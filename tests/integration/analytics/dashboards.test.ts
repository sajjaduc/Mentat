import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  addWidget,
  createDashboard,
  deleteDashboard,
  deleteWidget,
  getDashboard,
  listDashboards,
  runDashboard,
  setDashboardLayout,
  updateDashboard,
  updateWidget
} from '../../../src/lib/server/analytics/dashboards';
import { createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { isAppError } from '../../../src/lib/server/core/errors';
import type { Executor } from '../../../src/lib/server/db/client';
import { auditEvents } from '../../../src/lib/server/db/schema';
import type { FilterAst } from '../../../src/lib/server/filters/ast';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createDashboardRecord,
  createField,
  createTicket,
  createUser,
  createWidgetRecord,
  createWorkflow,
  createWorkspace,
  memberActor,
  ownerActor,
  setTypedFieldValue,
  type UserFixture,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let workflow: WorkflowFixture;
let owner: UserFixture;
let other: UserFixture;
let ownerView: ReturnType<typeof ownerActor>;
let amountField: string;
const ids: Record<string, string> = {};

const highPriority: FilterAst = {
  type: 'condition',
  kind: 'system',
  key: 'priority',
  operator: 'eq',
  value: 'high'
};

async function seed(): Promise<void> {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Dashboards WS');
  workspaceId = workspace.id;
  workflow = await createWorkflow(db, workspaceId);
  owner = await createUser(db, { name: 'Owner' });
  other = await createUser(db, { name: 'Other' });
  ownerView = ownerActor(workspaceId, owner.id);
  amountField = await createField(db, { workspaceId, key: 'amount', type: 'currency' });

  const specs = [
    { key: 'A', priority: 'high' as const, amount: 100 },
    { key: 'B', priority: 'high' as const, amount: 200 },
    { key: 'C', priority: 'low' as const, amount: 300 }
  ];
  for (const spec of specs) {
    const ticket = await createTicket(db, {
      workspaceId,
      workflow,
      title: spec.key,
      priority: spec.priority
    });
    ids[spec.key] = ticket.id;
    await setTypedFieldValue(db, {
      workspaceId,
      ticketId: ticket.id,
      fieldDefinitionId: amountField,
      type: 'currency',
      value: spec.amount
    });
  }
}

async function auditActions(): Promise<string[]> {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .all();
  return rows.map((row) => row.action);
}

beforeEach(seed);
afterEach(() => handle.cleanup());

describe('dashboards: CRUD and audit', () => {
  test('creates, lists, reads and updates a dashboard with validated global filters', async () => {
    const dashboard = await createDashboard(db, ownerView, {
      name: 'Ops',
      description: 'Operations board',
      globalFilters: highPriority,
      isDefault: true
    });
    expect(dashboard.name).toBe('Ops');
    expect(dashboard.isDefault).toBe(true);

    const detail = await getDashboard(db, ownerView, dashboard.id);
    expect(detail.globalFilter).toEqual(highPriority);
    expect(detail.widgets).toEqual([]);
    expect((await listDashboards(db, ownerView)).map((entry) => entry.id)).toContain(dashboard.id);

    const updated = await updateDashboard(db, ownerView, dashboard.id, { name: 'Operations' });
    expect(updated.name).toBe('Operations');
    expect(await auditActions()).toContain('dashboard.created');
    expect(await auditActions()).toContain('dashboard.updated');
  });

  test('rejects an invalid global filter and a duplicate name', async () => {
    let code: string | undefined;
    try {
      await createDashboard(db, ownerView, {
        name: 'Broken',
        globalFilters: { type: 'condition', kind: 'system', key: 'priority', operator: 'x' }
      });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('validation_failed');

    await createDashboard(db, ownerView, { name: 'Unique' });
    code = undefined;
    try {
      await createDashboard(db, ownerView, { name: 'Unique' });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('conflict');
  });

  test('deletes a dashboard and audits it', async () => {
    const dashboard = await createDashboard(db, ownerView, { name: 'Temp' });
    await deleteDashboard(db, ownerView, dashboard.id);
    expect(await listDashboards(db, ownerView)).toHaveLength(0);
    expect(await auditActions()).toContain('dashboard.deleted');
  });
});

describe('dashboards: permissions and privacy', () => {
  test('requires analytics permissions', async () => {
    const nobody = createActorContext({
      workspaceId,
      actorType: 'user',
      actorId: other.id,
      role: 'member',
      permissions: []
    });
    let code: string | undefined;
    try {
      await createDashboard(db, nobody, { name: 'Nope' });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('forbidden');

    const reader = createActorContext({
      workspaceId,
      actorType: 'user',
      actorId: other.id,
      role: 'member',
      permissions: [Permissions.analyticsRead]
    });
    // Reading is allowed; writing is not.
    await listDashboards(db, reader);
    code = undefined;
    try {
      await createDashboard(db, reader, { name: 'Nope' });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('forbidden');
  });

  test('hides a private dashboard from other members', async () => {
    const privateDashboard = await createDashboard(db, ownerView, {
      name: 'Private',
      isShared: false
    });
    const member = memberActor(workspaceId, other.id);
    expect(
      (await listDashboards(db, member)).some((entry) => entry.id === privateDashboard.id)
    ).toBe(false);
    let code: string | undefined;
    try {
      await getDashboard(db, member, privateDashboard.id);
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('not_found');
  });

  test('isolates dashboards per workspace', async () => {
    const otherWorkspace = await createWorkspace(db, 'Other');
    const otherOwner = ownerActor(otherWorkspace.id, other.id);
    const foreign = await createDashboard(db, otherOwner, { name: 'Foreign' });
    let code: string | undefined;
    try {
      await getDashboard(db, ownerView, foreign.id);
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('not_found');
  });
});

describe('dashboards: widgets and layout', () => {
  test('adds, updates and deletes widgets and persists layout', async () => {
    const dashboard = await createDashboard(db, ownerView, { name: 'Board' });
    const kpi = await addWidget(db, ownerView, dashboard.id, {
      title: 'Count',
      type: 'kpi',
      dataSource: { kind: 'tickets' },
      measure: { aggregation: 'count' }
    });
    const sum = await addWidget(db, ownerView, dashboard.id, {
      title: 'Amount',
      type: 'number',
      dataSource: { kind: 'tickets' },
      measure: { aggregation: 'sum', fieldKey: 'amount' }
    });

    let detail = await getDashboard(db, ownerView, dashboard.id);
    expect(detail.widgets.map((entry) => entry.id)).toEqual([kpi.id, sum.id]);

    const renamed = await updateWidget(db, ownerView, kpi.id, { title: 'Ticket count' });
    expect(renamed.title).toBe('Ticket count');

    const layout = [
      { widgetId: kpi.id, x: 0, y: 0, w: 6, h: 4 },
      { widgetId: sum.id, x: 6, y: 0, w: 6, h: 4 }
    ];
    await setDashboardLayout(db, ownerView, dashboard.id, layout);
    detail = await getDashboard(db, ownerView, dashboard.id);
    expect(detail.layout).toEqual(layout);

    await deleteWidget(db, ownerView, sum.id);
    detail = await getDashboard(db, ownerView, dashboard.id);
    expect(detail.widgets.map((entry) => entry.id)).toEqual([kpi.id]);
  });

  test('rejects a widget on a dashboard in another workspace', async () => {
    const otherWorkspace = await createWorkspace(db, 'Other');
    const otherOwner = ownerActor(otherWorkspace.id, other.id);
    const foreign = await createDashboard(db, otherOwner, { name: 'Foreign' });
    let code: string | undefined;
    try {
      await addWidget(db, ownerView, foreign.id, {
        title: 'Nope',
        type: 'kpi',
        dataSource: { kind: 'tickets' },
        measure: { aggregation: 'count' }
      });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('not_found');
  });
});

describe('dashboards: run', () => {
  test('runs every widget and combines the dashboard global filter', async () => {
    const dashboard = await createDashboard(db, ownerView, {
      name: 'Board',
      globalFilters: highPriority
    });
    const countWidget = await addWidget(db, ownerView, dashboard.id, {
      title: 'Count',
      type: 'kpi',
      dataSource: { kind: 'tickets' },
      measure: { aggregation: 'count' }
    });
    const sumWidget = await addWidget(db, ownerView, dashboard.id, {
      title: 'Amount over 150',
      type: 'number',
      dataSource: { kind: 'tickets' },
      filter: {
        type: 'condition',
        kind: 'field',
        key: 'amount',
        operator: 'gt',
        value: 150
      },
      measure: { aggregation: 'sum', fieldKey: 'amount' }
    });

    const result = await runDashboard(db, { workspaceId, dashboardId: dashboard.id });
    // Global filter (high priority) narrows the count to A and B.
    expect(result.results[countWidget.id]?.value).toBe(2);
    // Widget-local amount > 150 AND global high priority -> only B.
    expect(result.results[sumWidget.id]?.value).toBe(200);
    expect(Object.keys(result.results).sort()).toEqual([countWidget.id, sumWidget.id].sort());
  });

  test('an external global filter is ANDed with the dashboard filter', async () => {
    const dashboard = await createDashboard(db, ownerView, { name: 'Board' });
    const countWidget = await addWidget(db, ownerView, dashboard.id, {
      title: 'Count',
      type: 'kpi',
      dataSource: { kind: 'tickets' },
      measure: { aggregation: 'count' }
    });
    const result = await runDashboard(db, {
      workspaceId,
      dashboardId: dashboard.id,
      globalFilter: highPriority
    });
    expect(result.results[countWidget.id]?.value).toBe(2);
  });

  test('runs widgets seeded directly in the workspace without leaking others', async () => {
    const dashboardId = await createDashboardRecord(db, {
      workspaceId,
      name: 'Seeded',
      createdByUserId: owner.id
    });
    await createWidgetRecord(db, {
      workspaceId,
      dashboardId,
      type: 'kpi',
      dataSource: { kind: 'tickets' },
      measure: { aggregation: 'count' }
    });

    const otherWorkspace = await createWorkspace(db, 'Other');
    const otherOwner = ownerActor(otherWorkspace.id, other.id);
    const otherDashboard = await createDashboard(db, otherOwner, { name: 'Other board' });
    const foreignWidget = await createWidgetRecord(db, {
      workspaceId: otherWorkspace.id,
      dashboardId: otherDashboard.id,
      type: 'kpi',
      dataSource: { kind: 'tickets' },
      measure: { aggregation: 'count' }
    });

    const result = await runDashboard(db, { workspaceId, dashboardId });
    expect(Object.values(result.results)).toHaveLength(1);
    expect(result.results[foreignWidget]).toBeUndefined();
  });
});
