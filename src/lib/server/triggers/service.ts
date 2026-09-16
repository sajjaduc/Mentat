/**
 * Trigger configuration.
 *
 * Why this exists: webhooks, schedules and manual/API entry points are all
 * *triggers*, and the platform needs one place that owns their lifecycle —
 * workspace scoping, permission checks, token generation, schedule validation and
 * audit. Firing is handled by the event pipeline; this module only owns the
 * configuration that pipeline reads.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit/ledger';
import { nextCronRun, validateCron } from '../core/clock';
import type { ActorContext } from '../core/context';
import { assertPermission, Permissions } from '../core/context';
import { timingSafeEqualString } from '../core/crypto';
import { errors } from '../core/errors';
import { randomToken } from '../core/ids';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import type {
  CronTriggerConfig,
  ManualTriggerConfig,
  Trigger,
  TriggerType,
  WebhookTriggerConfig
} from '../db/schema';
import { triggers, workflows } from '../db/schema';
import { triggerMappingSchema } from './mapping';

export const TRIGGER_TYPES: readonly TriggerType[] = ['webhook', 'cron', 'manual', 'api'];
export const DEFAULT_SIGNATURE_HEADER = 'X-Mentat-Signature';
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB

export type TriggerConfig = WebhookTriggerConfig | CronTriggerConfig | ManualTriggerConfig;

/** Public shape of a trigger; contains no secret material. */
export interface TriggerView {
  id: string;
  workspaceId: string;
  workflowId: string;
  name: string;
  description: string | null;
  type: TriggerType;
  enabled: boolean;
  /** Opaque URL segment, not a credential; null for non-webhook triggers. */
  webhookToken: string | null;
  config: TriggerConfig;
  targetStateId: string | null;
  upsertOnDedupe: boolean;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface CreateTriggerInput {
  workflowId: string;
  name: string;
  description?: string | null;
  type: TriggerType;
  enabled?: boolean;
  config?: TriggerConfig | null;
  targetStateId?: string | null;
  upsertOnDedupe?: boolean;
}

export interface UpdateTriggerInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  config?: TriggerConfig;
  targetStateId?: string | null;
  upsertOnDedupe?: boolean;
}

export interface FireOutcome {
  firedAt?: number;
  nextRunAt?: number | null;
  error?: string | null;
}

const webhookConfigSchema = z.object({
  signatureRequired: z.boolean().optional(),
  signatureHeader: z.string().min(1).max(256).optional(),
  signatureSecretId: z.string().min(1).optional(),
  mapping: triggerMappingSchema.optional(),
  maxPayloadBytes: z.number().int().positive().max(104_857_600).optional()
});

const cronConfigSchema = z.object({
  expression: z.string().min(1).max(256),
  timezone: z.string().min(1).max(128).optional(),
  mapping: triggerMappingSchema.optional(),
  skipIfRunning: z.boolean().optional()
});

const manualConfigSchema = z.object({
  mapping: triggerMappingSchema.optional(),
  inputSchema: z.unknown().optional()
});

const nameSchema = z.string().trim().min(1).max(200);

/**
 * Cron schedules are validated at the configuration boundary so an expression
 * that cannot ever run is rejected at write time, not at firing time. The
 * canonical next-run helper lives in `triggers/cron.ts`; this module only needs
 * the validation plus a deterministic next value.
 */
function cronNextRun(
  expression: string,
  timezone: string | null | undefined,
  from: number
): number {
  const tz = timezone && timezone.trim().length > 0 ? timezone : 'UTC';
  const result = validateCron(expression, tz);
  if (!result.valid) {
    throw errors.validation(`Invalid cron expression: ${result.error}`, {
      expression,
      timezone: tz
    });
  }
  return nextCronRun(expression, { from, timezone: tz });
}

function validation(error: z.ZodError, context: string): never {
  throw errors.validation(`Invalid ${context}`, {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message
    }))
  });
}

/**
 * Validate and normalise a trigger config. Cron expressions are validated here so
 * an invalid schedule can never be persisted.
 */
export function normalizeTriggerConfig(
  type: TriggerType,
  config: TriggerConfig | null | undefined
): TriggerConfig {
  const input = config ?? {};
  switch (type) {
    case 'webhook': {
      const parsed = webhookConfigSchema.safeParse(input);
      if (!parsed.success) validation(parsed.error, 'webhook configuration');
      const value = parsed.data as WebhookTriggerConfig;
      if (value.signatureRequired && !value.signatureSecretId) {
        throw errors.validation(
          'A webhook trigger that requires a signature needs a signatureSecretId'
        );
      }
      return value;
    }
    case 'cron': {
      const parsed = cronConfigSchema.safeParse(input);
      if (!parsed.success) validation(parsed.error, 'cron configuration');
      const value = parsed.data as CronTriggerConfig;
      // Throws errors.validation when the expression or timezone is not valid.
      cronNextRun(value.expression, value.timezone, Date.now());
      return value;
    }
    case 'manual':
    case 'api': {
      const parsed = manualConfigSchema.safeParse(input);
      if (!parsed.success) validation(parsed.error, 'manual configuration');
      return parsed.data as ManualTriggerConfig;
    }
    default:
      throw errors.validation(`Unsupported trigger type "${type as string}"`, { type });
  }
}

function toView(row: Trigger): TriggerView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    name: row.name,
    description: row.description,
    type: row.type,
    enabled: row.enabled,
    webhookToken: row.webhookToken,
    config: (row.config ?? {}) as TriggerConfig,
    targetStateId: row.targetStateId,
    upsertOnDedupe: row.upsertOnDedupe,
    lastFiredAt: row.lastFiredAt,
    nextRunAt: row.nextRunAt,
    lastError: row.lastError,
    fireCount: row.fireCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt
  };
}

function requireWorkflow(db: Executor, workspaceId: string, workflowId: string): void {
  const row = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
    .limit(1)
    .all()[0];
  // A workflow in another workspace is indistinguishable from a missing one.
  if (!row) throw errors.notFound('Workflow', workflowId);
}

function uniqueWebhookToken(db: Executor): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomToken();
    const existing = db
      .select({ id: triggers.id })
      .from(triggers)
      .where(eq(triggers.webhookToken, token))
      .limit(1)
      .all()[0];
    if (!existing) return token;
  }
  throw errors.internal('Unable to allocate a unique webhook token');
}

function nextRunFor(type: TriggerType, config: TriggerConfig, from: number): number | null {
  if (type !== 'cron') return null;
  const cron = config as CronTriggerConfig;
  if (!cron.expression) return null;
  return cronNextRun(cron.expression, cron.timezone, from);
}

export async function createTrigger(
  db: Executor,
  actor: ActorContext,
  input: CreateTriggerInput
): Promise<TriggerView> {
  assertPermission(actor, Permissions.triggerWrite, 'Not permitted to create triggers');
  const name = nameSchema.safeParse(input.name);
  if (!name.success) validation(name.error, 'trigger name');
  if (!TRIGGER_TYPES.includes(input.type)) {
    throw errors.validation(`Unsupported trigger type "${input.type as string}"`, {
      type: input.type
    });
  }
  requireWorkflow(db, actor.workspaceId, input.workflowId);
  const config = normalizeTriggerConfig(input.type, input.config);
  const now = Date.now();
  const nextRunAt = nextRunFor(input.type, config, now);

  const row = await withTransaction(db, (tx) => {
    const clash = tx
      .select({ id: triggers.id })
      .from(triggers)
      .where(
        and(
          eq(triggers.workspaceId, actor.workspaceId),
          eq(triggers.workflowId, input.workflowId),
          eq(triggers.name, name.data)
        )
      )
      .limit(1)
      .all()[0];
    if (clash) {
      throw errors.conflict(`A trigger named "${name.data}" already exists in this workflow`, {
        name: name.data
      });
    }

    const persisted = tx
      .insert(triggers)
      .values({
        workspaceId: actor.workspaceId,
        workflowId: input.workflowId,
        name: name.data,
        description: input.description ?? null,
        type: input.type,
        enabled: input.enabled ?? true,
        webhookToken: input.type === 'webhook' ? uniqueWebhookToken(tx) : null,
        config: config as never,
        targetStateId: input.targetStateId ?? null,
        upsertOnDedupe: input.upsertOnDedupe ?? false,
        nextRunAt,
        createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all()[0];
    if (!persisted) throw errors.internal('Failed to create trigger', { name: name.data });

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'trigger.created',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'trigger',
      entityId: persisted.id,
      workflowId: persisted.workflowId,
      summary: `Trigger "${persisted.name}" created`,
      data: { type: persisted.type, enabled: persisted.enabled, nextRunAt }
    });
    return persisted;
  });

  return toView(row);
}

export function getTrigger(db: Executor, actor: ActorContext, triggerId: string): TriggerView {
  assertPermission(actor, Permissions.triggerRead, 'Not permitted to read triggers');
  return toView(requireTriggerRow(db, actor.workspaceId, triggerId));
}

export function listTriggers(
  db: Executor,
  actor: ActorContext,
  options: {
    workflowId?: string;
    type?: TriggerType;
    /** Archived triggers are hidden unless explicitly requested. */
    includeArchived?: boolean;
  } = {}
): TriggerView[] {
  assertPermission(actor, Permissions.triggerRead, 'Not permitted to read triggers');
  const conditions = [eq(triggers.workspaceId, actor.workspaceId)];
  if (options.workflowId) conditions.push(eq(triggers.workflowId, options.workflowId));
  if (options.type) conditions.push(eq(triggers.type, options.type));
  if (!options.includeArchived) conditions.push(isNull(triggers.archivedAt));
  return db
    .select()
    .from(triggers)
    .where(and(...conditions))
    .orderBy(triggers.createdAt)
    .all()
    .map(toView);
}

export async function updateTrigger(
  db: Executor,
  actor: ActorContext,
  triggerId: string,
  patch: UpdateTriggerInput
): Promise<TriggerView> {
  assertPermission(actor, Permissions.triggerWrite, 'Not permitted to change triggers');
  const current = requireTriggerRow(db, actor.workspaceId, triggerId);

  const name = patch.name === undefined ? current.name : nameSchema.parse(patch.name);
  const config =
    patch.config === undefined
      ? ((current.config ?? {}) as TriggerConfig)
      : normalizeTriggerConfig(current.type, patch.config);
  const enabled = patch.enabled ?? current.enabled;
  const now = Date.now();
  // Reschedule only when the expression changed or no cursor exists yet, so an
  // unrelated edit (a rename, say) does not move the next run.
  const scheduleChanged = patch.config !== undefined || current.nextRunAt === null;
  const nextRunAt =
    current.type === 'cron' && scheduleChanged
      ? nextRunFor('cron', config, now)
      : current.nextRunAt;

  const row = await withTransaction(db, (tx) => {
    if (patch.name !== undefined && name !== current.name) {
      const clash = tx
        .select({ id: triggers.id })
        .from(triggers)
        .where(
          and(
            eq(triggers.workspaceId, actor.workspaceId),
            eq(triggers.workflowId, current.workflowId),
            eq(triggers.name, name)
          )
        )
        .limit(1)
        .all()[0];
      if (clash && clash.id !== triggerId) {
        throw errors.conflict(`A trigger named "${name}" already exists in this workflow`, {
          name
        });
      }
    }

    const updated = tx
      .update(triggers)
      .set({
        name,
        description: patch.description === undefined ? current.description : patch.description,
        enabled,
        config: config as never,
        targetStateId:
          patch.targetStateId === undefined ? current.targetStateId : patch.targetStateId,
        upsertOnDedupe: patch.upsertOnDedupe ?? current.upsertOnDedupe,
        nextRunAt,
        updatedAt: now
      })
      .where(and(eq(triggers.id, triggerId), eq(triggers.workspaceId, actor.workspaceId)))
      .returning()
      .all()[0];
    if (!updated) throw errors.notFound('Trigger', triggerId);

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'trigger.updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'trigger',
      entityId: updated.id,
      workflowId: updated.workflowId,
      summary: `Trigger "${updated.name}" updated`,
      data: {
        enabled: updated.enabled,
        type: updated.type,
        nextRunAt,
        changed: Object.keys(patch)
      }
    });
    return updated;
  });

  return toView(row);
}

/** Soft archive: history and events stay inspectable, the trigger stops firing. */
export async function archiveTrigger(
  db: Executor,
  actor: ActorContext,
  triggerId: string
): Promise<void> {
  assertPermission(actor, Permissions.triggerWrite, 'Not permitted to archive triggers');
  await withTransaction(db, (tx) => {
    const archived = tx
      .update(triggers)
      .set({ archivedAt: Date.now(), enabled: false, updatedAt: Date.now() })
      .where(and(eq(triggers.id, triggerId), eq(triggers.workspaceId, actor.workspaceId)))
      .returning()
      .all()[0];
    if (!archived) throw errors.notFound('Trigger', triggerId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'trigger.archived',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'trigger',
      entityId: archived.id,
      workflowId: archived.workflowId,
      summary: `Trigger "${archived.name}" archived`,
      data: { type: archived.type }
    });
  });
}

/** Replace the webhook URL segment, invalidating the previous endpoint. */
export async function rotateWebhookToken(
  db: Executor,
  actor: ActorContext,
  triggerId: string
): Promise<TriggerView> {
  assertPermission(actor, Permissions.triggerWrite, 'Not permitted to change triggers');
  const current = requireTriggerRow(db, actor.workspaceId, triggerId);
  if (current.type !== 'webhook') {
    throw errors.validation('Only webhook triggers have a webhook token', { triggerId });
  }
  const now = Date.now();
  const row = await withTransaction(db, (tx) => {
    const updated = tx
      .update(triggers)
      .set({ webhookToken: uniqueWebhookToken(tx), updatedAt: now })
      .where(and(eq(triggers.id, triggerId), eq(triggers.workspaceId, actor.workspaceId)))
      .returning()
      .all()[0];
    if (!updated) throw errors.notFound('Trigger', triggerId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'trigger.updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'trigger',
      entityId: updated.id,
      workflowId: updated.workflowId,
      summary: `Webhook token rotated for "${updated.name}"`,
      // The token is public URL material, but the audit row stays metadata-only.
      data: { rotated: true }
    });
    return updated;
  });
  return toView(row);
}

/**
 * Record one firing. Called from the webhook/mutual receive paths so
 * `fireCount`/`lastFiredAt` are accurate even before the event is processed.
 */
export function recordFire(
  tx: Executor,
  triggerId: string,
  outcome: FireOutcome = {}
): Trigger | null {
  const now = outcome.firedAt ?? Date.now();
  const values: Record<string, unknown> = {
    lastFiredAt: now,
    fireCount: sql`${triggers.fireCount} + 1`,
    lastError: outcome.error ?? null,
    updatedAt: now
  };
  if (outcome.nextRunAt !== undefined) values.nextRunAt = outcome.nextRunAt;
  return (
    tx
      .update(triggers)
      .set(values as never)
      .where(eq(triggers.id, triggerId))
      .returning()
      .all()[0] ?? null
  );
}

/** Record a processing failure without changing the fire counters. */
export function recordTriggerError(tx: Executor, triggerId: string, error: string): void {
  tx.update(triggers)
    .set({ lastError: error.slice(0, 1000), updatedAt: Date.now() })
    .where(eq(triggers.id, triggerId))
    .run();
}

/** Workspace-scoped load used by every service entry point. */
export function requireTriggerRow(db: Executor, workspaceId: string, triggerId: string): Trigger {
  const row = db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.id, triggerId),
        eq(triggers.workspaceId, workspaceId),
        isNull(triggers.archivedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Trigger', triggerId);
  return row;
}

/**
 * Resolve a trigger from a webhook token. The token *is* the credential for an
 * anonymous delivery, so the lookup is deliberately not permission-gated; the
 * comparison is constant-time even though the index lookup already matched.
 */
export function findTriggerByWebhookToken(db: Executor, token: string): Trigger | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const row = db
    .select()
    .from(triggers)
    .where(and(eq(triggers.webhookToken, token), isNull(triggers.archivedAt)))
    .limit(1)
    .all()[0];
  if (!row) return null;
  if (!timingSafeEqualString(row.webhookToken ?? '', token)) return null;
  return row;
}

/** Counters surfaced in the trigger list UI. */
export function triggerStats(
  db: Executor,
  actor: ActorContext,
  workspaceId: string
): { total: number; enabled: number; scheduled: number } {
  assertPermission(actor, Permissions.triggerRead, 'Not permitted to read triggers');
  const rows = db
    .select({ enabled: triggers.enabled, nextRunAt: triggers.nextRunAt })
    .from(triggers)
    .where(and(eq(triggers.workspaceId, workspaceId), isNull(triggers.archivedAt)))
    .all();
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.enabled).length,
    scheduled: rows.filter((row) => row.enabled && row.nextRunAt !== null).length
  };
}
