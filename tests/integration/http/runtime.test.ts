import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { httpRequestLogs } from '../../../src/lib/server/db/schema';
import { executeOperation, requiresApproval } from '../../../src/lib/server/http/runtime';
import { testRequest } from '../../../src/lib/server/http/testing';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createHttpOperation,
  createHttpService,
  createUser,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';
import { type MockHandler, type MockHttpServer, startMockServer } from '../../helpers/mock-http';

let handle: TestDatabase;
let workspaceId: string;
let actor: ReturnType<typeof ownerActor>;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'HTTP Workspace');
  workspaceId = workspace.id;
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
});

afterEach(() => {
  handle.cleanup();
});

async function withServer<T>(
  handler: MockHandler | undefined,
  run: (server: MockHttpServer) => Promise<T>
): Promise<T> {
  const server = startMockServer(handler ?? {});
  try {
    return await run(server);
  } finally {
    await server.stop();
  }
}

describe('executeOperation: happy path', () => {
  test('builds the URL, maps the response and logs the request', async () => {
    await withServer(
      () => Response.json({ id: 'c1', name: 'Ada' }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'contacts.get',
          path: '/contacts/{{id}}',
          parameters: [{ name: 'id', location: 'path', required: true }],
          responseMapping: { outputTemplate: { contactId: '{{id}}', name: '{{name}}' } }
        });

        const result = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: { id: 'c1' }
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(result.output).toEqual({ contactId: 'c1', name: 'Ada' });
        expect(result.attempts).toBe(1);
        expect(result.cacheStatus).toBe('bypass');
        expect(result.logId).not.toBeNull();
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]?.path).toBe('/contacts/c1');

        const logs = await handle.db.select().from(httpRequestLogs).all();
        expect(logs).toHaveLength(1);
        expect(logs[0]?.responseStatus).toBe(200);
        expect(logs[0]?.method).toBe('GET');
      }
    );
  });

  test('testRequest bypasses approval and cache and formats the response', async () => {
    await withServer(
      () => Response.json({ hello: 'world' }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'greet.get',
          path: '/greet',
          method: 'POST',
          approvalPolicy: { mode: 'always' },
          cachePolicy: { enabled: true, ttlSeconds: 60 }
        });

        const result = await testRequest({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: {}
        });

        expect(result.ok).toBe(true);
        expect(result.body).toEqual({ hello: 'world' });
        expect(result.formattedBody).toContain('"hello": "world"');
        expect(result.retryTrace).toHaveLength(1);
        const logs = await handle.db.select().from(httpRequestLogs).all();
        expect(logs[0]?.fromTestConsole).toBe(true);
      }
    );
  });
});

describe('executeOperation: retries', () => {
  test('retries a transient 503 and succeeds on the second attempt', async () => {
    let calls = 0;
    await withServer(
      () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: 'unavailable' }, { status: 503 })
          : Response.json({ ok: true });
      },
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000,
          retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'flaky.get',
          path: '/flaky'
        });

        const result = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(2);
        expect(server.requests).toHaveLength(2);
        expect(result.retryTrace).toHaveLength(2);
      }
    );
  });

  test('stops after maxAttempts when the upstream keeps failing', async () => {
    await withServer(
      () => Response.json({ error: 'unavailable' }, { status: 503 }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000,
          retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'down.get',
          path: '/down'
        });

        const result = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(503);
        expect(result.attempts).toBe(3);
        expect(server.requests).toHaveLength(3);
      }
    );
  });

  test('honours Retry-After on a 429 before retrying', async () => {
    let calls = 0;
    await withServer(
      () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: 'slow down' },
            { status: 429, headers: { 'retry-after': '1' } }
          );
        }
        return Response.json({ ok: true });
      },
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000,
          retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5, honorRetryAfter: true }
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'throttled.get',
          path: '/throttled'
        });

        const delays: number[] = [];
        const result = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          overrides: {
            sleep: async (ms) => {
              delays.push(ms);
            }
          }
        });

        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(2);
        expect(delays).toEqual([1000]);
        expect(server.requests).toHaveLength(2);
      }
    );
  });

  test('does not retry a POST by default', async () => {
    await withServer(
      () => Response.json({ error: 'unavailable' }, { status: 503 }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000,
          retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'create.post',
          path: '/create',
          method: 'POST'
        });

        const result = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(1);
        expect(server.requests).toHaveLength(1);
      }
    );
  });
});

describe('executeOperation: timeout', () => {
  test('produces a timeout AppError and a failed request log', async () => {
    await withServer(
      async () => {
        await Bun.sleep(500);
        return Response.json({ ok: true });
      },
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 60,
          retryPolicy: { maxAttempts: 1 }
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'slow.get',
          path: '/slow'
        });

        let caught: { code?: string } | null = null;
        try {
          await executeOperation({ db: handle.db, actor, operationId: operation.id });
        } catch (error) {
          caught = error as { code?: string };
        }
        expect(caught?.code).toBe('timeout');

        const logs = await handle.db.select().from(httpRequestLogs).all();
        expect(logs).toHaveLength(1);
        expect(logs[0]?.responseStatus).toBeNull();
        expect(logs[0]?.errorCode).toBe('timeout');
        expect(logs[0]?.error).toContain('timed out');
      }
    );
  });
});

describe('executeOperation: success rules', () => {
  test('rejects a 200 whose body carries a failure flag', async () => {
    await withServer(
      () => Response.json({ error: 'quota exceeded' }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'guarded.get',
          path: '/guarded',
          successRules: { failWhenPath: 'error' }
        });

        const result = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(result.ok).toBe(false);
        expect(result.status).toBe(200);
        expect(result.error?.message).toContain('error');
        expect(server.requests).toHaveLength(1);
      }
    );
  });
});

describe('executeOperation: caching', () => {
  test('a second GET is served from cache with zero upstream requests', async () => {
    await withServer(
      () => Response.json({ value: 42 }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'cached.get',
          path: '/cached',
          cachePolicy: { enabled: true, ttlSeconds: 60 }
        });

        const first = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(first.ok).toBe(true);
        expect(first.cacheStatus).toBe('stored');

        const second = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(second.ok).toBe(true);
        expect(second.cacheStatus).toBe('hit');
        expect(second.attempts).toBe(0);
        expect(second.output).toEqual({ value: 42 });
        expect(server.requests).toHaveLength(1);
      }
    );
  });

  test('mutations are never cached even when the policy enables caching', async () => {
    await withServer(
      () => Response.json({ ok: true }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'mutate.post',
          path: '/mutate',
          method: 'POST',
          cachePolicy: { enabled: true, ttlSeconds: 60 }
        });

        const first = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        const second = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        expect(first.cacheStatus).toBe('bypass');
        expect(second.cacheStatus).toBe('bypass');
        expect(server.requests).toHaveLength(2);
      }
    );
  });

  test('a read-disabled policy still stores responses for other callers', async () => {
    await withServer(
      () => Response.json({ value: 'fresh' }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'writeonly.get',
          path: '/write-only',
          cachePolicy: { enabled: true, ttlSeconds: 60, read: false }
        });

        const first = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        const second = await executeOperation({ db: handle.db, actor, operationId: operation.id });
        // Both calls go upstream because reads are disabled...
        expect(first.cacheStatus).toBe('stored');
        expect(second.cacheStatus).toBe('stored');
        expect(server.requests).toHaveLength(2);
      }
    );
  });

  test('cachePolicy.varyOn keeps responses for different parameter values apart', async () => {
    await withServer(
      async (_request, record) =>
        Response.json({ locale: new URL(record.url).searchParams.get('locale') }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'vary.get',
          path: '/vary',
          parameters: [{ name: 'locale', location: 'query' }],
          cachePolicy: { enabled: true, ttlSeconds: 60, varyOn: ['locale'] }
        });

        const english = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: { locale: 'en' }
        });
        const englishAgain = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: { locale: 'en' }
        });
        const french = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: { locale: 'fr' }
        });

        expect(english.cacheStatus).toBe('stored');
        expect(englishAgain.cacheStatus).toBe('hit');
        expect(french.cacheStatus).toBe('stored');
        expect(server.requests).toHaveLength(2);
      }
    );
  });

  test('a body-field input reaches the wire without being rejected as unknown', async () => {
    await withServer(
      async (_request, record) => Response.json({ received: record.body }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'contacts.create',
          path: '/contacts',
          method: 'POST',
          body: {
            mode: 'json',
            fields: [{ name: 'email', location: 'body', required: true, type: 'string' }]
          }
        });

        const result = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: { email: 'ada@example.com' }
        });
        expect(result.ok).toBe(true);
        expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({ email: 'ada@example.com' });
      }
    );
  });
});

describe('executeOperation: rate limiting', () => {
  test('serialises calls beyond the service concurrency limit', async () => {
    await withServer(
      async () => {
        await Bun.sleep(40);
        return Response.json({ ok: true });
      },
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000,
          rateLimit: { requests: 100, windowSeconds: 1, concurrency: 1 }
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'limited.get',
          path: '/limited'
        });

        const [a, b] = await Promise.all([
          executeOperation({ db: handle.db, actor, operationId: operation.id }),
          executeOperation({ db: handle.db, actor, operationId: operation.id })
        ]);

        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        expect(server.requests).toHaveLength(2);
        expect(server.maxInFlight).toBe(1);
      }
    );
  });
});

describe('executeOperation: approval', () => {
  test('an always policy returns approvalRequired without any outbound request', async () => {
    await withServer(
      () => Response.json({ ok: true }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'risky.post',
          path: '/risky/{{id}}',
          method: 'POST',
          parameters: [{ name: 'id', location: 'path', required: true }],
          approvalPolicy: { mode: 'always', reason: 'Write to production CRM' }
        });

        const result = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          input: { id: '42' }
        });

        expect(result.ok).toBe(false);
        expect(result.approvalRequired?.kind).toBe('approvalRequired');
        expect(result.approvalRequired?.reason).toBe('Write to production CRM');
        expect(result.approvalRequired?.request.method).toBe('POST');
        expect(result.approvalRequired?.request.url).toBe(`${server.url}/risky/42`);
        expect(result.attempts).toBe(0);
        expect(result.logId).toBeNull();
        expect(server.requests).toHaveLength(0);

        const operations = await handle.db
          .select()
          .from(httpRequestLogs)
          .where(eq(httpRequestLogs.operationId, operation.id))
          .all();
        expect(operations).toHaveLength(0);

        expect(requiresApproval(operation, service, { id: '42' })).toBe(true);
      }
    );
  });

  test('a test-console request bypasses the approval gate', async () => {
    await withServer(
      () => Response.json({ ok: true }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'risky2.post',
          path: '/risky2',
          method: 'POST',
          approvalPolicy: { mode: 'always' }
        });

        const result = await executeOperation({
          db: handle.db,
          actor,
          operationId: operation.id,
          overrides: { fromTestConsole: true }
        });
        expect(result.ok).toBe(true);
        expect(server.requests).toHaveLength(1);
      }
    );
  });
});

describe('executeOperation: permissions', () => {
  test('denies a member without http:invoke', async () => {
    await withServer(
      () => Response.json({ ok: true }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'denied.get',
          path: '/denied'
        });
        const user = await createUser(handle.db);
        const limited = createActorContext({
          workspaceId,
          actorType: 'user',
          actorId: user.id,
          role: 'member',
          permissions: [Permissions.httpRead]
        });

        await expect(
          executeOperation({ db: handle.db, actor: limited, operationId: operation.id })
        ).rejects.toThrow(/not permitted|permission/i);
        expect(server.requests).toHaveLength(0);
      }
    );
  });

  test('rejects a disabled operation without calling out', async () => {
    await withServer(
      () => Response.json({ ok: true }),
      async (server) => {
        const service = await createHttpService(handle.db, {
          workspaceId,
          baseUrl: server.url,
          timeoutMs: 2000
        });
        const operation = await createHttpOperation(handle.db, {
          workspaceId,
          serviceId: service.id,
          key: 'disabled.get',
          path: '/disabled',
          enabled: false
        });

        await expect(
          executeOperation({ db: handle.db, actor, operationId: operation.id })
        ).rejects.toThrow(/disabled/i);
        expect(server.requests).toHaveLength(0);
      }
    );
  });
});
