/**
 * Model service.
 *
 * A Model is the selectable inference target: a provider row plus capability
 * declarations and inference defaults. This module owns hand-registration,
 * favourite/enablement/defaults editing, deletion safety and the precedence rules
 * that turn a model row, an agent's execution config and an explicit request into
 * one effective generation configuration.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import {
  type AgentExecutionConfig,
  agentRuns,
  type Model,
  type ModelCapabilities,
  type ModelInferenceDefaults,
  models,
  providers
} from '../db/schema';
import type { GenerateRequest } from './types';

const capabilitySchema = z
  .object({
    streaming: z.boolean().optional(),
    toolCalling: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
    vision: z.boolean().optional(),
    embeddings: z.boolean().optional(),
    reasoning: z.boolean().optional()
  })
  .strict();

const inferenceDefaultsSchema = z
  .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().int().optional(),
    numCtx: z.number().int().positive().optional(),
    numPredict: z.number().int().positive().optional(),
    stop: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
    repeatPenalty: z.number().optional()
  })
  .strict();

const registerModelSchema = z.object({
  providerId: z.string().trim().min(1),
  modelKey: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  family: z.string().trim().max(120).nullable().optional(),
  parameterSize: z.string().trim().max(60).nullable().optional(),
  quantization: z.string().trim().max(60).nullable().optional(),
  capabilities: capabilitySchema.nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  inferenceDefaults: inferenceDefaultsSchema.nullable().optional()
});

export type RegisterModelInput = z.input<typeof registerModelSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.validation(`Invalid ${label}`, { issues: result.error.issues });
  }
  return result.data;
}

function requireModel(tx: Executor, actor: ActorContext, modelId: string): Model {
  const rows = tx
    .select()
    .from(models)
    .where(and(eq(models.id, modelId), eq(models.workspaceId, actor.workspaceId)))
    .limit(1)
    .all();
  const model = rows[0];
  if (!model) throw errors.notFound('Model', modelId);
  return model;
}

export interface ListModelsOptions {
  providerId?: string;
  /** Defaults to true so operators can see disabled models. */
  includeDisabled?: boolean;
}

export function listModels(
  db: Executor,
  actor: ActorContext,
  options: ListModelsOptions = {}
): Model[] {
  assertPermission(actor, Permissions.providerRead, 'Not permitted to list models');
  const conditions = [eq(models.workspaceId, actor.workspaceId)];
  if (options.providerId) conditions.push(eq(models.providerId, options.providerId));
  if (!(options.includeDisabled ?? true)) conditions.push(eq(models.enabled, true));
  return db
    .select()
    .from(models)
    .where(and(...conditions))
    .orderBy(models.displayName)
    .all();
}

export function getModel(db: Executor, actor: ActorContext, modelId: string): Model {
  assertPermission(actor, Permissions.providerRead, 'Not permitted to read models');
  return requireModel(db, actor, modelId);
}

/**
 * Register a hand-curated model.
 *
 * Hand registration carries explicit capabilities and inference defaults, so it
 * is never overwritten by discovery; refresh only disables models it previously
 * discovered.
 */
export async function registerModel(
  db: Executor,
  actor: ActorContext,
  input: RegisterModelInput
): Promise<Model> {
  assertPermission(actor, Permissions.providerWrite, 'Not permitted to register models');
  const parsed = parseOrThrow(registerModelSchema, input, 'model');

  return withTransaction(db, (tx) => {
    const provider = tx
      .select()
      .from(providers)
      .where(and(eq(providers.id, parsed.providerId), eq(providers.workspaceId, actor.workspaceId)))
      .limit(1)
      .all()[0];
    if (!provider) throw errors.notFound('Provider', parsed.providerId);

    const existing = tx
      .select()
      .from(models)
      .where(and(eq(models.providerId, parsed.providerId), eq(models.modelKey, parsed.modelKey)))
      .limit(1)
      .all()[0];
    if (existing) {
      throw errors.conflict(
        `Model "${parsed.modelKey}" is already registered for provider "${provider.name}"`,
        { modelKey: parsed.modelKey, providerId: provider.id }
      );
    }

    const now = Date.now();
    const id = uuidv7();
    const inserted = tx
      .insert(models)
      .values({
        id,
        workspaceId: actor.workspaceId,
        providerId: parsed.providerId,
        modelKey: parsed.modelKey,
        displayName: parsed.displayName ?? parsed.modelKey,
        description: parsed.description ?? null,
        family: parsed.family ?? null,
        parameterSize: parsed.parameterSize ?? null,
        quantization: parsed.quantization ?? null,
        capabilities: parsed.capabilities ?? null,
        contextWindow: parsed.contextWindow ?? null,
        maxOutputTokens: parsed.maxOutputTokens ?? null,
        inferenceDefaults: parsed.inferenceDefaults ?? null,
        enabled: true,
        isFavorite: false,
        discovered: false,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all()[0];
    if (!inserted) throw errors.internal('Failed to register model');

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'model',
      entityId: id,
      summary: `Model "${inserted.displayName}" registered`,
      data: { modelKey: inserted.modelKey, providerId: provider.id, source: 'registered' }
    });
    return inserted;
  });
}

async function mutateModel(
  db: Executor,
  actor: ActorContext,
  modelId: string,
  permissionMessage: string,
  apply: (tx: Executor, model: Model, now: number) => { summary: string; data: unknown }
): Promise<Model> {
  assertPermission(actor, Permissions.providerWrite, permissionMessage);
  return withTransaction(db, (tx) => {
    const model = requireModel(tx, actor, modelId);
    const now = Date.now();
    const { summary, data } = apply(tx, model, now);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'model',
      entityId: model.id,
      summary,
      data
    });
    const updated = tx.select().from(models).where(eq(models.id, model.id)).limit(1).all()[0];
    if (!updated) throw errors.internal('Failed to reload model');
    return updated;
  });
}

export async function setFavorite(
  db: Executor,
  actor: ActorContext,
  modelId: string,
  favorite: boolean
): Promise<Model> {
  return mutateModel(
    db,
    actor,
    modelId,
    'Not permitted to change model favourites',
    (tx, model, now) => {
      tx.update(models)
        .set({ isFavorite: favorite, updatedAt: now })
        .where(eq(models.id, model.id))
        .run();
      return {
        summary: `Model "${model.displayName}" favourite=${favorite}`,
        data: { modelKey: model.modelKey, favorite }
      };
    }
  );
}

export async function updateModelDefaults(
  db: Executor,
  actor: ActorContext,
  modelId: string,
  defaults: ModelInferenceDefaults
): Promise<Model> {
  const parsed = parseOrThrow(inferenceDefaultsSchema, defaults, 'model defaults');
  return mutateModel(
    db,
    actor,
    modelId,
    'Not permitted to change model defaults',
    (tx, model, now) => {
      tx.update(models)
        .set({ inferenceDefaults: parsed, updatedAt: now })
        .where(eq(models.id, model.id))
        .run();
      return {
        summary: `Model "${model.displayName}" defaults updated`,
        data: { modelKey: model.modelKey, defaults: parsed }
      };
    }
  );
}

export async function setEnabled(
  db: Executor,
  actor: ActorContext,
  modelId: string,
  enabled: boolean
): Promise<Model> {
  return mutateModel(
    db,
    actor,
    modelId,
    'Not permitted to enable or disable models',
    (tx, model, now) => {
      tx.update(models).set({ enabled, updatedAt: now }).where(eq(models.id, model.id)).run();
      return {
        summary: `Model "${model.displayName}" enabled=${enabled}`,
        data: { modelKey: model.modelKey, enabled }
      };
    }
  );
}

/**
 * Delete a model.
 *
 * Runs reference the model id for their history, so a referenced model is never
 * deleted; the caller is told exactly why instead of receiving a foreign-key
 * error or silently orphaning a run.
 */
export async function deleteModel(
  db: Executor,
  actor: ActorContext,
  modelId: string
): Promise<void> {
  assertPermission(actor, Permissions.providerWrite, 'Not permitted to delete models');
  await withTransaction(db, (tx) => {
    const model = requireModel(tx, actor, modelId);
    const referencingRun = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.modelId, model.id))
      .limit(1)
      .all()[0];
    if (referencingRun) {
      throw errors.conflict(
        `Model "${model.displayName}" is referenced by an agent run and cannot be deleted`,
        { modelId: model.id, runId: referencingRun.id }
      );
    }
    tx.delete(models).where(eq(models.id, model.id)).run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'model',
      entityId: model.id,
      summary: `Model "${model.displayName}" deleted`,
      data: { modelKey: model.modelKey, providerId: model.providerId }
    });
  });
}

export interface ResolvedGenerationOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stop?: string[];
  seed?: number;
  /** Provider-specific options, e.g. Ollama's `num_ctx` / `repeat_penalty`. */
  options: Record<string, unknown>;
}

/**
 * Merge generation options with a documented precedence:
 *
 *   explicit request  >  agent execution config  >  model inference defaults
 *
 * `model.maxOutputTokens` sits between the agent config and `numPredict`: the
 * column is a hard ceiling for the model, while `numPredict` is a legacy default.
 */
export function resolveGenerationOptions(
  model: Pick<Model, 'inferenceDefaults' | 'maxOutputTokens'>,
  agentConfig: AgentExecutionConfig | null | undefined,
  request: Partial<
    Pick<
      GenerateRequest,
      'temperature' | 'topP' | 'topK' | 'maxOutputTokens' | 'stop' | 'seed' | 'options'
    >
  >
): ResolvedGenerationOptions {
  const defaults = model.inferenceDefaults ?? {};
  const agent = agentConfig ?? {};

  const options: Record<string, unknown> = {
    ...(defaults.numCtx !== undefined ? { num_ctx: defaults.numCtx } : {}),
    ...(defaults.repeatPenalty !== undefined ? { repeat_penalty: defaults.repeatPenalty } : {}),
    ...(request.options ?? {})
  };

  const resolved: ResolvedGenerationOptions = { options };
  const temperature = request.temperature ?? agent.temperature ?? defaults.temperature;
  if (temperature !== undefined) resolved.temperature = temperature;
  const topP = request.topP ?? agent.topP ?? defaults.topP;
  if (topP !== undefined) resolved.topP = topP;
  const topK = request.topK ?? defaults.topK;
  if (topK !== undefined) resolved.topK = topK;
  const maxOutputTokens =
    request.maxOutputTokens ??
    agent.maxOutputTokens ??
    model.maxOutputTokens ??
    defaults.numPredict;
  if (maxOutputTokens !== undefined) resolved.maxOutputTokens = maxOutputTokens;
  const stop = request.stop ?? defaults.stop;
  if (stop !== undefined) resolved.stop = stop;
  const seed = request.seed ?? defaults.seed;
  if (seed !== undefined) resolved.seed = seed;
  return resolved;
}

/** Re-exported so callers can type capability patches without another import. */
export type { ModelCapabilities, ModelInferenceDefaults };
