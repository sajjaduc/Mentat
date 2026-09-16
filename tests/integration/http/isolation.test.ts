import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { httpServices } from '../../../src/lib/server/db/schema';
import { executeOperation } from '../../../src/lib/server/http/runtime';
import { listHttpServices } from '../../../src/lib/server/http/service';
import { createSecret } from '../../../src/lib/server/secrets/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createHttpOperation,
  createHttpService,
  createUser,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';
import { startMockServer } from '../../helpers/mock-http';

let handle: TestDatabase;
let actorA: ReturnType<typeof ownerActor>;
let actorB: ReturnType<typeof ownerActor>;
let workspaceA: string;
let workspaceB: string;

beforeEach(async () => {
  handle = createTestDatabase();
  const a = await createWorkspace(handle.db, 'Workspace A');
  const b = await createWorkspace(handle.db, 'Workspace B');
  workspaceA = a.id;
  workspaceB = b.id;
  const userA = await createUser(handle.db);
  const userB = await createUser(handle.db);
  actorA = ownerActor(workspaceA, userA.id, 'Owner A');
  actorB = ownerActor(workspaceB, userB.id, 'Owner B');
});

afterEach(() => {
  handle.cleanup();
});

describe('cache identity isolation', () => {
  test('the same URL and key in another workspace is not a cache hit', async () => {
    const server = startMockServer(() => Response.json({ value: 'shared' }));
    try {
      const serviceA = await createHttpService(handle.db, {
        workspaceId: workspaceA,
        baseUrl: server.url,
        timeoutMs: 2000
      });
      const operationA = await createHttpOperation(handle.db, {
        workspaceId: workspaceA,
        serviceId: serviceA.id,
        key: 'shared.get',
        path: '/shared',
        cachePolicy: { enabled: true, ttlSeconds: 60 }
      });
      const serviceB = await createHttpService(handle.db, {
        workspaceId: workspaceB,
        baseUrl: server.url,
        timeoutMs: 2000
      });
      const operationB = await createHttpOperation(handle.db, {
        workspaceId: workspaceB,
        serviceId: serviceB.id,
        key: 'shared.get',
        path: '/shared',
        cachePolicy: { enabled: true, ttlSeconds: 60 }
      });

      const first = await executeOperation({
        db: handle.db,
        actor: actorA,
        operationId: operationA.id
      });
      const second = await executeOperation({
        db: handle.db,
        actor: actorB,
        operationId: operationB.id
      });

      expect(first.cacheStatus).toBe('stored');
      expect(second.cacheStatus).not.toBe('hit');
      expect(second.cacheStatus).toBe('stored');
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  test('changing the credential invalidates cached responses', async () => {
    const server = startMockServer(() => Response.json({ value: 'private' }));
    try {
      const firstSecret = createSecret(handle.db, actorA, {
        key: 'CACHE_TOKEN',
        value: 'first-credential-value'
      });
      const secondSecret = createSecret(handle.db, actorA, {
        key: 'CACHE_TOKEN_TWO',
        value: 'second-credential-value'
      });
      const service = await createHttpService(handle.db, {
        workspaceId: workspaceA,
        baseUrl: server.url,
        timeoutMs: 2000,
        authType: 'bearer',
        authConfig: { secretId: firstSecret.id }
      });
      const operation = await createHttpOperation(handle.db, {
        workspaceId: workspaceA,
        serviceId: service.id,
        key: 'private.get',
        path: '/private',
        cachePolicy: { enabled: true, ttlSeconds: 60 }
      });

      const first = await executeOperation({
        db: handle.db,
        actor: actorA,
        operationId: operation.id
      });
      expect(first.cacheStatus).toBe('stored');
      expect(server.requests).toHaveLength(1);

      // Rotate the credential on the service; the old entry must not be reused.
      await handle.db
        .update(httpServices)
        .set({ authConfig: { secretId: secondSecret.id }, updatedAt: Date.now() })
        .where(eq(httpServices.id, service.id))
        .run();

      const second = await executeOperation({
        db: handle.db,
        actor: actorA,
        operationId: operation.id
      });
      expect(second.cacheStatus).toBe('stored');
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]?.headers.authorization).toBe('Bearer second-credential-value');
    } finally {
      await server.stop();
    }
  });
});

describe('auth isolation', () => {
  test('two workspace services send their own credential', async () => {
    const server = startMockServer(() => Response.json({ ok: true }));
    try {
      const secretA = createSecret(handle.db, actorA, {
        key: 'WS_A_TOKEN',
        value: 'alpha-secret-value'
      });
      const secretB = createSecret(handle.db, actorB, {
        key: 'WS_B_TOKEN',
        value: 'beta-secret-value'
      });
      const serviceA = await createHttpService(handle.db, {
        workspaceId: workspaceA,
        baseUrl: server.url,
        timeoutMs: 2000,
        authType: 'bearer',
        authConfig: { secretId: secretA.id }
      });
      const operationA = await createHttpOperation(handle.db, {
        workspaceId: workspaceA,
        serviceId: serviceA.id,
        key: 'whoami.get',
        path: '/whoami'
      });
      const serviceB = await createHttpService(handle.db, {
        workspaceId: workspaceB,
        baseUrl: server.url,
        timeoutMs: 2000,
        authType: 'bearer',
        authConfig: { secretId: secretB.id }
      });
      const operationB = await createHttpOperation(handle.db, {
        workspaceId: workspaceB,
        serviceId: serviceB.id,
        key: 'whoami.get',
        path: '/whoami'
      });

      await executeOperation({ db: handle.db, actor: actorA, operationId: operationA.id });
      await executeOperation({ db: handle.db, actor: actorB, operationId: operationB.id });

      expect(server.requests[0]?.headers.authorization).toBe('Bearer alpha-secret-value');
      expect(server.requests[1]?.headers.authorization).toBe('Bearer beta-secret-value');
    } finally {
      await server.stop();
    }
  });
});

describe('redaction of persisted rows', () => {
  test('a bearer credential never appears in request logs or audit rows', async () => {
    const server = startMockServer(() => Response.json({ ok: true }));
    try {
      const secretValue = 'super-secret-credential';
      const secret = createSecret(handle.db, actorA, { key: 'REDACT_TOKEN', value: secretValue });
      const service = await createHttpService(handle.db, {
        workspaceId: workspaceA,
        baseUrl: server.url,
        timeoutMs: 2000,
        authType: 'bearer',
        authConfig: { secretId: secret.id }
      });
      const operation = await createHttpOperation(handle.db, {
        workspaceId: workspaceA,
        serviceId: service.id,
        key: 'redacted.get',
        path: '/redacted'
      });

      const result = await executeOperation({
        db: handle.db,
        actor: actorA,
        operationId: operation.id
      });
      expect(result.ok).toBe(true);
      expect(result.request.headers.Authorization).toBe('[redacted]');
      expect(Object.values(result.request.headers).join(' ')).not.toContain(secretValue);

      const logRows = handle.sqlite.query('SELECT * FROM http_request_logs').all();
      const auditRows = handle.sqlite.query('SELECT * FROM audit_events').all();
      expect(JSON.stringify(logRows)).not.toContain(secretValue);
      expect(JSON.stringify(auditRows)).not.toContain(secretValue);
      expect(JSON.stringify(logRows)).toContain('[redacted]');
    } finally {
      await server.stop();
    }
  });

  test('a query-string API key is redacted even though it is in the URL', async () => {
    const server = startMockServer(() => Response.json({ ok: true }));
    try {
      const secretValue = 'query-secret-value';
      const secret = createSecret(handle.db, actorA, { key: 'QUERY_TOKEN', value: secretValue });
      const service = await createHttpService(handle.db, {
        workspaceId: workspaceA,
        baseUrl: server.url,
        timeoutMs: 2000,
        authType: 'api_key_query',
        authConfig: { secretId: secret.id, queryName: 'access_token' }
      });
      const operation = await createHttpOperation(handle.db, {
        workspaceId: workspaceA,
        serviceId: service.id,
        key: 'querykey.get',
        path: '/query-key'
      });

      await executeOperation({ db: handle.db, actor: actorA, operationId: operation.id });

      // The upstream did receive the real key...
      expect(server.requests[0]?.url).toContain(secretValue);
      // ...but nothing persisted does.
      const logRows = handle.sqlite.query('SELECT * FROM http_request_logs').all();
      const auditRows = handle.sqlite.query('SELECT * FROM audit_events').all();
      expect(JSON.stringify(logRows)).not.toContain(secretValue);
      expect(JSON.stringify(auditRows)).not.toContain(secretValue);
    } finally {
      await server.stop();
    }
  });
});

describe('tenant isolation', () => {
  test('another workspace cannot read or invoke a service or operation', async () => {
    const server = startMockServer(() => Response.json({ ok: true }));
    try {
      const service = await createHttpService(handle.db, {
        workspaceId: workspaceA,
        baseUrl: server.url,
        timeoutMs: 2000
      });
      const operation = await createHttpOperation(handle.db, {
        workspaceId: workspaceA,
        serviceId: service.id,
        key: 'tenant.get',
        path: '/tenant'
      });

      expect(() => listHttpServices(handle.db, actorB)).not.toThrow();
      expect(listHttpServices(handle.db, actorB)).toHaveLength(0);

      await expect(
        executeOperation({ db: handle.db, actor: actorB, operationId: operation.id })
      ).rejects.toThrow(/not found/i);
      await expect(
        executeOperation({ db: handle.db, actor: actorB, operationKey: 'tenant.get' })
      ).rejects.toThrow(/not found/i);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });
});
