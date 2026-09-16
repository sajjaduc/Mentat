/**
 * Provider service.
 *
 * Providers are workspace-scoped connections: a base URL, a secret reference and
 * operational config. This module owns their CRUD, the health-check history and
 * model discovery. Provider I/O always happens *outside* the transaction, then the
 * result is persisted atomically with its audit row (ADR-0004).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import {
  type Model,
  models,
  type Provider,
  type ProviderConfig,
  type ProviderType,
  providerHealthChecks,
  providers,
  secrets
} from '../db/schema';
import { createProvider } from './registry';
import type { ProviderHealth } from './types';

const providerConfigSchema = z
  .object({
    keepAlive: z.string().trim().max(60).optional(),
    organization: z.string().trim().max(200).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    queryParams: z.record(z.string(), z.string()).optional()
  })
  .strict();

const baseUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Base URL must start with http:// or https://'
  });

const providerWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['ollama', 'openai', 'openai_compatible', 'anthropic', 'fake']),
  baseUrl: baseUrlSchema.nullable().optional(),
  apiKeySecretId: z.string().trim().min(1).max(200).nullable().optional(),
  config: providerConfigSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional()
});

const providerUpdateSchema = providerWriteSchema.partial();

export type RegisterProviderInput = z.input<typeof providerWriteSchema>;
export type UpdateProviderInput = z.input<typeof providerUpdateSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.validation(`Invalid ${label}`, { issues: result.error.issues });
  }
  return result.data;
}

function requireProvider(tx: Executor, actor: ActorContext, providerId: string): Provider {
  const rows = tx
    .select()
    .from(providers)
    .where(and(eq(providers.id, providerId), eq(providers.workspaceId, actor.workspaceId)))
    .limit(1)
    .all();
  const provider = rows[0];
  if (!provider) throw errors.notFound('Provider', providerId);
  return provider;
}

function assertSecretInWorkspace(tx: Executor, workspaceId: string, secretId: string): void {
  const rows = tx
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(eq(secrets.id, secretId), eq(secrets.workspaceId, workspaceId), isNull(secrets.deletedAt))
    )
    .limit(1)
    .all();
  if (rows.length === 0) throw errors.notFound('Secret', secretId);
}

export async function registerProvider(
  db: Executor,
  actor: ActorContext,
  input: RegisterProviderInput
): Promise<Provider> {
  assertPermission(actor, Permissions.providerWrite, 'Not permitted to create providers');
  const parsed = parseOrThrow(providerWriteSchema, input, 'provider');

  return withTransaction(db, (tx) => {
    if (parsed.apiKeySecretId) {
      assertSecretInWorkspace(tx, actor.workspaceId, parsed.apiKeySecretId);
    }
    const existing = tx
      .select()
      .from(providers)
      .where(and(eq(providers.workspaceId, actor.workspaceId), eq(providers.name, parsed.name)))
      .limit(1)
      .all()[0];
    if (existing) {
      throw errors.conflict(`A provider named "${parsed.name}" already exists`, {
        name: parsed.name
      });
    }

    const now = Date.now();
    const id = uuidv7();
    const inserted = tx
      .insert(providers)
      .values({
        id,
        workspaceId: actor.workspaceId,
        name: parsed.name,
        type: parsed.type,
        baseUrl: parsed.baseUrl ?? null,
        apiKeySecretId: parsed.apiKeySecretId ?? null,
        config: (parsed.config as ProviderConfig | null | undefined) ?? null,
        enabled: parsed.enabled ?? true,
        isDefault: parsed.isDefault ?? false,
        createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all()[0];
    if (!inserted) throw errors.internal('Failed to create provider');

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'provider',
      entityId: id,
      summary: `Provider "${inserted.name}" created`,
      data: {
        type: inserted.type,
        baseUrl: inserted.baseUrl,
        hasApiKey: inserted.apiKeySecretId !== null,
        enabled: inserted.enabled
      }
    });
    return inserted;
  });
}

export async function updateProvider(
  db: Executor,
  actor: ActorContext,
  providerId: string,
  input: UpdateProviderInput
): Promise<Provider> {
  assertPermission(actor, Permissions.providerWrite, 'Not permitted to update providers');
  const parsed = parseOrThrow(providerUpdateSchema, input, 'provider update');

  return withTransaction(db, (tx) => {
    const current = requireProvider(tx, actor, providerId);
    if (parsed.apiKeySecretId) {
      assertSecretInWorkspace(tx, actor.workspaceId, parsed.apiKeySecretId);
    }
    if (parsed.name && parsed.name !== current.name) {
      const clash = tx
        .select({ id: providers.id })
        .from(providers)
        .where(and(eq(providers.workspaceId, actor.workspaceId), eq(providers.name, parsed.name)))
        .limit(1)
        .all()[0];
      if (clash) {
        throw errors.conflict(`A provider named "${parsed.name}" already exists`, {
          name: parsed.name
        });
      }
    }

    const now = Date.now();
    const updated = tx
      .update(providers)
      .set({
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.type !== undefined ? { type: parsed.type as ProviderType } : {}),
        ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
        ...(parsed.apiKeySecretId !== undefined ? { apiKeySecretId: parsed.apiKeySecretId } : {}),
        ...(parsed.config !== undefined ? { config: parsed.config as ProviderConfig | null } : {}),
        ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
        ...(parsed.isDefault !== undefined ? { isDefault: parsed.isDefault } : {}),
        updatedAt: now
      })
      .where(eq(providers.id, current.id))
      .returning()
      .all()[0];
    if (!updated) throw errors.internal('Failed to update provider');

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'provider',
      entityId: updated.id,
      summary: `Provider "${updated.name}" updated`,
      data: {
        changed: Object.keys(parsed),
        type: updated.type,
        enabled: updated.enabled,
        hasApiKey: updated.apiKeySecretId !== null
      }
    });
    return updated;
  });
}

export function getProvider(db: Executor, actor: ActorContext, providerId: string): Provider {
  assertPermission(actor, Permissions.providerRead, 'Not permitted to read providers');
  return requireProvider(db, actor, providerId);
}

export interface ListProvidersOptions {
  enabledOnly?: boolean;
}

export function listProviders(
  db: Executor,
  actor: ActorContext,
  options: ListProvidersOptions = {}
): Provider[] {
  assertPermission(actor, Permissions.providerRead, 'Not permitted to list providers');
  const conditions = [eq(providers.workspaceId, actor.workspaceId)];
  if (options.enabledOnly) conditions.push(eq(providers.enabled, true));
  return db
    .select()
    .from(providers)
    .where(and(...conditions))
    .orderBy(providers.name)
    .all();
}

/**
 * Hard-delete a provider and its models.
 *
 * The audit action set is frozen and has no `provider.deleted`; recording the
 * change under `provider.updated` with `deleted: true` keeps the mutation audited
 * rather than silently unaudited.
 */
export async function deleteProvider(
  db: Executor,
  actor: ActorContext,
  providerId: string
): Promise<void> {
  assertPermission(actor, Permissions.providerWrite, 'Not permitted to delete providers');
  await withTransaction(db, (tx) => {
    const provider = requireProvider(tx, actor, providerId);
    tx.delete(providers).where(eq(providers.id, provider.id)).run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'provider',
      entityId: provider.id,
      summary: `Provider "${provider.name}" deleted`,
      data: { deleted: true, type: provider.type }
    });
  });
}

export interface CheckHealthResult {
  provider: Provider;
  health: ProviderHealth;
}

/**
 * Run a health probe and persist the result.
 *
 * A provider that is down is a normal operational state, not an error: the health
 * result is recorded and returned, never thrown.
 */
export async function checkHealth(
  db: Executor,
  actor: ActorContext,
  providerId: string
): Promise<CheckHealthResult> {
  assertPermission(actor, Permissions.providerRead, 'Not permitted to check provider health');
  const providerRow = requireProvider(db, actor, providerId);

  const provider = createProvider(db, providerRow);
  let health: ProviderHealth;
  try {
    health = await provider.health();
  } catch (error) {
    health = {
      status: 'unreachable',
      message: error instanceof Error ? error.message : 'Provider health check failed'
    };
  }

  const checkedAt = Date.now();
  const message =
    health.message ??
    (health.modelCount !== undefined ? `Reachable; ${health.modelCount} models available` : null);

  await withTransaction(db, (tx) => {
    tx.insert(providerHealthChecks)
      .values({
        id: uuidv7(),
        workspaceId: actor.workspaceId,
        providerId: providerRow.id,
        status: health.status,
        latencyMs: health.latencyMs ?? null,
        message,
        modelCount: health.modelCount ?? null,
        checkedAt
      })
      .run();
    tx.update(providers)
      .set({
        healthStatus: health.status,
        healthMessage: message,
        healthCheckedAt: checkedAt
      })
      .where(eq(providers.id, providerRow.id))
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.providerHealthChecked,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'provider',
      entityId: providerRow.id,
      summary: `Provider "${providerRow.name}" health: ${health.status}`,
      data: {
        status: health.status,
        latencyMs: health.latencyMs ?? null,
        modelCount: health.modelCount ?? null
      }
    });
  });

  const updated = requireProvider(db, actor, providerRow.id);
  return {
    provider: updated,
    health: { ...health, ...(message !== null ? { message } : {}) }
  };
}

export interface RefreshModelsResult {
  added: number;
  updated: number;
  removed: number;
  models: Model[];
}

/**
 * Discover the provider's models and reconcile them with this workspace's rows.
 *
 * New keys are inserted, changed metadata is updated, and models that vanished
 * are *disabled* rather than deleted — runs and agents reference model ids, and
 * a missing model should degrade to "unavailable", not break history. Models
 * registered by hand (`discovered = false`) are never disabled by a refresh.
 */
export async function refreshModels(
  db: Executor,
  actor: ActorContext,
  providerId: string
): Promise<RefreshModelsResult> {
  assertPermission(actor, Permissions.providerWrite, 'Not permitted to refresh provider models');
  const providerRow = requireProvider(db, actor, providerId);
  const provider = createProvider(db, providerRow);

  // Provider I/O happens before the transaction so no network call holds a write.
  const descriptors = await provider.listModels();
  const now = Date.now();

  return withTransaction(db, (tx) => {
    const existing = tx.select().from(models).where(eq(models.providerId, providerRow.id)).all();
    const byKey = new Map(existing.map((model) => [model.modelKey, model]));
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;

    for (const descriptor of descriptors) {
      seen.add(descriptor.key);
      const capabilities = descriptor.capabilities ?? null;
      const metadata = {
        displayName: descriptor.displayName,
        family: descriptor.family ?? null,
        parameterSize: descriptor.parameterSize ?? null,
        quantization: descriptor.quantization ?? null,
        capabilities,
        contextWindow: descriptor.contextWindow ?? null,
        discovered: true,
        lastSeenAt: now
      };
      const current = byKey.get(descriptor.key);
      if (!current) {
        tx.insert(models)
          .values({
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            providerId: providerRow.id,
            modelKey: descriptor.key,
            ...metadata,
            enabled: true,
            isFavorite: false,
            discoveredAt: now,
            createdAt: now,
            updatedAt: now
          })
          .run();
        added += 1;
        continue;
      }

      if (!current.discovered) {
        // Hand-registered models carry explicit capabilities and defaults that
        // discovery must not overwrite; refresh only records that it saw them.
        tx.update(models)
          .set({ lastSeenAt: now, updatedAt: now })
          .where(eq(models.id, current.id))
          .run();
        continue;
      }

      const changed =
        current.displayName !== metadata.displayName ||
        current.family !== metadata.family ||
        current.parameterSize !== metadata.parameterSize ||
        current.quantization !== metadata.quantization ||
        current.contextWindow !== metadata.contextWindow ||
        current.discovered !== true ||
        JSON.stringify(current.capabilities ?? null) !== JSON.stringify(capabilities);
      tx.update(models)
        .set({ ...metadata, updatedAt: now })
        .where(eq(models.id, current.id))
        .run();
      if (changed) updated += 1;
    }

    let removed = 0;
    for (const current of existing) {
      if (!seen.has(current.modelKey) && current.discovered && current.enabled) {
        tx.update(models)
          .set({ enabled: false, updatedAt: now })
          .where(eq(models.id, current.id))
          .run();
        removed += 1;
      }
    }

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.modelsDiscovered,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'provider',
      entityId: providerRow.id,
      summary: `Discovered ${descriptors.length} model(s) for "${providerRow.name}"`,
      data: { added, updated, removed, discovered: descriptors.length }
    });

    const refreshed = tx.select().from(models).where(eq(models.providerId, providerRow.id)).all();
    return { added, updated, removed, models: refreshed };
  });
}
