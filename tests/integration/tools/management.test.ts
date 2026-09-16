/**
 * Tool management.
 *
 * Covers the surface added for grouping and creation: the catalogue's native
 * descriptors carry their row id and availability, enable/disable works per tool and
 * per group, OpenAPI documents import as HTTP tools, and an MCP server is discovered
 * and invoked end to end against an in-process mock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dispatchApi } from '../../../src/lib/server/api/router';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import { users } from '../../../src/lib/server/db/schema';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { listToolRows } from '../../../src/lib/server/tools/catalog';
import { invokeTool } from '../../../src/lib/server/tools/invoke';
import { getDefaultToolRegistry, resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let actor: ActorContext;
let mockMcp: { url: string; stop(): void } | null = null;

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const url = new URL(path, 'http://127.0.0.1');
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const result = await dispatchApi({
    db: handle.db,
    method,
    pathname: url.pathname,
    actor,
    query,
    rawBody,
    request: new Request(`http://127.0.0.1/api${path}`, {
      method,
      ...(rawBody === undefined
        ? {}
        : { body: rawBody, headers: { 'content-type': 'application/json' } })
    })
  });
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

/** A minimal Streamable-HTTP MCP server that advertises one `echo` tool. */
function startMockMcp(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const payload = (await request.json()) as {
        id?: unknown;
        method?: string;
        params?: { arguments?: Record<string, unknown> };
      };
      const reply = (result: unknown, init: ResponseInit = {}) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id ?? null, result }), {
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
        });

      if (payload.method === 'initialize') {
        return reply(
          {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'mock', version: '1' }
          },
          { headers: { 'mcp-session-id': 'session-1' } }
        );
      }
      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (payload.method === 'tools/list') {
        return reply({
          tools: [
            {
              name: 'echo',
              description: 'Echo text back',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text']
              }
            }
          ]
        });
      }
      if (payload.method === 'tools/call') {
        return reply({
          content: [{ type: 'text', text: `echo:${String(payload.params?.arguments?.text ?? '')}` }]
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          error: { code: -32601, message: 'no method' }
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      );
    }
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true)
  };
}

const openApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Widgets', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1:9' }],
  paths: {
    '/widgets': {
      get: { operationId: 'listWidgets', summary: 'List widgets', responses: {} },
      post: {
        operationId: 'createWidget',
        summary: 'Create widget',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              }
            }
          }
        },
        responses: {}
      }
    }
  }
};

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();

  const workspace = await createWorkspace(handle.db, 'Tools Co');
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@tools.test`,
      name: 'Tools Owner',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, userId, 'owner');
  actor = createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: userId,
    actorLabel: 'Tools Owner',
    role: 'owner',
    permissions: permissionsForRole('owner')
  });
  await runBootstrap({
    db: handle.db,
    sqlite: handle.sqlite,
    skipMigrations: true,
    startWorker: false
  });
});

afterEach(() => {
  mockMcp?.stop();
  mockMcp = null;
  handle.cleanup();
});

describe('tool catalogue', () => {
  test('native descriptors carry their row id and availability', async () => {
    const result = await call('GET', '/tools');
    expect(result.status).toBe(200);
    const native = result.body.native as Array<{
      key: string;
      rowId: string | null;
      enabled: boolean;
    }>;
    expect(native.length).toBeGreaterThan(0);
    for (const tool of native) {
      expect(tool.rowId, `${tool.key} should have a materialised row`).toBeTruthy();
      expect(tool.enabled).toBe(true);
    }
  });

  test('a disabled tool stays in the catalogue but leaves the picker list', async () => {
    const result = await call('GET', '/tools');
    const native = result.body.native as Array<{ key: string; rowId: string }>;
    const first = native[0]!;

    const disabled = await call('PATCH', `/tools/${first.rowId}`, { enabled: false });
    expect(disabled.status).toBe(200);

    const catalogue = await call('GET', '/tools');
    const stored = catalogue.body.stored as Array<{ id: string; key: string; enabled: boolean }>;
    const row = stored.find((tool) => tool.key === first.key);
    expect(row?.enabled).toBe(false);
    // The picker-facing list excludes disabled tools.
    expect(listToolRows(handle.db, actor).some((tool) => tool.key === first.key)).toBe(false);
  });

  test('a group can be disabled and re-enabled in one call', async () => {
    const result = await call('GET', '/tools');
    const stored = result.body.stored as Array<{ id: string; key: string }>;
    // All the materialised native tickets rows share the `mentat.ticket` prefix.
    const ids = stored
      .filter((tool) => tool.key.startsWith('mentat.ticket'))
      .map((tool) => tool.id);
    expect(ids.length).toBeGreaterThan(1);

    const off = await call('POST', '/tools/enabled', { ids, enabled: false });
    expect(off.status).toBe(200);

    let rows = (await call('GET', '/tools')).body.stored as Array<{ id: string; enabled: boolean }>;
    expect(rows.filter((row) => ids.includes(row.id)).every((row) => !row.enabled)).toBe(true);

    await call('POST', '/tools/enabled', { ids, enabled: true });
    rows = (await call('GET', '/tools')).body.stored as Array<{ id: string; enabled: boolean }>;
    expect(rows.filter((row) => ids.includes(row.id)).every((row) => row.enabled)).toBe(true);
  });
});

describe('OpenAPI import', () => {
  test('previews and imports selected operations as HTTP tools', async () => {
    const preview = await call('POST', '/openapi/preview', {
      document: JSON.stringify(openApiDocument)
    });
    expect(preview.status).toBe(200);
    const summary = preview.body.preview as {
      namespace: string;
      operations: Array<{ key: string }>;
    };
    expect(summary.namespace).toBe('widgets');
    expect(summary.operations.map((operation) => operation.key)).toEqual([
      'widgets.listwidgets',
      'widgets.createwidget'
    ]);

    const imported = await call('POST', '/openapi/import', {
      document: JSON.stringify(openApiDocument),
      keys: ['widgets.listwidgets'],
      service: { name: 'Widget API', baseUrl: 'http://127.0.0.1:9' }
    });
    expect(imported.status).toBe(201);
    expect(imported.body.imported).toBe(1);

    const catalogue = await call('GET', '/tools');
    const stored = catalogue.body.stored as Array<{ key: string; kind: string; enabled: boolean }>;
    const tool = stored.find((entry) => entry.key === 'widgets.listwidgets');
    expect(tool?.kind).toBe('http');
    expect(tool?.enabled).toBe(true);
  });

  test('rejects an import without a destination service', async () => {
    const imported = await call('POST', '/openapi/import', {
      document: JSON.stringify(openApiDocument),
      keys: ['widgets.listwidgets']
    });
    expect(imported.status).toBe(422);
  });
});

describe('MCP servers', () => {
  test('discovers, imports, invokes and removes an MCP tool', async () => {
    mockMcp = startMockMcp();

    const preview = await call('POST', '/mcp/servers/preview', {
      name: 'mock',
      url: mockMcp.url
    });
    expect(preview.status).toBe(200);
    const advertised = (preview.body.server as { tools: Array<{ name: string }> }).tools;
    expect(advertised.map((tool) => tool.name)).toEqual(['echo']);

    const created = await call('POST', '/mcp/servers', {
      name: 'mock',
      url: mockMcp.url,
      toolNames: ['echo']
    });
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(1);

    const catalogue = await call('GET', '/tools');
    const stored = catalogue.body.stored as Array<{
      id: string;
      key: string;
      kind: string;
      implementation: { kind: string; serverId?: string; toolName?: string };
      inputSchema: Record<string, unknown>;
    }>;
    const tool = stored.find((entry) => entry.key === 'mock.echo');
    expect(tool?.kind).toBe('mcp');
    expect(tool?.implementation.toolName).toBe('echo');

    const invocation = await invokeTool(handle.db, {
      key: tool!.key,
      toolId: tool!.id,
      kind: 'mcp',
      implementation: tool!.implementation as never,
      input: { text: 'hello' },
      inputSchema: tool!.inputSchema,
      actor,
      workspaceId: actor.workspaceId,
      registry: getDefaultToolRegistry()
    });
    expect(invocation.ok).toBe(true);
    expect(invocation.output).toBe('echo:hello');

    const servers = await call('GET', '/mcp/servers');
    const server = (servers.body.servers as Array<{ id: string }>)[0]!;
    const removed = await call('DELETE', `/mcp/servers/${server.id}`);
    expect(removed.status).toBe(204);

    const after = await call('GET', '/tools');
    const disabled = (after.body.stored as Array<{ key: string; enabled: boolean }>).find(
      (entry) => entry.key === 'mock.echo'
    );
    expect(disabled?.enabled).toBe(false);
  });

  test('reports a clear failure when the server is unreachable', async () => {
    const preview = await call('POST', '/mcp/servers/preview', {
      name: 'down',
      url: 'http://127.0.0.1:1/mcp'
    });
    expect(preview.status).toBe(422);
  });
});
