import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runFunnel } from '../../../src/lib/server/analytics/funnel';
import type { Executor } from '../../../src/lib/server/db/client';
import type { WidgetDataSource } from '../../../src/lib/server/db/schema';
import type { FilterAst } from '../../../src/lib/server/filters/ast';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createFieldValueHistory,
  createWorkflow,
  createWorkflowItem,
  createWorkflowItemStateInterval,
  createWorkspace,
  setTypedFieldValue,
  updateWorkflowItemRow,
  type WorkflowFixture
} from '../../helpers/factories';

const DAY = 86_400_000;
const W1 = Date.UTC(2024, 2, 4);
const W2 = Date.UTC(2024, 2, 11);

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let workflow: WorkflowFixture;
const tickets: Record<string, string> = {};
const definition: WidgetDataSource = {
  kind: 'workflow_items',
  funnelStages: [
    { label: 'Incoming', stateIds: [] },
    { label: 'Qualified', stateIds: [] },
    { label: 'Quoted', stateIds: [] },
    { label: 'Accepted', stateIds: [] }
  ]
};

async function seed(): Promise<void> {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Funnel WS');
  workspaceId = workspace.id;
  workflow = await createWorkflow(db, workspaceId, {
    states: [
      { name: 'Incoming', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Qualified', kind: 'manual', category: 'active' },
      { name: 'Quoted', kind: 'manual', category: 'active' },
      { name: 'Accepted', kind: 'manual', category: 'done', isTerminal: true }
    ]
  });
  const stateId = (name: string): string => workflow.stateIds[name]!;
  (definition.funnelStages![0] as { stateIds: string[] }).stateIds = [stateId('Incoming')];
  (definition.funnelStages![1] as { stateIds: string[] }).stateIds = [stateId('Qualified')];
  (definition.funnelStages![2] as { stateIds: string[] }).stateIds = [stateId('Quoted')];
  (definition.funnelStages![3] as { stateIds: string[] }).stateIds = [stateId('Accepted')];

  async function makeTicket(key: string, createdAt: number): Promise<string> {
    const ticket = await createWorkflowItem(db, { workspaceId, workflow, title: key });
    tickets[key] = ticket.id;
    await updateWorkflowItemRow(db, ticket.id, {
      createdAt,
      updatedAt: createdAt,
      enteredStateAt: createdAt,
      lastActivityAt: createdAt
    });
    return ticket.id;
  }

  async function interval(
    key: string,
    state: string,
    enteredAt: number,
    exitedAt: number | null = null
  ): Promise<void> {
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: tickets[key]!,
      workflowId: workflow.id,
      stateId: stateId(state),
      stateName: state,
      enteredAt,
      exitedAt
    });
  }

  await makeTicket('t1', W1);
  await interval('t1', 'Incoming', W1);
  await interval('t1', 'Qualified', W1 + DAY);
  await interval('t1', 'Quoted', W1 + 2 * DAY);
  await interval('t1', 'Accepted', W1 + 3 * DAY);

  await makeTicket('t2', W1);
  await interval('t2', 'Incoming', W1);
  await interval('t2', 'Qualified', W1 + DAY);
  // t2 skips Quoted entirely.
  await interval('t2', 'Accepted', W1 + 4 * DAY);

  await makeTicket('t3', W1);
  await interval('t3', 'Incoming', W1);
  await interval('t3', 'Qualified', W1 + 2 * DAY);

  await makeTicket('t4', W2);
  await interval('t4', 'Incoming', W2);
}

beforeEach(seed);
afterEach(() => handle.cleanup());

describe('funnels from history', () => {
  test('counts each stage and computes conversions', async () => {
    const result = await runFunnel(db, { workspaceId, definition });
    const byLabel = new Map(result.stages.map((stage) => [stage.label, stage]));
    expect(byLabel.get('Incoming')?.count).toBe(4);
    expect(byLabel.get('Qualified')?.count).toBe(3);
    expect(byLabel.get('Quoted')?.count).toBe(1);
    expect(byLabel.get('Accepted')?.count).toBe(2);

    expect(byLabel.get('Incoming')?.conversionFromFirst).toBe(100);
    expect(byLabel.get('Qualified')?.conversionFromPrevious).toBeCloseTo(75, 6);
    expect(byLabel.get('Quoted')?.conversionFromPrevious).toBeCloseTo(100 / 3, 6);
    expect(byLabel.get('Accepted')?.conversionFromFirst).toBe(50);
    expect(result.overallConversion).toBe(50);
  });

  test('a ticket that skips a stage still counts later and is not double counted', async () => {
    const result = await runFunnel(db, { workspaceId, definition });
    const accepted = result.stages.find((stage) => stage.label === 'Accepted');
    // t1 and t2 reached Accepted; t2 never reached Quoted.
    expect(accepted?.count).toBe(2);
    const quoted = result.stages.find((stage) => stage.label === 'Quoted');
    expect(quoted?.count).toBe(1);
    // The sum of stage counts is not a ticket count; each stage is independent.
    expect(result.stages.reduce((sum, stage) => sum + stage.count, 0)).toBe(10);
  });

  test('median and average time between stages come from recorded entries', async () => {
    const result = await runFunnel(db, { workspaceId, definition });
    const qualified = result.stages.find((stage) => stage.label === 'Qualified');
    // t1 and t2 took 1 day; t3 took 2 days -> median 1 day, mean 4/3 day.
    expect(qualified?.medianSecondsToReach).toBe(DAY / 1000);
    expect(qualified?.avgSecondsToReach).toBeCloseTo((4 * DAY) / 3 / 1000, 6);

    const accepted = result.stages.find((stage) => stage.label === 'Accepted');
    // Only t1 reached both Quoted and Accepted (t2 skipped Quoted), so the
    // inter-stage time is 1 day and the skipped ticket contributes no delta.
    expect(accepted?.medianSecondsToReach).toBe(DAY / 1000);
    expect(accepted?.avgSecondsToReach).toBe(DAY / 1000);
  });

  test('ignores the current ticket state entirely', async () => {
    // Move every ticket's current state somewhere unrelated.
    await updateWorkflowItemRow(db, tickets.t1!, { stateId: workflow.stateIds.Incoming! });
    await updateWorkflowItemRow(db, tickets.t2!, { stateId: workflow.stateIds.Incoming! });
    await updateWorkflowItemRow(db, tickets.t3!, { stateId: workflow.stateIds.Accepted! });
    const result = await runFunnel(db, { workspaceId, definition });
    const counts = result.stages.map((stage) => stage.count);
    expect(counts).toEqual([4, 3, 1, 2]);
  });

  test('respects the time window on milestone entry', async () => {
    const result = await runFunnel(db, {
      workspaceId,
      definition,
      timeRange: { kind: 'absolute', from: W1, to: W1 + 6 * DAY }
    });
    const byLabel = new Map(result.stages.map((stage) => [stage.label, stage.count]));
    expect(byLabel.get('Incoming')).toBe(3); // t4 entered in week 2
    expect(byLabel.get('Accepted')).toBe(2);
  });

  test('applies field filters to every stage', async () => {
    const region = await createField(db, { workspaceId, key: 'region', type: 'select' });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: tickets.t1!,
      fieldDefinitionId: region,
      type: 'select',
      value: 'north'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: tickets.t2!,
      fieldDefinitionId: region,
      type: 'select',
      value: 'north'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: tickets.t3!,
      fieldDefinitionId: region,
      type: 'select',
      value: 'south'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: tickets.t4!,
      fieldDefinitionId: region,
      type: 'select',
      value: 'south'
    });

    const filter: FilterAst = {
      type: 'condition',
      kind: 'field',
      key: 'region',
      operator: 'eq',
      value: 'north'
    };
    const result = await runFunnel(db, { workspaceId, definition, filter });
    expect(result.stages.map((stage) => stage.count)).toEqual([2, 2, 1, 2]);
  });

  test('supports a field-value milestone', async () => {
    const status = await createField(db, { workspaceId, key: 'status', type: 'select' });
    await createFieldValueHistory(db, {
      workspaceId,
      ownerId: tickets.t1!,
      fieldDefinitionId: status,
      previousValue: null,
      newValue: 'approved',
      createdAt: W1 + 5 * DAY
    });
    await createFieldValueHistory(db, {
      workspaceId,
      ownerId: tickets.t2!,
      fieldDefinitionId: status,
      previousValue: null,
      newValue: 'approved',
      createdAt: W1 + 6 * DAY
    });

    const withField: WidgetDataSource = {
      kind: 'workflow_items',
      funnelStages: [
        ...definition.funnelStages!.slice(0, 2),
        { label: 'Approved', fieldKey: 'status', fieldValue: 'approved' }
      ]
    };
    const result = await runFunnel(db, { workspaceId, definition: withField });
    const approved = result.stages.find((stage) => stage.label === 'Approved');
    expect(approved?.count).toBe(2);
    expect(approved?.conversionFromPrevious).toBeCloseTo(200 / 3, 6);
  });

  test('an unknown stage field yields a zero stage rather than throwing', async () => {
    const unknown: WidgetDataSource = {
      kind: 'workflow_items',
      funnelStages: [
        ...definition.funnelStages!.slice(0, 2),
        { label: 'Ghost', fieldKey: 'no_such_field', fieldValue: 1 }
      ]
    };
    const result = await runFunnel(db, { workspaceId, definition: unknown });
    expect(result.stages.find((stage) => stage.label === 'Ghost')?.count).toBe(0);
  });

  test('an empty definition reports an empty funnel', async () => {
    const result = await runFunnel(db, { workspaceId, definition: { kind: 'workflow_items' } });
    expect(result.empty).toBe(true);
    expect(result.stages).toEqual([]);
    expect(result.overallConversion).toBeNull();
  });
});
