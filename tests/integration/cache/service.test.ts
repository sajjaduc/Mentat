import { beforeEach, describe, expect, test } from 'bun:test';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import { purgeExpired, purgeExpiredDetailed } from '../../../src/lib/server/cache/purge-expired';
import {
  cacheClear,
  cacheDelete,
  cacheGet,
  cacheList,
  cacheSet,
  cacheStats,
  MAX_CACHE_VALUE_BYTES
} from '../../../src/lib/server/cache/service';
import { createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { cacheEntries } from '../../../src/lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceA: string;
let workspaceB: string;

beforeEach(async () => {
  handle = createTestDatabase();
  workspaceA = (await createWorkspace(handle.db, 'A')).id;
  workspaceB = (await createWorkspace(handle.db, 'B')).id;
});

describe('cache service', () => {
  test('round-trips a value and reports hit metadata', () => {
    const now = Date.now();
    cacheSet(handle.db, {
      workspaceId: workspaceA,
      key: 'greeting',
      value: { hello: 'world' },
      now
    });
    const result = cacheGet<{ hello: string }>(handle.db, {
      workspaceId: workspaceA,
      key: 'greeting',
      now: now + 50
    });
    expect(result.hit).toBe(true);
    expect(result.value).toEqual({ hello: 'world' });
    expect(result.storedAt).toBe(now);
    expect(result.ageMs).toBe(50);
    expect(result.expiresAt).toBeNull();
  });

  test('missing keys are misses and counted', () => {
    const result = cacheGet(handle.db, { workspaceId: workspaceA, key: 'absent' });
    expect(result.hit).toBe(false);
    expect(result.value).toBeNull();
    expect(result.storedAt).toBeNull();
    expect(cacheStats(handle.db, { workspaceId: workspaceA }).misses).toBe(1);
  });

  test('an expired entry is a miss and is deleted lazily', () => {
    const now = Date.now();
    cacheSet(handle.db, {
      workspaceId: workspaceA,
      key: 'short',
      value: 'value',
      ttlSeconds: 10,
      now
    });
    const before = cacheGet(handle.db, { workspaceId: workspaceA, key: 'short', now: now + 5_000 });
    expect(before.hit).toBe(true);

    const after = cacheGet(handle.db, { workspaceId: workspaceA, key: 'short', now: now + 11_000 });
    expect(after.hit).toBe(false);
    expect(after.value).toBeNull();
    const rows = handle.db.select().from(cacheEntries).all();
    expect(rows).toHaveLength(0);
  });

  test('namespace isolates otherwise identical keys', () => {
    cacheSet(handle.db, { workspaceId: workspaceA, namespace: 'a', key: 'k', value: 'in-a' });
    expect(cacheGet(handle.db, { workspaceId: workspaceA, namespace: 'a', key: 'k' }).value).toBe(
      'in-a'
    );
    expect(cacheGet(handle.db, { workspaceId: workspaceA, namespace: 'b', key: 'k' }).hit).toBe(
      false
    );
  });

  test('authScope isolates values cached under different credentials', () => {
    cacheSet(handle.db, {
      workspaceId: workspaceA,
      key: 'token-response',
      value: 'for-credential-1',
      authScope: 'credential-1'
    });
    expect(
      cacheGet(handle.db, {
        workspaceId: workspaceA,
        key: 'token-response',
        authScope: 'credential-1'
      }).value
    ).toBe('for-credential-1');
    const other = cacheGet(handle.db, {
      workspaceId: workspaceA,
      key: 'token-response',
      authScope: 'credential-2'
    });
    expect(other.hit).toBe(false);
    expect(other.value).toBeNull();
  });

  test('workspace isolates values even with identical namespace, scope and key', () => {
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'shared', value: 'tenant-a' });
    cacheSet(handle.db, { workspaceId: workspaceB, key: 'shared', value: 'tenant-b' });
    expect(cacheGet(handle.db, { workspaceId: workspaceA, key: 'shared' }).value).toBe('tenant-a');
    expect(cacheGet(handle.db, { workspaceId: workspaceB, key: 'shared' }).value).toBe('tenant-b');
  });

  test('set upserts rather than duplicating', () => {
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'k', value: 1 });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'k', value: 2 });
    const rows = handle.db.select().from(cacheEntries).all();
    expect(rows).toHaveLength(1);
    expect(cacheGet(handle.db, { workspaceId: workspaceA, key: 'k' }).value).toBe(2);
  });

  test('delete is idempotent', () => {
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'k', value: 1 });
    expect(cacheDelete(handle.db, { workspaceId: workspaceA, key: 'k' })).toBe(true);
    expect(cacheDelete(handle.db, { workspaceId: workspaceA, key: 'k' })).toBe(false);
  });

  test('clear by namespace removes only that namespace and audits once', async () => {
    cacheSet(handle.db, { workspaceId: workspaceA, namespace: 'a', key: 'k1', value: 1 });
    cacheSet(handle.db, { workspaceId: workspaceA, namespace: 'a', key: 'k2', value: 2 });
    cacheSet(handle.db, { workspaceId: workspaceA, namespace: 'b', key: 'k3', value: 3 });

    const removed = await cacheClear(handle.db, { workspaceId: workspaceA, namespace: 'a' });
    expect(removed).toBe(2);
    expect(cacheGet(handle.db, { workspaceId: workspaceA, namespace: 'b', key: 'k3' }).hit).toBe(
      true
    );

    const audit = await queryAudit(handle.db, {
      workspaceId: workspaceA,
      actions: ['cache.cleared']
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({ namespace: 'a', removed: 2 });
  });

  test('clear by tag removes only tagged entries', async () => {
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'k1', value: 1, tags: ['http'] });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'k2', value: 2, tags: ['other'] });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'k3', value: 3 });

    const removed = await cacheClear(handle.db, { workspaceId: workspaceA, tag: 'http' });
    expect(removed).toBe(1);
    expect(cacheGet(handle.db, { workspaceId: workspaceA, key: 'k1' }).hit).toBe(false);
    expect(cacheGet(handle.db, { workspaceId: workspaceA, key: 'k2' }).hit).toBe(true);
  });

  test('clear requires cache:write when an actor is supplied', async () => {
    const reader = createActorContext({
      workspaceId: workspaceA,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: [Permissions.cacheRead]
    });
    await expect(
      cacheClear(handle.db, { workspaceId: workspaceA, actor: reader })
    ).rejects.toThrow();
  });

  test('list exposes metadata but hides values unless requested with cache:read', () => {
    const now = Date.now();
    cacheSet(handle.db, {
      workspaceId: workspaceA,
      namespace: 'n',
      key: 'alpha',
      value: 'secret',
      now
    });
    cacheGet(handle.db, { workspaceId: workspaceA, namespace: 'n', key: 'alpha', now: now + 1 });

    const entries = cacheList(handle.db, {
      workspaceId: workspaceA,
      namespace: 'n',
      now: now + 1
    });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.key).toBe('alpha');
    expect(entry?.namespace).toBe('n');
    expect(entry?.hits).toBe(1);
    expect(entry?.sizeBytes).toBeGreaterThan(0);
    expect(entry?.ageMs).toBe(1);
    expect(entry).not.toHaveProperty('value');

    expect(() => cacheList(handle.db, { workspaceId: workspaceA, includeValues: true })).toThrow();

    const agent = createActorContext({
      workspaceId: workspaceA,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: [Permissions.cacheRead]
    });
    const withValues = cacheList(handle.db, {
      workspaceId: workspaceA,
      includeValues: true,
      actor: agent
    });
    expect(withValues[0]?.value).toBe('secret');
  });

  test('list filters by key prefix', () => {
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'user:1', value: 1 });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'user:2', value: 2 });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'org:1', value: 3 });
    const entries = cacheList(handle.db, { workspaceId: workspaceA, prefix: 'user:' });
    expect(entries.map((entry) => entry.key).sort()).toEqual(['user:1', 'user:2']);
  });

  test('stats aggregate entries, bytes, expiring soon and hit/miss counters', () => {
    const now = Date.now();
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'a', value: 'aaaa', ttlSeconds: 60, now });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'b', value: 'bbbb', now: now + 1 });
    cacheGet(handle.db, { workspaceId: workspaceA, key: 'a', now: now + 2 });
    cacheGet(handle.db, { workspaceId: workspaceA, key: 'a', now: now + 3 });
    cacheGet(handle.db, { workspaceId: workspaceA, key: 'missing' });
    cacheSet(handle.db, { workspaceId: workspaceA, namespace: 'x', key: 'c', value: 1 });

    const stats = cacheStats(handle.db, { workspaceId: workspaceA, now: now + 1_000 });
    expect(stats.entries).toBe(3);
    expect(stats.bytes).toBe(13);
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.namespaces).toBe(2);
    expect(stats.expiringSoon).toBe(1);
    expect(stats.expired).toBe(0);
  });

  test('rejects an oversized value with a validation error', () => {
    const huge = 'x'.repeat(MAX_CACHE_VALUE_BYTES + 1);
    expect(() =>
      cacheSet(handle.db, { workspaceId: workspaceA, key: 'huge', value: huge })
    ).toThrow();
    expect(handle.db.select().from(cacheEntries).all()).toHaveLength(0);
  });

  test('purgeExpired removes only expired entries and stale locks', () => {
    const now = Date.now();
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'old', value: 1, ttlSeconds: 5, now });
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'live', value: 2, ttlSeconds: 5_000, now });
    expect(purgeExpired(handle.db, now + 6_000)).toBe(1);
    const remaining = handle.db.select().from(cacheEntries).all();
    expect(remaining.map((row) => row.key)).toEqual(['live']);
  });
});

describe('cache tenant isolation with actor-scoped writes', () => {
  test('a workspace owner cannot read another workspace value through list', () => {
    cacheSet(handle.db, { workspaceId: workspaceB, key: 'b-only', value: 1 });
    const owner = ownerActor(workspaceA, 'user-1');
    const entries = cacheList(handle.db, { workspaceId: owner.workspaceId, actor: owner });
    expect(entries).toHaveLength(0);
  });

  test('purgeExpiredDetailed reports lock cleanup separately', () => {
    const now = Date.now();
    cacheSet(handle.db, { workspaceId: workspaceA, key: 'old', value: 1, ttlSeconds: 1, now });
    const result = purgeExpiredDetailed(handle.db, now + 2_000);
    expect(result.entries).toBe(1);
    expect(result.locks).toBe(0);
  });
});
