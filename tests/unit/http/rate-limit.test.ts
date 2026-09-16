import { describe, expect, test } from 'bun:test';
import {
  createRateLimiter,
  InProcessRateLimiter,
  type RateLimiterKey
} from '../../../src/lib/server/http/rate-limit';

const keyA: RateLimiterKey = { workspaceId: 'ws-a', serviceId: 'service-1' };
const keyOtherService: RateLimiterKey = { workspaceId: 'ws-a', serviceId: 'service-2' };
const keyOtherWorkspace: RateLimiterKey = { workspaceId: 'ws-b', serviceId: 'service-1' };

describe('rate limiter: token bucket', () => {
  test('waits for the refill window instead of failing when bounded', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new InProcessRateLimiter({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      maxWaitMs: 60_000
    });
    const config = { requests: 2, windowSeconds: 10 };

    const first = await limiter.acquire(keyA, { config });
    const second = await limiter.acquire(keyA, { config });
    const third = await limiter.acquire(keyA, { config });

    // Two tokens per ten seconds: the third caller waits half a window.
    expect(sleeps).toEqual([5000]);
    expect(clock).toBe(5000);
    first.release();
    second.release();
    third.release();
  });

  test('fails with a rate_limited error when the wait exceeds the budget', async () => {
    const limiter = new InProcessRateLimiter({
      now: () => 0,
      sleep: async () => {},
      maxWaitMs: 100
    });
    const config = { requests: 1, windowSeconds: 60 };
    await limiter.acquire(keyA, { config });

    try {
      await limiter.acquire(keyA, { config });
      throw new Error('expected acquire to reject');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('rate_limited');
      expect(
        (error as { details?: { retryAfterMs?: number } }).details?.retryAfterMs
      ).toBeGreaterThan(0);
    }
  });

  test('does not limit when no requests budget is configured', async () => {
    const limiter = new InProcessRateLimiter({ now: () => 0, sleep: async () => {} });
    const lease = await limiter.acquire(keyA, { config: {} });
    expect(typeof lease.release).toBe('function');
    expect(lease.waitedMs).toBe(0);
  });
});

describe('rate limiter: concurrency', () => {
  test('serialises calls beyond the concurrency limit and resumes on release', async () => {
    const limiter = new InProcessRateLimiter({ maxWaitMs: 5000 });
    const config = { requests: 100, windowSeconds: 1, concurrency: 1 };

    const first = await limiter.acquire(keyA, { config });
    let secondResolved = false;
    const secondPromise = limiter.acquire(keyA, { config }).then((lease) => {
      secondResolved = true;
      return lease;
    });

    await Bun.sleep(25);
    expect(secondResolved).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(secondResolved).toBe(true);
    second.release();

    // The slot is free again.
    const third = await limiter.acquire(keyA, { config });
    expect(typeof third.release).toBe('function');
    third.release();
  });

  test('releasing twice does not corrupt the in-flight count', async () => {
    const limiter = new InProcessRateLimiter({ maxWaitMs: 5000 });
    const config = { requests: 100, windowSeconds: 1, concurrency: 1 };
    const lease = await limiter.acquire(keyA, { config });
    lease.release();
    lease.release();
    const next = await limiter.acquire(keyA, { config });
    expect(typeof next.release).toBe('function');
    next.release();
  });
});

describe('rate limiter: isolation', () => {
  test('limits are per service and never shared across workspaces', async () => {
    const limiter = new InProcessRateLimiter({ now: () => 0, sleep: async () => {}, maxWaitMs: 1 });
    const config = { requests: 1, windowSeconds: 60 };

    // Exhaust the first service in the first workspace.
    const consumed = await limiter.acquire(keyA, { config });
    await expect(limiter.acquire(keyA, { config })).rejects.toThrow(/rate/i);

    // A different service and a different workspace each have their own bucket.
    const otherService = await limiter.acquire(keyOtherService, { config });
    const otherWorkspace = await limiter.acquire(keyOtherWorkspace, { config });
    expect(typeof otherService.release).toBe('function');
    expect(typeof otherWorkspace.release).toBe('function');

    consumed.release();
    otherService.release();
    otherWorkspace.release();
  });

  test('createRateLimiter exposes the portable RateLimiter interface', async () => {
    const limiter = createRateLimiter({ now: () => 0, sleep: async () => {} });
    const lease = await limiter.acquire(keyA, { config: { requests: 5, windowSeconds: 1 } });
    expect(typeof lease.release).toBe('function');
    lease.release();
  });

  test('bounds remembered buckets by evicting idle ones', async () => {
    const limiter = new InProcessRateLimiter({
      now: () => 0,
      sleep: async () => {},
      maxTrackedKeys: 2
    });
    const config = { requests: 1, windowSeconds: 60 };
    for (let index = 0; index < 5; index++) {
      const lease = await limiter.acquire(
        { workspaceId: 'ws-a', serviceId: `service-${index}` },
        { config }
      );
      lease.release();
    }
    expect(limiter.trackedKeyCount()).toBeLessThanOrEqual(2);
  });
});
