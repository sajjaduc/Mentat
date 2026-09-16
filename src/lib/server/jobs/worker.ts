/**
 * Worker runtime.
 *
 * A single `startWorker()` call is enough to run Mentat locally: it leases jobs,
 * executes them with a bounded concurrency, heartbeats long-running work and
 * reaps expired leases. It is deliberately in-process with the HTTP server (there
 * is no external queue in V1) but is written so that a second process can run the
 * same code against the same database without coordination beyond the lease.
 *
 * The worker never crashes the process: a handler failure is recorded on the job
 * and the loop continues. Cancellation is cooperative through `AbortSignal`.
 */

import { env } from '../config/env';
import { isAppError, toAppError } from '../core/errors';
import { moduleLogger } from '../core/logger';
import type { Executor } from '../db/client';
import { type JobHandlerContext, requireJobHandler } from './handlers';
import { type JobQueue, type LeasedJob, SqliteJobQueue } from './queue';

export interface WorkerOptions {
  db: Executor;
  workerId?: string;
  concurrency?: number;
  pollMs?: number;
  leaseSeconds?: number;
  queue?: string;
  /** Restrict this worker to one workspace. */
  workspaceId?: string;
  /** Stop after this many milliseconds with no work. Test/one-shot use. */
  idleTimeoutMs?: number;
  /** Run at most this many jobs then return. Test/one-shot use. */
  maxJobs?: number;
  onJobFinished?: (info: { job: LeasedJob; ok: boolean; error?: string }) => void;
}

export interface WorkerHandle {
  workerId: string;
  /** Resolves when the loop stops (idle timeout, maxJobs reached or abort). */
  done: Promise<void>;
  stop(): Promise<void>;
  /** Number of jobs processed so far. */
  processed(): number;
}

export function createWorkerId(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runWorker(options: WorkerOptions): Promise<WorkerHandle> {
  const workerId = options.workerId ?? createWorkerId();
  const concurrency = Math.max(1, options.concurrency ?? env().MENTAT_WORKER_CONCURRENCY);
  const pollMs = Math.max(25, options.pollMs ?? env().MENTAT_WORKER_POLL_MS);
  const leaseSeconds = options.leaseSeconds ?? env().MENTAT_JOB_LEASE_SECONDS;
  const queue: JobQueue = new SqliteJobQueue(options.db);
  const log = moduleLogger('jobs.worker', { workerId });

  const controller = new AbortController();
  let stopped = false;
  let processed = 0;
  let idleSince = Date.now();
  let inFlight = 0;

  const inFlightJobs = new Set<AbortController>();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    for (const jobController of inFlightJobs) jobController.abort();
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const reap = async () => {
    try {
      const reaped = await queue.reapExpiredLeases();
      if (reaped > 0) log.warn('recovered expired leases', { count: reaped });
    } catch (error) {
      log.error('lease reaping failed', { error });
    }
  };

  const execute = async (job: LeasedJob): Promise<void> => {
    const jobController = new AbortController();
    inFlightJobs.add(jobController);
    inFlight += 1;
    const startedAt = Date.now();

    const context: JobHandlerContext = {
      job,
      db: options.db,
      workerId,
      signal: jobController.signal,
      heartbeat: async (extraSeconds = leaseSeconds) => {
        await queue.extendLease(job.id, workerId, extraSeconds);
      }
    };

    try {
      const handler = requireJobHandler(job.type);
      log.debug('job started', { jobId: job.id, type: job.type, attempt: job.attempts });
      const outcome = (await handler(context)) ?? {};

      if (outcome.skipRetry && outcome.result === undefined) {
        await queue.complete(job.id, { skipped: true });
      } else {
        await queue.complete(job.id, outcome.result ?? null);
      }
      processed += 1;
      options.onJobFinished?.({ job, ok: true });
      log.debug('job completed', { jobId: job.id, type: job.type, ms: Date.now() - startedAt });
    } catch (error) {
      const appError = toAppError(error);
      const retryable = isAppError(error) ? appError.retryable : !jobController.signal.aborted;
      const outcome = await queue.fail(job.id, {
        error: appError,
        errorCode: appError.code,
        retryable
      });
      processed += 1;
      options.onJobFinished?.({ job, ok: false, error: appError.message });
      log.warn('job failed', {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        code: appError.code,
        willRetry: outcome.willRetry,
        error: appError.message
      });
    } finally {
      inFlightJobs.delete(jobController);
      inFlight -= 1;
    }
  };

  const loop = async () => {
    const pending: Promise<void>[] = [];
    let lastReap = Date.now();

    while (!stopped) {
      if (options.maxJobs !== undefined && processed >= options.maxJobs && inFlight === 0) break;
      if (options.idleTimeoutMs !== undefined && Date.now() - idleSince > options.idleTimeoutMs)
        break;

      if (Date.now() - lastReap > 5_000) {
        lastReap = Date.now();
        await reap();
      }

      if (inFlight >= concurrency) {
        await sleep(pollMs);
        continue;
      }

      let job: LeasedJob | null = null;
      try {
        job = await queue.lease({
          workerId,
          queue: options.queue ?? 'default',
          workspaceId: options.workspaceId,
          leaseSeconds
        });
      } catch (error) {
        log.error('lease attempt failed', { error });
        await sleep(pollMs * 2);
        continue;
      }

      if (!job) {
        if (pending.length > 0) {
          await Promise.race(pending);
          continue;
        }
        await sleep(pollMs);
        continue;
      }

      idleSince = Date.now();
      const promise = execute(job).finally(() => {
        const index = pending.indexOf(promise);
        if (index >= 0) pending.splice(index, 1);
      });
      pending.push(promise);
    }

    await Promise.allSettled(pending);
  };

  const done = loop().catch((error) => {
    log.error('worker loop crashed', { error });
  });

  return {
    workerId,
    done,
    stop,
    processed: () => processed
  };
}

/**
 * Drain the queue completely then stop. Used by tests, CLI one-shots and the
 * `bun run worker --once` maintenance path.
 */
export async function drainQueue(
  options: WorkerOptions & { maxJobs?: number } = { db: undefined as never }
): Promise<number> {
  const handle = await runWorker({
    ...options,
    concurrency: options.concurrency ?? 1,
    maxJobs: options.maxJobs ?? 10_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 50
  });
  await handle.done;
  return handle.processed();
}
