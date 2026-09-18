import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createAgent } from '../../../src/lib/server/agents/service';
import { decideApprovalSync, listApprovals } from '../../../src/lib/server/approvals/service';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import {
  clearSecretRegistry,
  registerSecretValue
} from '../../../src/lib/server/core/secret-registry';
import {
  agentRunSteps,
  agentRuns,
  approvalRequests,
  jobs,
  records,
  runEvents,
  tools,
  users,
  workflowItemFieldValues,
  workflowItems
} from '../../../src/lib/server/db/schema';
import {
  enqueueApprovalResumeSync,
  handleApprovalResume,
  registerExecutionJobHandlers
} from '../../../src/lib/server/execution/engine';
import { setProviderLookup } from '../../../src/lib/server/execution/provider-lookup';
import { createAgentRunSync, executeAgentRun } from '../../../src/lib/server/execution/runner';
import { createFieldDefinition, setWorkflowFields } from '../../../src/lib/server/fields/service';
import { clearJobHandlers, getJobHandler } from '../../../src/lib/server/jobs/handlers';
import { registerCoreNativeTools } from '../../../src/lib/server/tools/native/register';
import { getDefaultToolRegistry, resetToolRegistry } from '../../../src/lib/server/tools/registry';
import {
  dispatchWorkflowItemEntrySync,
  handleWorkflowItemStateEntry
} from '../../../src/lib/server/workflow-items/dispatch';
import { requestWorkflowItemTransition } from '../../../src/lib/server/workflow-items/service';
import {
  createState,
  createTransition,
  updateState
} from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createWorkflow,
  createWorkflowItem,
  createWorkspace,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';
import { type FakeTurn, fakeModelRow, ScriptedProvider } from '../../helpers/fake-provider';

let handle: TestDatabase;
let workspaceId: string;
let owner: ActorContext;

function installProvider(turns: FakeTurn[], modelOverrides: Record<string, unknown> = {}) {
  const provider = new ScriptedProvider({ turns });
  setProviderLookup(async () => ({
    provider,
    model: fakeModelRow(workspaceId, modelOverrides)
  }));
  return provider;
}

/** Seed an agent with tools, returning its id. */
async function seedAgent(options: {
  workflowId: string;
  toolKeys?: string[];
  permissions?: Record<string, unknown>;
  executionConfig?: Record<string, unknown>;
}): Promise<string> {
  const toolIds: string[] = [];
  const now = Date.now();
  for (const key of options.toolKeys ?? []) {
    const id = uuidv7(now);
    handle.db
      .insert(tools)
      .values({
        id,
        workspaceId,
        key,
        name: key,
        description: `Tool ${key}`,
        kind: 'native',
        implementation: { kind: 'native', key } as never,
        inputSchema: { type: 'object', additionalProperties: true } as never,
        timeoutSeconds: 10,
        enabled: true,
        createdAt: now,
        updatedAt: now
      })
      .run();
    toolIds.push(id);
  }

  const agent = createAgent(handle.db, owner, {
    name: `Agent ${Math.random().toString(36).slice(2, 7)}`,
    workflowId: options.workflowId,
    instructions: 'Do the work.',
    modelId: 'fake-model-row',
    toolIds,
    permissions: (options.permissions as never) ?? null,
    executionConfig: options.executionConfig ?? null
  });
  return agent.id;
}

/** Start work: a Record placed into a workflow at `stateId`. */
async function start(
  workflow: WorkflowFixture,
  stateId: string,
  options: { title?: string } = {}
): Promise<{ id: string; recordId: string; key: string; number: number }> {
  return createWorkflowItem(handle.db, {
    workspaceId,
    workflow,
    stateId,
    title: options.title
  });
}

function itemRow(workflowItemId: string) {
  return handle.db
    .select()
    .from(workflowItems)
    .where(eq(workflowItems.id, workflowItemId))
    .all()[0]!;
}

/**
 * `workflow_item.enter` jobs for one item. Filtered through the payload rather
 * than the `jobs.workflow_item_id` column because the workflow-item enqueue paths
 * do not populate that column; `enqueueApprovalResumeSync` does.
 */
function entryJobsFor(workflowItemId: string) {
  return handle.db
    .select()
    .from(jobs)
    .where(eq(jobs.type, 'workflow_item.enter'))
    .all()
    .filter(
      (job) => (job.payload as { workflowItemId?: string }).workflowItemId === workflowItemId
    );
}

/** The `workflow_item.enter` payload for the item's current state entry. */
function payloadFor(
  workflow: WorkflowFixture,
  item: { id: string; recordId: string },
  stateId: string,
  enteredAt?: number
) {
  return {
    workspaceId,
    workflowItemId: item.id,
    stateId,
    workflowId: workflow.id,
    recordId: item.recordId,
    enteredAt: enteredAt ?? itemRow(item.id).enteredStateAt
  };
}

beforeEach(async () => {
  handle = createTestDatabase();
  clearSecretRegistry();
  clearJobHandlers();
  resetToolRegistry();
  registerCoreNativeTools(getDefaultToolRegistry());
  registerExecutionJobHandlers();
  const workspace = await createWorkspace(handle.db, 'Execution Co');
  workspaceId = workspace.id;
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@example.test`,
      name: 'Reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  owner = ownerActor(workspaceId, userId, 'Reviewer');
});

describe('agent state execution', () => {
  test('runs an agent state, persists steps and completes the run', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const agentId = await seedAgent({ workflowId: workflow.id });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Drafting',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Draft a reply' });

    const provider = installProvider([
      { content: 'I have drafted the reply.', usage: { inputTokens: 40, outputTokens: 8 } }
    ]);

    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );

    expect(result.outcome).toBe('ran');
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0];
    expect(run?.status).toBe('succeeded');
    expect(run?.outputText).toBe('I have drafted the reply.');
    expect(provider.calls.length).toBe(1);

    const steps = handle.db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, run!.id))
      .all();
    expect(steps.map((step) => step.type)).toContain('context');
    expect(steps.map((step) => step.type)).toContain('message');

    const events = handle.db.select().from(runEvents).where(eq(runEvents.runId, run!.id)).all();
    const types = events.map((event) => event.type);
    expect(types).toContain('run.queued');
    expect(types).toContain('run.started');
    expect(types).toContain('run.completed');
  });

  test('streams content deltas into persisted run events', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const agentId = await seedAgent({ workflowId: workflow.id });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Stream',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Stream' });

    installProvider([{ content: 'Hello world from the agent.', chunkSize: 5 }]);
    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );

    expect(result.outcome).toBe('ran');
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    const deltas = handle.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, 'run.output.delta')))
      .all();
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((row) => (row.data as { content: string }).content).join('')).toBe(
      'Hello world from the agent.'
    );
  });

  test('executes a tool call and feeds the result back to the model', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const fieldId = createFieldDefinition(handle.db, owner, {
      key: 'reply',
      name: 'Reply',
      type: 'long_text'
    }).id;
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);

    const agentId = await seedAgent({
      workflowId: workflow.id,
      toolKeys: ['workflowItems.setFields'],
      permissions: { native: ['workflowItems.setFields'] }
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Write',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Write reply' });

    installProvider([
      {
        toolCalls: [
          {
            name: 'workflowItems.setFields',
            arguments: { values: { reply: 'Thanks for reaching out.' } }
          }
        ]
      },
      { content: 'Filed the reply.' }
    ]);

    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );

    expect(result.outcome).toBe('ran');
    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values[0]?.valueText).toBe('Thanks for reaching out.');

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    const steps = handle.db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, run.id))
      .all();
    expect(steps.filter((step) => step.type === 'tool_call')).toHaveLength(1);
    expect(steps.filter((step) => step.type === 'tool_result')).toHaveLength(1);
  });

  test('refuses a tool the agent has no capability for', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const fieldId = createFieldDefinition(handle.db, owner, {
      key: 'reply',
      name: 'Reply',
      type: 'long_text'
    }).id;
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);

    const agentId = await seedAgent({
      workflowId: workflow.id,
      toolKeys: ['workflowItems.setFields'],
      permissions: { native: [] }
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Write',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Denied' });

    installProvider([
      {
        toolCalls: [{ name: 'workflowItems.setFields', arguments: { values: { reply: 'nope' } } }]
      },
      { content: 'I could not do that.' }
    ]);

    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));

    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values).toHaveLength(0);

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    const toolResult = handle.db
      .select()
      .from(agentRunSteps)
      .where(and(eq(agentRunSteps.runId, run.id), eq(agentRunSteps.type, 'tool_result')))
      .all()[0];
    expect(toolResult?.status).toBe('failed');
    expect(toolResult?.error?.toLowerCase()).toContain('not permitted');
  });

  test('marks the run failed when the model is not configured', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const agent = createAgent(handle.db, owner, {
      name: 'Modelless',
      workflowId: workflow.id,
      instructions: 'x'
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Broken',
      kind: 'agent',
      agentId: agent.id
    });
    const item = await start(workflow, state.id, { title: 'No model' });

    installProvider([{ content: 'never used' }]);
    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );

    expect(result.outcome).toBe('failed');
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('precondition_failed');
  });
});

describe('idempotency and recovery', () => {
  test('skips a state entry the item has already left', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const agentId = await seedAgent({ workflowId: workflow.id });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Work',
      kind: 'agent',
      agentId
    });
    createTransition(handle.db, owner, workflow.id, {
      fromStateId: state.id,
      toStateId: workflow.stateIds['In Progress'] as string,
      name: 'Move on'
    });
    const item = await start(workflow, state.id, { title: 'Moved on' });

    const enteredAt = itemRow(item.id).enteredStateAt;
    await requestWorkflowItemTransition(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });

    installProvider([{ content: 'should not run' }]);
    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id, enteredAt)
    );
    expect(result.outcome).toBe('skipped');
  });

  test('running a run twice does not duplicate work', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const agentId = await seedAgent({ workflowId: workflow.id });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Work',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Once' });

    const provider = installProvider([{ content: 'answer' }]);
    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    await executeAgentRun(handle.db, run.id);
    expect(provider.calls.length).toBe(1);
  });

  test('recovers a pending tool call after a simulated worker crash', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const fieldId = createFieldDefinition(handle.db, owner, {
      key: 'outcome',
      name: 'Outcome',
      type: 'short_text'
    }).id;
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    const agentId = await seedAgent({
      workflowId: workflow.id,
      toolKeys: ['workflowItems.setFields'],
      permissions: { native: ['workflowItems.setFields'] }
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Work',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Crash' });

    const provider = installProvider([{ content: 'Recovered.' }]);

    // Simulate a worker that died *after* the model asked for a tool call but
    // before the tool ran: exactly the state the database would hold.
    const runId = createAgentRunSync(handle.db, {
      workspaceId,
      workflowItemId: item.id,
      recordId: item.recordId,
      state,
      agentId,
      triggerType: 'state_entry'
    }).id;
    const now = Date.now();
    handle.db
      .insert(agentRunSteps)
      .values({
        id: uuidv7(now),
        workspaceId,
        runId,
        index: 0,
        type: 'context',
        name: 'context',
        status: 'completed',
        output: { system: 'system prompt', user: 'user prompt' } as never,
        startedAt: now,
        finishedAt: now
      })
      .run();
    handle.db
      .insert(agentRunSteps)
      .values({
        id: uuidv7(now),
        workspaceId,
        runId,
        index: 1,
        type: 'message',
        name: 'assistant',
        status: 'completed',
        output: {
          content: '',
          toolCalls: [
            {
              id: 'call_crash',
              name: 'workflowItems.setFields',
              arguments: { values: { outcome: 'recovered' } }
            }
          ],
          finishReason: 'tool_calls'
        } as never,
        startedAt: now,
        finishedAt: now
      })
      .run();
    handle.db
      .insert(agentRunSteps)
      .values({
        id: uuidv7(now),
        workspaceId,
        runId,
        index: 2,
        type: 'tool_call',
        name: 'workflowItems.setFields',
        status: 'started',
        input: { values: { outcome: 'recovered' } } as never,
        startedAt: now
      })
      .run();

    const outcome = await executeAgentRun(handle.db, runId);
    expect(outcome.status).toBe('succeeded');

    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values[0]?.valueText).toBe('recovered');

    // The tool must not run twice if the run is re-executed after succeeding.
    const callsAfter = provider.calls.length;
    await executeAgentRun(handle.db, runId);
    expect(provider.calls.length).toBe(callsAfter);
  });

  test('dispatch refuses a human-gated state', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Gated',
      states: [
        { name: 'Review', kind: 'manual', category: 'review', isStart: true },
        { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
      ],
      transitions: [['Review', 'Done', 'Approve']]
    });
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Review'] as string,
      humanGate: { enabled: true }
    });
    const item = await start(workflow, workflow.stateIds['Review'] as string, { title: 'Gated' });

    expect(() =>
      dispatchWorkflowItemEntrySync(handle.db, owner, { workflowItemId: item.id })
    ).toThrow(/human decision/);

    const queued = entryJobsFor(item.id);
    expect(queued).toHaveLength(0);
  });

  test('handleWorkflowItemStateEntry returns waiting for a gated state', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Gated',
      states: [
        { name: 'Review', kind: 'manual', category: 'review', isStart: true },
        { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
      ]
    });
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Review'] as string,
      humanGate: { enabled: true }
    });
    const item = await start(workflow, workflow.stateIds['Review'] as string, { title: 'Gated' });
    const row = itemRow(item.id);
    const result = await handleWorkflowItemStateEntry(handle.db, {
      workspaceId,
      workflowItemId: item.id,
      stateId: row.stateId,
      workflowId: workflow.id,
      recordId: row.recordId,
      enteredAt: row.enteredStateAt
    });
    expect(result.outcome).toBe('waiting');
  });

  test('dispatch queues exactly one job per entry', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Manual' });
    const agentId = await seedAgent({ workflowId: workflow.id });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Dispatchable',
      kind: 'agent',
      agentId,
      autoExecute: false
    });
    const item = await start(workflow, state.id, { title: 'Dispatch' });

    const first = dispatchWorkflowItemEntrySync(handle.db, owner, {
      workflowItemId: item.id,
      force: true
    });
    const second = dispatchWorkflowItemEntrySync(handle.db, owner, {
      workflowItemId: item.id,
      force: true
    });
    expect(second.jobId).toBe(first.jobId);
    const queued = entryJobsFor(item.id);
    expect(queued).toHaveLength(1);
  });
});

describe('system states', () => {
  test('setFields action writes typed values deterministically', async () => {
    const field = createFieldDefinition(handle.db, owner, {
      key: 'routed',
      name: 'Routed',
      type: 'boolean'
    });
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'System' });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: field.id }]);
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Normalise',
      kind: 'system',
      config: { systemAction: { type: 'setFields', values: { routed: true } } }
    });
    const item = await start(workflow, state.id, { title: 'Normalise me' });

    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );
    expect(result.outcome).toBe('ran');
    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values[0]?.valueBool).toBe(true);
  });

  test('transition action moves the item without a model', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'System' });
    // Configure the start state itself as a deterministic action, reusing the
    // transition the template already provides.
    const state = updateState(handle.db, owner, {
      stateId: workflow.stateIds['Backlog'] as string,
      kind: 'system',
      config: {
        systemAction: {
          type: 'transition',
          targetStateId: workflow.stateIds['In Progress'] as string
        }
      }
    });
    const item = await start(workflow, state.id, { title: 'Auto' });

    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );
    expect(result.outcome, `system action detail: ${result.detail}`).toBe('ran');
    const moved = itemRow(item.id);
    expect(moved.stateId).toBe(workflow.stateIds['In Progress'] as string);
  });
});

describe('tool-call approvals', () => {
  async function approvalFixture() {
    const field = createFieldDefinition(handle.db, owner, {
      key: 'amount',
      name: 'Amount',
      type: 'number'
    });
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Approvals' });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: field.id }]);

    // Mark the tool as always requiring approval.
    const toolId = uuidv7();
    handle.db
      .insert(tools)
      .values({
        id: toolId,
        workspaceId,
        key: 'workflowItems.setFields',
        name: 'set field',
        description: 'set',
        kind: 'native',
        implementation: { kind: 'native', key: 'workflowItems.setFields' } as never,
        inputSchema: { type: 'object', additionalProperties: true } as never,
        approvalPolicy: { mode: 'always', reason: 'Changing money requires approval' } as never,
        timeoutSeconds: 10,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .run();

    const agent = createAgent(handle.db, owner, {
      name: 'Approval Agent',
      workflowId: workflow.id,
      instructions: 'Set the amount.',
      modelId: 'fake-model-row',
      toolIds: [toolId],
      permissions: { native: ['workflowItems.setFields'] } as never
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Adjust',
      kind: 'agent',
      agentId: agent.id
    });
    const item = await start(workflow, state.id, { title: 'Adjust claim' });
    return { workflow, state, item, fieldId: field.id };
  }

  test('pauses the run and creates a pending approval without side effects', async () => {
    const { workflow, state, item } = await approvalFixture();
    installProvider([
      {
        toolCalls: [
          {
            id: 'call_money',
            name: 'workflowItems.setFields',
            arguments: { values: { amount: 5000 } }
          }
        ]
      }
    ]);

    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );

    expect(result.outcome).toBe('waiting');
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    expect(run.status).toBe('awaiting_approval');

    const approvals = handle.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.workflowItemId, item.id))
      .all();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('pending');
    expect(approvals[0]?.kind).toBe('tool_call');
    const requestedAction = approvals[0]?.requestedAction as unknown as { toolKey: string };
    expect(requestedAction.toolKey).toBe('workflowItems.setFields');

    // The gated side effect must not have happened.
    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values).toHaveLength(0);
  });

  test('approving resumes the run and applies the action exactly once', async () => {
    const { workflow, state, item } = await approvalFixture();
    installProvider([
      {
        toolCalls: [
          {
            id: 'call_money',
            name: 'workflowItems.setFields',
            arguments: { values: { amount: 5000 } }
          }
        ]
      },
      { content: 'Amount updated.' }
    ]);

    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    const approval = handle.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.workflowItemId, item.id))
      .all()[0]!;

    // Decision and resume-enqueue happen together, mirroring the API path.
    decideApprovalSync(handle.db, owner, {
      approvalId: approval.id,
      decision: 'approved',
      comment: 'Checked the policy'
    });
    enqueueApprovalResumeSync(handle.db, {
      workspaceId,
      approvalId: approval.id,
      runId: run.id,
      recordId: item.recordId,
      workflowItemId: item.id
    });

    const resumed = await handleApprovalResume(handle.db, approval.id);
    expect(resumed.outcome).toBe('resumed');

    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values).toHaveLength(1);
    expect(values[0]?.valueNumber).toBe(5000);

    const finished = handle.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).all()[0]!;
    expect(finished.status).toBe('succeeded');

    // Resuming again must be a no-op.
    const again = await handleApprovalResume(handle.db, approval.id);
    expect(again.outcome).toBe('skipped');
    const after = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(after).toHaveLength(1);
  });

  test('rejecting lets the model continue without applying the action', async () => {
    const { workflow, state, item } = await approvalFixture();
    installProvider([
      {
        toolCalls: [
          {
            id: 'call_money',
            name: 'workflowItems.setFields',
            arguments: { values: { amount: 9000 } }
          }
        ]
      },
      { content: 'I left the amount unchanged as requested.' }
    ]);

    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));
    const approval = handle.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.workflowItemId, item.id))
      .all()[0]!;

    expect(() =>
      decideApprovalSync(handle.db, owner, { approvalId: approval.id, decision: 'rejected' })
    ).toThrow(/reason is required/);

    decideApprovalSync(handle.db, owner, {
      approvalId: approval.id,
      decision: 'rejected',
      comment: 'Too high for this policy'
    });
    const resumed = await handleApprovalResume(handle.db, approval.id);
    expect(resumed.outcome).toBe('rejected');

    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values).toHaveLength(0);

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    expect(run.status).toBe('succeeded');
  });

  test('lists pending approvals for the inbox', async () => {
    const { workflow, state, item } = await approvalFixture();
    installProvider([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'workflowItems.setFields',
            arguments: { values: { amount: 1 } }
          }
        ]
      }
    ]);
    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));

    const pending = listApprovals(handle.db, owner, { status: ['pending'] });
    expect(pending).toHaveLength(1);
    const record = handle.db.select().from(records).where(eq(records.id, item.recordId)).all()[0]!;
    expect(pending[0]?.recordKey).toBe(record.key);
  });
});

describe('failure handling', () => {
  test('a provider error fails the run and records the error', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Failures' });
    const agentId = await seedAgent({
      workflowId: workflow.id,
      executionConfig: { retryOnProviderError: false }
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Broken',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Fail' });

    installProvider([{ error: new Error('connection refused') }]);
    const result = await handleWorkflowItemStateEntry(
      handle.db,
      payloadFor(workflow, item, state.id)
    );
    expect(result.outcome).toBe('failed');

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('connection refused');
  });

  test('a failure state receives the item after the job exhausts its attempts', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Failures',
      states: [
        { name: 'Work', kind: 'manual', category: 'active', isStart: true },
        { name: 'Needs attention', kind: 'manual', category: 'review' }
      ],
      transitions: [
        ['Work', 'Needs attention', 'Escalate'],
        ['Needs attention', 'Work', 'Retry']
      ]
    });
    const agentId = await seedAgent({ workflowId: workflow.id });
    updateState(handle.db, owner, {
      stateId: workflow.stateIds['Work'] as string,
      kind: 'agent',
      agentId,
      maxAttempts: 1,
      failureStateId: workflow.stateIds['Needs attention'] as string
    });
    const item = await start(workflow, workflow.stateIds['Work'] as string, { title: 'Will fail' });

    // Dispatch enqueues the state-entry job for the agent state.
    dispatchWorkflowItemEntrySync(handle.db, owner, { workflowItemId: item.id, force: true });

    // Directly exercise the handler path including final-attempt handling.
    const job = entryJobsFor(item.id)[0];
    expect(job).toBeDefined();

    installProvider([{ error: new Error('nope') }]);
    const handler = getJobHandler('workflow_item.enter')!;
    const leased = { ...job!, attempts: 1, maxAttempts: 1, leasedBy: 'w', workerId: 'w' };
    try {
      await handler({
        job: leased as never,
        db: handle.db,
        workerId: 'w',
        heartbeat: async () => {},
        signal: new AbortController().signal
      });
    } catch {
      // The handler surfaces the failure so the queue can retry; the failure-state
      // move is applied on the final attempt, which is what we assert below.
    }

    const moved = itemRow(item.id);
    expect(moved.stateId).toBe(workflow.stateIds['Needs attention'] as string);
  });
});

describe('secret hygiene', () => {
  test('a registered secret never reaches the run snapshot or steps', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Secrets' });
    const agentId = await seedAgent({ workflowId: workflow.id });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Work',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, {
      title: 'Contains API_KEY_PLACEHOLDER sk-live-supersecretvalue123'
    });
    registerSecretValue('sk-live-supersecretvalue123');

    installProvider([{ content: 'ok' }]);
    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));

    const dump = handle.sqlite
      .query(
        `SELECT group_concat(coalesce(input,'') || coalesce(output,'') || coalesce(metadata,''), ' ') AS blob
         FROM agent_run_steps WHERE run_id IN (SELECT id FROM agent_runs WHERE workflow_item_id = ?)`
      )
      .get(item.id) as { blob: string | null };
    expect(dump.blob ?? '').not.toContain('sk-live-supersecretvalue123');
  });
});

describe('reasoning configuration', () => {
  const REASONING_CAPABILITIES = {
    streaming: true,
    toolCalling: true,
    jsonMode: false,
    vision: false,
    embeddings: false
  };

  async function runAgent(options: {
    executionConfig?: Record<string, unknown>;
    modelOverrides?: Record<string, unknown>;
  }): Promise<{ runId: string; provider: ScriptedProvider }> {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: `Reasoning ${Math.random().toString(36).slice(2, 6)}`
    });
    const agentId = await seedAgent({
      workflowId: workflow.id,
      executionConfig: options.executionConfig
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Thinking',
      kind: 'agent',
      agentId
    });
    const item = await start(workflow, state.id, { title: 'Think carefully' });
    const provider = installProvider([{ content: 'done' }], options.modelOverrides);
    await handleWorkflowItemStateEntry(handle.db, payloadFor(workflow, item, state.id));
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0]!;
    return { runId: run.id, provider };
  }

  test('passes the agent reasoning level to the provider', async () => {
    const { runId, provider } = await runAgent({
      executionConfig: { reasoningEffort: 'high' },
      modelOverrides: {
        capabilities: {
          ...REASONING_CAPABILITIES,
          reasoning: true,
          reasoningEfforts: ['off', 'low', 'medium', 'high']
        }
      }
    });
    expect(provider.calls[0]?.reasoningEffort).toBe('high');
    const warnings = handle.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'run.warning')))
      .all();
    expect(warnings).toHaveLength(0);
  });

  test('drops a level the model does not accept and records a run warning', async () => {
    const { runId, provider } = await runAgent({
      executionConfig: { reasoningEffort: 'off' },
      modelOverrides: {
        capabilities: {
          ...REASONING_CAPABILITIES,
          reasoning: true,
          reasoningEfforts: ['low', 'medium', 'high']
        }
      }
    });
    expect(provider.calls[0]?.reasoningEffort).toBeUndefined();
    const warnings = handle.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'run.warning')))
      .all();
    expect(warnings).toHaveLength(1);
    expect((warnings[0]!.data as { kind?: string }).kind).toBe('reasoning');
  });

  test('falls back to the model default when the agent level is unsupported', async () => {
    const { provider } = await runAgent({
      executionConfig: { reasoningEffort: 'off' },
      modelOverrides: {
        capabilities: {
          ...REASONING_CAPABILITIES,
          reasoning: true,
          reasoningEfforts: ['low', 'medium', 'high']
        },
        inferenceDefaults: { reasoningEffort: 'medium' }
      }
    });
    expect(provider.calls[0]?.reasoningEffort).toBe('medium');
  });

  test('sends no reasoning when the model does not declare the capability', async () => {
    const { runId, provider } = await runAgent({
      executionConfig: { reasoningEffort: 'high' }
    });
    expect(provider.calls[0]?.reasoningEffort).toBeUndefined();
    const warnings = handle.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, 'run.warning')))
      .all();
    expect(warnings).toHaveLength(1);
  });
});
