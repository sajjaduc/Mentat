/**
 * Model Context Protocol servers.
 *
 * MCP is the second way an external capability enters Mentat, alongside the
 * first-class HTTP service. The trust model is the same as HTTP: the *connection*
 * (URL, credential reference) lives on its own row, discovery materialises one
 * `tools` row per advertised tool, and execution happens through the same approval,
 * validation and audit path as every other tool — the runner never special-cases it.
 *
 * Only the Streamable HTTP transport is implemented. Every request is a JSON-RPC
 * POST; a response may be `application/json` or a single-event `text/event-stream`.
 * The `initialize` handshake captures an `Mcp-Session-Id` when the server issues one
 * and reuses it for the rest of the exchange.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors, toAppError } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { moduleLogger } from '../core/logger';
import { type Executor, withTransaction } from '../db/client';
import { type McpAuthConfig, type McpServer, mcpServers, tools } from '../db/schema';
import { resolveSecretValue } from '../secrets/service';
import type { JsonSchema } from './types';

const log = moduleLogger('mcp');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'mentat';
const CLIENT_VERSION = '0.1.0';
const MAX_PAGES = 20;

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface McpServerInput {
  name: string;
  description?: string | null;
  url: string;
  authType?: 'none' | 'bearer' | 'custom_header';
  authConfig?: McpAuthConfig | null;
  defaultHeaders?: Record<string, string> | null;
  timeoutMs?: number;
}

export interface McpToolSyncResult {
  server: McpServer;
  discovered: number;
  created: number;
  updated: number;
  tools: Array<{ id: string; key: string; name: string }>;
}

/** A model-facing, collision-safe key for a tool advertised by a server. */
export function mcpToolKey(server: Pick<McpServer, 'name'>, toolName: string): string {
  const namespace =
    server.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'mcp';
  const tool = toolName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 80);
  return `${namespace}.${tool || 'tool'}`.toLowerCase();
}

// ---------------------------------------------------------------- server rows

export function listMcpServers(
  db: Executor,
  actor: ActorContext,
  options: { includeArchived?: boolean } = {}
): McpServer[] {
  assertPermission(actor, Permissions.mcpRead, 'Not permitted to read MCP servers');
  const conditions = [eq(mcpServers.workspaceId, actor.workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(mcpServers.archivedAt));
  return db
    .select()
    .from(mcpServers)
    .where(and(...conditions))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getMcpServer(db: Executor, actor: ActorContext, serverId: string): McpServer {
  assertPermission(actor, Permissions.mcpRead, 'Not permitted to read MCP servers');
  const row = findServerRow(db, actor.workspaceId, serverId);
  if (!row) throw errors.notFound('MCP server', serverId);
  return row;
}

export function findServerRow(
  db: Executor,
  workspaceId: string,
  serverId: string
): McpServer | null {
  return (
    db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.id, serverId)))
      .limit(1)
      .all()[0] ?? null
  );
}

export async function createMcpServer(
  db: Executor,
  actor: ActorContext,
  input: McpServerInput
): Promise<McpServer> {
  assertPermission(actor, Permissions.mcpWrite, 'Not permitted to create MCP servers');
  assertValidServerInput(input);

  const duplicate = db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.workspaceId, actor.workspaceId),
        eq(mcpServers.name, input.name.trim()),
        isNull(mcpServers.archivedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (duplicate) {
    throw errors.conflict(`An MCP server named "${input.name.trim()}" already exists`);
  }

  const now = Date.now();
  const row: McpServer = {
    id: uuidv7(now),
    workspaceId: actor.workspaceId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    url: input.url.trim(),
    transport: 'http',
    authType: input.authType ?? 'none',
    authConfig: input.authConfig ?? null,
    defaultHeaders: input.defaultHeaders ?? null,
    timeoutMs: input.timeoutMs ?? 15000,
    enabled: true,
    lastDiscoveredAt: null,
    lastError: null,
    createdByUserId: actor.actorId,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  };

  return withTransaction(db, (tx) => {
    tx.insert(mcpServers).values(row).run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.mcpServerCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'mcp_server',
      entityId: row.id,
      summary: `MCP server "${row.name}" registered`,
      data: { url: row.url, authType: row.authType }
    });
    return row;
  });
}

export async function updateMcpServer(
  db: Executor,
  actor: ActorContext,
  serverId: string,
  patch: Partial<McpServerInput> & { enabled?: boolean }
): Promise<McpServer> {
  assertPermission(actor, Permissions.mcpWrite, 'Not permitted to update MCP servers');
  const current = findServerRow(db, actor.workspaceId, serverId);
  if (!current) throw errors.notFound('MCP server', serverId);

  const updates: Partial<McpServer> = { updatedAt: Date.now() };
  if (patch.name !== undefined) updates.name = patch.name.trim();
  if (patch.description !== undefined) updates.description = patch.description?.trim() || null;
  if (patch.url !== undefined) updates.url = patch.url.trim();
  if (patch.authType !== undefined) updates.authType = patch.authType;
  if (patch.authConfig !== undefined) updates.authConfig = patch.authConfig;
  if (patch.defaultHeaders !== undefined) updates.defaultHeaders = patch.defaultHeaders;
  if (patch.timeoutMs !== undefined) updates.timeoutMs = patch.timeoutMs;
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;

  assertValidServerInput({
    name: updates.name ?? current.name,
    url: updates.url ?? current.url,
    authType: updates.authType ?? current.authType,
    authConfig: updates.authConfig ?? current.authConfig,
    timeoutMs: updates.timeoutMs ?? current.timeoutMs
  });

  return withTransaction(db, (tx) => {
    tx.update(mcpServers)
      .set(updates)
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, actor.workspaceId)))
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.mcpServerUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'mcp_server',
      entityId: serverId,
      summary: `MCP server "${updates.name ?? current.name}" updated`,
      data: { changedFields: Object.keys(patch) }
    });
    return { ...current, ...updates } as McpServer;
  });
}

export async function archiveMcpServer(
  db: Executor,
  actor: ActorContext,
  serverId: string
): Promise<void> {
  assertPermission(actor, Permissions.mcpWrite, 'Not permitted to remove MCP servers');
  const current = findServerRow(db, actor.workspaceId, serverId);
  if (!current) throw errors.notFound('MCP server', serverId);

  const now = Date.now();
  await withTransaction(db, (tx) => {
    tx.update(mcpServers)
      .set({ archivedAt: now, enabled: false, updatedAt: now })
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, actor.workspaceId)))
      .run();
    // Tools derived from the server are disabled, not deleted: an agent that references
    // the tool id keeps a stable reference and simply loses the capability.
    disableServerTools(tx, actor.workspaceId, serverId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.mcpServerRemoved,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'mcp_server',
      entityId: serverId,
      summary: `MCP server "${current.name}" removed`,
      data: {}
    });
  });
}

/** Archive only the tools whose implementation points at this server. */
function disableServerTools(tx: Executor, workspaceId: string, serverId: string): void {
  const rows = tx
    .select({ id: tools.id, implementation: tools.implementation })
    .from(tools)
    .where(and(eq(tools.workspaceId, workspaceId), eq(tools.kind, 'mcp')))
    .all();
  const now = Date.now();
  for (const row of rows) {
    const implementation = row.implementation;
    if (implementation.kind === 'mcp' && implementation.serverId === serverId) {
      tx.update(tools)
        .set({ enabled: false, updatedAt: now })
        .where(and(eq(tools.id, row.id), eq(tools.workspaceId, workspaceId)))
        .run();
    }
  }
}

// ---------------------------------------------------------------- discovery

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * One JSON-RPC exchange over Streamable HTTP.
 *
 * `id` omitted means a notification, for which a server may answer `202` with no body.
 * The response body may be a single JSON object or one or more SSE `data:` frames.
 */
async function rpc(
  server: McpServer,
  db: Executor,
  payload: Record<string, unknown>,
  session: { id: string | null },
  externalSignal?: AbortSignal
): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...(server.defaultHeaders ?? {})
  };
  Object.assign(headers, resolveAuthHeaders(db, server));
  if (session.id) headers['mcp-session-id'] = session.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), server.timeoutMs);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  let response: Response;
  try {
    response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (failure) {
    throw errors.validation(`Could not reach the MCP server: ${describe(failure)}`, {
      url: server.url
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }

  const returnedSession = response.headers.get('mcp-session-id');
  if (returnedSession) session.id = returnedSession;

  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    throw errors.validation(
      `MCP server returned ${response.status} ${response.statusText}${
        text.length > 0 ? `: ${text.slice(0, 300)}` : ''
      }`,
      { url: server.url, status: response.status }
    );
  }
  if (text.trim().length === 0) return null;

  const contentType = response.headers.get('content-type') ?? '';
  const messages = contentType.includes('text/event-stream')
    ? parseSseMessages(text)
    : [parseJsonMessage(text)];

  const wantedId = payload.id;
  const answered =
    messages.find((message) => message !== null && message.id === wantedId) ??
    messages.find((message) => message !== null && message.id !== null) ??
    messages.find((message) => message !== null);
  if (!answered) {
    throw errors.validation('MCP server returned no JSON-RPC response', { url: server.url });
  }
  if (answered.error) {
    throw errors.validation(`MCP error: ${answered.error.message}`, {
      code: answered.error.code,
      data: answered.error.data
    });
  }
  return answered.result ?? null;
}

function parseJsonMessage(text: string): { id?: unknown; result?: unknown; error?: JsonRpcError } {
  try {
    return JSON.parse(text) as { id?: unknown; result?: unknown; error?: JsonRpcError };
  } catch {
    throw errors.validation('MCP server returned a malformed JSON-RPC response');
  }
}

function parseSseMessages(text: string): Array<{
  id?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}> {
  const messages: Array<{ id?: unknown; result?: unknown; error?: JsonRpcError }> = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (data.length === 0) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON frames (keep-alives, comments).
    }
  }
  return messages;
}

async function openSession(
  server: McpServer,
  db: Executor,
  externalSignal?: AbortSignal
): Promise<{ id: string | null }> {
  const session: { id: string | null } = { id: null };
  await rpc(
    server,
    db,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
      }
    },
    session,
    externalSignal
  );
  await rpc(
    server,
    db,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    session,
    externalSignal
  ).catch(() => undefined);
  return session;
}

/** Advertised tools, following `nextCursor` pagination to a bounded depth. */
export async function discoverMcpTools(
  db: Executor,
  server: McpServer,
  signal?: AbortSignal
): Promise<McpDiscoveredTool[]> {
  const session = await openSession(server, db, signal);
  const discovered: McpDiscoveredTool[] = [];
  let cursor: string | null = null;
  let requestId = 2;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await rpc(
      server,
      db,
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
        params: cursor ? { cursor } : {}
      },
      session,
      signal
    );
    requestId += 1;
    const record = asRecord(result);
    const list = Array.isArray(record?.tools) ? record.tools : [];
    for (const raw of list) {
      const tool = asRecord(raw);
      const name = typeof tool?.name === 'string' ? tool.name : null;
      if (!name) continue;
      discovered.push({
        name,
        description:
          typeof tool?.description === 'string' && tool.description.length > 0
            ? tool.description
            : `Tool "${name}" provided by ${server.name}`,
        inputSchema: normalizeInputSchema(tool?.inputSchema)
      });
    }
    const next = record?.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    cursor = next;
  }

  return discovered;
}

/**
 * Discover without persisting anything.
 *
 * The wizard needs to show what a server advertises — and fail with a real error —
 * before the operator commits a row. A transient server object is enough because
 * discovery only reads the connection fields.
 */
export async function previewMcpServer(
  db: Executor,
  actor: ActorContext,
  input: McpServerInput
): Promise<{ name: string; url: string; tools: McpDiscoveredTool[] }> {
  assertPermission(actor, Permissions.mcpWrite, 'Not permitted to inspect MCP servers');
  assertValidServerInput(input);
  const transient: McpServer = {
    id: 'preview',
    workspaceId: actor.workspaceId,
    name: input.name.trim() || 'MCP server',
    description: input.description?.trim() || null,
    url: input.url.trim(),
    transport: 'http',
    authType: input.authType ?? 'none',
    authConfig: input.authConfig ?? null,
    defaultHeaders: input.defaultHeaders ?? null,
    timeoutMs: input.timeoutMs ?? 15000,
    enabled: true,
    lastDiscoveredAt: null,
    lastError: null,
    createdByUserId: actor.actorId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null
  };
  const tools = await discoverMcpTools(db, transient);
  return { name: transient.name, url: transient.url, tools };
}

/** Discovery + materialise the `tools` rows, in one transaction. */
export async function syncMcpServerTools(
  db: Executor,
  actor: ActorContext,
  serverId: string,
  options: { includeToolNames?: string[] } = {}
): Promise<McpToolSyncResult> {
  assertPermission(actor, Permissions.mcpWrite, 'Not permitted to sync MCP servers');
  const server = findServerRow(db, actor.workspaceId, serverId);
  if (!server) throw errors.notFound('MCP server', serverId);
  if (server.archivedAt !== null) throw errors.precondition('MCP server is archived');

  let discovered: McpDiscoveredTool[];
  try {
    discovered = await discoverMcpTools(db, server);
    if (options.includeToolNames) {
      const included = new Set(options.includeToolNames);
      discovered = discovered.filter((tool) => included.has(tool.name));
    }
  } catch (failure) {
    const appError = toAppError(failure);
    // Record the failure on the row so the UI can show why a re-sync did nothing.
    db.update(mcpServers)
      .set({ lastError: appError.message, updatedAt: Date.now() })
      .where(eq(mcpServers.id, serverId))
      .run();
    throw failure;
  }

  const now = Date.now();
  const result = withTransaction(db, (tx) => {
    const existing = tx
      .select()
      .from(tools)
      .where(and(eq(tools.workspaceId, actor.workspaceId), eq(tools.kind, 'mcp')))
      .all();
    const byKey = new Map(existing.map((row) => [row.key, row]));
    let created = 0;
    let updated = 0;
    const synced: Array<{ id: string; key: string; name: string }> = [];

    for (const tool of discovered) {
      const key = mcpToolKey(server, tool.name);
      const current = byKey.get(key);
      if (
        current &&
        current.implementation.kind === 'mcp' &&
        current.implementation.serverId !== serverId
      ) {
        // A different server already owns this key; skipping is safer than silently
        // rebinding an agent's grant to another server.
        log.warn('mcp tool key collision', { key, serverId });
        continue;
      }

      const values = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as never,
        outputSchema: null,
        permissions: [Permissions.mcpInvoke] as never,
        implementation: {
          kind: 'mcp' as const,
          serverId,
          toolName: tool.name
        } as never,
        updatedAt: now,
        archivedAt: null
      };

      if (current) {
        tx.update(tools)
          .set({ ...values, enabled: true, version: current.version + 1 })
          .where(and(eq(tools.id, current.id), eq(tools.workspaceId, actor.workspaceId)))
          .run();
        updated += 1;
        synced.push({ id: current.id, key, name: tool.name });
      } else {
        const id = uuidv7(now);
        tx.insert(tools)
          .values({
            id,
            workspaceId: actor.workspaceId,
            key,
            kind: 'mcp',
            enabled: true,
            version: 1,
            createdAt: now,
            ...values
          })
          .onConflictDoNothing()
          .run();
        created += 1;
        synced.push({ id, key, name: tool.name });
      }
    }

    // Tools the server no longer advertises are disabled, preserving their ids.
    const advertised = new Set(synced.map((entry) => entry.id));
    for (const row of existing) {
      if (
        row.implementation.kind === 'mcp' &&
        row.implementation.serverId === serverId &&
        !advertised.has(row.id)
      ) {
        tx.update(tools)
          .set({ enabled: false, updatedAt: now })
          .where(and(eq(tools.id, row.id), eq(tools.workspaceId, actor.workspaceId)))
          .run();
      }
    }

    tx.update(mcpServers)
      .set({ lastDiscoveredAt: now, lastError: null, updatedAt: now })
      .where(eq(mcpServers.id, serverId))
      .run();

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.mcpToolsDiscovered,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'mcp_server',
      entityId: serverId,
      summary: `Discovered ${discovered.length} tool(s) from "${server.name}"`,
      data: { discovered: discovered.length, created, updated }
    });

    return {
      server: { ...server, lastDiscoveredAt: now, lastError: null },
      discovered: discovered.length,
      created,
      updated,
      tools: synced
    };
  });

  return result;
}

// ---------------------------------------------------------------- execution

export interface McpCallResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  durationMs?: number;
}

/**
 * Call a discovered tool. Text content is unwrapped to a string, structured content
 * is returned as-is, and `isError: true` becomes a structured tool failure.
 */
export async function callMcpTool(
  db: Executor,
  options: {
    server: McpServer;
    toolName: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }
): Promise<McpCallResult> {
  const startedAt = Date.now();
  try {
    const session = await openSession(options.server, db, options.signal);
    const result = await rpc(
      options.server,
      db,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: options.toolName, arguments: options.input }
      },
      session,
      options.signal
    );
    const record = asRecord(result);
    if (record?.isError === true) {
      return {
        ok: false,
        error: {
          code: 'mcp_tool_error',
          message: extractText(record) ?? 'The MCP tool reported an error',
          details: { toolName: options.toolName }
        },
        durationMs: Date.now() - startedAt
      };
    }
    const structured = record?.structuredContent;
    return {
      ok: true,
      output: structured ?? extractText(record) ?? result,
      durationMs: Date.now() - startedAt
    };
  } catch (failure) {
    const appError = toAppError(failure);
    return {
      ok: false,
      error: { code: appError.code, message: appError.message, details: appError.details },
      durationMs: Date.now() - startedAt
    };
  }
}

/** Resolve the server for a tool row, or a structured failure if it is gone. */
export function serverForTool(
  db: Executor,
  workspaceId: string,
  serverId: string
): McpServer | null {
  const row = findServerRow(db, workspaceId, serverId);
  return row && row.archivedAt === null ? row : null;
}

function extractText(record: Record<string, unknown> | null): string | null {
  const content = record?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null && entry.type === 'text')
    .map((entry) => (typeof entry.text === 'string' ? entry.text : ''));
  return texts.length > 0 ? texts.join('\n') : null;
}

// ---------------------------------------------------------------- helpers

function resolveAuthHeaders(db: Executor, server: McpServer): Record<string, string> {
  const config = server.authConfig ?? {};
  if (server.authType === 'none') return {};
  if (!config.secretId) {
    throw errors.validation('MCP authentication requires a secret reference');
  }
  const secret = resolveSecretValue(db, {
    workspaceId: server.workspaceId,
    secretId: config.secretId,
    purpose: 'mcp.request'
  });
  if (server.authType === 'bearer') {
    return { authorization: `Bearer ${secret}` };
  }
  const name = config.headerName?.trim();
  if (!name) throw errors.validation('A custom auth header requires a header name');
  const template = config.template ?? '{{secret}}';
  return { [name.toLowerCase()]: template.split('{{secret}}').join(secret) };
}

function assertValidServerInput(input: {
  name: string;
  url: string;
  authType?: string;
  authConfig?: McpAuthConfig | null;
  timeoutMs?: number;
}): void {
  if (input.name.trim().length === 0) throw errors.validation('An MCP server needs a name');
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw errors.validation('The MCP server URL must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw errors.validation('The MCP server URL must use http or https');
  }
  if (
    (input.authType === 'bearer' || input.authType === 'custom_header') &&
    !input.authConfig?.secretId
  ) {
    throw errors.validation('This authentication type requires a secret reference');
  }
  if (input.timeoutMs !== undefined && (input.timeoutMs < 1000 || input.timeoutMs > 120000)) {
    throw errors.validation('The MCP timeout must be between 1000 and 120000 ms');
  }
}

function normalizeInputSchema(schema: unknown): JsonSchema {
  const record = asRecord(schema);
  if (!record) return { type: 'object', properties: {}, additionalProperties: false };
  return record as JsonSchema;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describe(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  return String(failure);
}

export { disableServerTools };
