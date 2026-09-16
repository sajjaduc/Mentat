import { beforeEach, describe, expect, test } from 'bun:test';
import { acquireLock, releaseLock } from '../../../src/lib/server/cache/locks';
import { cacheGet, cacheGetOrCompute, cacheSet } from '../../../src/lib/server/cache/service';
import { cacheLocks } from '../../../src/lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;

beforeEach(async () => {
  handle = createTestDatabase();
  workspaceId = (await createWorkspace(handle.db, 'Compute')).id;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('cacheGetOrCompute', () => {
  test('serves a hit without running compute', async () => {
    cacheSet(handle.db, { workspaceId, key: 'k', value: 'cached' });
    let calls = 0;
    const result = await cacheGetOrCompute(handle.db, {
      workspaceId,
      key: 'k',
      compute: async () => {
        calls += 1;
        return 'computed';
      }
    });
    expect(calls).toBe(0);
    expect(result.hit).toBe(true);
    expect(result.computed).toBe(false);
    expect(result.value).toBe('cached');
  });

  test('computes exactly once for ten concurrent callers', async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      await delay(30);
      return { generated: calls };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cacheGetOrCompute(handle.db, {
          workspaceId,
          key: 'stampede',
          ttlSeconds: 60,
          compute,
          waitPollMs: 5,
          waitTimeoutMs: 2_000
        })
      )
    );

    expect(calls).toBe(1);
    for (const result of results) {
      expect(result.value).toEqual({ generated: 1 });
    }
    expect(results.filter((result) => result.computed)).toHaveLength(1);
    expect(results.filter((result) => result.hit)).toHaveLength(9);
    expect(cacheGet(handle.db, { workspaceId, key: 'stampede' }).value).toEqual({ generated: 1 });
    // The lock is released once the computation is persisted.
    expect(handle.db.select().from(cacheLocks).all()).toHaveLength(0);
  });

  test('releases the lock and caches nothing when compute throws', async () => {
    await expect(
      cacheGetOrCompute(handle.db, {
        workspaceId,
        key: 'boom',
        compute: async () => {
          throw new Error('producer failed');
        }
      })
    ).rejects.toThrow('producer failed');

    expect(handle.db.select().from(cacheLocks).all()).toHaveLength(0);
    expect(cacheGet(handle.db, { workspaceId, key: 'boom' }).hit).toBe(false);

    const recovered = await cacheGetOrCompute(handle.db, {
      workspaceId,
      key: 'boom',
      compute: async () => 'recovered'
    });
    expect(recovered.value).toBe('recovered');
  });

  test('computes anyway when the lock is held by someone else and the wait times out', async () => {
    const now = Date.now();
    const lock = acquireLock(handle.db, {
      workspaceId,
      key: 'wedged',
      holder: 'other-process',
      ttlMs: 60_000,
      now
    });
    expect(lock.acquired).toBe(true);

    let calls = 0;
    const result = await cacheGetOrCompute(handle.db, {
      workspaceId,
      key: 'wedged',
      ttlSeconds: 60,
      waitTimeoutMs: 30,
      waitPollMs: 10,
      compute: async () => {
        calls += 1;
        return 'fallback';
      }
    });

    expect(calls).toBe(1);
    expect(result.computed).toBe(true);
    expect(result.value).toBe('fallback');
    expect(cacheGet(handle.db, { workspaceId, key: 'wedged' }).value).toBe('fallback');
    // The other holder's lock is untouched: we never stole an unexpired lock.
    releaseLock(handle.db, { workspaceId, key: 'wedged', holder: 'other-process' });
  });

  test('a waiter re-reads the value produced by the lock holder', async () => {
    const order: string[] = [];
    const holder = cacheGetOrCompute(handle.db, {
      workspaceId,
      key: 'handoff',
      compute: async () => {
        order.push('holder-compute');
        await delay(40);
        return 'produced';
      },
      waitPollMs: 5,
      waitTimeoutMs: 2_000
    });
    await delay(5);
    const waiter = cacheGetOrCompute(handle.db, {
      workspaceId,
      key: 'handoff',
      compute: async () => {
        order.push('waiter-compute');
        return 'waiter-produced';
      },
      waitPollMs: 5,
      waitTimeoutMs: 2_000
    });

    const [holderResult, waiterResult] = await Promise.all([holder, waiter]);
    expect(holderResult.value).toBe('produced');
    expect(waiterResult.value).toBe('produced');
    expect(waiterResult.hit).toBe(true);
    expect(order).toEqual(['holder-compute']);
    expect(cacheGet(handle.db, { workspaceId, key: 'handoff' }).value).toBe('produced');
  });
});
