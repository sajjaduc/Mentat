import { describe, expect, test } from 'bun:test';
import { backoffDelayMs } from '../../../src/lib/server/core/clock';
import type { RetryPolicy } from '../../../src/lib/server/db/schema';
import {
  parseRetryAfter,
  RETRYABLE_STATUS_CODES,
  retryDelayMs,
  shouldRetry
} from '../../../src/lib/server/http/retry';

const policy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 3,
  ...overrides
});

describe('shouldRetry: methods', () => {
  test('retries an idempotent GET on a retryable status', () => {
    expect(shouldRetry({ method: 'GET', attempt: 1, policy: policy(), status: 503 })).toBe(true);
    expect(shouldRetry({ method: 'HEAD', attempt: 1, policy: policy(), status: 502 })).toBe(true);
    expect(shouldRetry({ method: 'PUT', attempt: 1, policy: policy(), status: 500 })).toBe(true);
    expect(shouldRetry({ method: 'DELETE', attempt: 1, policy: policy(), status: 429 })).toBe(true);
    expect(shouldRetry({ method: 'OPTIONS', attempt: 1, policy: policy(), status: 408 })).toBe(
      true
    );
  });

  test('never retries a non-retryable status', () => {
    expect(shouldRetry({ method: 'GET', attempt: 1, policy: policy(), status: 400 })).toBe(false);
    expect(shouldRetry({ method: 'GET', attempt: 1, policy: policy(), status: 404 })).toBe(false);
    expect(shouldRetry({ method: 'GET', attempt: 1, policy: policy(), status: 422 })).toBe(false);
  });

  test('does not retry a POST by default', () => {
    expect(shouldRetry({ method: 'POST', attempt: 1, policy: policy(), status: 503 })).toBe(false);
    expect(shouldRetry({ method: 'PATCH', attempt: 1, policy: policy(), status: 500 })).toBe(false);
  });

  test('retries a POST when retryOn explicitly lists the status', () => {
    expect(
      shouldRetry({ method: 'POST', attempt: 1, policy: policy({ retryOn: [503] }), status: 503 })
    ).toBe(true);
    expect(
      shouldRetry({ method: 'POST', attempt: 1, policy: policy({ retryOn: [429] }), status: 503 })
    ).toBe(false);
  });

  test('retries a POST when the caller opts in', () => {
    expect(
      shouldRetry({ method: 'POST', attempt: 1, policy: policy(), status: 503, optIn: true })
    ).toBe(true);
  });

  test('stops once maxAttempts is reached', () => {
    expect(shouldRetry({ method: 'GET', attempt: 3, policy: policy(), status: 503 })).toBe(false);
    expect(shouldRetry({ method: 'GET', attempt: 2, policy: policy(), status: 503 })).toBe(true);
  });

  test('defaults to retrying idempotent methods three times without a policy', () => {
    expect(shouldRetry({ method: 'GET', attempt: 1, status: 503 })).toBe(true);
    expect(shouldRetry({ method: 'GET', attempt: 3, status: 503 })).toBe(false);
    expect(shouldRetry({ method: 'POST', attempt: 1, status: 503 })).toBe(false);
  });
});

describe('shouldRetry: network errors', () => {
  test('retries a network error for an idempotent method', () => {
    expect(shouldRetry({ method: 'GET', attempt: 1, policy: policy() })).toBe(true);
    expect(shouldRetry({ method: 'GET', attempt: 1, status: null, policy: policy() })).toBe(true);
  });

  test('does not retry a network error for POST unless opted in', () => {
    expect(shouldRetry({ method: 'POST', attempt: 1, policy: policy() })).toBe(false);
    expect(shouldRetry({ method: 'POST', attempt: 1, policy: policy(), optIn: true })).toBe(true);
  });

  test('a retryable error flag can force a retry for a mutation', () => {
    expect(
      shouldRetry({ method: 'POST', attempt: 1, policy: policy(), error: { retryable: true } })
    ).toBe(true);
  });
});

describe('Retry-After parsing', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  test('parses a delta in seconds', () => {
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  test('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });

  test('clamps a date in the past to zero', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now + 10_000)).toBe(0);
  });

  test('clamps an enormous delta to the maximum', () => {
    expect(parseRetryAfter('999999', now, 60_000)).toBe(60_000);
  });

  test('returns null for absent or invalid values', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('-5', now)).toBe(0);
  });
});

describe('retryDelayMs', () => {
  test('uses deterministic exponential backoff when jitter is disabled', () => {
    expect(backoffDelayMs(1, { baseMs: 1000, maxMs: 5000, jitter: false })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000, maxMs: 5000, jitter: false })).toBe(4000);
    expect(backoffDelayMs(10, { baseMs: 1000, maxMs: 5000, jitter: false })).toBe(5000);
  });

  test('honours Retry-After ahead of exponential backoff', () => {
    expect(retryDelayMs({ attempt: 1, policy: policy(), retryAfterMs: 2500 })).toBe(2500);
  });

  test('ignores Retry-After when the policy disables it', () => {
    const delay = retryDelayMs({
      attempt: 1,
      policy: policy({ honorRetryAfter: false, baseDelayMs: 10, maxDelayMs: 10 }),
      retryAfterMs: 2500,
      random: () => 0
    });
    expect(delay).toBe(10);
  });

  test('caps the backoff at maxDelayMs', () => {
    expect(
      retryDelayMs({
        attempt: 10,
        policy: policy({ baseDelayMs: 10, maxDelayMs: 50 }),
        random: () => 1
      })
    ).toBe(50);
  });
});

describe('RETRYABLE_STATUS_CODES', () => {
  test('contains the transient gateway and throttling statuses', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(RETRYABLE_STATUS_CODES.has(status)).toBe(true);
    }
    expect(RETRYABLE_STATUS_CODES.has(200)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(401)).toBe(false);
  });
});
