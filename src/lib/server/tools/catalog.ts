/**
 * Stored tool catalogue.
 *
 * Native tools live in the in-process registry; HTTP tools live in the database as
 * `tools` rows (synced from `http_operations`). This module reads the stored side
 * so the tool picker can show both together without the API layer knowing where a
 * tool comes from.
 */
import { and, asc, eq } from 'drizzle-orm';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import type { Executor } from '../db/client';
import { type Tool, tools } from '../db/schema';

export function listToolRows(db: Executor, actor: ActorContext): Tool[] {
  assertPermission(actor, Permissions.agentRead);
  return db
    .select()
    .from(tools)
    .where(and(eq(tools.workspaceId, actor.workspaceId), eq(tools.enabled, true)))
    .orderBy(asc(tools.key))
    .all();
}
