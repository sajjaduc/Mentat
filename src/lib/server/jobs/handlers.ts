/**
 * Job handler registry.
 *
 * Each durable job type has exactly one handler, registered at bootstrap. Keeping
 * registration explicit (rather than filesystem discovery) means the set of work
 * a worker can perform is auditable in one place and a missing handler fails
 * loudly instead of silently retrying forever.
 */

import { errors } from '../core/errors';
import { moduleLogger } from '../core/logger';
import type { Executor } from '../db/client';
import type { Job, JobPayload, JobType } from '../db/schema';

export interface JobHandlerContext {
  job: Job;
  db: Executor;
  /** Worker identity, used for lease extension and attempt attribution. */
  workerId: string;
  /** Extend the lease when a handler is legitimately long-running. */
  heartbeat(extraSeconds?: number): Promise<void>;
  signal: AbortSignal;
}

export interface JobHandlerResult {
  /** Persisted on the job row for operator visibility. */
  result?: unknown;
  /** Overrides the default: a handler may ask for a delayed retry. */
  retryAfterMs?: number;
  /**
   * When true, the outcome is not counted as a failure even though the handler
   * reported one (used for "duplicate delivery, already handled").
   */
  skipRetry?: boolean;
}

export type JobHandler = (context: JobHandlerContext) => Promise<JobHandlerResult | undefined>;

const handlers = new Map<string, JobHandler>();
const log = moduleLogger('jobs.handlers');

export function registerJobHandler(type: JobType, handler: JobHandler): void {
  if (handlers.has(type)) {
    throw new Error(`Duplicate job handler registration for ${type}`);
  }
  handlers.set(type, handler);
}

export function replaceJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export function requireJobHandler(type: string): JobHandler {
  const handler = handlers.get(type);
  if (!handler) {
    throw errors.unsupported(`No handler registered for job type "${type}"`, { type });
  }
  return handler;
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()].sort();
}

export function clearJobHandlers(): void {
  handlers.clear();
}

/** Convenience for handlers that only need the payload. */
export function payloadOf<T extends JobPayload>(job: Job): T {
  const payload = job.payload as T | null;
  if (!payload || typeof payload !== 'object') {
    throw errors.validation(`Job ${job.id} (${job.type}) has no payload object`);
  }
  return payload;
}

/** Report a non-retryable failure from a handler. */
export function permanentFailure(message: string, code = 'permanent_failure'): Error {
  return errors.internal(message, { code, retryable: false });
}

export const jobHandlers = {
  register: registerJobHandler,
  get: getJobHandler,
  has: (type: string) => handlers.has(type),
  types: registeredJobTypes,
  clear: clearJobHandlers,
  log
};
