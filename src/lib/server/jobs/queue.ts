/**
 * Native durable job queue.
 *
 * Mentat does not require Redis, Kafka, Temporal or any external scheduler. Jobs
 * live in the same transactional store as domain data, which is what makes
 * "enqueue subsequent work only after persistence succeeds" actually true: the
 * enqueue happens inside the same transaction as the state change that caused it.
 *
 * ## Leasing model
 *
 * A worker leases a job atomically (`status = 'leased'`, `leasedBy`,
 * `leaseExpiresAt`, `attempts += 1`). If the worker dies, the lease expires and the
 * job becomes leasable again — no external reaper is required for correctness,
 * though `reapExpiredLeases` makes the transition observable and auditable.
 *
 * The claim statement is a single `UPDATE ... WHERE id = (SELECT ... LIMIT 1)`
 * with a re-checked predicate, which is correct on SQLite's single writer and
 * maps directly onto PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` when the
 * deployment grows (see docs/postgres-migration.md).
 */
import { and, desc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { backoffDelayMs } from '../core/clock';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  type Job,
  type JobPayload,
  type JobStatus,
  type JobType,
  jobAttempts,
  jobs
} from '../db/schema';

export interface EnqueueInput {
  workspaceId: string;
  type: JobType;
  payload: JobPayload;
  queue?: string;
  priority?: number;
  maxAttempts?: number;
  /** Absolute epoch ms at which the job becomes leasable. */
  availableAt?: number;
  /** Relative delay from now; ignored when `availableAt` is set. */
  delayMs?: number;
  /** Makes enqueueing the same unit of work idempotent while it is active. */
  dedupeKey?: string;
  idempotencyKey?: string;
  timeoutSeconds?: number;
  ticketId?: string;
  runId?: string;
  parentJobId?: string;
  actorType?: 'user' | 'agent' | 'system' | 'api';
  actorId?: string | null;
  actorLabel?: string | null;
}

export interface LeasedJob extends Job {
  workerId: string;
}

export interface LeaseOptions {
  workerId: string;
  queue?: string;
  /** Restrict leasing to one workspace (used by the local single-tenant worker). */
  workspaceId?: string;
  leaseSeconds?: number;
  now?: number;
}

export interface FailOptions {
  error: unknown;
  errorCode?: string;
  retryable?: boolean;
  now?: number;
  /** Overrides computed backoff (used by tests and Retry-After handling). */
  availableAt?: number;
}

export interface FailOutcome {
  status: Extract<JobStatus, 'pending' | 'failed' | 'dead'>;
  attempts: number;
  availableAt: number | null;
  willRetry: boolean;
}

export interface JobStats {
  pending: number;
  leased: number;
  completed: number;
  failed: number;
  dead: number;
  cancelled: number;
  oldestPendingAt: number | null;
  nextAvailableAt: number | null;
}

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<Job>;
  lease(options: LeaseOptions): Promise<LeasedJob | null>;
  complete(jobId: string, result: unknown, now?: number): Promise<void>;
  fail(jobId: string, options: FailOptions): Promise<FailOutcome>;
  extendLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
    now?: number
  ): Promise<boolean>;
  cancel(jobId: string, reason?: string, now?: number): Promise<boolean>;
  reapExpiredLeases(now?: number): Promise<number>;
  stats(workspaceId?: string): Promise<JobStats>;
}

const ACTIVE_STATUSES: JobStatus[] = ['pending', 'leased'];

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === 'string') return error.slice(0, 1000);
  try {
    return JSON.stringify(error).slice(0, 1000);
  } catch {
    return 'Unknown error';
  }
}

/**
 * SQLite-native queue implementation. PostgreSQL swaps only the lease statement;
 * every other method is dialect-neutral.
 */
export class SqliteJobQueue implements JobQueue {
  constructor(private readonly db: Executor) {}

  async enqueue(input: EnqueueInput): Promise<Job> {
    const now = Date.now();
    const availableAt = input.availableAt ?? now + (input.delayMs ?? 0);

    if (input.dedupeKey) {
      const existing = await this.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.dedupeKey, input.dedupeKey),
            inArray(jobs.status, ACTIVE_STATUSES)
          )
        )
        .limit(1)
        .all();
      if (existing[0]) return existing[0];
    }

    const inserted = await this.db
      .insert(jobs)
      .values({
        workspaceId: input.workspaceId,
        type: input.type,
        queue: input.queue ?? 'default',
        payload: input.payload as never,
        status: 'pending',
        priority: input.priority ?? 0,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 5,
        availableAt,
        timeoutSeconds: input.timeoutSeconds ?? null,
        dedupeKey: input.dedupeKey ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        ticketId: input.ticketId ?? null,
        runId: input.runId ?? null,
        parentJobId: input.parentJobId ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all();

    const job = inserted[0];
    if (!job) throw errors.internal('Failed to enqueue job', { type: input.type });

    writeAudit(this.db, {
      workspaceId: input.workspaceId,
      action: AuditActions.jobEnqueued,
      actorType: input.actorType ?? 'system',
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      entityType: 'job',
      entityId: job.id,
      jobId: job.id,
      ticketId: job.ticketId,
      runId: job.runId,
      summary: `Job ${input.type} enqueued`,
      data: { type: input.type, queue: job.queue, availableAt, dedupeKey: input.dedupeKey ?? null }
    });

    return job;
  }

  async lease(options: LeaseOptions): Promise<LeasedJob | null> {
    const now = options.now ?? Date.now();
    const queue = options.queue ?? 'default';
    const leaseSeconds = options.leaseSeconds ?? 120;
    const leaseExpiresAt = now + leaseSeconds * 1000;

    const workspaceClause: SQL = options.workspaceId
      ? sql`AND ${jobs.workspaceId} = ${options.workspaceId}`
      : sql``;

    const leasable = sql`(
      (${jobs.status} = 'pending')
      OR (${jobs.status} = 'leased' AND ${jobs.leaseExpiresAt} IS NOT NULL AND ${jobs.leaseExpiresAt} <= ${now})
    )`;

    const claimed = await this.db
      .update(jobs)
      .set({
        status: 'leased',
        leasedBy: options.workerId,
        leasedAt: now,
        leaseExpiresAt,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: now
      })
      .where(
        sql`${jobs.id} = (
          SELECT ${jobs.id} FROM ${jobs}
          WHERE ${leasable}
            AND ${jobs.availableAt} <= ${now}
            AND ${jobs.queue} = ${queue}
            ${workspaceClause}
          ORDER BY ${jobs.priority} DESC, ${jobs.availableAt} ASC, ${jobs.createdAt} ASC
          LIMIT 1
        ) AND ${leasable}`
      )
      .returning()
      .all();

    const job = claimed[0];
    if (!job) return null;

    // Record the attempt inside the same statement group so a crash cannot leave
    // an attempt counter without a matching attempt row.
    await this.db
      .insert(jobAttempts)
      .values({
        workspaceId: job.workspaceId,
        jobId: job.id,
        attempt: job.attempts,
        workerId: options.workerId,
        status: 'started',
        startedAt: now
      })
      .onConflictDoNothing()
      .run();

    return { ...job, workerId: options.workerId };
  }

  async complete(jobId: string, result: unknown, now: number = Date.now()): Promise<void> {
    const updated = await this.db
      .update(jobs)
      .set({
        status: 'completed',
        result: result === undefined ? null : (result as never),
        completedAt: now,
        updatedAt: now,
        leasedBy: null,
        leaseExpiresAt: null,
        lastError: null,
        lastErrorCode: null
      })
      .where(eq(jobs.id, jobId))
      .returning()
      .all();
    const job = updated[0];
    if (!job) return;

    await this.finishAttempt(job.id, job.attempts, 'succeeded', now, null, null);
    writeAudit(this.db, {
      workspaceId: job.workspaceId,
      action: AuditActions.jobCompleted,
      entityType: 'job',
      entityId: job.id,
      jobId: job.id,
      ticketId: job.ticketId,
      runId: job.runId,
      summary: `Job ${job.type} completed`,
      data: { attempts: job.attempts },
      occurredAt: now
    });
  }

  async fail(jobId: string, options: FailOptions): Promise<FailOutcome> {
    const now = options.now ?? Date.now();
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).all();
    const job = rows[0];
    if (!job) throw errors.notFound('Job', jobId);

    const message = describeError(options.error);
    const retryable = options.retryable ?? true;
    const exhausted = job.attempts >= job.maxAttempts;
    const willRetry = retryable && !exhausted;

    const availableAt = willRetry
      ? (options.availableAt ??
        now + backoffDelayMs(job.attempts, { baseMs: 2000, maxMs: 15 * 60_000 }))
      : null;

    // `failed` means permanently failed (non-retryable); `dead` means retries were
    // exhausted. Keeping them distinct lets operators filter "needs attention"
    // separately from "this will never work".
    const status: FailOutcome['status'] = willRetry ? 'pending' : retryable ? 'dead' : 'failed';

    const updated = await this.db
      .update(jobs)
      .set({
        status,
        lastError: message,
        lastErrorCode: options.errorCode ?? null,
        availableAt: availableAt ?? job.availableAt,
        leasedBy: null,
        leaseExpiresAt: null,
        updatedAt: now,
        completedAt: willRetry ? null : now
      })
      .where(eq(jobs.id, jobId))
      .returning()
      .all();

    await this.finishAttempt(
      jobId,
      job.attempts,
      'failed',
      now,
      message,
      options.errorCode ?? null
    );

    const finalJob = updated[0];
    const action = willRetry
      ? AuditActions.jobRetryScheduled
      : status === 'dead'
        ? AuditActions.jobDead
        : AuditActions.jobFailed;

    writeAudit(this.db, {
      workspaceId: job.workspaceId,
      action,
      entityType: 'job',
      entityId: jobId,
      jobId,
      ticketId: job.ticketId,
      runId: job.runId,
      summary: willRetry
        ? `Job ${job.type} failed (attempt ${job.attempts}/${job.maxAttempts}); retry scheduled`
        : status === 'dead'
          ? `Job ${job.type} exhausted all ${job.maxAttempts} attempts`
          : `Job ${job.type} failed permanently`,
      data: { error: message, errorCode: options.errorCode ?? null, availableAt },
      occurredAt: now
    });

    return {
      status: (finalJob?.status as FailOutcome['status']) ?? status,
      attempts: job.attempts,
      availableAt,
      willRetry
    };
  }

  async extendLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
    now: number = Date.now()
  ): Promise<boolean> {
    const updated = await this.db
      .update(jobs)
      .set({ leaseExpiresAt: now + leaseSeconds * 1000, updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.leasedBy, workerId), eq(jobs.status, 'leased')))
      .returning({ id: jobs.id })
      .all();
    return updated.length > 0;
  }

  async cancel(jobId: string, reason?: string, now: number = Date.now()): Promise<boolean> {
    const updated = await this.db
      .update(jobs)
      .set({
        status: 'cancelled',
        lastError: reason ?? 'Cancelled',
        leaseExpiresAt: null,
        leasedBy: null,
        updatedAt: now,
        completedAt: now
      })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE_STATUSES)))
      .returning()
      .all();
    const job = updated[0];
    if (!job) return false;
    writeAudit(this.db, {
      workspaceId: job.workspaceId,
      action: AuditActions.jobCancelled,
      entityType: 'job',
      entityId: jobId,
      jobId,
      ticketId: job.ticketId,
      runId: job.runId,
      summary: `Job ${job.type} cancelled`,
      data: { reason: reason ?? null },
      occurredAt: now
    });
    return true;
  }

  /**
   * Flip expired leases back to `pending` and mark their attempt rows. Leasing
   * already tolerates expired leases; this makes the recovery visible in history
   * and bounds how long a dead worker's attempt row stays open.
   */
  async reapExpiredLeases(now: number = Date.now()): Promise<number> {
    const expired = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'leased'), lte(jobs.leaseExpiresAt, now)))
      .all();

    const recoverable = expired;
    for (const job of recoverable) {
      await this.db
        .update(jobs)
        .set({ status: 'pending', leasedBy: null, leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'leased')))
        .run();
      await this.db
        .update(jobAttempts)
        .set({
          status: 'lease_expired',
          finishedAt: now,
          durationMs: now - job.leasedAt!,
          error: 'Lease expired before the worker reported completion'
        })
        .where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.attempt, job.attempts)))
        .run();
      writeAudit(this.db, {
        workspaceId: job.workspaceId,
        action: AuditActions.jobLeaseExpired,
        entityType: 'job',
        entityId: job.id,
        jobId: job.id,
        ticketId: job.ticketId,
        runId: job.runId,
        summary: `Job ${job.type} lease expired; returned to the queue`,
        data: { attempt: job.attempts },
        occurredAt: now
      });
    }
    return recoverable.length;
  }

  async stats(workspaceId?: string): Promise<JobStats> {
    const where: SQL | undefined = workspaceId ? eq(jobs.workspaceId, workspaceId) : undefined;
    const rows = await this.db
      .select({ status: jobs.status, count: sql<number>`count(*)` })
      .from(jobs)
      .where(where)
      .groupBy(jobs.status)
      .all();

    const stats: JobStats = {
      pending: 0,
      leased: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      cancelled: 0,
      oldestPendingAt: null,
      nextAvailableAt: null
    };
    for (const row of rows) {
      stats[row.status] = row.count;
    }

    const oldest = await this.db
      .select({ createdAt: jobs.createdAt })
      .from(jobs)
      .where(
        workspaceId
          ? and(eq(jobs.status, 'pending'), eq(jobs.workspaceId, workspaceId))
          : eq(jobs.status, 'pending')
      )
      .orderBy(jobs.createdAt)
      .limit(1)
      .all();
    stats.oldestPendingAt = oldest[0]?.createdAt ?? null;

    const next = await this.db
      .select({ availableAt: jobs.availableAt })
      .from(jobs)
      .where(
        workspaceId
          ? and(eq(jobs.status, 'pending'), eq(jobs.workspaceId, workspaceId))
          : eq(jobs.status, 'pending')
      )
      .orderBy(jobs.availableAt)
      .limit(1)
      .all();
    stats.nextAvailableAt = next[0]?.availableAt ?? null;

    return stats;
  }

  private async finishAttempt(
    jobId: string,
    attempt: number,
    status: 'succeeded' | 'failed',
    now: number,
    error: string | null,
    errorCode: string | null
  ): Promise<void> {
    const rows = await this.db
      .select({ startedAt: jobAttempts.startedAt })
      .from(jobAttempts)
      .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.attempt, attempt)))
      .limit(1)
      .all();
    const startedAt = rows[0]?.startedAt ?? now;
    await this.db
      .update(jobAttempts)
      .set({ status, finishedAt: now, durationMs: now - startedAt, error, errorCode })
      .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.attempt, attempt)))
      .run();
  }
}

/** List jobs for the operator view, newest first. */
export async function listJobs(
  db: Executor,
  options: {
    workspaceId?: string;
    status?: JobStatus[];
    type?: JobType;
    ticketId?: string;
    runId?: string;
    limit?: number;
  } = {}
): Promise<Job[]> {
  const conditions: SQL[] = [];
  if (options.workspaceId) conditions.push(eq(jobs.workspaceId, options.workspaceId));
  if (options.status && options.status.length > 0)
    conditions.push(inArray(jobs.status, options.status));
  if (options.type) conditions.push(eq(jobs.type, options.type));
  if (options.ticketId) conditions.push(eq(jobs.ticketId, options.ticketId));
  if (options.runId) conditions.push(eq(jobs.runId, options.runId));
  return db
    .select()
    .from(jobs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(jobs.createdAt))
    .limit(Math.min(options.limit ?? 100, 500))
    .all();
}

export async function getJobAttempts(db: Executor, jobId: string) {
  return db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId))
    .orderBy(jobAttempts.attempt)
    .all();
}
