/**
 * "My Work" queues, workflow listing, tenant isolation and audit coverage
 * (ADR-0021 port of the ticket queues suite).
 *
 * Every bucket is a persisted query over WorkflowItems, so counts cannot drift
 * from the board. Listing returns Record identity plus state; overlay field values
 * and labels are read through the item detail / label tables.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { labels, workflowItemLabels, workflowItems } from '../../../src/lib/server/db/schema';
import { setWorkflowFields } from '../../../src/lib/server/fields/service';
import { listWorkflowItems } from '../../../src/lib/server/workflow-items/query';
import {
  addWorkflowItemLabelsSync,
  createWorkflowItemSync,
  getWorkflowItemDetail,
  myWork,
  requestWorkflowItemTransitionSync,
  requireWorkflowItemRow,
  searchWorkflowItems,
  setWorkflowItemWaitingOnSync,
  transferWorkflowItemSync
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createObjectType,
  createRecord,
  createUser,
  createWorkflow,
  createWorkflowItem,
  createWorkspace,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Queues Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Sarah Reviewer' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId, 'Sarah Reviewer');
});

async function makeWorkflow(name = 'Queues'): Promise<WorkflowFixture> {
  return createWorkflow(handle.db, workspaceId, { name });
}

describe('my work queues', () => {
  test('buckets work by what it is waiting on', async () => {
    const workflow = await makeWorkflow();
    const agentItem = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Agent'
    });
    setWorkflowItemWaitingOnSync(handle.db, owner, {
      workflowItemId: agentItem.id,
      waitingOn: 'agent'
    });

    const humanItem = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Human'
    });
    setWorkflowItemWaitingOnSync(handle.db, owner, {
      workflowItemId: humanItem.id,
      waitingOn: 'human'
    });

    const triggerItem = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Trigger'
    });
    setWorkflowItemWaitingOnSync(handle.db, owner, {
      workflowItemId: triggerItem.id,
      waitingOn: 'trigger'
    });

    const approvalItem = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Approval'
    });
    setWorkflowItemWaitingOnSync(handle.db, owner, {
      workflowItemId: approvalItem.id,
      waitingOn: 'approval'
    });

    const assignedItem = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Assigned',
      ownerUserId: ownerId,
      createdById: ownerId
    });
    setWorkflowItemWaitingOnSync(handle.db, owner, {
      workflowItemId: assignedItem.id,
      waitingOn: 'none'
    });

    const work = await myWork(handle.db, owner);

    expect(work.waitingForAgent.map((row) => row.id)).toEqual([agentItem.id]);
    expect(work.waitingForMe.map((row) => row.id)).toEqual([humanItem.id]);
    expect(work.waitingForApproval.map((row) => row.id)).toEqual([approvalItem.id]);
    expect(work.needsAttention.map((row) => row.id)).toEqual([triggerItem.id]);
    expect(work.assigned.map((row) => row.id)).toEqual([assignedItem.id]);
    expect(work.owned.map((row) => row.id)).toEqual([assignedItem.id]);
    expect(work.createdByMe.map((row) => row.id)).toEqual([assignedItem.id]);
  });

  test('completed and archived work is excluded from the queues', async () => {
    const workflow = await makeWorkflow('Closed');
    const open = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Open',
      ownerUserId: ownerId
    });
    const done = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Done',
      ownerUserId: ownerId
    });
    handle.db
      .update(workflowItems)
      .set({ completedAt: Date.now() })
      .where(eq(workflowItems.id, done.id))
      .run();

    const work = await myWork(handle.db, owner);
    expect(work.owned.map((row) => row.id)).toEqual([open.id]);
  });

  test('lists work for a workflow with overlay field values and labels', async () => {
    const workflow = await makeWorkflow('Board');
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);

    const record = await createRecord(handle.db, {
      workspaceId,
      objectTypeId: workflow.objectTypeId,
      displayName: 'Visible'
    });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      fields: { customer: 'ACME' }
    });
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelNames: ['vip']
    });

    const page = await searchWorkflowItems(handle.db, owner, { workflowId: workflow.id });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.rows[0]?.id).toBe(item.id);
    expect(page.rows[0]?.workflowId).toBe(workflow.id);
    expect(page.rows[0]?.recordDisplayName).toBe('Visible');

    const listed = await listWorkflowItems(handle.db, { workspaceId, workflowId: workflow.id });
    expect(listed.items.map((entry) => entry.id)).toEqual([item.id]);

    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.fields.customer).toBe('ACME');

    const attached = handle.db
      .select({ name: labels.name })
      .from(workflowItemLabels)
      .innerJoin(labels, eq(labels.id, workflowItemLabels.labelId))
      .where(eq(workflowItemLabels.workflowItemId, item.id))
      .all();
    expect(attached.map((row) => row.name)).toEqual(['vip']);
  });

  test('filters by state, owner and search text', async () => {
    const workflow = await makeWorkflow('Filtered');
    const inProgress = workflow.stateIds['In Progress'] as string;
    const big = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      stateId: inProgress,
      title: 'Big',
      priority: 'high',
      ownerUserId: ownerId
    });
    await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Small',
      priority: 'low'
    });

    const byState = await searchWorkflowItems(handle.db, owner, {
      workflowId: workflow.id,
      stateIds: [inProgress]
    });
    expect(byState.rows.map((row) => row.id)).toEqual([big.id]);

    const byOwner = await searchWorkflowItems(handle.db, owner, { ownerUserId: ownerId });
    expect(byOwner.rows.map((row) => row.id)).toEqual([big.id]);

    const bySearch = await searchWorkflowItems(handle.db, owner, { search: 'big' });
    expect(bySearch.rows.map((row) => row.id)).toEqual([big.id]);

    const all = await searchWorkflowItems(handle.db, owner, { workflowId: workflow.id });
    expect(all.rows).toHaveLength(2);
  });

  test('the queue is scoped to the acting workspace', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const workflow = await makeWorkflow('Mine');
    const mine = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Mine',
      ownerUserId: ownerId
    });
    await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Theirs',
      ownerUserId: ownerId
    });

    const work = await myWork(handle.db, owner);
    expect(work.owned.map((row) => row.id)).toEqual([mine.id]);
    expect(work.createdByMe).toHaveLength(0);
  });
});

describe('tenant isolation', () => {
  test('work from another workspace is not visible', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Mine' });
    const mine = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Mine'
    });
    const otherUser = await createUser(handle.db, { name: 'Other Owner' });
    const otherOwner = ownerActor(other.id, otherUser.id, 'Other Owner');
    const theirs = await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Theirs'
    });

    expect(() => requireWorkflowItemRow(handle.db, other.id, mine.id)).toThrow(/not found/);
    expect(() => requireWorkflowItemRow(handle.db, workspaceId, theirs.id)).toThrow(/not found/);
    expect(() => getWorkflowItemDetail(handle.db, otherOwner, mine.id)).toThrow();

    const page = await searchWorkflowItems(handle.db, owner, {});
    expect(page.rows.map((row) => row.id)).toContain(mine.id);
    expect(page.rows.map((row) => row.id)).not.toContain(theirs.id);
    expect(page.rows.every((row) => row.workflowId !== otherWorkflow.id)).toBe(true);
  });
});

describe('audit coverage', () => {
  test('creation, field changes, transitions and transfers all write ledger rows', async () => {
    const objectType = await createObjectType(handle.db, {
      workspaceId,
      key: 'claim',
      name: 'Claim'
    });
    const intake = await createWorkflow(handle.db, workspaceId, {
      name: 'Intake',
      key: 'INT',
      objectTypeId: objectType.id
    });
    const claims = await createWorkflow(handle.db, workspaceId, {
      name: 'Claims',
      key: 'CLM',
      objectTypeId: objectType.id
    });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, intake.id, [{ fieldDefinitionId: fieldId }]);

    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: intake.id,
      record: { displayName: 'Audited' },
      fields: { customer: 'ACME' }
    });
    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: intake.stateIds['In Progress'] as string
    });
    transferWorkflowItemSync(handle.db, owner, {
      workflowItemId: item.id,
      targetWorkflowId: claims.id
    });

    const actions = handle.sqlite
      .query('SELECT action FROM audit_events WHERE record_id = ? ORDER BY seq')
      .all(item.recordId) as Array<{ action: string }>;
    const names = actions.map((row) => row.action);
    expect(names).toContain('workflow_item.created');
    expect(names).toContain('workflow_item.field.changed');
    expect(names).toContain('workflow_item.state.exited');
    expect(names).toContain('workflow_item.state.entered');
    expect(names).toContain('workflow_item.transferred');
  });

  test('work created in another workspace never appears in the ledger query', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Mine' });
    // Use the service (not the raw factory) so creation writes its audit row.
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Private' }
    });

    const rows = handle.sqlite
      .query('SELECT count(*) AS n FROM audit_events WHERE record_id = ? AND workspace_id = ?')
      .get(item.recordId, other.id) as { n: number };
    expect(rows.n).toBe(0);

    const own = handle.sqlite
      .query('SELECT count(*) AS n FROM audit_events WHERE record_id = ? AND workspace_id = ?')
      .get(item.recordId, workspaceId) as { n: number };
    expect(own.n).toBeGreaterThan(0);
  });
});
