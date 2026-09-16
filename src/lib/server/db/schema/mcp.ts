/**
 * MCP servers.
 *
 * A Model Context Protocol server is a reachable endpoint that advertises a set of
 * tools. Mentat stores the *connection* here (URL, transport, credential reference)
 * and materialises one `tools` row per discovered tool with
 * `implementation.kind = 'mcp'`. Keeping the connection separate means a re-sync can
 * refresh every tool's schema without re-entering the URL, and the credential is
 * referenced by secret id — never stored inline (the same rule HTTP services follow,
 * ADR-0020).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { users, workspaces } from './tenancy';

/** How Mentat talks to the server. `http` is Streamable HTTP; `sse` is the legacy SSE transport. */
export type McpTransport = 'http' | 'sse';

export type McpAuthType = 'none' | 'bearer' | 'custom_header';

export interface McpAuthConfig {
  /** Secret reference; resolved only inside execution, never serialized outward. */
  secretId?: string;
  /** Header name for `custom_header`, e.g. `X-Api-Key`. */
  headerName?: string;
  /** Template for a custom header, e.g. `Bearer {{secret}}`. */
  template?: string;
}

export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    url: text('url').notNull(),
    transport: text('transport').$type<McpTransport>().notNull().default('http'),
    authType: text('auth_type').$type<McpAuthType>().notNull().default('none'),
    authConfig: json<McpAuthConfig>('auth_config'),
    defaultHeaders: json<Record<string, string>>('default_headers'),
    timeoutMs: integer('timeout_ms').notNull().default(15000),
    enabled: bool('enabled', true),
    /** Epoch ms of the last successful `tools/list`; null until first discovery. */
    lastDiscoveredAt: epochMs('last_discovered_at'),
    /** Redacted failure from the last discovery attempt, for the UI. */
    lastError: text('last_error'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('mcp_servers_name_unique').on(table.workspaceId, table.name),
    index('mcp_servers_workspace_idx').on(table.workspaceId, table.archivedAt)
  ]
);

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
