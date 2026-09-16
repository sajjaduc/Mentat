/**
 * Retry policy for HTTP calls.
 *
 * Retrying is a correctness decision, not a performance tweak: replaying a POST can
 * duplicate a payment, while replaying a GET is free. The default therefore follows
 * HTTP semantics — idempotent methods retry, mutations do not — and a mutation only
 * retries when the operation author explicitly lists the status in `retryPolicy.retryOn`
 * or the caller opts in.
 *
 * Backoff is delegated to `backoffDelayMs` in core/clock (exponential with full
 * jitter) so HTTP retries and job retries share one implementation. `Retry-After`,
 * when present and honoured, wins over backoff because the server knows better.
 */
import { backoffDelayMs } from '../core/clock';
import type { HttpMethod, RetryPolicy } from '../db/schema';

/** Methods that may be replayed without changing the server's intent. */
export const RETRYABLE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS'
]);

/** Transient statuses that justify another attempt. */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504
]);

/** Attempts applied to an idempotent method when no policy is configured. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Upper bound applied to a server-supplied Retry-After. */
export const MAX_RETRY_AFTER_MS = 60_000;

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

export interface RetryDecisionInput {
  method: HttpMethod;
  /** The 1-based attempt that just failed. */
  attempt: number;
  policy?: RetryPolicy | null;
  status?: number | null;
  /** Present for network/transport failures; `retryable` forces a retry. */
  error?: unknown;
  /** The caller (e.g. a Test Request) explicitly allows mutation retries. */
  optIn?: boolean;
}

export function shouldRetry(input: RetryDecisionInput): boolean {
  const { method, attempt, policy, status } = input;
  const idempotent = RETRYABLE_METHODS.has(method);
  const maxAttempts = policy?.maxAttempts ?? (idempotent ? DEFAULT_MAX_ATTEMPTS : 1);
  if (attempt >= maxAttempts) return false;

  const explicitlyListed =
    status !== null && status !== undefined && !!policy?.retryOn?.includes(status);
  const mutationAllowed = idempotent || explicitlyListed || input.optIn === true;

  if (status === null || status === undefined) {
    // Transport failure. A caller-declared retryable error is honoured even for
    // mutations, otherwise mutations stay non-retryable.
    return mutationAllowed || isRetryableError(input.error);
  }

  return mutationAllowed && (RETRYABLE_STATUS_CODES.has(status) || explicitlyListed);
}

/**
 * Parse `Retry-After` into a bounded delay in milliseconds.
 *
 * Accepts both forms from RFC 9110 — delta-seconds and an HTTP-date — and clamps to
 * `maxMs` so a hostile or confused server cannot park a worker for a day.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: number = Date.now(),
  maxMs: number = MAX_RETRY_AFTER_MS
): number | null {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = headerValue.trim();
  if (raw.length === 0) return null;

  if (/^\d+$/.test(raw)) {
    return clamp(Number(raw) * 1000, 0, maxMs);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return clamp(Number(raw) * 1000, 0, maxMs);
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return clamp(timestamp - now, 0, maxMs);
}

export interface RetryDelayInput {
  attempt: number;
  policy?: RetryPolicy | null;
  retryAfterMs?: number | null;
  random?: () => number;
}

/** Compute the delay before the next attempt, preferring a server-supplied hint. */
export function retryDelayMs(input: RetryDelayInput): number {
  const { policy } = input;
  const honorRetryAfter = policy?.honorRetryAfter ?? true;
  if (honorRetryAfter && input.retryAfterMs !== null && input.retryAfterMs !== undefined) {
    return input.retryAfterMs;
  }
  return backoffDelayMs(input.attempt, {
    baseMs: policy?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxMs: policy?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    jitter: true,
    random: input.random
  });
}

/** True when a thrown value is explicitly marked retryable (AppError or plain object). */
function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined || typeof error !== 'object') return false;
  return (error as { retryable?: unknown }).retryable === true;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
