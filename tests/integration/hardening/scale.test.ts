/**
 * Scale and pagination sanity.
 *
 * Two things degrade quietly as data grows, so they get an explicit test:
 *
 *  1. **Keyset pagination.** Walking every page must visit every row exactly once.
 *     A cursor bug shows up as duplicates or gaps only at scale, and only on the
 *     second page.
 *  2. **Board and filter queries.** The time bounds here are generous sanity limits,
 *     not benchmarks: they fail if an index is dropped or a query degenerates into a
 *     per-row scan, which is the failure mode that actually matters.
 *
 * The dataset is sized to stay fast in CI while still exercising a real index path.
 * ADR-0021 made work `records` + `workflow_items`; the dataset seeds both.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { queryAudit, writeAudit } from '../../../src/lib/server/audit/ledger';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import {
  auditEvents,
  recordFieldValues,
  records,
  users,
  workflowItemStateHistory,
  workflowItems
} from '../../../src/lib/server/db/schema';
import { createFieldDefinition } from '../../../src/lib/server/fields/service';
import { filterWorkflowItems } from '../../../src/lib/server/filters/compile';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { createObjectType } from '../../../src/lib/server/records/object-types';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { getWorkflowBoard, listWorkflowItems } from '../../../src/lib/server/workflow-items/query';
import { createWorkflow } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

const ITEM_COUNT = 1_200;
const PAGE_SIZE = 50;

let handle: TestDatabase;
let actor: ActorContext;
let objectTypeId: string;
let workflowId: string;
let stateIds: string[];

/**
 * Seed directly against the schema: this test is about query behaviour, not about
 * the creation path, and 1,200 service calls would dominate the runtime.
 */
function seedWorkItems(): void {
  const now = Date.now();
  const priorities = ['low', 'medium', 'high', 'urgent'] as const;
  const recordRows: Array<typeof records.$inferInsert> = [];
  const itemRows: Array<typeof workflowItems.$inferInsert> = [];

  for (let index = 0; index < ITEM_COUNT; index++) {
    const stateIndex = index % stateIds.length;
    const recordId = uuidv7(now + index);
    const updatedAt = now - index * 1_000;
    recordRows.push({
      id: recordId,
      workspaceId: actor.workspaceId,
      objectTypeId,
      displayName: `Work item ${index + 1}`,
      key: `SCALE-${index + 1}`,
      number: index + 1,
      // `priority` is a Record system field in the universal model.
      structuredData: { priority: priorities[index % priorities.length] },
      lastActivityAt: now - (index % 30) * 60_000,
      createdAt: now - index * 1_000,
      updatedAt,
      version: 1,
      createdByType: 'user',
      createdById: actor.actorId
    });
    itemRows.push({
      id: uuidv7(now + index),
      workspaceId: actor.workspaceId,
      workflowId,
      recordId,
      stateId: stateIds[stateIndex] as string,
      structuredData: null,
      ownerUserId: index % 5 === 0 ? actor.actorId : null,
      enteredStateAt: now - (index % 90) * 60_000,
      lastActivityAt: now - (index % 30) * 60_000,
      waitingOn: stateIndex === 0 ? 'human' : 'agent',
      participation: 'primary',
      stateRunCount: 0,
      createdAt: now - index * 1_000,
      updatedAt,
      version: 1,
      createdByType: 'user',
      createdById: actor.actorId
    });
  }

  // Chunked inserts keep each statement within SQLite's parameter limit.
  for (let offset = 0; offset < ITEM_COUNT; offset += 100) {
    handle.db
      .insert(records)
      .values(recordRows.slice(offset, offset + 100))
      .run();
    handle.db
      .insert(workflowItems)
      .values(itemRows.slice(offset, offset + 100))
      .run();
  }
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();

  const workspace = await createWorkspace(handle.db, 'Scale Co');
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@scale.test`,
      name: 'Scale Owner',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, userId, 'owner');
  actor = createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: userId,
    actorLabel: 'Scale Owner',
    role: 'owner',
    permissions: permissionsForRole('owner')
  });

  await runBootstrap({
    db: handle.db,
    sqlite: handle.sqlite,
    skipMigrations: true,
    startWorker: false
  });

  objectTypeId = createObjectType(handle.db, actor, { name: 'Scale Work', key: 'scale_work' }).id;
  const workflow = createWorkflow(handle.db, actor, {
    name: 'Scale',
    template: 'claims',
    objectTypeId
  });
  workflowId = workflow.workflow.id;
  stateIds = workflow.states.map((state) => state.id);
  seedWorkItems();
});

describe('keyset pagination at scale', () => {
  test('walking every page visits each work item exactly once', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    while (true) {
      const page = await listWorkflowItems(handle.db, {
        workspaceId: actor.workspaceId,
        workflowId,
        limit: PAGE_SIZE,
        cursor
      });
      pages += 1;
      for (const row of page.items) {
        expect(seen.has(row.id), `duplicate row: ${row.recordKey}`).toBe(false);
        seen.add(row.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      // Guard against an infinite loop if the cursor stops advancing.
      expect(pages).toBeLessThan(ITEM_COUNT);
    }

    expect(seen.size).toBe(ITEM_COUNT);
    expect(pages).toBe(Math.ceil(ITEM_COUNT / PAGE_SIZE));
  });

  test('total is reported independently of the page', async () => {
    const page = await listWorkflowItems(handle.db, {
      workspaceId: actor.workspaceId,
      workflowId,
      limit: 10
    });
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(ITEM_COUNT);
    expect(page.nextCursor).toBeTruthy();
  });

  test('a filtered pagination walk is also exact', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      const page = await filterWorkflowItems(handle.db, {
        workspaceId: actor.workspaceId,
        limit: PAGE_SIZE,
        cursor,
        filter: {
          type: 'condition',
          kind: 'system',
          key: 'priority',
          operator: 'eq',
          value: 'urgent'
        }
      });
      for (const row of page.rows) {
        seen.add(row.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    // Priorities cycle through four values, so a quarter are urgent.
    expect(seen.size).toBe(ITEM_COUNT / 4);
  });
});

describe('query behaviour at scale', () => {
  test('a full board completes within a sane bound', async () => {
    const started = performance.now();
    const board = await getWorkflowBoard(handle.db, {
      workspaceId: actor.workspaceId,
      workflowId,
      perColumnLimit: 50
    });
    const elapsed = performance.now() - started;

    const states = handle.sqlite
      .query('SELECT count(*) AS n FROM workflow_states WHERE workflow_id = ?')
      .get(workflowId) as { n: number };
    expect(board.columns).toHaveLength(states.n);

    // Every column is capped at the limit even though it holds more rows.
    for (const column of board.columns) {
      expect(column.items.length).toBeLessThanOrEqual(50);
      expect(column.count).toBeGreaterThan(0);
    }
    const totalAcrossColumns = board.columns.reduce((sum, column) => sum + column.count, 0);
    expect(totalAcrossColumns).toBe(ITEM_COUNT);

    expect(elapsed, `board took ${Math.round(elapsed)}ms`).toBeLessThan(3_000);
  });

  test('a custom-field filter stays bounded', async () => {
    const field = createFieldDefinition(handle.db, actor, {
      key: 'scale_amount',
      name: 'Amount',
      type: 'number'
    });

    // Give a tenth of the records a value, then filter on it.
    const withValues = handle.db
      .select({ id: records.id })
      .from(records)
      .where(eq(records.workspaceId, actor.workspaceId))
      .limit(120)
      .all();
    const qualifying = new Set<string>();
    for (const [index, row] of withValues.entries()) {
      const value = index * 10;
      handle.db
        .insert(recordFieldValues)
        .values({
          id: uuidv7(),
          workspaceId: actor.workspaceId,
          recordId: row.id,
          fieldDefinitionId: field.id,
          valueNumber: value,
          updatedAt: Date.now()
        })
        .run();
      if (value > 1_000) qualifying.add(row.id);
    }

    const started = performance.now();
    const page = await filterWorkflowItems(handle.db, {
      workspaceId: actor.workspaceId,
      filter: { type: 'condition', kind: 'field', key: 'scale_amount', operator: 'gt', value: 1000 }
    });
    const elapsed = performance.now() - started;

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => qualifying.has(row.recordId))).toBe(true);
    expect(page.rows.length).toBe(qualifying.size);
    expect(elapsed, `field filter took ${Math.round(elapsed)}ms`).toBeLessThan(2_000);
  });

  test('a long work-item timeline is returned in order and within a bound', async () => {
    const item = handle.db.select().from(workflowItems).limit(1).all()[0]!;

    // 600 ledger rows for one work item, written in one transaction.
    handle.db.transaction((tx) => {
      for (let index = 0; index < 600; index++) {
        writeAudit(tx as never, {
          workspaceId: actor.workspaceId,
          action: 'workflow_item.updated',
          entityType: 'workflow_item',
          entityId: item.id,
          recordId: item.recordId,
          workflowItemId: item.id,
          workflowId,
          summary: `change ${index}`,
          data: { index }
        });
      }
    });

    const started = performance.now();
    const events = await queryAudit(handle.db, {
      workspaceId: actor.workspaceId,
      workflowItemId: item.id,
      limit: 500,
      order: 'desc'
    });
    const elapsed = performance.now() - started;

    expect(events).toHaveLength(500);
    // Sequence ordinals must be strictly descending in a newest-first read.
    for (let index = 1; index < events.length; index++) {
      expect((events[index]!.seq as number) < (events[index - 1]!.seq as number)).toBe(true);
    }
    expect(elapsed, `timeline took ${Math.round(elapsed)}ms`).toBeLessThan(1_500);
  });

  test('time-in-state reads history rather than scanning work items', async () => {
    // 900 interval rows, then a per-state aggregate.
    const rows = handle.db.select().from(workflowItems).limit(900).all();
    handle.db.transaction((tx) => {
      for (const [index, row] of rows.entries()) {
        tx.insert(workflowItemStateHistory)
          .values({
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            workflowItemId: row.id,
            workflowId,
            stateId: row.stateId,
            stateName: `State ${index % 5}`,
            stateKind: 'manual',
            previousStateId: null,
            enteredAt: row.enteredStateAt,
            exitedAt: row.enteredStateAt + 3_600_000,
            durationMs: 3_600_000,
            enteredByType: 'user'
          })
          .run();
      }
    });

    const started = performance.now();
    const aggregate = handle.sqlite
      .query(
        `SELECT state_id, count(*) AS entries, avg(duration_ms) AS avg_ms
         FROM workflow_item_state_history
         WHERE workspace_id = ?
         GROUP BY state_id`
      )
      .all(actor.workspaceId) as Array<{ entries: number; avg_ms: number }>;
    const elapsed = performance.now() - started;

    expect(aggregate.length).toBeGreaterThan(1);
    expect(aggregate.every((row) => row.avg_ms === 3_600_000)).toBe(true);
    expect(elapsed, `aggregate took ${Math.round(elapsed)}ms`).toBeLessThan(500);
  });

  test('the workspace boundary holds at scale', async () => {
    const other = await createWorkspace(handle.db, 'Other Scale Co');
    const theirs = await listWorkflowItems(handle.db, { workspaceId: other.id, limit: 100 });
    expect(theirs.items).toHaveLength(0);
    expect(theirs.total).toBe(0);

    const rows = handle.db
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, other.id))
      .all();
    expect(rows[0]?.count).toBe(0);
  });

  test('the legacy ticket tables are gone (ADR-0021)', () => {
    const names = new Set(
      (
        handle.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );
    for (const legacy of [
      'tickets',
      'ticket_state_history',
      'ticket_workflow_history',
      'ticket_field_values',
      'ticket_files'
    ]) {
      expect(names.has(legacy), `legacy table still present: ${legacy}`).toBe(false);
    }
    for (const universal of [
      'records',
      'workflow_items',
      'workflow_item_state_history',
      'record_field_values'
    ]) {
      expect(names.has(universal), `universal table missing: ${universal}`).toBe(true);
    }
  });
});
