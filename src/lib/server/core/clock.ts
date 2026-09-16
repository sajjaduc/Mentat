/**
 * Time handling.
 *
 * All persistence timestamps are UTC. We store epoch milliseconds as integers so
 * that ordering and arithmetic are dialect-independent (SQLite has no real
 * timestamp type and PostgreSQL round-trips are avoided entirely).
 */

import { CronExpressionParser } from 'cron-parser';

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now()
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function fromMs(ms: number): Date {
  return new Date(ms);
}

export function toIso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function addMs(base: number, delta: number): number {
  return base + delta;
}

/** Exponential backoff with full jitter, capped. Used by the job queue and HTTP retries. */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; jitter?: boolean; random?: () => number } = {}
): number {
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 5 * MINUTE;
  const jitter = options.jitter ?? true;
  const random = options.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  if (!jitter) return exponential;
  // Full jitter: random between the base slice and the exponential ceiling keeps
  // thundering herds apart while guaranteeing an eventual attempt.
  const floor = Math.min(exponential, baseMs);
  return Math.round(floor + random() * (exponential - floor));
}

/** Human/agent friendly relative duration such as "3h 12m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Deterministic next-run calculation for cron schedules.
 *
 * `cron-parser` is timezone aware through the IANA database. This wrapper keeps
 * the scheduler free of ad-hoc date math and makes the behaviour testable with an
 * injected reference time.
 */
export function nextCronRun(
  expression: string,
  options: { from?: number; timezone?: string } = {}
): number {
  const from = options.from ?? Date.now();
  const interval = CronExpressionParser.parse(expression, {
    currentDate: new Date(from),
    tz: options.timezone ?? 'UTC'
  });
  return interval.next().getTime();
}

/** Validate a cron expression, returning a human-readable problem when invalid. */
export function validateCron(
  expression: string,
  timezone = 'UTC'
): { valid: true; next: number } | { valid: false; error: string } {
  try {
    return { valid: true, next: nextCronRun(expression, { timezone }) };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron expression'
    };
  }
}
