/**
 * The internal trigger-event path.
 *
 * Why this exists: webhook, cron and manual/API triggers must behave identically
 * once a payload has been accepted. They all normalize into one `trigger_events`
 * row and one durable job, and all processing goes through
 * {@link processTriggerEvent}. That is what makes idempotency, redaction, mapping
 * and audit uniform instead of three subtly different implementations.
 *
 * Ordering follows ADR-0004/ADR-0007: persist the event first, then enqueue the
 * job that will act on it. The job is idempotent on the event id, and
 * {@link recoverPendingTriggerEvents} re-enqueues events that were persisted but
 * whose enqueue did not complete.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { systemActor } from '../core/context';
import { errors } from '../core/errors';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import type { TriggerEventStatus } from '../db/schema';
import { type Job, type Trigger, type TriggerEvent, triggerEvents, triggers } from '../db/schema';
import { SqliteJobQueue } from '../jobs/queue';
import { applyTriggerMapping, attachmentSourceType } from './mapping';
import { recordTriggerError } from './service';

/** Redact a payload using structural rules plus any registered secret values. */
export function redactTriggerPayload(payload: unknown): unknown {
  return createRedactor(registeredSecretValues()).value(payload);
}

/** Redact a free-text error before it is persisted on the event or trigger. */
function redactErrorText(message: string): string {
  return createRedactor(registeredSecretValues()).string(message);
}

export interface InsertTriggerEventInput {
  workspaceId: string;
  triggerId: string;
  /** Unique per trigger; makes redelivery a no-op. */
  idempotencyKey: string;
  source?: string | null;
  /** Already redacted via {@link redactTriggerPayload}. */
  payload: unknown;
  payloadBytes?: number | null;
  receivedAt?: number;
  /** `ignored` is used for deliveries accepted but intentionally not processed. */
  status?: TriggerEventStatus;
}

export interface InsertTriggerEventResult {
  event: TriggerEvent;
  duplicate: boolean;
  /** Original record id when the delivery is a duplicate. */
  recordId: string | null;
  /** Original workflow item id when the delivery is a duplicate. */
  workflowItemId: string | null;
}

/**
 * Persist a received event. The unique index on `(triggerId, idempotencyKey)` is
 * the idempotency mechanism: a conflict returns the original row instead of
 * creating a second unit of work.
 */
export function insertTriggerEvent(
  db: Executor,
  input: InsertTriggerEventInput
): InsertTriggerEventResult {
  const now = input.receivedAt ?? Date.now();
  const inserted = db
    .insert(triggerEvents)
    .values({
      workspaceId: input.workspaceId,
      triggerId: input.triggerId,
      idempotencyKey: input.idempotencyKey,
      status: input.status ?? 'received',
      source: input.source ?? null,
      payload: input.payload as never,
      payloadBytes: input.payloadBytes ?? null,
      receivedAt: now
    })
    .onConflictDoNothing()
    .returning()
    .all()[0];

  if (inserted) return { event: inserted, duplicate: false, recordId: null, workflowItemId: null };

  const existing = db
    .select()
    .from(triggerEvents)
    .where(
      and(
        eq(triggerEvents.triggerId, input.triggerId),
        eq(triggerEvents.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1)
    .all()[0];
  if (!existing) {
    throw errors.internal('Trigger event conflicted but the original row is missing', {
      triggerId: input.triggerId,
      idempotencyKey: input.idempotencyKey
    });
  }
  return {
    event: existing,
    duplicate: true,
    recordId: existing.recordId,
    workflowItemId: existing.workflowItemId
  };
}

export interface EnqueueTriggerJobInput {
  workspaceId: string;
  triggerId: string;
  eventId: string;
  type: 'trigger.webhook' | 'trigger.cron';
  actor?: ActorContext;
  reference?: string | null;
  source?: string | null;
  /** Stable key that keeps an event's job unique while it is active. */
  dedupeKey: string;
  availableAt?: number;
}

/** Enqueue the durable job that will process an event. */
export async function enqueueTriggerJob(db: Executor, input: EnqueueTriggerJobInput): Promise<Job> {
  const queue = new SqliteJobQueue(db);
  return queue.enqueue({
    workspaceId: input.workspaceId,
    type: input.type,
    payload: {
      triggerId: input.triggerId,
      eventId: input.eventId,
      source: input.source ?? null,
      reference: input.reference ?? null
    },
    dedupeKey: input.dedupeKey,
    availableAt: input.availableAt,
    // The queue's actor vocabulary is narrower than ActorContext's; an
    // extraction actor is attributed to the system.
    actorType:
      input.actor && input.actor.actorType !== 'extraction' ? input.actor.actorType : 'system',
    actorId: input.actor?.actorId ?? null,
    actorLabel: input.actor?.actorLabel ?? null
  });
}

export function attachJobToEvent(db: Executor, eventId: string, jobId: string): void {
  db.update(triggerEvents).set({ jobId }).where(eq(triggerEvents.id, eventId)).run();
}

/** Cron jobs dedupe per trigger (for `skipIfRunning`); everything else per event. */
export function triggerJobDedupeKey(
  trigger: Pick<Trigger, 'id' | 'type'>,
  eventId: string
): string {
  return trigger.type === 'cron' ? `cron:${trigger.id}` : `trigger-event:${eventId}`;
}

function loadTriggerForEvent(db: Executor, event: TriggerEvent): Trigger | null {
  return (
    db
      .select()
      .from(triggers)
      .where(and(eq(triggers.id, event.triggerId), eq(triggers.workspaceId, event.workspaceId)))
      .limit(1)
      .all()[0] ?? null
  );
}

export interface TriggerProcessResult {
  eventId: string;
  recordId: string | null;
  workflowItemId: string | null;
  workflowId: string | null;
  stateId: string | null;
  status: 'processed' | 'duplicate';
}

/**
 * Turn a persisted event into a Record + WorkflowItem through the trigger's
 * mapping. Safe to call twice for the same event: the second call observes
 * `processed` and returns the original ids rather than creating duplicate work.
 */
export async function processTriggerEvent(
  db: Executor,
  eventId: string
): Promise<TriggerProcessResult> {
  const event = db
    .select()
    .from(triggerEvents)
    .where(eq(triggerEvents.id, eventId))
    .limit(1)
    .all()[0];
  if (!event) throw errors.notFound('Trigger event', eventId);

  if (event.status === 'processed' && event.workflowItemId) {
    return {
      eventId,
      recordId: event.recordId,
      workflowItemId: event.workflowItemId,
      workflowId: null,
      stateId: null,
      status: 'duplicate'
    };
  }
  if (event.status === 'ignored') {
    return {
      eventId,
      recordId: null,
      workflowItemId: null,
      workflowId: null,
      stateId: null,
      status: 'duplicate'
    };
  }

  const trigger = loadTriggerForEvent(db, event);
  if (!trigger) throw errors.notFound('Trigger', event.triggerId);
  const actor = systemActor(event.workspaceId, `trigger:${trigger.type}:${trigger.id}`);

  try {
    const mapping = await applyTriggerMapping(db, {
      trigger,
      payload: event.payload,
      actor,
      // The file service is resolved lazily by the mapping only when the trigger
      // actually declares attachments, so a trigger without files does not depend
      // on the files workstream being installed.
      sourceType: attachmentSourceType(trigger, event.source),
      reference: event.source ?? event.idempotencyKey,
      triggerEventId: event.id
    });

    const now = Date.now();
    await withTransaction(db, (tx) => {
      tx.update(triggerEvents)
        .set({
          status: 'processed',
          recordId: mapping.recordId,
          workflowItemId: mapping.workflowItemId,
          processedAt: now,
          error: null
        })
        .where(eq(triggerEvents.id, eventId))
        .run();
      writeAudit(tx, {
        workspaceId: event.workspaceId,
        action: AuditActions.triggerProcessed,
        actorType: 'system',
        entityType: 'trigger_event',
        entityId: eventId,
        recordId: mapping.recordId,
        workflowItemId: mapping.workflowItemId,
        workflowId: mapping.workflowId,
        summary: `Trigger event processed into work ${mapping.workflowItemId}`,
        data: {
          triggerId: trigger.id,
          fieldKeysSet: mapping.fieldKeysSet,
          filesIngested: mapping.filesIngested,
          dedupeKey: mapping.dedupeKey
        },
        occurredAt: now
      });
    });

    return {
      eventId,
      recordId: mapping.recordId,
      workflowItemId: mapping.workflowItemId,
      workflowId: mapping.workflowId,
      stateId: mapping.stateId,
      status: 'processed'
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trigger processing failed';
    const now = Date.now();
    await withTransaction(db, (tx) => {
      tx.update(triggerEvents)
        .set({ status: 'failed', error: redactErrorText(message), processedAt: now })
        .where(eq(triggerEvents.id, eventId))
        .run();
      recordTriggerError(tx, trigger.id, message);
      writeAudit(tx, {
        workspaceId: event.workspaceId,
        action: AuditActions.triggerFailed,
        actorType: 'system',
        entityType: 'trigger_event',
        entityId: eventId,
        summary: `Trigger event failed: ${message}`,
        data: { triggerId: trigger.id },
        occurredAt: now
      });
    });
    throw error;
  }
}

/**
 * Re-enqueue events that were persisted but never got a job (a crash between
 * commit and enqueue). The event-id dedupe key keeps this from doubling work when
 * a job is already active.
 */
export async function recoverPendingTriggerEvents(
  db: Executor,
  options: { limit?: number; olderThanMs?: number; now?: number } = {}
): Promise<number> {
  const now = options.now ?? Date.now();
  const cutoff = now - (options.olderThanMs ?? 0);
  const pending = db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.status, 'received'), isNull(triggerEvents.jobId)))
    .orderBy(asc(triggerEvents.receivedAt))
    .limit(Math.min(options.limit ?? 25, 200))
    .all()
    .filter((event) => event.receivedAt <= cutoff);

  let recovered = 0;
  for (const event of pending) {
    const trigger = loadTriggerForEvent(db, event);
    if (!trigger) continue;
    const job = await enqueueTriggerJob(db, {
      workspaceId: event.workspaceId,
      triggerId: trigger.id,
      eventId: event.id,
      type: trigger.type === 'cron' ? 'trigger.cron' : 'trigger.webhook',
      dedupeKey: triggerJobDedupeKey(trigger, event.id),
      source: event.source ?? null,
      reference: event.source ?? null
    });
    await withTransaction(db, (tx) => {
      tx.update(triggerEvents).set({ jobId: job.id }).where(eq(triggerEvents.id, event.id)).run();
    });
    recovered += 1;
  }
  return recovered;
}
