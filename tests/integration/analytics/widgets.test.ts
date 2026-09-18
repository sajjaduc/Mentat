import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { runWidget, type WidgetDefinition } from '../../../src/lib/server/analytics/query';
import type { Executor } from '../../../src/lib/server/db/client';
import { workflowItemStateHistory } from '../../../src/lib/server/db/schema';
import type { FilterAst } from '../../../src/lib/server/filters/ast';
import { createSavedView } from '../../../src/lib/server/filters/views';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  addWorkflowItemLabel,
  createAgentRun,
  createField,
  createFileRecord,
  createLabel,
  createTeam,
  createUser,
  createWorkflow,
  createWorkflowItem,
  createWorkflowItemStateInterval,
  createWorkspace,
  linkWorkflowItemFile,
  ownerActor,
  setTypedFieldValue,
  type UserFixture,
  updateRecordRow,
  updateWorkflowItemRow,
  type WorkflowFixture
} from '../../helpers/factories';

const DAY = 86_400_000;
const BASE = Date.UTC(2024, 2, 4); // Monday, 2024-03-04T00:00:00Z

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let workflow: WorkflowFixture;
let ada: UserFixture;
let bob: UserFixture;
let claimsTeam: string;
let opsTeam: string;
let urgentLabel: string;
let vipLabel: string;
let amount: string;
let score: string;
let opened: string;
let urgent: string;
let claimType: string;
let channels: string;
const itemIds: Record<string, string> = {};

function widget(overrides: Partial<WidgetDefinition>): WidgetDefinition {
  return {
    type: 'kpi',
    dataSource: { kind: 'workflow_items' },
    measure: { aggregation: 'count' },
    ...overrides
  };
}

function byKey(
  rows: Array<{ key: string | null; value: number }> | undefined
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows ?? []) map.set(row.key ?? '(none)', row.value);
  return map;
}

function cond(
  key: string,
  operator: string,
  value?: unknown,
  kind: 'system' | 'field' = 'system'
): FilterAst {
  return { type: 'condition', kind, key, operator: operator as never, value };
}

async function seed(): Promise<void> {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Analytics WS');
  workspaceId = workspace.id;
  workflow = await createWorkflow(db, workspaceId, {
    states: [
      { name: 'Backlog', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'In Progress', kind: 'manual', category: 'active' },
      { name: 'Human Review', kind: 'manual', category: 'review' },
      { name: 'Done', kind: 'manual', category: 'done', isTerminal: true }
    ]
  });
  ada = await createUser(db, { name: 'Ada' });
  bob = await createUser(db, { name: 'Bob' });
  claimsTeam = await createTeam(db, workspaceId, 'Claims');
  opsTeam = await createTeam(db, workspaceId, 'Ops');
  urgentLabel = await createLabel(db, workspaceId, 'urgent');
  vipLabel = await createLabel(db, workspaceId, 'vip');
  amount = await createField(db, { workspaceId, key: 'amount', type: 'currency' });
  score = await createField(db, { workspaceId, key: 'score', type: 'number' });
  opened = await createField(db, { workspaceId, key: 'opened', type: 'date' });
  urgent = await createField(db, { workspaceId, key: 'urgent', type: 'boolean' });
  claimType = await createField(db, {
    workspaceId,
    key: 'claim_type',
    type: 'select',
    options: { choices: [{ value: 'motor', label: 'Motor' }] }
  });
  channels = await createField(db, { workspaceId, key: 'channels', type: 'multi_select' });

  const specs: Array<{
    key: string;
    title: string;
    owner?: string;
    team?: string;
    state: string;
    priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
    amount?: number;
    score?: number;
    urgent?: boolean;
    claimType?: string;
    channels?: string[];
    day: number;
  }> = [
    {
      key: 'A',
      title: 'Alpha',
      owner: ada.id,
      team: claimsTeam,
      state: 'Backlog',
      priority: 'high',
      amount: 100,
      score: 1,
      urgent: true,
      claimType: 'motor',
      channels: ['email'],
      day: 0
    },
    {
      key: 'B',
      title: 'Bravo',
      owner: ada.id,
      team: claimsTeam,
      state: 'In Progress',
      priority: 'medium',
      amount: 200,
      score: 2,
      urgent: false,
      claimType: 'motor',
      channels: ['email', 'phone'],
      day: 1
    },
    {
      key: 'C',
      title: 'Charlie',
      owner: bob.id,
      team: opsTeam,
      state: 'Human Review',
      priority: 'high',
      amount: 300,
      score: 3,
      urgent: true,
      claimType: 'property',
      day: 2
    },
    {
      key: 'D',
      title: 'Delta',
      owner: bob.id,
      team: opsTeam,
      state: 'Done',
      priority: 'low',
      amount: 400,
      score: 4,
      urgent: false,
      claimType: 'property',
      day: 3
    },
    { key: 'E', title: 'Echo', state: 'Backlog', priority: 'none', day: 4 },
    {
      key: 'F',
      title: 'Foxtrot',
      owner: ada.id,
      team: claimsTeam,
      state: 'Done',
      priority: 'none',
      amount: 500,
      score: 5,
      day: 7
    }
  ];

  for (const spec of specs) {
    const ticket = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: spec.title,
      stateId: workflow.stateIds[spec.state]!,
      ownerUserId: spec.owner,
      ownerTeamId: spec.team
    });
    itemIds[spec.key] = ticket.id;
    // The factory records the item's initial state entry; these tests seed the
    // exact history they assert on, so drop the automatic one.
    await db
      .delete(workflowItemStateHistory)
      .where(eq(workflowItemStateHistory.workflowItemId, ticket.id))
      .run();
    // The universal model keeps `priority` as a Record structured value.
    await updateRecordRow(db, ticket.recordId, {
      structuredData: { priority: spec.priority ?? 'none' }
    });
    const createdAt = BASE + spec.day * DAY;
    await updateWorkflowItemRow(db, ticket.id, {
      createdAt,
      updatedAt: createdAt,
      enteredStateAt: createdAt,
      lastActivityAt: createdAt
    });
    if (spec.amount !== undefined) {
      await setTypedFieldValue(db, {
        workspaceId,
        workflowItemId: ticket.id,
        fieldDefinitionId: amount,
        type: 'currency',
        value: spec.amount
      });
    }
    if (spec.score !== undefined) {
      await setTypedFieldValue(db, {
        workspaceId,
        workflowItemId: ticket.id,
        fieldDefinitionId: score,
        type: 'number',
        value: spec.score
      });
    }
    if (spec.urgent !== undefined) {
      await setTypedFieldValue(db, {
        workspaceId,
        workflowItemId: ticket.id,
        fieldDefinitionId: urgent,
        type: 'boolean',
        value: spec.urgent
      });
    }
    if (spec.claimType) {
      await setTypedFieldValue(db, {
        workspaceId,
        workflowItemId: ticket.id,
        fieldDefinitionId: claimType,
        type: 'select',
        value: spec.claimType
      });
    }
    if (spec.channels) {
      await setTypedFieldValue(db, {
        workspaceId,
        workflowItemId: ticket.id,
        fieldDefinitionId: channels,
        type: 'multi_select',
        value: spec.channels
      });
    }
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: ticket.id,
      fieldDefinitionId: opened,
      type: 'date',
      value: BASE - spec.day * DAY
    });
  }
  await addWorkflowItemLabel(db, {
    workspaceId,
    workflowItemId: itemIds.A!,
    labelId: urgentLabel
  });
  await addWorkflowItemLabel(db, {
    workspaceId,
    workflowItemId: itemIds.B!,
    labelId: urgentLabel
  });
  await addWorkflowItemLabel(db, { workspaceId, workflowItemId: itemIds.D!, labelId: vipLabel });
}

beforeEach(seed);
afterEach(() => handle.cleanup());

describe('widgets: scalar measures', () => {
  test('KPI count and filtered count', async () => {
    const all = await runWidget(db, { workspaceId, widget: widget({}) });
    expect(all.value).toBe(6);
    expect(all.grouping).toBe('none');

    const high = await runWidget(db, {
      workspaceId,
      widget: widget({ filter: cond('priority', 'eq', 'high') })
    });
    expect(high.value).toBe(2);
  });

  test('SUM and AVG over a currency field', async () => {
    const sum = await runWidget(db, {
      workspaceId,
      widget: widget({ measure: { aggregation: 'sum', fieldKey: 'amount' } })
    });
    expect(sum.value).toBe(1500);

    const avg = await runWidget(db, {
      workspaceId,
      widget: widget({ measure: { aggregation: 'avg', fieldKey: 'amount' } })
    });
    expect(avg.value).toBe(300);
  });

  test('MIN and MAX over a number field', async () => {
    const min = await runWidget(db, {
      workspaceId,
      widget: widget({ measure: { aggregation: 'min', fieldKey: 'amount' } })
    });
    expect(min.value).toBe(100);
    const max = await runWidget(db, {
      workspaceId,
      widget: widget({ measure: { aggregation: 'max', fieldKey: 'amount' } })
    });
    expect(max.value).toBe(500);
  });

  test('MEDIAN is exact for odd and even counts', async () => {
    // Five tickets have a score: 1,2,3,4,5 -> odd median 3.
    const odd = await runWidget(db, {
      workspaceId,
      widget: widget({ measure: { aggregation: 'median', fieldKey: 'score' } })
    });
    expect(odd.value).toBe(3);

    // Grouped by claim_type: motor = [1,2] and property = [3,4] -> even medians.
    const even = await runWidget(db, {
      workspaceId,
      widget: widget({
        measure: { aggregation: 'median', fieldKey: 'score' },
        grouping: { by: 'field', fieldKey: 'claim_type' }
      })
    });
    const grouped = byKey(even.rows);
    expect(grouped.get('motor')).toBe(1.5);
    expect(grouped.get('property')).toBe(3.5);
  });

  test('aggregations can be scoped by a workspace field filter', async () => {
    const sum = await runWidget(db, {
      workspaceId,
      widget: widget({
        measure: { aggregation: 'sum', fieldKey: 'amount' },
        filter: cond('claim_type', 'eq', 'motor', 'field')
      })
    });
    expect(sum.value).toBe(300);
  });
});

describe('widgets: breakdowns', () => {
  test('breaks down by owner, team, state, priority, workflow and label', async () => {
    const byOwner = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'owner' } })
    });
    // The universal engine keys a breakdown by the display value.
    const owners = byKey(byOwner.rows);
    expect(owners.get('Ada')).toBe(3);
    expect(owners.get('Bob')).toBe(2);
    expect(owners.get('Unassigned')).toBe(1);

    const byTeam = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'team' } })
    });
    const teams = new Map((byTeam.rows ?? []).map((row) => [row.label, row.value]));
    expect([...teams].find(([label]) => label?.startsWith('Claims'))?.[1]).toBe(3);
    expect([...teams].find(([label]) => label?.startsWith('Ops'))?.[1]).toBe(2);

    const byState = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'state' } })
    });
    const states = byKey(byState.rows);
    expect(states.get('Backlog')).toBe(2);
    expect(states.get('Done')).toBe(2);
    expect(byState.rows?.find((row) => row.key === 'Done')?.label).toBe('Done');

    const byPriority = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'priority' } })
    });
    expect(byKey(byPriority.rows).get('high')).toBe(2);

    const byWorkflow = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'workflow' } })
    });
    expect(byWorkflow.rows).toHaveLength(1);
    expect(byWorkflow.rows?.[0]?.value).toBe(6);

    const byLabel = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'label' } })
    });
    const labels = new Map((byLabel.rows ?? []).map((row) => [row.label, row.value]));
    // A ticket with two labels appears once per label, but COUNT is DISTINCT.
    expect([...labels].find(([label]) => label?.startsWith('urgent'))?.[1]).toBe(2);
    expect([...labels].find(([label]) => label?.startsWith('vip'))?.[1]).toBe(1);
  });

  test('field grouping uses the typed value', async () => {
    const result = await runWidget(db, {
      workspaceId,
      widget: widget({
        measure: { aggregation: 'sum', fieldKey: 'amount' },
        grouping: { by: 'field', fieldKey: 'claim_type' }
      })
    });
    const grouped = byKey(result.rows);
    expect(grouped.get('motor')).toBe(300);
    expect(grouped.get('property')).toBe(700);
  });
});

describe('widgets: time series', () => {
  test('day buckets are continuous with explicit zeros', async () => {
    const result = await runWidget(db, {
      workspaceId,
      widget: widget({ type: 'line', grouping: { by: 'day' } })
    });
    expect(result.grouping).toBe('day');
    expect(result.rows?.map((row) => row.bucket)).toEqual([
      '2024-03-04',
      '2024-03-05',
      '2024-03-06',
      '2024-03-07',
      '2024-03-08',
      '2024-03-09',
      '2024-03-10',
      '2024-03-11'
    ]);
    const day6 = result.rows?.find((row) => row.bucket === '2024-03-09');
    expect(day6?.value).toBe(0);
  });

  test('week and month buckets use UTC boundaries', async () => {
    const weeks = await runWidget(db, {
      workspaceId,
      widget: widget({ type: 'line', grouping: { by: 'week' } })
    });
    expect(weeks.rows?.map((row) => row.bucket)).toEqual(['2024-03-04', '2024-03-11']);
    expect(weeks.rows?.find((row) => row.bucket === '2024-03-04')?.value).toBe(5);
    expect(weeks.rows?.find((row) => row.bucket === '2024-03-11')?.value).toBe(1);

    const months = await runWidget(db, {
      workspaceId,
      widget: widget({ type: 'line', grouping: { by: 'month' } })
    });
    expect(months.rows?.map((row) => row.bucket)).toEqual(['2024-03']);
  });

  test('relative time ranges restrict the window and end at now', async () => {
    const now = BASE + 3 * DAY;
    const result = await runWidget(db, {
      workspaceId,
      now,
      widget: widget({
        timeRange: { kind: 'relative', lastDays: 2, basis: 'created' }
      })
    });
    // 2 days back from 2024-03-07T00:00Z is 2024-03-05: tickets B, C and D fall
    // inside the inclusive window.
    expect(result.value).toBe(3);
  });
});

describe('widgets: non-ticket data sources', () => {
  test('counts and groups state_history, runs and files sources', async () => {
    const backlog = workflow.stateIds.Backlog!;
    const review = workflow.stateIds['Human Review']!;
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: itemIds.A!,
      workflowId: workflow.id,
      stateId: backlog,
      stateName: 'Backlog',
      enteredAt: BASE,
      exitedAt: BASE + 100_000
    });
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: itemIds.B!,
      workflowId: workflow.id,
      stateId: review,
      stateName: 'Human Review',
      enteredAt: BASE,
      exitedAt: null
    });
    await createAgentRun(db, {
      workspaceId,
      workflowItemId: itemIds.A!,
      workflowId: workflow.id,
      stateId: backlog,
      status: 'succeeded'
    });
    const fileId = await createFileRecord(db, {
      workspaceId,
      originalFilename: 'evidence.pdf',
      status: 'ready'
    });
    await linkWorkflowItemFile(db, { workspaceId, workflowItemId: itemIds.B!, fileId });

    const history = await runWidget(db, {
      workspaceId,
      widget: widget({ dataSource: { kind: 'state_history' } })
    });
    expect(history.value).toBe(2);
    const byState = await runWidget(db, {
      workspaceId,
      widget: widget({ dataSource: { kind: 'state_history' }, grouping: { by: 'state' } })
    });
    expect(byKey(byState.rows).get(backlog)).toBe(1);
    expect(byKey(byState.rows).get(review)).toBe(1);

    const runs = await runWidget(db, {
      workspaceId,
      widget: widget({ dataSource: { kind: 'runs' } })
    });
    expect(runs.value).toBe(1);

    const fileWidget = await runWidget(db, {
      workspaceId,
      widget: widget({ dataSource: { kind: 'files' } })
    });
    expect(fileWidget.value).toBe(1);

    const fieldHistory = await runWidget(db, {
      workspaceId,
      widget: widget({ dataSource: { kind: 'field_history' } })
    });
    expect(fieldHistory.value).toBe(0);
  });

  test('absolute time ranges are inclusive on both ends', async () => {
    const result = await runWidget(db, {
      workspaceId,
      widget: widget({
        timeRange: { kind: 'absolute', from: BASE + DAY, to: BASE + 2 * DAY, basis: 'created' }
      })
    });
    expect(result.value).toBe(2);
  });
});

describe('widgets: filter composition and isolation', () => {
  test('combines the widget filter with the dashboard global filter using AND', async () => {
    const combined = await runWidget(db, {
      workspaceId,
      widget: widget({
        filter: cond('priority', 'eq', 'high'),
        measure: { aggregation: 'sum', fieldKey: 'amount' }
      }),
      globalFilter: cond('stateId', 'eq', workflow.stateIds.Done!)
    });
    // priority high AND state Done: no ticket matches.
    expect(combined.value).toBe(0);

    const narrower = await runWidget(db, {
      workspaceId,
      widget: widget({
        filter: cond('stateId', 'eq', workflow.stateIds.Done!),
        measure: { aggregation: 'sum', fieldKey: 'amount' }
      }),
      globalFilter: cond('claim_type', 'eq', 'property', 'field')
    });
    // Done AND property: tickets D (400) and F (500, no claim_type) -> only D.
    expect(narrower.value).toBe(400);
  });

  test('reuses a saved view AST inside a widget', async () => {
    const actor = ownerActor(workspaceId, ada.id);
    const view = await createSavedView(db, actor, {
      name: 'High priority',
      filter: cond('priority', 'eq', 'high')
    });
    const result = await runWidget(db, {
      workspaceId,
      widget: widget({ savedViewId: view.id })
    });
    expect(result.value).toBe(2);
  });

  test('isolates the same widget between workspaces', async () => {
    const other = await createWorkspace(db, 'Other WS');
    const otherWorkflow = await createWorkflow(db, other.id, { name: 'Other WF' });
    const otherAda = await createUser(db, { name: 'Ada' });
    await createWorkflowItem(db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Foreign',
      ownerUserId: otherAda.id,
      priority: 'high'
    });
    const otherTeam = await createTeam(db, other.id, 'Claims');
    const foreign = await createWorkflowItem(db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Foreign team',
      ownerTeamId: otherTeam
    });
    await addWorkflowItemLabel(db, {
      workspaceId: other.id,
      workflowItemId: foreign.id,
      labelId: await createLabel(db, other.id, 'urgent')
    });

    const count = await runWidget(db, { workspaceId, widget: widget({}) });
    expect(count.value).toBe(6);
    const byOwner = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'owner' } })
    });
    // Only this workspace's work contributes: Ada 3, Bob 2 and one unassigned.
    expect(byOwner.rows?.reduce((sum, row) => sum + row.value, 0)).toBe(6);
    const byLabel = await runWidget(db, {
      workspaceId,
      widget: widget({ grouping: { by: 'label' } })
    });
    expect(byLabel.rows?.length).toBe(2);
  });
});

describe('widgets: duration measures from history', () => {
  test('time_in_state averages recorded intervals, including open ones', async () => {
    const backlog = workflow.stateIds.Backlog!;
    const t1 = itemIds.A!;
    const t2 = itemIds.B!;
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: t1,
      workflowId: workflow.id,
      stateId: backlog,
      stateName: 'Backlog',
      enteredAt: BASE,
      exitedAt: BASE + 100_000
    });
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: t2,
      workflowId: workflow.id,
      stateId: backlog,
      stateName: 'Backlog',
      enteredAt: BASE,
      exitedAt: BASE + 300_000
    });
    // An open interval: 200s from `now`.
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: itemIds.C!,
      workflowId: workflow.id,
      stateId: backlog,
      stateName: 'Backlog',
      enteredAt: BASE,
      exitedAt: null
    });

    const result = await runWidget(db, {
      workspaceId,
      now: BASE + 200_000,
      widget: widget({
        measure: { aggregation: 'duration', durationOf: 'time_in_state' },
        dataSource: { kind: 'workflow_items', agingStates: [backlog] }
      })
    });
    // (100 + 300 + 200) / 3 = 200
    expect(result.value).toBe(200);
  });

  test('time_in_state re-scopes history when the widget declares another source', async () => {
    const backlog = workflow.stateIds.Backlog!;
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: itemIds.A!,
      workflowId: workflow.id,
      stateId: backlog,
      stateName: 'Backlog',
      enteredAt: BASE,
      exitedAt: BASE + 60_000
    });
    const result = await runWidget(db, {
      workspaceId,
      now: BASE + 200_000,
      widget: widget({
        // A non-ticket source must not leak its alias into the history query.
        dataSource: { kind: 'runs', agingStates: [backlog] },
        measure: { aggregation: 'duration', durationOf: 'time_in_state' }
      })
    });
    expect(result.value).toBe(60);
  });

  test('cycle_time measures creation to first terminal entry', async () => {
    const done = workflow.stateIds.Done!;
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: itemIds.A!,
      workflowId: workflow.id,
      stateId: done,
      stateName: 'Done',
      enteredAt: BASE + 100_000
    });
    await createWorkflowItemStateInterval(db, {
      workspaceId,
      workflowItemId: itemIds.B!,
      workflowId: workflow.id,
      stateId: done,
      stateName: 'Done',
      enteredAt: BASE + 1 * DAY + 300_000
    });
    const result = await runWidget(db, {
      workspaceId,
      widget: widget({
        measure: { aggregation: 'duration', durationOf: 'cycle_time' }
      })
    });
    // A was created at BASE (+100s); B at BASE+1d (+300s); others have no terminal.
    expect(result.value).toBe(200);
  });
});

describe('widgets: conversion over time', () => {
  test('conversion changes week over week for a controlled dataset', async () => {
    const backlog = workflow.stateIds.Backlog!;
    const done = workflow.stateIds.Done!;
    const week1 = Date.UTC(2024, 2, 5); // Tuesday of week starting 2024-03-04
    const week2 = Date.UTC(2024, 2, 12); // Tuesday of the next week

    // Four tickets, seeded directly here so the fixture tickets do not interfere.
    const specs = [
      { first: week1, done: week1 + DAY },
      { first: week1, done: week1 + 2 * DAY },
      { first: week2, done: null },
      { first: week2, done: week2 + DAY }
    ];
    for (const spec of specs) {
      const ticket = await createWorkflowItem(db, {
        workspaceId,
        workflow,
        title: `Conv ${spec.first}-${spec.done}`
      });
      await createWorkflowItemStateInterval(db, {
        workspaceId,
        workflowItemId: ticket.id,
        workflowId: workflow.id,
        stateId: backlog,
        stateName: 'Backlog',
        enteredAt: spec.first
      });
      if (spec.done !== null) {
        await createWorkflowItemStateInterval(db, {
          workspaceId,
          workflowItemId: ticket.id,
          workflowId: workflow.id,
          stateId: done,
          stateName: 'Done',
          enteredAt: spec.done
        });
      }
    }

    const definition: WidgetDefinition = widget({
      type: 'line',
      measure: { aggregation: 'conversion' },
      grouping: { by: 'week' },
      filter: cond('title', 'starts_with', 'Conv'),
      dataSource: {
        kind: 'workflow_items',
        funnelStages: [
          { label: 'Incoming', stateIds: [backlog] },
          { label: 'Accepted', stateIds: [done] }
        ]
      }
    });
    const result = await runWidget(db, { workspaceId, widget: definition });
    const series = new Map((result.rows ?? []).map((row) => [row.bucket, row.value]));
    expect(series.get('2024-03-04')).toBe(100);
    expect(series.get('2024-03-11')).toBe(50);

    const overall = await runWidget(db, {
      workspaceId,
      widget: { ...definition, grouping: { by: 'none' } }
    });
    expect(overall.value).toBe(75);
  });
});
