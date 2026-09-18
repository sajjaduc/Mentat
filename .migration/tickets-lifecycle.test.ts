import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { errors } from '../../../src/lib/server/core/errors';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import { getDb } from '../../../src/lib/server/db/client';
import {
  agents,
  agentVersions,
  jobs,
  ticketFieldValues,
  ticketStateHistory
} from '../../../src/lib/server/db/schema';
import { setWorkflowFields } from '../../../src/lib/server/fields/service';
import {
  createTicketSync,
  installTicketService,
  myWork,
  requestTransitionSync,
  requireTicketSync,
  searchTickets,
  setWaitingOnSync,
  transferTicketSync,
  updateTicketSync
} from '../../../src/lib/server/tickets/service';
import { writeTicketFieldValues } from '../../../src/lib/server/tickets/values';
import {
  createState,
  createTransition,
  updateState
} from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createWorkflow,
  createWorkspace,
  memberActor,
  ownerActor
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let owner: ActorContext;

async function seedAgent(workflowId: string, name = 'Triage Agent'): Promise<string> {
  const now = Date.now();
  const agentId = uuidv7(now);
  handle.db
    .insert(agents)
    .values({
      id: agentId,
      workspaceId,
      workflowId,
      name,
      description: null,
      instructions: 'Do the work.',
      version: 1,
      createdAt: now,
      updatedAt: now
    })
    .run();
  handle.db
    .insert(agentVersions)
    .values({
      id: uuidv7(now),
      workspaceId,
      agentId,
      version: 1,
      snapshot: {
        id: agentId,
        workspaceId,
        name,
        instructions: 'Do the work.',
        skillIds: [],
        toolIds: [],
        version: 1
      },
      createdAt: now
    })
    .run();
  return agentId;
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Claims Co');
  workspaceId = workspace.id;
  const user = { id: uuidv7() };
  ownerId = user.id;
  handle.db
    .insert((await import('../../../src/lib/server/db/schema')).users)
    .values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      name: 'Sarah Reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  owner = ownerActor(workspaceId, ownerId, 'Sarah Reviewer');
  // The service locator is used by triggers/files; install it for these tests too.
  installTicketService(() => handle.db);
  void getDb;
});

describe('ticket creation', () => {
  test('allocates a per-workspace number and a workflow-scoped key', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims', key: 'CLM' });
    const first = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'First' });
    const second = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Second' });

    expect(first.number).toBe(1);
    expect(first.key).toBe('CLM-1');
    expect(second.number).toBe(2);
    expect(second.key).toBe('CLM-2');
  });

  test('records the initial state interval and stamps provenance', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Intake' });
    const created = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Inbound request',
      provenance: { sourceType: 'incoming_email', sourceReference: 'msg-123' }
    });

    const history = handle.db
      .select()
      .from(ticketStateHistory)
      .where(eq(ticketStateHistory.ticketId, created.id))
      .all();
    expect(history).toHaveLength(1);
    expect(history[0]?.previousStateId).toBeNull();
    expect(history[0]?.exitedAt).toBeNull();

    const ticket = requireTicketSync(handle.db, workspaceId, created.id);
    expect(ticket.provenance).toMatchObject({
      sourceType: 'incoming_email',
      sourceReference: 'msg-123'
    });
  });

  test('enqueues destination-state work only for agent and system states', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const manual = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Manual' });
    let queued = handle.db.select().from(jobs).where(eq(jobs.ticketId, manual.id)).all();
    expect(queued).toHaveLength(0);

    const agentId = await seedAgent(workflow.id);
    const agentState = createState(handle.db, owner, workflow.id, {
      name: 'Drafting',
      kind: 'agent',
      agentId
    });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      stateId: agentState.id,
      title: 'Agent work'
    });
    queued = handle.db.select().from(jobs).where(eq(jobs.ticketId, ticket.id)).all();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.type).toBe('state.enter');
    expect(queued[0]?.dedupeKey).toContain(`${ticket.id}:${agentState.id}`);
  });

  test('an agent state requires a bound agent', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    expect(() =>
      createState(handle.db, owner, workflow.id, { name: 'Broken', kind: 'agent' })
    ).toThrow(/requires an agentId/);
  });

  test('applies typed fields, labels and parent relationships at creation', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'claim_amount',
      name: 'Claim Amount',
      type: 'currency'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: fieldId, required: true, showOnCard: true }
    ]);

    const parent = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Parent' });
    const child = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Child',
      fields: { claim_amount: 12500 },
      labelNames: ['urgent'],
      parentTicketId: parent.id
    });

    const values = handle.db
      .select()
      .from(ticketFieldValues)
      .where(eq(ticketFieldValues.ticketId, child.id))
      .all();
    expect(values).toHaveLength(1);
    expect(values[0]?.valueNumber).toBe(12500);

    const { ticketRelationships } = await import('../../../src/lib/server/db/schema');
    const rel = handle.db
      .select()
      .from(ticketRelationships)
      .where(eq(ticketRelationships.toTicketId, child.id))
      .all();
    expect(rel).toHaveLength(1);
    expect(rel[0]?.type).toBe('child');
  });

  test('rejects a state that belongs to another workflow', async () => {
    const a = await createWorkflow(handle.db, workspaceId, { name: 'A' });
    const b = await createWorkflow(handle.db, workspaceId, { name: 'B' });
    expect(() =>
      createTicketSync(handle.db, owner, {
        workflowId: a.id,
        stateId: b.states[0] as string,
        title: 'Cross-wired'
      })
    ).toThrow(/does not belong/);
  });

  test('requires the ticket:create permission', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const member = memberActor(workspaceId, uuidv7(), 'Member');
    expect(() =>
      createTicketSync(
        handle.db,
        { ...member, permissions: new Set() },
        {
          workflowId: workflow.id,
          title: 'Nope'
        }
      )
    ).toThrow(errors.forbidden().message);
  });

  test('refuses to create in an archived workflow', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Old' });
    handle.db
      .update((await import('../../../src/lib/server/db/schema')).workflows)
      .set({ archivedAt: Date.now() })
      .where(eq((await import('../../../src/lib/server/db/schema')).workflows.id, workflow.id))
      .run();
    expect(() =>
      createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Nope' })
    ).toThrow(/archived/);
  });
});

describe('typed field writes', () => {
  test('normalizes each type into the right column and records history', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const textId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    const moneyId = await createField(handle.db, {
      workspaceId,
      key: 'amount',
      name: 'Amount',
      type: 'currency'
    });
    const dateId = await createField(handle.db, {
      workspaceId,
      key: 'renewal',
      name: 'Renewal',
      type: 'date'
    });
    const boolId = await createField(handle.db, {
      workspaceId,
      key: 'flagged',
      name: 'Flagged',
      type: 'boolean'
    });
    const selectId = await createField(handle.db, {
      workspaceId,
      key: 'risk',
      name: 'Risk',
      type: 'select',
      options: {
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: textId },
      { fieldDefinitionId: moneyId },
      { fieldDefinitionId: dateId },
      { fieldDefinitionId: boolId },
      { fieldDefinitionId: selectId }
    ]);

    const ticket = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Typed' });
    writeTicketFieldValues(handle.db, {
      workspaceId,
      ticketId: ticket.id,
      workflowId: workflow.id,
      values: {
        customer: 'ACME Pty Ltd',
        amount: '12,500.50',
        renewal: '2026-03-01',
        flagged: 'yes',
        risk: 'high'
      },
      actor: owner
    });

    const rows = handle.db
      .select()
      .from(ticketFieldValues)
      .where(eq(ticketFieldValues.ticketId, ticket.id))
      .all();
    const byField = new Map(rows.map((row) => [row.fieldDefinitionId, row]));
    expect(byField.get(textId)?.valueText).toBe('ACME Pty Ltd');
    expect(byField.get(textId)?.searchText).toBe('acme pty ltd');
    expect(byField.get(moneyId)?.valueNumber).toBe(12500.5);
    expect(byField.get(dateId)?.valueDate).toBe(Date.parse('2026-03-01T00:00:00.000Z'));
    expect(byField.get(boolId)?.valueBool).toBe(true);
    expect(byField.get(selectId)?.valueText).toBe('high');

    const history = handle.db
      .select()
      .from((await import('../../../src/lib/server/db/schema')).fieldValueHistory)
      .where(
        eq((await import('../../../src/lib/server/db/schema')).fieldValueHistory.ownerId, ticket.id)
      )
      .all();
    expect(history).toHaveLength(5);
    expect(history.every((row) => row.previousValue === null)).toBe(true);
  });

  test('rejects a value that violates the field type or options', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const selectId = await createField(handle.db, {
      workspaceId,
      key: 'risk',
      name: 'Risk',
      type: 'select',
      options: { choices: [{ value: 'low', label: 'Low' }] }
    });
    const numberId = await createField(handle.db, {
      workspaceId,
      key: 'count',
      name: 'Count',
      type: 'number'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: selectId },
      { fieldDefinitionId: numberId }
    ]);
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Invalid'
    });

    expect(() =>
      writeTicketFieldValues(handle.db, {
        workspaceId,
        ticketId: ticket.id,
        workflowId: workflow.id,
        values: { risk: 'enormous' },
        actor: owner
      })
    ).toThrow(/must be one of/);

    expect(() =>
      writeTicketFieldValues(handle.db, {
        workspaceId,
        ticketId: ticket.id,
        workflowId: workflow.id,
        values: { count: 'not a number' },
        actor: owner
      })
    ).toThrow(/must be a number/);
  });

  test('refuses a field that is not configured on the workflow', async () => {
    const workflowA = await createWorkflow(handle.db, workspaceId, { name: 'A' });
    const workflowB = await createWorkflow(handle.db, workspaceId, { name: 'B' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'only_a',
      name: 'Only A',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflowA.id, [{ fieldDefinitionId: fieldId }]);

    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflowB.id,
      title: 'B ticket'
    });
    expect(() =>
      writeTicketFieldValues(handle.db, {
        workspaceId,
        ticketId: ticket.id,
        workflowId: workflowB.id,
        values: { only_a: 'x' },
        actor: owner
      })
    ).toThrow(/not configured/);
  });

  test('honours read-only workflow fields and agent write grants', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const lockedId = await createField(handle.db, {
      workspaceId,
      key: 'locked',
      name: 'Locked',
      type: 'short_text'
    });
    const openId = await createField(handle.db, {
      workspaceId,
      key: 'open_field',
      name: 'Open',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: lockedId, editable: false },
      { fieldDefinitionId: openId, editable: true }
    ]);
    const ticket = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Policy' });

    expect(() =>
      writeTicketFieldValues(handle.db, {
        workspaceId,
        ticketId: ticket.id,
        workflowId: workflow.id,
        values: { locked: 'nope' },
        actor: owner
      })
    ).toThrow(/read-only/);

    const agent = { ...owner, actorType: 'agent' as const, role: 'agent' as const };
    expect(() =>
      writeTicketFieldValues(handle.db, {
        workspaceId,
        ticketId: ticket.id,
        workflowId: workflow.id,
        values: { open_field: 'nope' },
        actor: agent,
        allowedKeys: new Set(['other_key'])
      })
    ).toThrow(/Not permitted to write field/);
  });

  test('records previous and next values on update and deletion', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'amount',
      name: 'Amount',
      type: 'number'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'History'
    });

    writeTicketFieldValues(handle.db, {
      workspaceId,
      ticketId: ticket.id,
      workflowId: workflow.id,
      values: { amount: 100 },
      actor: owner
    });
    writeTicketFieldValues(handle.db, {
      workspaceId,
      ticketId: ticket.id,
      workflowId: workflow.id,
      values: { amount: 200 },
      actor: owner
    });
    writeTicketFieldValues(handle.db, {
      workspaceId,
      ticketId: ticket.id,
      workflowId: workflow.id,
      values: { amount: '' },
      actor: owner
    });

    const { fieldValueHistory } = await import('../../../src/lib/server/db/schema');
    const history = handle.db
      .select()
      .from(fieldValueHistory)
      .where(eq(fieldValueHistory.ownerId, ticket.id))
      .all();
    expect(history.map((row) => [row.previousValue, row.newValue])).toEqual([
      [null, 100],
      [100, 200],
      [200, null]
    ]);
    const remaining = handle.db
      .select()
      .from(ticketFieldValues)
      .where(eq(ticketFieldValues.ticketId, ticket.id))
      .all();
    expect(remaining).toHaveLength(0);
  });

  test('does not create history when the value is unchanged', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Idempotent'
    });

    for (let i = 0; i < 3; i++) {
      writeTicketFieldValues(handle.db, {
        workspaceId,
        ticketId: ticket.id,
        workflowId: workflow.id,
        values: { customer: 'ACME' },
        actor: owner
      });
    }
    const { fieldValueHistory } = await import('../../../src/lib/server/db/schema');
    const history = handle.db
      .select()
      .from(fieldValueHistory)
      .where(eq(fieldValueHistory.ownerId, ticket.id))
      .all();
    expect(history).toHaveLength(1);
  });
});

describe('transition validation', () => {
  test('moves a ticket along a configured transition and closes the interval', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Move me'
    });

    const result = requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['In Progress'] as string,
      comment: 'Starting work'
    });

    expect(result.enteredStateId).toBe(workflow.stateIds['In Progress'] as string);
    const history = handle.db
      .select()
      .from(ticketStateHistory)
      .where(eq(ticketStateHistory.ticketId, ticket.id))
      .orderBy(ticketStateHistory.enteredAt)
      .all();
    expect(history).toHaveLength(2);
    expect(history[0]?.exitedAt).toBeGreaterThan(0);
    expect(history[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(history[1]?.exitedAt).toBeNull();

    const moved = requireTicketSync(handle.db, workspaceId, ticket.id);
    expect(moved.stateId).toBe(workflow.stateIds['In Progress'] as string);
    expect(moved.enteredStateAt).toBeGreaterThanOrEqual(moved.createdAt);
  });

  test('refuses a transition that does not exist from the current state', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Blocked'
    });

    expect(() =>
      requestTransitionSync(handle.db, owner, {
        ticketId: ticket.id,
        // Backlog → Done is not configured in the default template.
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/no transition to that state/i);
  });

  test('enforces a required comment on a transition', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    // A distinct target so this test exercises the guarded transition rather than
    // the unguarded transition the template already provides to the same state.
    const guarded = createTransition(handle.db, owner, workflow.id, {
      fromStateId: workflow.stateIds['Backlog'] as string,
      toStateId: workflow.stateIds['Done'] as string,
      name: 'Close with reason',
      requiresComment: true
    });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Comment needed'
    });

    expect(() =>
      requestTransitionSync(handle.db, owner, {
        ticketId: ticket.id,
        transitionId: guarded.id
      })
    ).toThrow(/comment is required/i);

    const ok = requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      transitionId: guarded.id,
      comment: 'Because'
    });
    expect(ok.enteredStateId).toBe(workflow.stateIds['Done'] as string);
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
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Needs outcome'
    });

    // Entering the state is allowed: the requirement describes what the work in the
    // state must produce, not what it needs on arrival.
    const entered = requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    expect(entered.enteredStateId).toBe(workflow.stateIds['In Progress'] as string);

    // Leaving it without the outcome is refused.
    expect(() =>
      requestTransitionSync(handle.db, owner, {
        ticketId: ticket.id,
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/Required field/);

    // Supplying the value on the transition satisfies it in one step.
    const left = requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['Done'] as string,
      fieldValues: { outcome: 'approved' }
    });
    expect(left.enteredStateId).toBe(workflow.stateIds['Done'] as string);
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
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Needs customer',
      fields: { customer: 'ACME' }
    });

    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    writeTicketFieldValues(handle.db, {
      workspaceId,
      ticketId: ticket.id,
      workflowId: workflow.id,
      values: { customer: '' },
      actor: owner
    });
    expect(() =>
      requestTransitionSync(handle.db, owner, {
        ticketId: ticket.id,
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/Required field/);
  });

  test('marks a terminal state as closed', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const ticket = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Finish' });
    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['Done'] as string
    });
    const done = requireTicketSync(handle.db, workspaceId, ticket.id);
    expect(done.closedAt).toBeGreaterThan(0);
    expect(done.waitingOn).toBe('none');
  });

  test('rejects a stale optimistic-concurrency update', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const ticket = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Race' });
    const before = requireTicketSync(handle.db, workspaceId, ticket.id);

    updateTicketSync(handle.db, owner, {
      ticketId: ticket.id,
      title: 'Renamed',
      expectedVersion: before.version
    });
    expect(() =>
      updateTicketSync(handle.db, owner, {
        ticketId: ticket.id,
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
    const agentId = await seedAgent(workflow.id);
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Work'] as string,
      agentId,
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
    const ticket = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Gated' });
    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['Review'] as string
    });

    const agent: ActorContext = {
      ...owner,
      actorType: 'agent',
      role: 'agent',
      permissions: new Set(owner.permissions)
    };
    expect(() =>
      requestTransitionSync(handle.db, agent, {
        ticketId: ticket.id,
        targetStateId: workflow.stateIds['Done'] as string,
        comment: 'I approve myself'
      })
    ).toThrow(/requires a human decision/);
  });

  test('a human decision is recorded with its outcome and comment', async () => {
    const workflow = await gatedWorkflow();
    const ticket = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Gated' });
    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['Review'] as string
    });

    expect(() =>
      requestTransitionSync(handle.db, owner, {
        ticketId: ticket.id,
        targetStateId: workflow.stateIds['Done'] as string
      })
    ).toThrow(/comment is required/i);

    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['Done'] as string,
      comment: 'Reviewed and approved'
    });

    const { humanGateDecisions } = await import('../../../src/lib/server/db/schema');
    const decisions = handle.db
      .select()
      .from(humanGateDecisions)
      .where(eq(humanGateDecisions.ticketId, ticket.id))
      .all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decidedByUserId).toBe(ownerId);
    expect(decisions[0]?.comment).toBe('Reviewed and approved');
    expect(decisions[0]?.toStateId).toBe(workflow.stateIds['Done']);
  });

  test('a gated state marks the ticket as waiting on a human', async () => {
    const workflow = await gatedWorkflow();
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Waiting'
    });
    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: workflow.stateIds['Review'] as string
    });
    const waiting = requireTicketSync(handle.db, workspaceId, ticket.id);
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
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Senior only'
    });
    const member = memberActor(workspaceId, uuidv7(), 'Junior');

    expect(() =>
      requestTransitionSync(handle.db, member, {
        ticketId: ticket.id,
        targetStateId: workflow.stateIds['Done'] as string,
        comment: 'Let me in'
      })
    ).toThrow(/role is not permitted/);
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
      .from((await import('../../../src/lib/server/db/schema')).workflowTransitions)
      .where(
        and(
          eq(
            (await import('../../../src/lib/server/db/schema')).workflowTransitions.workflowId,
            workflow.id
          ),
          eq(
            (await import('../../../src/lib/server/db/schema')).workflowTransitions.toStateId,
            workflow.stateIds['Approved'] as string
          )
        )
      )
      .all()[0];

    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Review'] as string,
      humanGate: { enabled: true, allowedTransitionIds: [approveTransition?.id as string] }
    });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Restricted'
    });

    expect(() =>
      requestTransitionSync(handle.db, owner, {
        ticketId: ticket.id,
        targetStateId: workflow.stateIds['Rejected'] as string,
        comment: 'Reject'
      })
    ).toThrow(/not permitted at this human gate/);
  });
});

describe('cross-workflow transfer', () => {
  async function intakeAndClaims() {
    const intake = await createWorkflow(handle.db, workspaceId, { name: 'Intake', key: 'INT' });
    const claims = await createWorkflow(handle.db, workspaceId, { name: 'Claims', key: 'CLM' });
    return { intake, claims };
  }

  test('moves a ticket, preserving identity, notes and history', async () => {
    const { intake, claims } = await intakeAndClaims();
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: intake.id,
      title: 'Inbound claim'
    });
    const { addNoteSync } = await import('../../../src/lib/server/tickets/service');
    addNoteSync(handle.db, owner, { ticketId: ticket.id, body: 'Classified as a claim' });

    const result = transferTicketSync(handle.db, owner, {
      ticketId: ticket.id,
      targetWorkflowId: claims.id,
      reason: 'Classified as claim'
    });

    expect(result.ticketId).toBe(ticket.id);
    expect(result.toWorkflowId).toBe(claims.id);
    expect(result.toStateId).toBe(claims.states[0] as string);

    const moved = requireTicketSync(handle.db, workspaceId, ticket.id);
    expect(moved.id).toBe(ticket.id);
    expect(moved.key).toBe(ticket.key);
    expect(moved.workflowId).toBe(claims.id);

    const { ticketWorkflowHistory, ticketNotes } = await import(
      '../../../src/lib/server/db/schema'
    );
    const transfers = handle.db
      .select()
      .from(ticketWorkflowHistory)
      .where(eq(ticketWorkflowHistory.ticketId, ticket.id))
      .all();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.reason).toBe('Classified as claim');

    const notes = handle.db
      .select()
      .from(ticketNotes)
      .where(eq(ticketNotes.ticketId, ticket.id))
      .all();
    expect(notes).toHaveLength(1);

    const history = handle.db
      .select()
      .from(ticketStateHistory)
      .where(eq(ticketStateHistory.ticketId, ticket.id))
      .orderBy(ticketStateHistory.enteredAt)
      .all();
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[history.length - 1]?.workflowId).toBe(claims.id);
    expect(history[history.length - 1]?.exitedAt).toBeNull();
  });

  test('applies configured field mappings and carries shared keys automatically', async () => {
    const { intake, claims } = await intakeAndClaims();
    const sharedId = await createField(handle.db, {
      workspaceId,
      key: 'customer_email',
      name: 'Customer Email',
      type: 'email'
    });
    const sourceOnlyId = await createField(handle.db, {
      workspaceId,
      key: 'reference_number',
      name: 'Reference',
      type: 'short_text'
    });
    const targetId = await createField(handle.db, {
      workspaceId,
      key: 'external_reference',
      name: 'External Ref',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, intake.id, [
      { fieldDefinitionId: sharedId },
      { fieldDefinitionId: sourceOnlyId }
    ]);
    setWorkflowFields(handle.db, owner, claims.id, [
      { fieldDefinitionId: sharedId },
      { fieldDefinitionId: targetId }
    ]);
    const { setTransferRule } = await import('../../../src/lib/server/workflows/service');
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      fieldMappings: { reference_number: 'external_reference' }
    });

    const ticket = createTicketSync(handle.db, owner, {
      workflowId: intake.id,
      title: 'Mapped',
      fields: { customer_email: 'ap@acme.test', reference_number: 'REF-9' }
    });
    transferTicketSync(handle.db, owner, { ticketId: ticket.id, targetWorkflowId: claims.id });

    const { fieldValuesByKey } = await import('../../../src/lib/server/tickets/values');
    const values = fieldValuesByKey(handle.db, workspaceId, ticket.id);
    expect(values.customer_email).toBe('ap@acme.test');
    expect(values.external_reference).toBe('REF-9');
  });

  test('refuses a transfer when a destination required field is missing', async () => {
    const { intake, claims } = await intakeAndClaims();
    const requiredId = await createField(handle.db, {
      workspaceId,
      key: 'claim_type',
      name: 'Claim Type',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, claims.id, [
      { fieldDefinitionId: requiredId, required: true }
    ]);

    const ticket = createTicketSync(handle.db, owner, { workflowId: intake.id, title: 'Missing' });
    expect(() =>
      transferTicketSync(handle.db, owner, { ticketId: ticket.id, targetWorkflowId: claims.id })
    ).toThrow(/destination requires/i);

    // The failed transfer must not have moved the ticket.
    const unchanged = requireTicketSync(handle.db, workspaceId, ticket.id);
    expect(unchanged.workflowId).toBe(intake.id);
  });

  test('agents may not transfer when the rule disallows it', async () => {
    const { intake, claims } = await intakeAndClaims();
    const { setTransferRule } = await import('../../../src/lib/server/workflows/service');
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      allowAgents: false
    });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: intake.id,
      title: 'Agent transfer'
    });
    const agent: ActorContext = {
      ...owner,
      actorType: 'agent',
      role: 'agent',
      permissions: new Set(owner.permissions)
    };
    expect(() =>
      transferTicketSync(handle.db, agent, { ticketId: ticket.id, targetWorkflowId: claims.id })
    ).toThrow(/Agents may not transfer/);
  });

  test('a transfer requiring approval is refused without one', async () => {
    const { intake, claims } = await intakeAndClaims();
    const { setTransferRule } = await import('../../../src/lib/server/workflows/service');
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      requiresApproval: true
    });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: intake.id,
      title: 'Needs approval'
    });
    expect(() =>
      transferTicketSync(handle.db, owner, { ticketId: ticket.id, targetWorkflowId: claims.id })
    ).toThrow(/requires approval/);

    const approved = transferTicketSync(handle.db, owner, {
      ticketId: ticket.id,
      targetWorkflowId: claims.id,
      approved: true
    });
    expect(approved.toWorkflowId).toBe(claims.id);
  });

  test('transfer preview reports compatible, mapped and missing fields', async () => {
    const { intake, claims } = await intakeAndClaims();
    const sharedId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    const sourceId = await createField(handle.db, {
      workspaceId,
      key: 'source_ref',
      name: 'Source Ref',
      type: 'short_text'
    });
    const targetRequiredId = await createField(handle.db, {
      workspaceId,
      key: 'claim_type',
      name: 'Claim Type',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, intake.id, [
      { fieldDefinitionId: sharedId },
      { fieldDefinitionId: sourceId }
    ]);
    setWorkflowFields(handle.db, owner, claims.id, [
      { fieldDefinitionId: sharedId },
      { fieldDefinitionId: targetRequiredId, required: true }
    ]);
    const { setTransferRule } = await import('../../../src/lib/server/workflows/service');
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      fieldMappings: { source_ref: 'source_ref_mapped' }
    });

    const ticket = createTicketSync(handle.db, owner, {
      workflowId: intake.id,
      title: 'Preview',
      fields: { customer: 'ACME', source_ref: 'REF-1' }
    });
    const { previewTransfer } = await import('../../../src/lib/server/tickets/service');
    const preview = previewTransfer(handle.db, owner, {
      ticketId: ticket.id,
      targetWorkflowId: claims.id
    });
    expect(preview.compatible).toContain('customer');
    expect(preview.mapped).toEqual([{ source: 'source_ref', target: 'source_ref_mapped' }]);
    expect(preview.destinationRequired.map((entry) => entry.key)).toContain('claim_type');
    expect(preview.destinationRequired.find((entry) => entry.key === 'claim_type')?.satisfied).toBe(
      false
    );
  });
});

describe('tenant isolation', () => {
  test('a ticket from another workspace is not visible', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Mine' });
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const mine = createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Mine' });
    const theirs = createTicketSync(handle.db, ownerActor(other.id, uuidv7(), 'Other Owner'), {
      workflowId: otherWorkflow.id,
      title: 'Theirs'
    });

    expect(() => requireTicketSync(handle.db, other.id, mine.id)).toThrow(/not found/);
    expect(() => requireTicketSync(handle.db, workspaceId, theirs.id)).toThrow(/not found/);

    const page = await searchTickets(handle.db, owner, {});
    expect(page.rows.every((row) => row.ticket.workspaceId === workspaceId)).toBe(true);
  });
});

describe('my work queues', () => {
  test('buckets tickets by what they are waiting on', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Queues',
      states: [
        { name: 'New', kind: 'manual', category: 'backlog', isStart: true },
        { name: 'Agent', kind: 'manual', category: 'active' },
        { name: 'Review', kind: 'manual', category: 'review' }
      ],
      transitions: [
        ['New', 'Agent', 'Dispatch'],
        ['New', 'Review', 'Review']
      ]
    });
    // Mark states as agent/human-waiting via direct waitingOn updates.
    const agentTicket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Agent'
    });
    setWaitingOnSync(handle.db, owner, agentTicket.id, 'agent');
    const humanTicket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Human'
    });
    setWaitingOnSync(handle.db, owner, humanTicket.id, 'human');
    const triggerTicket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Trigger'
    });
    setWaitingOnSync(handle.db, owner, triggerTicket.id, 'trigger');
    const assignedTicket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Assigned',
      ownerUserId: ownerId
    });
    setWaitingOnSync(handle.db, owner, assignedTicket.id, 'none');

    const work = await myWork(handle.db, owner);
    expect(work.waitingForAgent.map((row) => row.ticket.id)).toEqual([agentTicket.id]);
    expect(work.waitingForMe.map((row) => row.ticket.id)).toEqual([humanTicket.id]);
    expect(work.needsAttention.map((row) => row.ticket.id)).toEqual([triggerTicket.id]);
    expect(work.assigned.map((row) => row.ticket.id)).toEqual([assignedTicket.id]);
  });

  test('lists tickets for a workflow with labels and field values', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Board' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Visible',
      fields: { customer: 'ACME' },
      labelNames: ['vip']
    });
    const page = await searchTickets(handle.db, owner, { workflowId: workflow.id });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.fields.customer).toBe('ACME');
    expect(page.rows[0]?.labels.map((label) => label.name)).toEqual(['vip']);
    expect(page.total).toBe(1);
    void ticket;
  });

  test('filters by priority, state, owner and custom field', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Filtered' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'amount',
      name: 'Amount',
      type: 'number'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Big',
      priority: 'high',
      fields: { amount: 5000 }
    });
    createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Small',
      priority: 'low'
    });

    const high = await searchTickets(handle.db, owner, {
      filter: { type: 'condition', kind: 'system', key: 'priority', operator: 'eq', value: 'high' }
    });
    expect(high.rows.map((row) => row.ticket.title)).toEqual(['Big']);

    const bigAmount = await searchTickets(handle.db, owner, {
      filter: { type: 'condition', kind: 'field', key: 'amount', operator: 'gt', value: 1000 }
    });
    expect(bigAmount.rows.map((row) => row.ticket.title)).toEqual(['Big']);

    const nested = await searchTickets(handle.db, owner, {
      filter: {
        type: 'group',
        op: 'or',
        children: [
          { type: 'condition', kind: 'system', key: 'priority', operator: 'eq', value: 'low' },
          { type: 'condition', kind: 'field', key: 'amount', operator: 'gt', value: 1000 }
        ]
      }
    });
    expect(nested.rows.map((row) => row.ticket.title).sort()).toEqual(['Big', 'Small']);
  });
});

describe('audit coverage', () => {
  test('creation, field changes, transitions and transfers all write ledger rows', async () => {
    const intake = await createWorkflow(handle.db, workspaceId, { name: 'Intake' });
    const claims = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, intake.id, [{ fieldDefinitionId: fieldId }]);

    const ticket = createTicketSync(handle.db, owner, {
      workflowId: intake.id,
      title: 'Audited',
      fields: { customer: 'ACME' }
    });
    requestTransitionSync(handle.db, owner, {
      ticketId: ticket.id,
      targetStateId: intake.stateIds['In Progress'] as string
    });
    transferTicketSync(handle.db, owner, { ticketId: ticket.id, targetWorkflowId: claims.id });

    const actions = handle.sqlite
      .query('SELECT action FROM audit_events WHERE ticket_id = ? ORDER BY seq')
      .all(ticket.id) as Array<{ action: string }>;
    const names = actions.map((row) => row.action);
    expect(names).toContain('ticket.created');
    expect(names).toContain('ticket.field.changed');
    expect(names).toContain('ticket.state.exited');
    expect(names).toContain('ticket.state.entered');
    expect(names).toContain('ticket.transferred');
  });

  test('a ticket created in another workspace never appears in the ledger query', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Mine' });
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Private'
    });
    const rows = handle.sqlite
      .query('SELECT count(*) AS n FROM audit_events WHERE ticket_id = ? AND workspace_id = ?')
      .get(ticket.id, other.id) as { n: number };
    expect(rows.n).toBe(0);
  });
});
