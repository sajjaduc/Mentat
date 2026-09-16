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
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { writeAudit } from '../../../src/lib/server/audit/ledger';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import {
  auditEvents,
  ticketStateHistory,
  tickets as ticketsTable,
  users
} from '../../../src/lib/server/db/schema';
import { createFieldDefinition, setWorkflowFields } from '../../../src/lib/server/fields/service';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { getBoard, listTickets } from '../../../src/lib/server/tickets/query';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createWorkflow } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

const TICKET_COUNT = 1_200;
const PAGE_SIZE = 50;

let handle: TestDatabase;
let actor: ActorContext;
let workflowId: string;
let stateIds: string[];

/**
 * Seed directly against the schema: this test is about query behaviour, not about
 * the creation path, and 1,200 service calls would dominate the runtime.
 */
function seedTickets(): void {
  const now = Date.now();
  const priorities = ['low', 'medium', 'high', 'urgent'] as const;
  const rows: Array<typeof ticketsTable.$inferInsert> = [];

  for (let index = 0; index < TICKET_COUNT; index++) {
    const stateIndex = index % stateIds.length;
    rows.push({
      id: uuidv7(now + index),
      workspaceId: actor.workspaceId,
      workflowId,
      stateId: stateIds[stateIndex] as string,
      key: `SCALE-${index + 1}`,
      number: index + 1,
      title: `Ticket ${index + 1}`,
      description: index % 3 === 0 ? 'Contains the word deductible' : null,
      priority: priorities[index % priorities.length] as 'low' | 'medium' | 'high' | 'urgent',
      ownerUserId: index % 5 === 0 ? actor.actorId : null,
      enteredStateAt: now - (index % 90) * 60_000,
      lastActivityAt: now - (index % 30) * 60_000,
      waitingOn: stateIndex === 0 ? 'human' : 'agent',
      createdAt: now - index * 1_000,
      updatedAt: now - index * 1_000,
      version: 1,
      createdByType: 'user',
      createdById: actor.actorId
    });
  }

  // Chunked inserts keep each statement within SQLite's parameter limit.
  for (let offset = 0; offset < rows.length; offset += 200) {
    handle.db
      .insert(ticketsTable)
      .values(rows.slice(offset, offset + 200))
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

  const workflow = createWorkflow(handle.db, actor, { name: 'Scale', template: 'claims' });
  workflowId = workflow.workflow.id;
  stateIds = workflow.states.map((state) => state.id);
  seedTickets();
});

describe('keyset pagination at scale', () => {
  test('walking every page visits each ticket exactly once', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    while (true) {
      const page = await listTickets(handle.db, {
        workspaceId: actor.workspaceId,
        workflowId,
        limit: PAGE_SIZE,
        cursor
      });
      pages += 1;
      for (const row of page.rows) {
        expect(seen.has(row.ticket.id), `duplicate row: ${row.ticket.key}`).toBe(false);
        seen.add(row.ticket.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
      // Guard against an infinite loop if the cursor stops advancing.
      expect(pages).toBeLessThan(TICKET_COUNT);
    }

    expect(seen.size).toBe(TICKET_COUNT);
    expect(pages).toBe(Math.ceil(TICKET_COUNT / PAGE_SIZE));
  });

  test('total is reported independently of the page', async () => {
    const page = await listTickets(handle.db, {
      workspaceId: actor.workspaceId,
      workflowId,
      limit: 10
    });
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(TICKET_COUNT);
    expect(page.nextCursor).toBeTruthy();
  });

  test('a filtered pagination walk is also exact', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      const page = await listTickets(handle.db, {
        workspaceId: actor.workspaceId,
        workflowId,
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
        expect(row.ticket.priority).toBe('urgent');
        seen.add(row.ticket.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    // Priorities cycle through four values, so a quarter are urgent.
    expect(seen.size).toBe(TICKET_COUNT / 4);
  });
});

describe('query behaviour at scale', () => {
  test('a full board completes within a sane bound', async () => {
    const started = performance.now();
    const board = await getBoard(handle.db, {
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
      expect(column.tickets.length).toBeLessThanOrEqual(50);
      expect(column.total).toBeGreaterThan(0);
    }
    const totalAcrossColumns = board.columns.reduce((sum, column) => sum + column.total, 0);
    expect(totalAcrossColumns).toBe(TICKET_COUNT);

    expect(elapsed, `board took ${Math.round(elapsed)}ms`).toBeLessThan(3_000);
  });

  test('a custom-field filter stays bounded', async () => {
    const field = createFieldDefinition(handle.db, actor, {
      key: 'scale_amount',
      name: 'Amount',
      type: 'number'
    });
    setWorkflowFields(handle.db, actor, workflowId, [{ fieldDefinitionId: field.id }]);

    // Give a tenth of the tickets a value, then filter on it.
    const withValues = handle.db
      .select({ id: ticketsTable.id })
      .from(ticketsTable)
      .where(eq(ticketsTable.workflowId, workflowId))
      .limit(120)
      .all();
    for (const [index, row] of withValues.entries()) {
      handle.db.run(
        sql`INSERT INTO ticket_field_values (id, workspace_id, ticket_id, field_definition_id, value_number, updated_at)
            VALUES (${uuidv7()}, ${actor.workspaceId}, ${row.id}, ${field.id}, ${index * 10}, ${Date.now()})`
      );
    }

    const started = performance.now();
    const page = await listTickets(handle.db, {
      workspaceId: actor.workspaceId,
      workflowId,
      filter: { type: 'condition', kind: 'field', key: 'scale_amount', operator: 'gt', value: 1000 }
    });
    const elapsed = performance.now() - started;

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => Number(row.fields.scale_amount) > 1000)).toBe(true);
    expect(elapsed, `field filter took ${Math.round(elapsed)}ms`).toBeLessThan(2_000);
  });

  test('a long ticket timeline is returned in order and within a bound', async () => {
    const ticket = handle.db.select().from(ticketsTable).limit(1).all()[0]!;

    // 600 ledger rows for one ticket, written in one transaction.
    handle.db.transaction((tx) => {
      for (let index = 0; index < 600; index++) {
        writeAudit(tx as never, {
          workspaceId: actor.workspaceId,
          action: 'ticket.updated',
          entityType: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          workflowId,
          summary: `change ${index}`,
          data: { index }
        });
      }
    });

    const started = performance.now();
    const { queryAudit } = await import('../../../src/lib/server/audit/ledger');
    const events = await queryAudit(handle.db, {
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
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

  test('time-in-state reads history rather than scanning tickets', async () => {
    // 900 interval rows, then a per-state aggregate.
    const rows = handle.db.select().from(ticketsTable).limit(900).all();
    handle.db.transaction((tx) => {
      for (const [index, row] of rows.entries()) {
        tx.insert(ticketStateHistory)
          .values({
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            ticketId: row.id,
            workflowId,
            stateId: row.stateId,
            stateName: `State ${index % 5}`,
            stateKind: 'manual',
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
         FROM ticket_state_history
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
    const theirs = await listTickets(handle.db, { workspaceId: other.id, limit: 100 });
    expect(theirs.rows).toHaveLength(0);
    expect(theirs.total).toBe(0);

    const rows = handle.db
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, other.id))
      .all();
    expect(rows[0]?.count).toBe(0);
  });
});
