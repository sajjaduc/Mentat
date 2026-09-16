import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  computeAuthScope,
  effectiveCachePolicy,
  httpCacheIdentity,
  isCacheableMethod,
  SqliteHttpCacheStore
} from '../../../src/lib/server/http/cache';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;

beforeEach(() => {
  handle = createTestDatabase();
});

afterEach(() => {
  handle.cleanup();
});

describe('cache policy', () => {
  test('only GET and HEAD are cacheable by default', () => {
    expect(isCacheableMethod('GET')).toBe(true);
    expect(isCacheableMethod('HEAD')).toBe(true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      expect(isCacheableMethod(method)).toBe(false);
    }
  });

  test('the operation policy overrides the service policy', () => {
    const servicePolicy = { enabled: true, ttlSeconds: 60 };
    expect(effectiveCachePolicy(servicePolicy, null)).toEqual(servicePolicy);
    expect(effectiveCachePolicy(servicePolicy, { enabled: false })).toEqual({ enabled: false });
    expect(effectiveCachePolicy(null, null)).toBeNull();
  });
});

describe('cache identity', () => {
  const base = {
    workspaceId: 'ws-a',
    serviceId: 'svc-1',
    operationId: 'op-1',
    method: 'GET' as const,
    url: 'https://api.example.com/v3/contacts?limit=10',
    authScope: computeAuthScope('bearer', { secretId: 'secret-1' })
  };

  test('includes the workspace, service, operation and method', () => {
    const identity = httpCacheIdentity(base);
    expect(identity.workspaceId).toBe('ws-a');
    expect(identity.namespace).toContain('svc-1');
    expect(identity.namespace).toContain('op-1');
    // The request fingerprint is a hash, so identity is proven by inequality.
    expect(httpCacheIdentity({ ...base, method: 'HEAD' }).key).not.toBe(identity.key);
    expect(httpCacheIdentity({ ...base, url: `${base.url}&page=2` }).key).not.toBe(identity.key);
  });

  test('changes when the workspace changes', () => {
    const a = httpCacheIdentity(base);
    const b = httpCacheIdentity({ ...base, workspaceId: 'ws-b' });
    expect(a.key).toBe(b.key);
    expect(a.workspaceId).not.toBe(b.workspaceId);
  });

  test('changes when the credential changes', () => {
    const a = httpCacheIdentity(base);
    const b = httpCacheIdentity({
      ...base,
      authScope: computeAuthScope('bearer', { secretId: 'secret-2' })
    });
    expect(a.authScope).not.toBe(b.authScope);
  });

  test('changes when the request body changes', () => {
    const withBody = { ...base, method: 'GET' as const, body: '{"a":1}' };
    const other = { ...base, method: 'GET' as const, body: '{"a":2}' };
    expect(httpCacheIdentity(withBody).key).not.toBe(httpCacheIdentity(other).key);
  });

  test('changes when a varyOn value changes', () => {
    const english = httpCacheIdentity({ ...base, varyOn: { locale: 'en' } });
    const french = httpCacheIdentity({ ...base, varyOn: { locale: 'fr' } });
    const same = httpCacheIdentity({ ...base, varyOn: { locale: 'en' } });
    expect(english.key).not.toBe(french.key);
    expect(english.key).toBe(same.key);
  });

  test('computeAuthScope is stable and differs per credential', () => {
    const first = computeAuthScope('bearer', { secretId: 'secret-1' });
    const again = computeAuthScope('bearer', { secretId: 'secret-1' });
    const other = computeAuthScope('bearer', { secretId: 'secret-2' });
    const none = computeAuthScope('none', null);
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(none).toContain('none');
  });

  test('basic auth scoping considers the password secret', () => {
    const a = computeAuthScope('basic', { username: 'alice', passwordSecretId: 'p1' });
    const b = computeAuthScope('basic', { username: 'alice', passwordSecretId: 'p2' });
    expect(a).not.toBe(b);
  });
});

describe('SqliteHttpCacheStore', () => {
  async function identityFor(workspaceId: string, authScope: string) {
    return httpCacheIdentity({
      workspaceId,
      serviceId: 'svc-1',
      operationId: 'op-1',
      method: 'GET',
      url: 'https://api.example.com/contacts',
      authScope
    });
  }

  test('stores and retrieves a value, reporting hits', async () => {
    const workspace = await createWorkspace(handle.db);
    const store = new SqliteHttpCacheStore(handle.db);
    const identity = await identityFor(workspace.id, 'bearer:abc');
    const value = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { id: 'c1' },
      bodyText: '{"id":"c1"}',
      contentType: 'application/json',
      storedAt: Date.now(),
      expiresAt: null
    };
    expect(await store.get(identity)).toBeNull();

    await store.set(identity, value, { ttlSeconds: 60 });
    const hit = await store.get(identity);
    expect(hit?.status).toBe(200);
    expect(hit?.body).toEqual({ id: 'c1' });

    // The stored row tracks access counts for inspection.
    const rows = handle.sqlite
      .query('SELECT hits FROM cache_entries WHERE workspace_id = ?')
      .all(workspace.id) as Array<{ hits: number }>;
    expect(rows[0]?.hits).toBe(1);
  });

  test('never returns an entry across workspaces or credentials', async () => {
    const workspaceA = await createWorkspace(handle.db, 'A');
    const workspaceB = await createWorkspace(handle.db, 'B');
    const store = new SqliteHttpCacheStore(handle.db);
    const value = {
      status: 200,
      headers: {},
      body: { secret: true },
      bodyText: '{"secret":true}',
      contentType: 'application/json',
      storedAt: Date.now(),
      expiresAt: null
    };

    await store.set(await identityFor(workspaceA.id, 'bearer:one'), value, { ttlSeconds: 60 });

    expect(await store.get(await identityFor(workspaceB.id, 'bearer:one'))).toBeNull();
    expect(await store.get(await identityFor(workspaceA.id, 'bearer:two'))).toBeNull();
    expect(await store.get(await identityFor(workspaceA.id, 'bearer:one'))).not.toBeNull();
  });

  test('treats an expired entry as a miss', async () => {
    const workspace = await createWorkspace(handle.db);
    const store = new SqliteHttpCacheStore(handle.db);
    const identity = await identityFor(workspace.id, 'none');
    const value = {
      status: 200,
      headers: {},
      body: null,
      bodyText: '',
      contentType: null,
      storedAt: Date.now(),
      expiresAt: null
    };
    await store.set(identity, value, { ttlSeconds: 5 });
    const now = Date.now();
    expect(await store.get(identity, now + 1_000)).not.toBeNull();
    expect(await store.get(identity, now + 10_000)).toBeNull();
  });

  test('overwrites an existing key on set', async () => {
    const workspace = await createWorkspace(handle.db);
    const store = new SqliteHttpCacheStore(handle.db);
    const identity = await identityFor(workspace.id, 'none');
    const base = {
      status: 200,
      headers: {},
      body: { n: 1 },
      bodyText: '{"n":1}',
      contentType: 'application/json',
      storedAt: Date.now(),
      expiresAt: null
    };
    await store.set(identity, base, { ttlSeconds: 60 });
    await store.set(identity, { ...base, body: { n: 2 }, bodyText: '{"n":2}' }, { ttlSeconds: 60 });
    const hit = await store.get(identity);
    expect(hit?.body).toEqual({ n: 2 });
    const count = handle.sqlite.query('SELECT count(*) AS n FROM cache_entries').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  test('deletes an entry', async () => {
    const workspace = await createWorkspace(handle.db);
    const store = new SqliteHttpCacheStore(handle.db);
    const identity = await identityFor(workspace.id, 'none');
    await store.set(
      identity,
      {
        status: 200,
        headers: {},
        body: null,
        bodyText: '',
        contentType: null,
        storedAt: Date.now(),
        expiresAt: null
      },
      { ttlSeconds: 60 }
    );
    await store.delete(identity);
    expect(await store.get(identity)).toBeNull();
  });
});
