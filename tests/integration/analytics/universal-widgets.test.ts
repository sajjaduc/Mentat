/**
 * Universal-model analytics: records and workflow items as widget data sources.
 *
 * These prove the unified analytics path (ADR-0017 + ADR-0021): dashboards can
 * count, group and measure Records and WorkflowItems without going through the
 * legacy Ticket tables, funnels read recorded state intervals, and tenant
 * isolation still holds.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { runWidget, type WidgetDefinition } from '../../../src/lib/server/analytics/query';
import type { ActorContext } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import { records, workflows } from '../../../src/lib/server/db/schema';
import { createObjectType, setBaseFields } from '../../../src/lib/server/records/object-types';
import { createRecord } from '../../../src/lib/server/records/service';
import {
  createWorkflowItem,
  requestWorkflowItemTransition
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createUser,
  createWorkflow as createWorkflowFixture,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Universal Analytics');
  workspaceId = workspace.id;
  const user = await createUser(db, { name: 'Owner' });
  owner = ownerActor(workspaceId, user.id);
});

function widgetOf(overrides: Partial<WidgetDefinition>): WidgetDefinition {
  return {
    type: 'kpi',
    dataSource: { kind: 'records' },
    measure: { aggregation: 'count' },
    ...overrides
  };
}

async function makePolicyType() {
  const objectType = createObjectType(db, owner, { name: 'Policy' });
  await setBaseFields(db, owner, objectType.id, [
    { key: 'policy_number', name: 'Policy Number', type: 'short_text', isPrimaryDisplay: true },
    { key: 'premium', name: 'Premium', type: 'number' },
    { key: 'region', name: 'Region', type: 'short_text' }
  ] as never);
  return objectType;
}

async function makeWorkflow(name: string, objectTypeId: string) {
  const fixture = await createWorkflowFixture(db, workspaceId, { name });
  db.update(workflows).set({ objectTypeId }).where(eq(workflows.id, fixture.id)).run();
  return fixture;
}

describe('universal analytics: records', () => {
  test('counts records and groups by Object Type', async () => {
    const policy = await makePolicyType();
    const business = createObjectType(db, owner, { name: 'Business' });
    await setBaseFields(db, owner, business.id, [
      { key: 'business_name', name: 'Business Name', type: 'short_text', isPrimaryDisplay: true }
    ] as never);

    await createRecord(db, owner, { objectTypeId: policy.id, fields: { policy_number: 'P1' } });
    await createRecord(db, owner, { objectTypeId: policy.id, fields: { policy_number: 'P2' } });
    await createRecord(db, owner, {
      objectTypeId: business.id,
      fields: { business_name: 'ACME' }
    });

    const total = await runWidget(db, {
      workspaceId,
      widget: widgetOf({ dataSource: { kind: 'records' } })
    });
    expect(total.value).toBe(3);

    const grouped = await runWidget(db, {
      workspaceId,
      widget: widgetOf({ grouping: { by: 'objectType' }, type: 'bar' })
    });
    const byName = new Map((grouped.rows ?? []).map((row) => [row.key, row.value]));
    expect(byName.get('Policy')).toBe(2);
    expect(byName.get('Business')).toBe(1);
  });

  test('sums a numeric record field and filters by a record field', async () => {
    const policy = await makePolicyType();
    await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1', premium: 100, region: 'NSW' }
    });
    await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P2', premium: 250, region: 'VIC' }
    });

    const sum = await runWidget(db, {
      workspaceId,
      widget: widgetOf({ measure: { aggregation: 'sum', fieldKey: 'premium' } })
    });
    expect(sum.value).toBe(350);

    const filtered = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        filter: {
          type: 'condition',
          kind: 'record_field',
          key: 'premium',
          operator: 'gt',
          value: 200
        } as never
      })
    });
    expect(filtered.value).toBe(1);

    const grouped = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        type: 'bar',
        grouping: { by: 'field', fieldKey: 'region' },
        measure: { aggregation: 'count' }
      })
    });
    const byRegion = new Map((grouped.rows ?? []).map((row) => [row.key, row.value]));
    expect(byRegion.get('NSW')).toBe(1);
    expect(byRegion.get('VIC')).toBe(1);
  });

  test('buckets records by creation month and reports unresolved keys', async () => {
    const policy = await makePolicyType();
    const createdAt = Date.UTC(2024, 0, 15);
    await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    // Backdate the record so the bucket is deterministic.
    await db
      .update(records)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(records.workspaceId, workspaceId))
      .run();

    const series = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        type: 'line',
        grouping: { by: 'month' },
        timeRange: { kind: 'all', basis: 'created' }
      })
    });
    expect(series.rows?.some((row) => row.key === '2024-01')).toBe(true);

    const unresolved = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        filter: {
          type: 'condition',
          kind: 'record_field',
          key: 'does_not_exist',
          operator: 'eq',
          value: 'x'
        } as never
      })
    });
    expect(unresolved.meta.unresolved).toContain('does_not_exist');
  });

  test('isolates records analytics by workspace', async () => {
    const policy = await makePolicyType();
    await createRecord(db, owner, { objectTypeId: policy.id, fields: { policy_number: 'MINE' } });

    const other = await createWorkspace(db, 'Other');
    const otherUser = await createUser(db, { name: 'Other' });
    const otherOwner = ownerActor(other.id, otherUser.id);
    const otherType = createObjectType(db, otherOwner, { name: 'Policy' });
    await setBaseFields(db, otherOwner, otherType.id, [
      { key: 'policy_number', name: 'Policy Number', type: 'short_text', isPrimaryDisplay: true }
    ] as never);
    await createRecord(db, otherOwner, {
      objectTypeId: otherType.id,
      fields: { policy_number: 'THEIRS' }
    });

    const mine = await runWidget(db, {
      workspaceId,
      widget: widgetOf({ dataSource: { kind: 'records' } })
    });
    expect(mine.value).toBe(1);
  });
});

describe('universal analytics: workflow items', () => {
  test('counts work by state and by workflow', async () => {
    const policy = await makePolicyType();
    const lifecycle = await makeWorkflow('Policy Lifecycle', policy.id);
    const renewal = await makeWorkflow('Renewal', policy.id);

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1', premium: 50 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: lifecycle.id,
      recordId: record.id
    });
    await requestWorkflowItemTransition(db, owner, {
      workflowItemId: item.id,
      targetStateId: lifecycle.stateIds['In Progress'] as string
    });
    const second = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P2', premium: 75 }
    });
    await createWorkflowItem(db, owner, { workflowId: renewal.id, recordId: second.id });

    const byState = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        type: 'bar',
        dataSource: { kind: 'workflow_items' },
        grouping: { by: 'state' }
      })
    });
    const stateMap = new Map((byState.rows ?? []).map((row) => [row.key, row.value]));
    expect(stateMap.get('In Progress')).toBe(1);
    expect(stateMap.get('Backlog')).toBe(1);

    const byWorkflow = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        type: 'bar',
        dataSource: { kind: 'workflow_items' },
        grouping: { by: 'workflow' }
      })
    });
    const workflowMap = new Map((byWorkflow.rows ?? []).map((row) => [row.key, row.value]));
    expect(workflowMap.get('Policy Lifecycle')).toBe(1);
    expect(workflowMap.get('Renewal')).toBe(1);

    const sumPremium = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        dataSource: { kind: 'workflow_items' },
        measure: { aggregation: 'sum', fieldKey: 'premium' }
      })
    });
    expect(sumPremium.value).toBe(125);
  });

  test('derives a funnel from recorded state intervals', async () => {
    const policy = await makePolicyType();
    const workflow = await makeWorkflow('Funnel', policy.id);
    const first = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'F1' }
    });
    const second = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'F2' }
    });
    const itemA = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: first.id
    });
    await createWorkflowItem(db, owner, { workflowId: workflow.id, recordId: second.id });
    await requestWorkflowItemTransition(db, owner, {
      workflowItemId: itemA.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    await requestWorkflowItemTransition(db, owner, {
      workflowItemId: itemA.id,
      targetStateId: workflow.stateIds.Done as string
    });

    const funnel = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        type: 'funnel',
        dataSource: {
          kind: 'workflow_items',
          funnelStages: [
            { label: 'Entered', stateIds: [workflow.stateIds.Backlog as string] },
            { label: 'Done', stateIds: [workflow.stateIds.Done as string] }
          ]
        },
        measure: { aggregation: 'count' }
      })
    });
    const stages = new Map((funnel.rows ?? []).map((row) => [row.key, row.value]));
    expect(stages.get('Entered')).toBe(2);
    expect(stages.get('Done')).toBe(1);
    expect(funnel.meta.note).toContain('overallConversion=0.5');
  });

  test('measures time in state from intervals and rejects it for plain records', async () => {
    const policy = await makePolicyType();
    const workflow = await makeWorkflow('Dwell', policy.id);
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'D1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });
    await requestWorkflowItemTransition(db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });

    const duration = await runWidget(db, {
      workspaceId,
      widget: widgetOf({
        dataSource: { kind: 'workflow_items' },
        measure: { aggregation: 'duration', durationOf: 'time_in_state' },
        timeRange: { kind: 'all', basis: 'entered_state' }
      })
    });
    expect(duration.value).not.toBeNull();
    expect(duration.value as number).toBeGreaterThanOrEqual(0);

    await expect(
      runWidget(db, {
        workspaceId,
        widget: widgetOf({
          dataSource: { kind: 'records' },
          measure: { aggregation: 'duration', durationOf: 'time_in_state' }
        })
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
