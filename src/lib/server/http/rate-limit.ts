/**
 * Service-level rate limiting.
 *
 * Third-party APIs enforce request and concurrency budgets; a workflow that fans out
 * to an integration must respect them or it will be throttled (or banned). Mentat
 * applies the limit at the *service* boundary, keyed by `(workspaceId, serviceId)`, so
 * two workspaces that happen to use the same integration never share a budget and one
 * tenant cannot exhaust another's allowance.
 *
 * The default implementation is a portable in-process token bucket plus a concurrency
 * gate. That is the right default for the single-process local deployment (ADR-0016),
 * but it is deliberately behind the `RateLimiter` interface: a PostgreSQL-backed
 * implementation using advisory locks can replace it without touching the runtime.
 *
 * Under the limit, `acquire()` waits rather than failing, because a short wait is
 * usually cheaper than a failed step. A *bounded* budget keeps that from becoming an
 * unbounded stall: when the projected wait exceeds the budget the call fails with the
 * `rate_limited` code, which the job queue already knows how to retry.
 */
import { AppError } from '../core/errors';
import type { RateLimitConfig } from '../db/schema';

export interface RateLimiterKey {
  workspaceId: string;
  serviceId: string;
}

export interface RateLimitLease {
  /** Frees the concurrency slot. Idempotent. */
  release(): void;
  /** How long the caller waited before the slot was granted. */
  waitedMs: number;
}

export interface AcquireRateLimitOptions {
  config?: RateLimitConfig | null;
  /** Overrides the limiter's default wait budget for this call. */
  maxWaitMs?: number;
  signal?: AbortSignal;
}

/** Implemented by both the in-process limiter and a future PostgreSQL limiter. */
export interface RateLimiter {
  acquire(key: RateLimiterKey, options?: AcquireRateLimitOptions): Promise<RateLimitLease>;
}

export interface InProcessRateLimiterOptions {
  /** Injectable clock/sleep so token-bucket math is testable without real waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  /** Cap on remembered buckets; the least-recently-used idle buckets are evicted. */
  maxTrackedKeys?: number;
}

interface NormalizedConfig {
  capacity: number;
  refillPerMs: number;
  concurrency: number;
}

interface BucketState extends NormalizedConfig {
  tokens: number;
  lastRefill: number;
  lastUsed: number;
  inFlight: number;
  waiters: Array<() => void>;
}

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_MAX_TRACKED_KEYS = 5_000;

export class InProcessRateLimiter implements RateLimiter {
  private readonly states = new Map<string, BucketState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly maxTrackedKeys: number;

  constructor(options: InProcessRateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  /** Number of remembered buckets; exposed for observability and tests. */
  trackedKeyCount(): number {
    return this.states.size;
  }

  async acquire(
    key: RateLimiterKey,
    options: AcquireRateLimitOptions = {}
  ): Promise<RateLimitLease> {
    const normalized = normalizeConfig(options.config);
    if (!normalized) return { release: () => {}, waitedMs: 0 };

    const stateKey = `${key.workspaceId}:${key.serviceId}:${signature(normalized)}`;
    const state = this.states.get(stateKey) ?? createState(normalized, this.now());
    state.lastUsed = this.now();
    this.states.set(stateKey, state);
    this.prune();
    const startedAt = this.now();
    const maxWaitMs = options.maxWaitMs ?? this.maxWaitMs;

    while (true) {
      if (options.signal?.aborted) {
        throw new AppError('timeout', 'Rate limit wait was aborted', { retryable: true });
      }

      refill(state, this.now());

      if (state.inFlight >= state.concurrency) {
        const remaining = maxWaitMs - (this.now() - startedAt);
        if (remaining <= 0) {
          throw rateLimitedError('Rate limit wait budget exceeded', {
            reason: 'concurrency',
            retryAfterMs: 1
          });
        }
        const woke = await this.waitForRelease(state, remaining);
        if (!woke) {
          throw rateLimitedError('Rate limit wait budget exceeded', {
            reason: 'concurrency',
            retryAfterMs: 1
          });
        }
        continue;
      }

      if (state.tokens < 1) {
        const waitMs = Math.ceil((1 - state.tokens) / state.refillPerMs);
        if (this.now() - startedAt + waitMs > maxWaitMs) {
          throw rateLimitedError('Rate limit wait budget exceeded', {
            reason: 'requests',
            retryAfterMs: waitMs
          });
        }
        await this.sleep(Math.max(1, waitMs));
        continue;
      }

      state.tokens -= 1;
      state.inFlight += 1;
      const waitedMs = this.now() - startedAt;
      let released = false;
      return {
        waitedMs,
        release: () => {
          if (released) return;
          released = true;
          state.inFlight = Math.max(0, state.inFlight - 1);
          wakeWaiters(state);
        }
      };
    }
  }

  private waitForRelease(state: BucketState, budgetMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          resolve(false);
        },
        Math.max(1, budgetMs)
      );
      state.waiters.push(waiter);
    });
  }

  /**
   * Evict the least-recently-used idle buckets once the cap is exceeded. An in-flight
   * bucket is never dropped, because dropping it would forget a live concurrency slot
   * and reopen the gate it is holding shut.
   */
  private prune(): void {
    if (this.states.size <= this.maxTrackedKeys) return;
    const entries = [...this.states.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, state] of entries) {
      if (this.states.size <= this.maxTrackedKeys) break;
      if (state.inFlight === 0 && state.waiters.length === 0) this.states.delete(key);
    }
  }
}

export function createRateLimiter(options: InProcessRateLimiterOptions = {}): RateLimiter {
  return new InProcessRateLimiter(options);
}

function normalizeConfig(config: RateLimitConfig | null | undefined): NormalizedConfig | null {
  if (!config) return null;
  const requests = config.requests;
  if (requests === undefined || !Number.isFinite(requests) || requests <= 0) return null;
  const windowSeconds =
    config.windowSeconds !== undefined && config.windowSeconds > 0
      ? config.windowSeconds
      : DEFAULT_WINDOW_SECONDS;
  const concurrency =
    config.concurrency !== undefined && config.concurrency > 0
      ? Math.floor(config.concurrency)
      : Number.POSITIVE_INFINITY;
  return {
    capacity: requests,
    refillPerMs: requests / (windowSeconds * 1000),
    concurrency
  };
}

function createState(config: NormalizedConfig, now: number): BucketState {
  return {
    ...config,
    tokens: config.capacity,
    lastRefill: now,
    lastUsed: now,
    inFlight: 0,
    waiters: []
  };
}

function refill(state: BucketState, now: number): void {
  const elapsed = now - state.lastRefill;
  if (elapsed <= 0) return;
  state.tokens = Math.min(state.capacity, state.tokens + elapsed * state.refillPerMs);
  state.lastRefill = now;
}

function wakeWaiters(state: BucketState): void {
  const waiters = state.waiters.splice(0, state.waiters.length);
  for (const waiter of waiters) waiter();
}

function signature(config: NormalizedConfig): string {
  return `${config.capacity}:${config.concurrency}:${config.refillPerMs}`;
}

function rateLimitedError(message: string, details: Record<string, unknown>): AppError {
  return new AppError('rate_limited', message, { details, retryable: true });
}
