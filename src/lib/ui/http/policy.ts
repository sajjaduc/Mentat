/**
 * Policy defaults, effective values and plain-language explanations.
 *
 * The HTTP editor deliberately exposes the same policy objects the runtime reads.
 * Putting the defaults and the "where does this value come from" logic here means
 * the service tab and the operation tab cannot disagree about what will actually be
 * enforced — and the plain-language helpers are what let the UI explain a policy
 * without the user having to read the runtime.
 */

import type { ApprovalPolicy, CachePolicy, RateLimitConfig, RetryPolicy } from './types';

/** Methods the runtime retries by default (idempotent methods only). */
export const DEFAULT_RETRYABLE_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'] as const;

/** Transient statuses the runtime retries by default. */
export const DEFAULT_RETRYABLE_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504] as const;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 30_000;
export const DEFAULT_SERVICE_TIMEOUT_MS = 15_000;

export function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    retryOn: [...DEFAULT_RETRYABLE_STATUS_CODES],
    honorRetryAfter: true
  };
}

export function defaultCachePolicy(): CachePolicy {
  return { enabled: false, ttlSeconds: 300, read: true, varyOn: [] };
}

export function defaultApprovalPolicy(): ApprovalPolicy {
  return { mode: 'never', condition: '', reason: '' };
}

export function defaultRateLimit(): RateLimitConfig {
  return { requests: 60, windowSeconds: 60, concurrency: 4 };
}

export function describeRetryPolicy(policy: RetryPolicy | null | undefined): string {
  if (!policy) {
    return `No override: idempotent methods retry up to ${DEFAULT_MAX_ATTEMPTS} times; mutations do not retry.`;
  }
  const parts = [`Up to ${policy.maxAttempts} attempt(s)`];
  if (policy.baseDelayMs !== undefined) parts.push(`from ${policy.baseDelayMs}ms`);
  if (policy.maxDelayMs !== undefined) parts.push(`capped at ${policy.maxDelayMs}ms`);
  if (policy.honorRetryAfter !== false) parts.push('honours Retry-After');
  return parts.join(', ');
}

export function describeCachePolicy(policy: CachePolicy | null | undefined): string {
  if (!policy?.enabled) return 'Caching is off for this operation.';
  const parts: string[] = [];
  parts.push(
    policy.read === false ? 'writes the cache but never reads it' : 'reads and writes the cache'
  );
  parts.push(
    policy.ttlSeconds === undefined ? 'no TTL (entries do not expire)' : `TTL ${policy.ttlSeconds}s`
  );
  if (policy.varyOn && policy.varyOn.length > 0)
    parts.push(`varying on ${policy.varyOn.join(', ')}`);
  return `${parts.join('; ')}. Only GET/HEAD responses participate.`;
}

export function describeApprovalPolicy(policy: ApprovalPolicy | null | undefined): string {
  if (!policy || policy.mode === 'never') return 'Runs without approval.';
  if (policy.mode === 'always') return 'Every call pauses for human approval.';
  const condition = policy.condition?.trim();
  return condition
    ? `Requires approval when ${condition} (an unreadable condition fails closed).`
    : 'Requires approval because the condition is empty, which fails closed.';
}

export function describeRateLimit(limit: RateLimitConfig | null | undefined): string {
  if (!limit) return 'No service-level rate limit configured.';
  const parts: string[] = [];
  if (limit.requests !== undefined && limit.windowSeconds !== undefined) {
    parts.push(`${limit.requests} requests / ${limit.windowSeconds}s`);
  } else if (limit.requests !== undefined) {
    parts.push(`${limit.requests} requests per window`);
  }
  if (limit.concurrency !== undefined) parts.push(`max ${limit.concurrency} in flight`);
  return parts.length > 0 ? `${parts.join('; ')}.` : 'No service-level rate limit configured.';
}

/**
 * Effective policy: the operation's own policy wins, then the service default.
 * Mirrors the runtime so the editor can label a value "inherited" honestly.
 */
export function effectivePolicy<T>(
  operationValue: T | null | undefined,
  serviceValue: T | null | undefined
): { value: T | null; inherited: boolean } {
  if (operationValue !== null && operationValue !== undefined) {
    return { value: operationValue, inherited: false };
  }
  if (serviceValue !== null && serviceValue !== undefined) {
    return { value: serviceValue, inherited: true };
  }
  return { value: null, inherited: false };
}
