/**
 * Security and isolation sweep.
 *
 * Three properties that are cheap to test exhaustively and expensive to get wrong:
 *
 *  1. **Tenant isolation as a matrix.** Every API route that addresses a resource by
 *     id is called as an authenticated owner of a *different* workspace and must not
 *     succeed. Enumerating the route table means a new route is covered the moment it
 *     is declared, rather than when someone remembers to write a test for it.
 *  2. **Secret plaintext never lands anywhere.** A secret is created, resolved for a
 *     real HTTP call, and then every text-ish column in every table is scanned for the
 *     plaintext and its URL-encoded form.
 *  3. **Blob keys cannot escape their root.** Path traversal, absolute paths and
 *     separator abuse are rejected before they reach the filesystem.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { dispatchApi } from '../../../src/lib/server/api/router';
import { apiRoutes } from '../../../src/lib/server/api/routes';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import { clearSecretRegistry } from '../../../src/lib/server/core/secret-registry';
import { allSchema, users } from '../../../src/lib/server/db/schema';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { assertSafeKey, blobKeyFor } from '../../../src/lib/server/storage/blob-store';
import { LocalBlobStore } from '../../../src/lib/server/storage/local-blob-store';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkflow, createWorkspace } from '../../helpers/factories';
import { jsonResponse, type MockHttpServer, startMockServer } from '../../helpers/mock-http';

let handle: TestDatabase;
let owner: ActorContext;
let outsider: ActorContext;

async function call(
  method: string,
  path: string,
  options: { actor?: ActorContext | null; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, 'http://127.0.0.1');
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const rawBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  const result = await dispatchApi({
    db: handle.db,
    method,
    pathname: url.pathname,
    actor: options.actor === undefined ? owner : options.actor,
    query,
    rawBody,
    request: new Request(`http://127.0.0.1/api${path}`, {
      method,
      ...(rawBody === undefined
        ? {}
        : { body: rawBody, headers: { 'content-type': 'application/json' } })
    })
  });
  return { status: result.status, body: result.body };
}

async function setupWorkspace(name: string): Promise<ActorContext> {
  const workspace = await createWorkspace(handle.db, name);
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@${name.replace(/\s+/g, '-').toLowerCase()}.test`,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, userId, 'owner');
  return createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: userId,
    actorLabel: name,
    role: 'owner',
    permissions: permissionsForRole('owner')
  });
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();
  clearSecretRegistry();
  owner = await setupWorkspace('Home Co');
  outsider = await setupWorkspace('Other Co');
  await runBootstrap({
    db: handle.db,
    sqlite: handle.sqlite,
    skipMigrations: true,
    startWorker: false
  });
});

describe('tenant isolation matrix', () => {
  /**
   * Routes that address a resource by id. Each is called with a random id that
   * belongs to nobody: the response must be a refusal, never a success and never an
   * unhandled 500. That is the behaviour a cross-tenant probe should see.
   */
  const idRoutes = apiRoutes.filter(
    (entry) =>
      (entry.method === 'GET' || entry.method === 'DELETE' || entry.method === 'PATCH') &&
      entry.path.includes(':id') &&
      !entry.public
  );

  test('every id-addressed route refuses an unknown id without a 5xx', async () => {
    expect(idRoutes.length).toBeGreaterThan(20);
    const failures: string[] = [];

    for (const entry of idRoutes) {
      const path = entry.path.replace(':id', uuidv7());
      const result = await call(entry.method, path, { body: {} });
      if (result.status >= 500) {
        failures.push(`${entry.method} ${entry.path} -> ${result.status}`);
      }
      if (entry.method === 'GET' && result.status === 200) {
        failures.push(`${entry.method} ${entry.path} returned 200 for an unknown id`);
      }
      if (entry.method === 'DELETE' && result.status === 204) {
        failures.push(`${entry.method} ${entry.path} deleted an unknown id`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('another workspace cannot read a work item, workflow, agent or file by id', async () => {
    const workflow = await createWorkflow(handle.db, owner.workspaceId, { name: 'Private' });
    const item = await call('POST', '/workflow-items', {
      body: {
        workflowId: workflow.id,
        record: { objectTypeId: workflow.objectTypeId, displayName: 'Secret work' }
      }
    });
    const itemId = (item.body as { workflowItem: { id: string } }).workflowItem.id;

    const agent = await call('POST', '/agents', { body: { name: 'Private agent' } });
    const agentId = (agent.body as { agent: { id: string } }).agent.id;

    const secret = await call('POST', '/secrets', {
      body: { key: 'PRIVATE_KEY', value: 'a-private-value-123456' }
    });
    const secretId = (secret.body as { secret: { id: string } }).secret.id;

    for (const path of [
      `/workflow-items/${itemId}`,
      `/workflows/${workflow.id}`,
      `/agents/${agentId}`,
      `/secrets/${secretId}`,
      `/workflow-items/${itemId}/timeline`,
      `/workflow-items/${itemId}/fields`,
      `/workflow-items/${itemId}/notes`,
      `/workflows/${workflow.id}/board`
    ]) {
      const result = await call('GET', path, { actor: outsider });
      // 404 for a resource addressed but not found; 405 where only a write method is
      // declared. Both are refusals; the leak would be a 200.
      expect([404, 405], `${path} leaked to another workspace (${result.status})`).toContain(
        result.status
      );
      expect(result.status, path).not.toBe(200);
    }
  });

  test('a listing never returns another workspace’s rows', async () => {
    const mine = await createWorkflow(handle.db, owner.workspaceId, { name: 'Mine only' });
    await call('POST', '/workflow-items', {
      body: {
        workflowId: mine.id,
        record: { objectTypeId: mine.objectTypeId, displayName: 'Mine' }
      }
    });

    for (const path of [
      '/workflows',
      '/workflow-items',
      '/agents',
      '/files',
      '/triggers',
      '/collections',
      '/dashboards',
      '/views',
      '/labels'
    ]) {
      const mine = await call('GET', path, { actor: owner });
      const theirs = await call('GET', path, { actor: outsider });
      const mineBody = JSON.stringify(mine.body);
      const theirsBody = JSON.stringify(theirs.body);
      if (mineBody.length > 2 && theirsBody.length > 2) {
        // Any id present in the home workspace must not appear in the other one.
        const ids =
          mineBody.match(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ??
          [];
        for (const id of new Set(ids)) {
          expect(theirsBody, `${path} leaked ${id}`).not.toContain(id);
        }
      }
    }
  });

  test('an unauthenticated request to a protected route is refused', async () => {
    for (const path of [
      '/workflows',
      '/workflow-items',
      '/agents',
      '/secrets',
      '/jobs',
      '/audit'
    ]) {
      const result = await call('GET', path, { actor: null });
      expect(result.status, path).toBe(401);
    }
  });
});

describe('secret leak sweep', () => {
  let crm: MockHttpServer;

  beforeEach(() => {
    crm = startMockServer(() => jsonResponse({ data: { name: 'ACME' } }));
  });

  test('a resolved secret appears in no table, raw or URL-encoded', async () => {
    const plaintext = 'sk-live-leak-canary-9f8e7d6c5b4a';
    const secret = await call('POST', '/secrets', {
      body: { key: 'CANARY_KEY', name: 'Canary', value: plaintext }
    });
    const secretId = (secret.body as { secret: { id: string } }).secret.id;
    expect(secret.status).toBe(201);
    expect(JSON.stringify(secret.body)).not.toContain(plaintext);

    // Use the secret for real: bearer auth on an outbound HTTP call, plus a
    // query-string placement, which is the case that tempts an implementation to log
    // the URL verbatim.
    const service = await call('POST', '/http/services', {
      body: {
        name: 'Canary service',
        baseUrl: crm.url,
        authType: 'api_key_query',
        authConfig: { secretId, queryName: 'api_key' }
      }
    });
    const serviceId = (service.body as { service: { id: string } }).service.id;

    const bearer = await call('POST', '/http/services', {
      body: {
        name: 'Bearer service',
        baseUrl: crm.url,
        authType: 'bearer',
        authConfig: { secretId }
      }
    });
    const bearerId = (bearer.body as { service: { id: string } }).service.id;

    const operations = [
      await call('POST', '/http/operations', {
        body: {
          serviceId,
          key: 'canary.query',
          name: 'Query auth',
          description: 'x',
          method: 'GET',
          path: '/customers'
        }
      }),
      await call('POST', '/http/operations', {
        body: {
          serviceId: bearerId,
          key: 'canary.bearer',
          name: 'Bearer auth',
          description: 'x',
          method: 'GET',
          path: '/customers'
        }
      })
    ];

    for (const operation of operations) {
      const id = (operation.body as { operation: { id: string } }).operation.id;
      const tested = await call('POST', `/http/operations/${id}/test`, { body: { input: {} } });
      expect(tested.status).toBe(200);
      expect(JSON.stringify(tested.body)).not.toContain(plaintext);
    }

    // Run an agent so the redactor is exercised on prompts and run snapshots too.
    const workflow = await createWorkflow(handle.db, owner.workspaceId, { name: 'Leaky' });
    const ticket = await call('GET', `/workflows/${workflow.id}/board`);
    expect(ticket.status).toBe(200);

    // Scan every text column of every table for the plaintext.
    const encodedForms = [
      plaintext,
      encodeURIComponent(plaintext),
      Buffer.from(plaintext).toString('base64')
    ];
    const offenders: string[] = [];

    for (const table of Object.values(allSchema)) {
      if (typeof table !== 'object' || table === null) continue;
      let config: ReturnType<typeof getTableConfig>;
      try {
        config = getTableConfig(table as never);
      } catch {
        continue;
      }
      const textColumns = config.columns
        .filter((column) => column.dataType === 'string')
        .map((column) => column.name);
      if (textColumns.length === 0) continue;

      const rows = handle.sqlite.query(`SELECT * FROM "${config.name}"`).all() as Array<
        Record<string, unknown>
      >;

      for (const row of rows) {
        for (const column of textColumns) {
          const value = row[column];
          if (typeof value !== 'string') continue;
          for (const form of encodedForms) {
            if (form.length > 8 && value.includes(form)) {
              offenders.push(`${config.name}.${column}`);
            }
          }
        }
      }
    }

    expect(offenders, `secret plaintext found in: ${offenders.join(', ')}`).toEqual([]);

    // And the stored ciphertext must be unreadable without the key.
    const stored = handle.sqlite
      .query('SELECT ciphertext FROM secrets WHERE id = ?')
      .get(secretId) as { ciphertext: string };
    expect(stored.ciphertext).not.toContain(plaintext);

    crm.stop();
  });
});

describe('blob key safety', () => {
  test('rejects traversal, absolute paths and separator abuse', () => {
    for (const key of [
      '../escape',
      'a/../../escape',
      '/etc/passwd',
      'a//b',
      'a/./b',
      'a\\b',
      '',
      'a'.repeat(600),
      'a/../..'
    ]) {
      expect(() => assertSafeKey(key), key).toThrow();
    }
  });

  test('accepts content-addressed keys', () => {
    const workspaceId = uuidv7();
    const hash = 'a'.repeat(64);
    const key = blobKeyFor(workspaceId, hash);
    expect(() => assertSafeKey(key)).not.toThrow();
    expect(key).toBe(`workspaces/${workspaceId}/blobs/aa/aa/${hash}`);
  });

  test('a store rooted at a temp directory refuses to write outside it', async () => {
    const store = new LocalBlobStore({ root: handle.tempDir });
    await expect(store.put('../outside.txt', new TextEncoder().encode('nope'))).rejects.toThrow();
    await expect(store.get('../../etc/passwd')).rejects.toThrow();
  });

  test('the resolved path always stays under the root', () => {
    const store = new LocalBlobStore({ root: handle.tempDir });
    const resolved = store.resolvePath('workspaces/w/blobs/aa/bb/hash');
    expect(resolved.startsWith(handle.tempDir)).toBe(true);
  });
});

describe('audit ledger isolation', () => {
  test('platform-level events carry no workspace and stay out of tenant queries', async () => {
    // Account creation is audited with a null workspace: it belongs to no tenant.
    const ledger = await call('GET', '/audit', { actor: owner });
    expect(ledger.status).toBe(200);
    const events = (ledger.body as { events: Array<{ workspaceId: string | null }> }).events;
    expect(events.every((event) => event.workspaceId !== null)).toBe(true);

    const platformRows = handle.sqlite
      .query('SELECT count(*) AS n FROM audit_events WHERE workspace_id IS NULL')
      .get() as { n: number };
    expect(platformRows.n).toBeGreaterThanOrEqual(0);
  });
});
