import { beforeEach, describe, expect, test } from 'bun:test';
import { acquireLock, purgeExpiredLocks, releaseLock } from '../../../src/lib/server/cache/locks';
import { cacheLocks } from '../../../src/lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;

beforeEach(async () => {
  handle = createTestDatabase();
  workspaceId = (await createWorkspace(handle.db, 'Locks')).id;
});

describe('cache advisory locks', () => {
  test('acquires a free lock and releases it for the same holder', () => {
    const now = Date.now();
    const first = acquireLock(handle.db, {
      workspaceId,
      namespace: 'n',
      key: 'k',
      holder: 'worker-a',
      ttlMs: 5_000,
      now
    });
    expect(first.acquired).toBe(true);

    const second = acquireLock(handle.db, {
      workspaceId,
      namespace: 'n',
      key: 'k',
      holder: 'worker-b',
      ttlMs: 5_000,
      now: now + 10
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holder).toBe('worker-a');
      expect(second.expiresAt).toBe(now + 5_000);
    }

    expect(
      releaseLock(handle.db, { workspaceId, namespace: 'n', key: 'k', holder: 'worker-b' })
    ).toBe(false);
    expect(
      releaseLock(handle.db, { workspaceId, namespace: 'n', key: 'k', holder: 'worker-a' })
    ).toBe(true);

    const third = acquireLock(handle.db, {
      workspaceId,
      namespace: 'n',
      key: 'k',
      holder: 'worker-b',
      ttlMs: 5_000,
      now: now + 20
    });
    expect(third.acquired).toBe(true);
  });

  test('takes over a lock whose expiry has passed', () => {
    const now = Date.now();
    acquireLock(handle.db, {
      workspaceId,
      namespace: 'n',
      key: 'k',
      holder: 'stale',
      ttlMs: 1_000,
      now
    });

    const takeover = acquireLock(handle.db, {
      workspaceId,
      namespace: 'n',
      key: 'k',
      holder: 'fresh',
      ttlMs: 5_000,
      now: now + 2_000
    });
    expect(takeover.acquired).toBe(true);
    if (takeover.acquired) expect(takeover.holder).toBe('fresh');
    expect(handle.db.select().from(cacheLocks).all()).toHaveLength(1);
  });

  test('locks are isolated by workspace, namespace, authScope and key', () => {
    const now = Date.now();
    const first = acquireLock(handle.db, {
      workspaceId,
      namespace: 'n',
      key: 'k',
      authScope: 's1',
      holder: 'a',
      ttlMs: 5_000,
      now
    });
    expect(first.acquired).toBe(true);
    for (const variant of [
      { workspaceId, namespace: 'm', key: 'k', authScope: 's1' },
      { workspaceId, namespace: 'n', key: 'j', authScope: 's1' },
      { workspaceId, namespace: 'n', key: 'k', authScope: 's2' }
    ]) {
      const result = acquireLock(handle.db, { ...variant, holder: 'b', ttlMs: 5_000, now });
      expect(result.acquired).toBe(true);
    }
  });

  test('purgeExpiredLocks removes only expired rows', () => {
    const now = Date.now();
    acquireLock(handle.db, { workspaceId, key: 'old', holder: 'a', ttlMs: 1_000, now });
    acquireLock(handle.db, { workspaceId, key: 'live', holder: 'a', ttlMs: 60_000, now });
    expect(purgeExpiredLocks(handle.db, now + 2_000)).toBe(1);
    const rows = handle.db.select().from(cacheLocks).all();
    expect(rows.map((row) => row.key)).toEqual(['live']);
  });

  test('rejects an acquire with no holder', () => {
    expect(() =>
      acquireLock(handle.db, { workspaceId, key: 'k', holder: '', ttlMs: 5_000 })
    ).toThrow();
  });
});
