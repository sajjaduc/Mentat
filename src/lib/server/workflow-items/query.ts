/**
 * WorkflowItem listing and board queries (ADR-0021).
 *
 * Kanban columns are workflow states; cards are WorkflowItems backed by Records.
 * The query joins the Record for display but never treats Record fields as state.
 */
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import {
  agentRuns,
  records,
  users,
  workflowItemStateHistory,
  workflowItems,
  workflowStates,
  workflows
} from '../db/schema';

export interface ListWorkflowItemsOptions {
  workspaceId: string;
  workflowId?: string | null;
  recordId?: string | null;
  stateIds?: string[] | null;
  ownerUserId?: string | null;
  createdById?: string | null;
  waitingOn?: string | null;
  includeCompleted?: boolean;
  /** Include archived items (excluded by default). */
  includeArchived?: boolean;
  /** Items waiting on a trigger, or whose most recent run failed. */
  needsAttention?: boolean;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface WorkflowItemListRow {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowKey: string;
  recordId: string;
  recordDisplayName: string;
  recordKey: string | null;
  recordNumber: number | null;
  objectTypeId: string;
  stateId: string;
  stateName: string;
  stateKind: string;
  stateCategory: string;
  ownerUserId: string | null;
  ownerName: string | null;
  waitingOn: string | null;
  participation: string;
  enteredStateAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkflowItemPage {
  items: WorkflowItemListRow[];
  nextCursor: string | null;
  total: number;
}

export async function listWorkflowItems(
  db: Executor,
  options: ListWorkflowItemsOptions
): Promise<WorkflowItemPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions = buildConditions(options);
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      conditions.push(
        sql`(${workflowItems.updatedAt} < ${decoded.updatedAt} OR (${workflowItems.updatedAt} = ${decoded.updatedAt} AND ${workflowItems.id} < ${decoded.id}))`
      );
    }
  }
  const rows = await db
    .select({
      item: workflowItems,
      record: records,
      state: workflowStates,
      workflow: workflows,
      ownerName: users.name
    })
    .from(workflowItems)
    .innerJoin(records, eq(records.id, workflowItems.recordId))
    .innerJoin(workflowStates, eq(workflowStates.id, workflowItems.stateId))
    .innerJoin(workflows, eq(workflows.id, workflowItems.workflowId))
    .leftJoin(users, eq(users.id, workflowItems.ownerUserId))
    .where(and(...conditions))
    .orderBy(desc(workflowItems.updatedAt), desc(workflowItems.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const total = await countWorkflowItems(db, options);

  return {
    items: pageRows.map(mapRow),
    nextCursor: hasMore
      ? encodeCursor(pageRows[pageRows.length - 1] as { item: { updatedAt: number; id: string } })
      : null,
    total
  };
}

export async function listWorkflowItemsForRecord(
  db: Executor,
  workspaceId: string,
  recordId: string
): Promise<WorkflowItemListRow[]> {
  const page = await listWorkflowItems(db, {
    workspaceId,
    recordId,
    limit: 200
  });
  return page.items;
}

export interface WorkflowBoardColumn {
  state: {
    id: string;
    name: string;
    kind: string;
    category: string;
    color: string | null;
    position: number;
    wipLimit: number | null;
  };
  items: WorkflowItemListRow[];
  count: number;
}

export async function getWorkflowBoard(
  db: Executor,
  options: {
    workspaceId: string;
    workflowId: string;
    perColumnLimit?: number;
    /** Restrict to these item ids (e.g. the result of a board filter/search). */
    allowedIds?: ReadonlySet<string> | null;
  }
): Promise<{ columns: WorkflowBoardColumn[] }> {
  const states = await db
    .select()
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.workspaceId, options.workspaceId),
        eq(workflowStates.workflowId, options.workflowId)
      )
    )
    .orderBy(asc(workflowStates.position))
    .all();

  const items = await db
    .select({
      item: workflowItems,
      record: records,
      state: workflowStates,
      workflow: workflows,
      ownerName: users.name
    })
    .from(workflowItems)
    .innerJoin(records, eq(records.id, workflowItems.recordId))
    .innerJoin(workflowStates, eq(workflowStates.id, workflowItems.stateId))
    .innerJoin(workflows, eq(workflows.id, workflowItems.workflowId))
    .leftJoin(users, eq(users.id, workflowItems.ownerUserId))
    .where(
      and(
        eq(workflowItems.workspaceId, options.workspaceId),
        eq(workflowItems.workflowId, options.workflowId),
        isNull(workflowItems.archivedAt)
      )
    )
    .orderBy(desc(workflowItems.updatedAt))
    .all();

  const perColumn = Math.min(Math.max(options.perColumnLimit ?? 100, 1), 500);
  const visible = options.allowedIds
    ? items.filter((row) => options.allowedIds?.has(row.item.id))
    : items;
  return {
    columns: states.map((state) => {
      const stateItems = visible
        .filter((row) => row.item.stateId === state.id)
        .slice(0, perColumn)
        .map(mapRow);
      return {
        state: {
          id: state.id,
          name: state.name,
          kind: state.kind,
          category: state.category,
          color: state.color,
          position: state.position,
          wipLimit: null
        },
        items: stateItems,
        count: visible.filter((row) => row.item.stateId === state.id).length
      };
    })
  };
}

function buildConditions(options: ListWorkflowItemsOptions): SQL[] {
  const conditions: SQL[] = [eq(workflowItems.workspaceId, options.workspaceId)];
  if (!options.includeCompleted) conditions.push(isNull(workflowItems.completedAt));
  if (!options.includeArchived) conditions.push(isNull(workflowItems.archivedAt));
  if (options.workflowId) conditions.push(eq(workflowItems.workflowId, options.workflowId));
  if (options.recordId) conditions.push(eq(workflowItems.recordId, options.recordId));
  if (options.ownerUserId) conditions.push(eq(workflowItems.ownerUserId, options.ownerUserId));
  if (options.createdById) conditions.push(eq(workflowItems.createdById, options.createdById));
  if (options.waitingOn) conditions.push(eq(workflowItems.waitingOn, options.waitingOn as never));
  if (options.stateIds && options.stateIds.length > 0) {
    conditions.push(inArray(workflowItems.stateId, options.stateIds));
  }
  if (options.needsAttention) {
    conditions.push(
      or(
        eq(workflowItems.waitingOn, 'trigger'),
        sql`exists (select 1 from ${agentRuns} where ${agentRuns.workflowItemId} = ${workflowItems.id} and ${agentRuns.status} = 'failed')`
      ) as SQL
    );
  }
  if (options.search && options.search.trim().length > 0) {
    const term = `%${options.search.trim().toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${records.displayName}) LIKE ${term}`,
        sql`lower(coalesce(${records.key}, '')) LIKE ${term}`
      ) as SQL
    );
  }
  return conditions;
}

async function countWorkflowItems(
  db: Executor,
  options: ListWorkflowItemsOptions
): Promise<number> {
  const conditions = buildConditions(options);
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(workflowItems)
    .innerJoin(records, eq(records.id, workflowItems.recordId))
    .where(and(...conditions))
    .all();
  return Number(row[0]?.count ?? 0);
}

function mapRow(row: {
  item: typeof workflowItems.$inferSelect;
  record: typeof records.$inferSelect;
  state: typeof workflowStates.$inferSelect;
  workflow: typeof workflows.$inferSelect;
  ownerName: string | null;
}): WorkflowItemListRow {
  return {
    id: row.item.id,
    workflowId: row.item.workflowId,
    workflowName: row.workflow.name,
    workflowKey: row.workflow.key,
    recordId: row.item.recordId,
    recordDisplayName: row.record.displayName,
    recordKey: row.record.key,
    recordNumber: row.record.number,
    objectTypeId: row.record.objectTypeId,
    stateId: row.item.stateId,
    stateName: row.state.name,
    stateKind: row.state.kind,
    stateCategory: row.state.category,
    ownerUserId: row.item.ownerUserId,
    ownerName: row.ownerName,
    waitingOn: row.item.waitingOn,
    participation: row.item.participation,
    enteredStateAt: row.item.enteredStateAt,
    updatedAt: row.item.updatedAt,
    completedAt: row.item.completedAt
  };
}

/** Time-in-state over recorded intervals, for analytics and funnels. */
export async function workflowItemStateIntervals(
  db: Executor,
  workspaceId: string,
  workflowItemId: string
): Promise<Array<typeof workflowItemStateHistory.$inferSelect>> {
  return db
    .select()
    .from(workflowItemStateHistory)
    .where(
      and(
        eq(workflowItemStateHistory.workspaceId, workspaceId),
        eq(workflowItemStateHistory.workflowItemId, workflowItemId)
      )
    )
    .orderBy(asc(workflowItemStateHistory.enteredAt))
    .all();
}

function encodeCursor(row: { item: { updatedAt: number; id: string } }): string {
  return `${row.item.updatedAt}:${row.item.id}`;
}

function decodeCursor(cursor: string): { updatedAt: number; id: string } | null {
  const index = cursor.indexOf(':');
  if (index <= 0) return null;
  const updatedAt = Number(cursor.slice(0, index));
  const id = cursor.slice(index + 1);
  if (!Number.isFinite(updatedAt) || id.length === 0) return null;
  return { updatedAt, id };
}
