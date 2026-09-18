/**
 * Generic dispatch engine tests (ADR-0024).
 *
 * WorkflowItems of any Object Type are dispatched through `workflow_item.enter`:
 * system states execute their action, agent states run against the record, human
 * gates wait, and stale entries are skipped, so duplicate delivery is harmless.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import {
  jobs,
  records,
  workflowItems,
  workflowStates,
  workflows
} from '../../../src/lib/server/db/schema';
import { createObjectType, setBaseFields } from '../../../src/lib/server/records/object-types';
import { createRecord, getRecordDetail } from '../../../src/lib/server/records/service';
import {
  dispatchWorkflowItemEntrySync,
  handleWorkflowItemStateEntry,
  type WorkflowItemEntryPayload
} from '../../../src/lib/server/workflow-items/dispatch';
import {
  createWorkflowItem,
  getWorkflowItemDetail,
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
  const workspace = await createWorkspace(db, 'Dispatch');
  workspaceId = workspace.id;
  const user = await createUser(db, { name: 'Owner' });
  owner = ownerActor(workspaceId, user.id);
});

async function policyType() {
  const objectType = createObjectType(db, owner, { name: 'Policy' });
  await setBaseFields(db, owner, objectType.id, [
    { key: 'policy_number', name: 'Policy Number', type: 'short_text', isPrimaryDisplay: true }
  ] as never);
  return objectType;
}

async function workflowFor(name: string, objectTypeId: string) {
  const fixture = await createWorkflowFixture(db, workspaceId, {
    name,
    states: [
      { name: 'Backlog', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Working', kind: 'system', category: 'active' },
      { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
    ]
  });
  db.update(workflows).set({ objectTypeId }).where(eq(workflows.id, fixture.id)).run();
  return fixture;
}

function pendingEntryJobs() {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, 'workflow_item.enter')))
    .all();
}

describe('generic dispatch: enqueue', () => {
  test('entering a system state enqueues workflow_item.enter and runs the action', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({
        config: {
          systemAction: {
            type: 'transition',
            targetStateId: workflow.stateIds.Done as string
          }
        } as never
      })
      .where(eq(workflowStates.id, workflow.stateIds.Working as string))
      .run();

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: workflow.stateIds.Working as string
    });

    const queued = pendingEntryJobs();
    expect(queued).toHaveLength(1);
    const payload = queued[0]?.payload as unknown as WorkflowItemEntryPayload;
    expect(payload.workflowItemId).toBe(item.id);

    const result = await handleWorkflowItemStateEntry(db, payload);
    expect(result.outcome).toBe('ran');
    const detail = await getWorkflowItemDetail(db, owner, item.id);
    expect(detail.stateId).toBe(workflow.stateIds.Done as string);
    expect(detail.completedAt).not.toBeNull();
  });

  test('a system setFields action writes base and overlay values', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({ config: { systemAction: { type: 'setFields', values: { premium: 55 } } } as never })
      .where(eq(workflowStates.id, workflow.stateIds.Working as string))
      .run();
    // Add a numeric field to write.
    await setBaseFields(db, owner, policy.id, [
      { key: 'policy_number', name: 'Policy Number', type: 'short_text', isPrimaryDisplay: true },
      { key: 'premium', name: 'Premium', type: 'number' }
    ] as never);

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: workflow.stateIds.Working as string
    });
    const payload = pendingEntryJobs()[0]?.payload as unknown as WorkflowItemEntryPayload;
    const result = await handleWorkflowItemStateEntry(db, payload);
    expect(result.outcome).toBe('ran');
    const detail = await getRecordDetail(db, owner, record.id);
    expect(detail.fields.premium).toBe(55);
    void item;
  });

  test('a createWorkItem action starts work in another workflow from a template', async () => {
    const policy = await policyType();
    const destination = await workflowFor('Remediation', policy.id);
    const source = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({
        config: {
          systemAction: {
            type: 'createWorkItem',
            workflowId: destination.id,
            titleTemplate: '{{title}} follow-up'
          }
        } as never
      })
      .where(eq(workflowStates.id, source.stateIds.Working as string))
      .run();

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    await createWorkflowItem(db, owner, {
      workflowId: source.id,
      recordId: record.id,
      stateId: source.stateIds.Working as string
    });
    const payload = pendingEntryJobs()[0]?.payload as unknown as WorkflowItemEntryPayload;
    expect((await handleWorkflowItemStateEntry(db, payload)).outcome).toBe('ran');

    const created = db
      .select()
      .from(workflowItems)
      .where(eq(workflowItems.workflowId, destination.id))
      .all();
    expect(created).toHaveLength(1);
    const createdRecord = db
      .select()
      .from(records)
      .where(eq(records.id, created[0]!.recordId))
      .all()[0];
    // `{{title}}` resolves from the source Record's display name.
    expect(createdRecord?.displayName).toBe('P1 follow-up');
  });

  test('a manual state does not auto-enqueue work', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({ config: { systemAction: { type: 'transition' } } as never })
      .where(eq(workflowStates.id, workflow.states[0] as string))
      .run();

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: workflow.states[0] as string
    });
    expect(pendingEntryJobs()).toHaveLength(0);
  });
});

describe('generic dispatch: handle state entry', () => {
  test('a human gate waits and a stale entry is skipped', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({ humanGate: { enabled: true } as never })
      .where(eq(workflowStates.id, workflow.stateIds.Working as string))
      .run();

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: workflow.stateIds.Working as string
    });
    // A human gate is a hard stop: no job is enqueued.
    expect(pendingEntryJobs()).toHaveLength(0);
    const payload: WorkflowItemEntryPayload = {
      workspaceId,
      workflowItemId: item.id,
      stateId: workflow.stateIds.Working as string,
      workflowId: workflow.id,
      recordId: record.id,
      enteredAt: item.enteredStateAt
    };
    expect((await handleWorkflowItemStateEntry(db, payload)).outcome).toBe('waiting');

    // Move the item on, then replay the old payload: it must be skipped.
    await requestWorkflowItemTransition(db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds.Done as string
    });
    const stale = await handleWorkflowItemStateEntry(db, payload);
    expect(stale.outcome).toBe('skipped');
  });

  test('an agent state without an agent fails cleanly', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({ kind: 'agent', agentId: null, autoExecute: true } as never)
      .where(eq(workflowStates.id, workflow.stateIds.Working as string))
      .run();
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: workflow.stateIds.Working as string
    });
    const payload = pendingEntryJobs()[0]?.payload as unknown as WorkflowItemEntryPayload;
    const result = await handleWorkflowItemStateEntry(db, payload);
    expect(result.outcome).toBe('failed');
    expect(result.detail).toBe('agent_state_without_agent');
    void item;
  });

  test('manual dispatch enqueues a workflow_item.enter job', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    db.update(workflowStates)
      .set({ config: { systemAction: { type: 'transition' } } as never })
      .where(eq(workflowStates.id, workflow.stateIds.Working as string))
      .run();
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: workflow.stateIds.Working as string
    });
    const before = pendingEntryJobs().length;

    const dispatched = dispatchWorkflowItemEntrySync(db, owner, { workflowItemId: item.id });
    expect(dispatched.stateId).toBe(workflow.stateIds.Working as string);
    expect(pendingEntryJobs().length).toBe(before + 1);
  });
});
