/**
 * Cron scheduling without external infrastructure (ADR-0016).
 *
 * Why the claiming logic is shaped this way: two workers may run the scheduler at
 * the same moment, and a schedule must fire exactly once. Instead of a separate
 * lock table, the trigger row itself is the lock — a conditional `UPDATE` that
 * requires the *observed* `nextRunAt` to still be current (compare-and-swap).
 * Exactly one scheduler's update matches; the other sees zero rows and moves on.
 *
 * `lastFiredAt` plus the CAS predicate also make an interrupted scheduler safe:
 * a run that advanced `nextRunAt` but crashed before enqueueing is recovered by
 * `recoverPendingTriggerEvents`, not by firing twice.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { nextCronRun, validateCron } from '../core/clock';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import { type CronTriggerConfig, jobs, type Trigger, triggers } from '../db/schema';
import {
  attachJobToEvent,
  enqueueTriggerJob,
  insertTriggerEvent,
  recoverPendingTriggerEvents,
  redactTriggerPayload,
  triggerJobDedupeKey
} from './events';

/**
 * Deterministic, timezone-aware next run. `from` is explicit so schedules are
 * reproducible in tests and so "advance from now" is never accidentally
 * "advance from when the process started".
 */
export function computeNextRun(
  expression: string,
  timezone?: string | null,
  from: number = Date.now()
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

export interface ClaimedSchedule {
  trigger: Trigger;
  /** The `nextRunAt` that was due when the schedule was claimed. */
  scheduledFor: number;
  /** The advanced cursor persisted by the claim. */
  nextRunAt: number;
  /** True when `skipIfRunning` suppressed this fire. */
  skipped: boolean;
}

function hasActiveCronJob(db: Executor, trigger: Trigger): boolean {
  const row = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, trigger.workspaceId),
        eq(jobs.dedupeKey, `cron:${trigger.id}`),
        inArray(jobs.status, ['pending', 'leased'])
      )
    )
    .limit(1)
    .all()[0];
  return Boolean(row);
}

/**
 * Atomically claim every due cron trigger up to `limit`.
 *
 * The returned rows are exclusively owned by this caller: the conditional update
 * that advances `nextRunAt` is the claim. A concurrent caller either observes the
 * advanced cursor (no longer due) or loses the CAS.
 */
export async function claimDueSchedules(
  db: Executor,
  options: { now?: number; workerId?: string; limit?: number } = {}
): Promise<ClaimedSchedule[]> {
  const now = options.now ?? Date.now();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

  const due = db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.type, 'cron'),
        eq(triggers.enabled, true),
        isNull(triggers.archivedAt),
        lte(triggers.nextRunAt, now)
      )
    )
    .orderBy(asc(triggers.nextRunAt), asc(triggers.id))
    .limit(limit)
    .all();

  const claimed: ClaimedSchedule[] = [];
  for (const trigger of due) {
    const scheduledFor = trigger.nextRunAt;
    if (scheduledFor === null) continue;
    const config = (trigger.config ?? {}) as CronTriggerConfig;

    let nextRunAt: number;
    try {
      nextRunAt = computeNextRun(config.expression, config.timezone, now);
    } catch {
      // A persisted schedule should already be valid; if it is not, skip it
      // instead of wedging the scheduler in a retry loop every tick.
      continue;
    }

    const skipped = config.skipIfRunning ? hasActiveCronJob(db, trigger) : false;

    const updated = db
      .update(triggers)
      .set({
        nextRunAt,
        lastFiredAt: skipped ? trigger.lastFiredAt : now,
        fireCount: skipped ? trigger.fireCount : sql`${triggers.fireCount} + 1`,
        lastError: skipped ? trigger.lastError : null,
        updatedAt: now
      })
      .where(
        and(
          eq(triggers.id, trigger.id),
          // Compare-and-swap: the cursor must still be what we observed.
          eq(triggers.nextRunAt, scheduledFor),
          eq(triggers.enabled, true),
          isNull(triggers.archivedAt)
        )
      )
      .returning()
      .all()[0];

    // Zero rows means another scheduler won the race; this call made no claim.
    if (!updated) continue;
    claimed.push({ trigger: updated, scheduledFor, nextRunAt, skipped });
  }
  return claimed;
}

export interface ScheduledTriggerFire {
  triggerId: string;
  eventId: string | null;
  jobId: string | null;
  scheduledFor: number;
  nextRunAt: number;
  skipped: boolean;
  duplicate: boolean;
}

/**
 * Claim due schedules and enqueue one durable `trigger.cron` job per fire. Each
 * fire becomes a `trigger_events` row so cron shares the webhook processing path,
 * and the event's idempotency key includes the scheduled instant so a replay of
 * the same slot can never create a second ticket.
 */
export async function scheduleDueTriggers(
  db: Executor,
  options: { now?: number; limit?: number; workerId?: string } = {}
): Promise<ScheduledTriggerFire[]> {
  const now = options.now ?? Date.now();
  // Close any persist→enqueue gap from a previous crash before scheduling more.
  // A short grace period avoids racing a webhook that is mid-enqueue right now.
  await recoverPendingTriggerEvents(db, { now, limit: 25, olderThanMs: 30_000 });

  const claimed = await claimDueSchedules(db, {
    now,
    limit: options.limit,
    workerId: options.workerId
  });

  const fires: ScheduledTriggerFire[] = [];
  for (const claim of claimed) {
    const base = {
      triggerId: claim.trigger.id,
      scheduledFor: claim.scheduledFor,
      nextRunAt: claim.nextRunAt
    };
    if (claim.skipped) {
      fires.push({ ...base, eventId: null, jobId: null, skipped: true, duplicate: false });
      continue;
    }

    const idempotencyKey = `cron:${claim.trigger.id}:${claim.scheduledFor}`;
    const eventResult = await withTransaction(db, (tx) => {
      const result = insertTriggerEvent(tx, {
        workspaceId: claim.trigger.workspaceId,
        triggerId: claim.trigger.id,
        idempotencyKey,
        source: 'cron',
        payload: redactTriggerPayload({
          triggerId: claim.trigger.id,
          scheduledFor: claim.scheduledFor,
          firedAt: now
        }),
        payloadBytes: 0,
        receivedAt: now
      });
      writeAudit(tx, {
        workspaceId: claim.trigger.workspaceId,
        action: result.duplicate ? AuditActions.triggerDuplicate : AuditActions.triggerReceived,
        actorType: 'system',
        entityType: 'trigger_event',
        entityId: result.event.id,
        workflowId: claim.trigger.workflowId,
        summary: result.duplicate
          ? `Cron slot ${claim.scheduledFor} was already received`
          : `Cron trigger "${claim.trigger.name}" fired`,
        data: {
          triggerId: claim.trigger.id,
          scheduledFor: claim.scheduledFor,
          duplicate: result.duplicate
        },
        occurredAt: now
      });
      return result;
    });

    if (eventResult.duplicate) {
      fires.push({
        ...base,
        eventId: eventResult.event.id,
        jobId: eventResult.event.jobId,
        skipped: false,
        duplicate: true
      });
      continue;
    }

    const job = await enqueueTriggerJob(db, {
      workspaceId: claim.trigger.workspaceId,
      triggerId: claim.trigger.id,
      eventId: eventResult.event.id,
      type: 'trigger.cron',
      dedupeKey: triggerJobDedupeKey(claim.trigger, eventResult.event.id),
      source: 'cron'
    });
    attachJobToEvent(db, eventResult.event.id, job.id);

    fires.push({
      ...base,
      eventId: eventResult.event.id,
      jobId: job.id,
      skipped: false,
      duplicate: false
    });
  }
  return fires;
}
