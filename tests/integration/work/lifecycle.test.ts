/**
 * Work lifecycle integration tests (ADR-0021).
 *
 * Ported from the deleted ticket lifecycle suite. The work model is now
 * `records` + `workflow_items`, so every assertion reads the universal tables:
 * identity (key/number/provenance) lives on the Record, state and waiting
 * semantics live on the WorkflowItem, and human-gate decisions are recorded in
 * the audit ledger.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import {
  AuditActions,
  auditEvents,
  records,
  workflowItemStateHistory,
  workflows,
  workflowTransitions
} from '../../../src/lib/server/db/schema';
import { setWorkflowFields } from '../../../src/lib/server/fields/service';
import {
  createWorkflowItemSync,
  requestWorkflowItemTransitionSync,
  requireWorkflowItemRow,
  setWorkflowItemFields,
  updateWorkflowItemSync
} from '../../../src/lib/server/workflow-items/service';
import { createTransition, updateState } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createObjectType,
  createUser,
  createWorkflow,
  createWorkspace,
  memberActor,
  ownerActor
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Claims Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Sarah Reviewer' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId, 'Sarah Reviewer');
});

function recordOf(workflowItemId: string) {
  const item = requireWorkflowItemRow(handle.db, workspaceId, workflowItemId);
  const record = handle.db.select().from(records).where(eq(records.id, item.recordId)).all()[0];
  if (!record) throw new Error(`Record ${item.recordId} not found`);
  return { item, record };
}

describe('work item creation', () => {
  test('allocates a per-object-type number and a workflow-prefixed key', async () => {
    const objectType = await createObjectType(handle.db, {
      workspaceId,
      key: 'claim',
      name: 'Claim',
      settings: { numbered: true, keyPrefix: 'CLM' }
    });
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Claims',
      key: 'CLM',
      objectTypeId: objectType.id
    });
    const first = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'First' }
    });
    const second = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Second' }
    });

    const firstRecord = recordOf(first.id).record;
    const secondRecord = recordOf(second.id).record;
    expect(firstRecord.number).toBe(1);
    expect(firstRecord.key).toBe('CLM-1');
    expect(secondRecord.number).toBe(2);
    expect(secondRecord.key).toBe('CLM-2');
  });

  test('records the initial state interval and stamps provenance', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Intake' });
    const created = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Inbound request' },
      provenance: { sourceType: 'incoming_email', sourceReference: 'msg-123' }
    });

    const history = handle.db
      .select()
      .from(workflowItemStateHistory)
      .where(eq(workflowItemStateHistory.workflowItemId, created.id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0]?.previousStateId).toBeNull();
    expect(history[0]?.exitedAt).toBeNull();

    const item = requireWorkflowItemRow(handle.db, workspaceId, created.id);
    expect(item.provenance).toMatchObject({
      sourceType: 'incoming_email',
      sourceReference: 'msg-123'
    });
  });

  test('requires the workflow_item:create permission', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const member = memberActor(workspaceId, uuidv7(), 'Member');
    expect(() =>
      createWorkflowItemSync(
        handle.db,
        { ...member, permissions: new Set() },
        {
          workflowId: workflow.id,
          record: { displayName: 'Nope' }
        }
      )
    ).toThrow(/not permitted to start work/i);
  });

  test('refuses to create in an archived workflow', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Old' });
    handle.db
      .update(workflows)
      .set({ archivedAt: Date.now() })
      .where(eq(workflows.id, workflow.id))
      .run();

    expect(() =>
      createWorkflowItemSync(handle.db, owner, {
        workflowId: workflow.id,
        record: { displayName: 'Nope' }
      })
    ).toThrow(/archived/);
  });

  test('rejects a state that belongs to another workflow', async () => {
    const a = await createWorkflow(handle.db, workspaceId, { name: 'A' });
    const b = await createWorkflow(handle.db, workspaceId, { name: 'B' });
    expect(() =>
      createWorkflowItemSync(handle.db, owner, {
        workflowId: a.id,
        stateId: b.states[0] as string,
        record: { displayName: 'Cross-wired' }
      })
    ).toThrow(/does not belong/);
  });

  test('an agent state requires a bound agent', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const { createState } = await import('../../../src/lib/server/workflows/service');
    expect(() =>
      createState(handle.db, owner, workflow.id, { name: 'Broken', kind: 'agent' })
    ).toThrow(/requires an agentId/);
  });
});

describe('transition validation', () => {
  test('moves work along a configured transition and closes the interval', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Move me' }
    });

    const result = requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string,
      comment: 'Starting work'
    });

    expect(result.toStateId).toBe(workflow.stateIds['In Progress'] as string);
    const history = handle.db
      .select()
      .from(workflowItemStateHistory)
      .where(eq(workflowItemStateHistory.workflowItemId, item.id))
      .orderBy(workflowItemStateHistory.enteredAt)
      .all();
    expect(history).toHaveLength(2);
    expect(history[0]?.exitedAt).toBeGreaterThan(0);
    expect(history[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(history[1]?.exitedAt).toBeNull();

    const moved = requireWorkflowItemRow(handle.db, workspaceId, item.id);
    expect(moved.stateId).toBe(workflow.stateIds['In Progress'] as string);
    expect(moved.enteredStateAt).toBeGreaterThanOrEqual(moved.createdAt);
  });

  test('refuses a transition that does not exist from the current state', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Blocked' }
    });

    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, owner, {
        workflowItemId: item.id,
        // Backlog → Done is not configured in the default template.
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/no transition to that state/i);
  });

  test('enforces a required comment on a transition', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    // A distinct target so this test exercises the guarded transition rather than
    // an unguarded one the template already provides.
    const guarded = createTransition(handle.db, owner, workflow.id, {
      fromStateId: workflow.stateIds['Backlog'] as string,
      toStateId: workflow.stateIds['Done'] as string,
      name: 'Close with reason',
      requiresComment: true
    });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Comment needed' }
    });

    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, owner, {
        workflowItemId: item.id,
        transitionId: guarded.id
      })
    ).toThrow(/requires a comment/i);

    const ok = requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      transitionId: guarded.id,
      comment: 'Because'
    });
    expect(ok.toStateId).toBe(workflow.stateIds['Done'] as string);
  });

  test('enforces state-scoped required fields when leaving that state', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'outcome',
      name: 'Outcome',
      type: 'select',
      options: { choices: [{ value: 'approved', label: 'Approved' }] }
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: fieldId, requiredInStates: [workflow.stateIds['In Progress'] as string] }
    ]);
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Needs outcome' }
    });

    // Entering the state is allowed: the requirement describes what the work in the
    // state must produce, not what it needs on arrival.
    const entered = requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    expect(entered.toStateId).toBe(workflow.stateIds['In Progress'] as string);

    // Leaving it without the outcome is refused.
    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, owner, {
        workflowItemId: item.id,
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/Missing required field/);

    // Supplying the value on the transition satisfies it in one step.
    const left = requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['Done'] as string,
      fieldValues: { outcome: 'approved' }
    });
    expect(left.toStateId).toBe(workflow.stateIds['Done'] as string);
  });

  test('enforces universally required fields on entry', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: fieldId, required: true }
    ]);
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Needs customer' },
      fields: { customer: 'ACME' }
    });

    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    await setWorkflowItemFields(handle.db, owner, {
      workflowItemId: item.id,
      values: { customer: '' }
    });
    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, owner, {
        workflowItemId: item.id,
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/Missing required field/);
  });

  test('marks a terminal state as closed', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Finish' }
    });
    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['Done'] as string
    });
    const done = requireWorkflowItemRow(handle.db, workspaceId, item.id);
    expect(done.closedAt).toBeGreaterThan(0);
    expect(done.waitingOn).toBe('none');
  });

  test('rejects a stale optimistic-concurrency update', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Race' }
    });
    const before = requireWorkflowItemRow(handle.db, workspaceId, item.id);

    updateWorkflowItemSync(handle.db, owner, {
      workflowItemId: item.id,
      title: 'Renamed',
      expectedVersion: before.version
    });
    expect(() =>
      updateWorkflowItemSync(handle.db, owner, {
        workflowItemId: item.id,
        title: 'Stale rename',
        expectedVersion: before.version
      })
    ).toThrow(/modified by another writer/);
  });
});

describe('human gates', () => {
  async function gatedWorkflow() {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Review flow',
      states: [
        { name: 'Work', kind: 'agent', category: 'active', isStart: true },
        { name: 'Review', kind: 'manual', category: 'review' },
        { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true },
        { name: 'Rework', kind: 'manual', category: 'active' }
      ],
      transitions: [
        ['Work', 'Review', 'Request review'],
        ['Review', 'Done', 'Approve'],
        ['Review', 'Rework', 'Rework']
      ]
    });
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Work'] as string,
      agentId: 'agent-1',
      kind: 'agent'
    });
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Review'] as string,
      humanGate: { enabled: true, requiredComment: true }
    });
    return workflow;
  }

  test('agents cannot transition out of a gated state', async () => {
    const workflow = await gatedWorkflow();
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Gated' }
    });
    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['Review'] as string
    });

    const agent: ActorContext = {
      ...owner,
      actorType: 'agent',
      role: 'agent',
      permissions: new Set(owner.permissions)
    };
    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, agent, {
        workflowItemId: item.id,
        targetStateId: workflow.stateIds['Done'] as string,
        comment: 'I approve myself'
      })
    ).toThrow(/human decision/);
  });

  test('a human decision is recorded with its outcome and comment', async () => {
    const workflow = await gatedWorkflow();
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Gated' }
    });
    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['Review'] as string
    });

    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, owner, {
        workflowItemId: item.id,
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/requires a comment/i);

    const decision = requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['Done'] as string,
      comment: 'Reviewed and approved',
      viaGate: true
    });

    const events = handle.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workflowItemId, item.id),
          eq(auditEvents.action, AuditActions.workflowItemHumanGateDecided)
        )
      )
      .all();
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe(ownerId);
    expect((events[0]?.data as { comment?: string } | null)?.comment).toBe('Reviewed and approved');
    expect(decision.toStateId).toBe(workflow.stateIds['Done'] as string);
  });

  test('a gated state marks the work as waiting on a human', async () => {
    const workflow = await gatedWorkflow();
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Waiting' }
    });
    requestWorkflowItemTransitionSync(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['Review'] as string
    });
    const waiting = requireWorkflowItemRow(handle.db, workspaceId, item.id);
    expect(waiting.waitingOn).toBe('human');
  });

  test('gate role restrictions are enforced', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Senior review',
      states: [
        { name: 'Review', kind: 'manual', category: 'review', isStart: true },
        { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
      ],
      transitions: [['Review', 'Done', 'Approve']]
    });
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Review'] as string,
      humanGate: { enabled: true, allowedRoles: ['owner'] }
    });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Senior only' }
    });
    const member = memberActor(workspaceId, uuidv7(), 'Junior');

    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, member, {
        workflowItemId: item.id,
        targetStateId: workflow.stateIds['Done'] as string,
        comment: 'Let me in'
      })
    ).toThrow(/role cannot decide this gate/);
  });

  test('a transition not listed on the gate is refused', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Restricted gate',
      states: [
        { name: 'Review', kind: 'manual', category: 'review', isStart: true },
        { name: 'Approved', kind: 'terminal', category: 'done', isTerminal: true },
        { name: 'Rejected', kind: 'terminal', category: 'cancelled', isTerminal: true }
      ],
      transitions: [
        ['Review', 'Approved', 'Approve'],
        ['Review', 'Rejected', 'Reject']
      ]
    });
    const approveTransition = handle.db
      .select()
      .from(workflowTransitions)
      .where(
        and(
          eq(workflowTransitions.workflowId, workflow.id),
          eq(workflowTransitions.toStateId, workflow.stateIds['Approved'] as string)
        )
      )
      .all()[0];

    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Review'] as string,
      humanGate: { enabled: true, allowedTransitionIds: [approveTransition?.id as string] }
    });
    const item = createWorkflowItemSync(handle.db, owner, {
      workflowId: workflow.id,
      record: { displayName: 'Restricted' }
    });

    expect(() =>
      requestWorkflowItemTransitionSync(handle.db, owner, {
        workflowItemId: item.id,
        targetStateId: workflow.stateIds['Rejected'] as string,
        comment: 'Reject'
      })
    ).toThrow(/not permitted from this gate/);
  });
});
