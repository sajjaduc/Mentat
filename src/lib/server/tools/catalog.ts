/**
 * Stored tool catalogue.
 *
 * Native tool *handlers* live in the in-process registry; the rows an agent binds to
 * live in the `tools` table, alongside HTTP-operation tools. This module is the
 * bridge: it materialises a row per registered native handler so the tool picker can
 * show them and an agent can be granted one by id, and it reads the stored side for
 * the API.
 *
 * Rows are created lazily and idempotently rather than in a migration, because the
 * set of native handlers is a build artifact: adding a handler should not require a
 * data migration, and a workspace created before that handler existed still gets it
 * the first time someone looks.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import { type Tool, tools } from '../db/schema';
import { getDefaultToolRegistry } from './registry';

export function listToolRows(db: Executor, actor: ActorContext): Tool[] {
  assertPermission(actor, Permissions.agentRead);
  return db
    .select()
    .from(tools)
    .where(and(eq(tools.workspaceId, actor.workspaceId), eq(tools.enabled, true)))
    .orderBy(asc(tools.key))
    .all();
}

/**
 * Every tool row for the catalogue, including disabled ones.
 *
 * The management surface must show a disabled tool so it can be switched back on;
 * `listToolRows` deliberately hides it from the pickers, where a disabled tool is
 * not grantable.
 */
export function catalogToolRows(db: Executor, actor: ActorContext): Tool[] {
  assertPermission(actor, Permissions.agentRead);
  return allToolRows(db, actor.workspaceId);
}

/** Workspace-scoped rows without a permission check; callers assert at their boundary. */
export function allToolRows(db: Executor, workspaceId: string): Tool[] {
  return db
    .select()
    .from(tools)
    .where(eq(tools.workspaceId, workspaceId))
    .orderBy(asc(tools.key))
    .all();
}

/** Enable or disable one tool row. Native rows are toggled like any other. */
export function setToolEnabled(
  db: Executor,
  actor: ActorContext,
  toolId: string,
  enabled: boolean
): Tool {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to change tool availability');
  const current =
    db
      .select()
      .from(tools)
      .where(and(eq(tools.workspaceId, actor.workspaceId), eq(tools.id, toolId)))
      .limit(1)
      .all()[0] ?? null;
  if (!current) throw errors.notFound('Tool', toolId);

  const now = Date.now();
  db.update(tools)
    .set({ enabled, updatedAt: now })
    .where(and(eq(tools.workspaceId, actor.workspaceId), eq(tools.id, toolId)))
    .run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.toolEnabledChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'tool',
    entityId: toolId,
    summary: `Tool "${current.key}" ${enabled ? 'enabled' : 'disabled'}`,
    data: { key: current.key, enabled }
  });

  return { ...current, enabled, updatedAt: now };
}

/** Enable or disable a set of tool rows together (a whole group, from the UI). */
export function setToolsEnabled(
  db: Executor,
  actor: ActorContext,
  toolIds: string[],
  enabled: boolean
): Tool[] {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to change tool availability');
  const unique = [...new Set(toolIds)];
  if (unique.length === 0) return [];

  const rows = db
    .select()
    .from(tools)
    .where(and(eq(tools.workspaceId, actor.workspaceId), inArray(tools.id, unique)))
    .all();
  const now = Date.now();
  db.update(tools)
    .set({ enabled, updatedAt: now })
    .where(and(eq(tools.workspaceId, actor.workspaceId), inArray(tools.id, unique)))
    .run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.toolEnabledChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'tool',
    entityId: null,
    summary: `${rows.length} tool(s) ${enabled ? 'enabled' : 'disabled'}`,
    data: { count: rows.length, enabled, toolIds: unique }
  });

  return rows.map((row) => ({ ...row, enabled, updatedAt: now }));
}

export interface EnsureNativeToolRowsResult {
  created: number;
  updated: number;
  total: number;
}

/**
 * Create or refresh a `tools` row for every registered native handler in one
 * workspace. Safe to call on every request that needs the catalogue; it is a single
 * select plus at most one insert per handler.
 */
export function ensureNativeToolRows(
  db: Executor,
  workspaceId: string
): EnsureNativeToolRowsResult {
  const handlers = getDefaultToolRegistry().list();
  if (handlers.length === 0) return { created: 0, updated: 0, total: 0 };

  const keys = handlers.map((handler) => handler.key);
  const existing = db
    .select()
    .from(tools)
    .where(and(eq(tools.workspaceId, workspaceId), inArray(tools.key, keys)))
    .all();
  const byKey = new Map(existing.map((row) => [row.key, row]));

  const now = Date.now();
  let created = 0;
  let updated = 0;

  for (const handler of handlers) {
    const current = byKey.get(handler.key);
    const values = {
      name: handler.name,
      description: handler.description,
      kind: 'native' as const,
      implementation: { kind: 'native', key: handler.key } as never,
      inputSchema: handler.inputSchema as never,
      outputSchema: (handler.outputSchema as never) ?? null,
      permissions: (handler.permission ? [handler.permission] : null) as never,
      approvalPolicy: (handler.approvalPolicy as never) ?? null,
      enabled: true
    };

    if (!current) {
      db.insert(tools)
        .values({
          id: uuidv7(now),
          workspaceId,
          key: handler.key,
          version: 1,
          createdAt: now,
          updatedAt: now,
          ...values
        })
        .onConflictDoNothing()
        .run();
      created += 1;
      continue;
    }

    // Keep the *description and schema* current, but never touch policy: an operator
    // may deliberately have set approval or caching on a native tool, and silently
    // resetting that on every request would be a security regression.
    if (current.name !== values.name || current.description !== values.description) {
      db.update(tools)
        .set({
          name: values.name,
          description: values.description,
          inputSchema: values.inputSchema,
          updatedAt: now
        })
        .where(eq(tools.id, current.id))
        .run();
      updated += 1;
    }
  }

  return { created, updated, total: handlers.length };
}

/** Native tool rows for one workspace, materialising them if necessary. */
export function nativeToolRows(db: Executor, workspaceId: string): Tool[] {
  ensureNativeToolRows(db, workspaceId);
  return db
    .select()
    .from(tools)
    .where(
      and(eq(tools.workspaceId, workspaceId), eq(tools.kind, 'native'), eq(tools.enabled, true))
    )
    .orderBy(asc(tools.key))
    .all();
}

/** Resolve stored tool rows by id, scoped to a workspace. */
export function toolRowsByIds(db: Executor, workspaceId: string, ids: string[]): Tool[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(tools)
    .where(and(eq(tools.workspaceId, workspaceId), inArray(tools.id, ids)))
    .all();
}
