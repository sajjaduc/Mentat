/**
 * Record-bound agent runs and the enforced submission contract (ADR-0023/0024).
 *
 * Proves the AI execution contract end to end: the run is bound to a Record +
 * WorkflowItem (not a Ticket), the agent must finish with a validated
 * `workflowItems.submit` call, an unfinished answer is nudged, and the accepted
 * submission persists the record and moves the work.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createAgent } from '../../../src/lib/server/agents/service';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import {
  agentRunSteps,
  agentRuns,
  tools,
  users,
  workflows
} from '../../../src/lib/server/db/schema';
import { registerExecutionJobHandlers } from '../../../src/lib/server/execution/engine';
import { setProviderLookup } from '../../../src/lib/server/execution/provider-lookup';
import { clearJobHandlers } from '../../../src/lib/server/jobs/handlers';
import { createObjectType, setBaseFields } from '../../../src/lib/server/records/object-types';
import { createRecord, getRecordDetail } from '../../../src/lib/server/records/service';
import { registerCoreNativeTools } from '../../../src/lib/server/tools/native/register';
import { getDefaultToolRegistry, resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { handleWorkflowItemStateEntry } from '../../../src/lib/server/workflow-items/dispatch';
import {
  createWorkflowItem,
  getWorkflowItemDetail
} from '../../../src/lib/server/workflow-items/service';
import { updateState } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkflow, createWorkspace, ownerActor } from '../../helpers/factories';
import { type FakeTurn, fakeModelRow, ScriptedProvider } from '../../helpers/fake-provider';

let handle: TestDatabase;
let workspaceId: string;
let owner: ActorContext;

function installProvider(turns: FakeTurn[]) {
  const provider = new ScriptedProvider({ turns });
  setProviderLookup(async () => ({ provider, model: fakeModelRow(workspaceId) }));
  return provider;
}

async function seedAgent(options: {
  workflowId: string;
  toolKeys: string[];
  native: string[];
}): Promise<string> {
  const now = Date.now();
  const toolIds: string[] = [];
  for (const key of options.toolKeys) {
    const id = uuidv7(now);
    handle.db
      .insert(tools)
      .values({
        id,
        workspaceId,
        key,
        name: key,
        description: key,
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
    instructions: 'Process the record and submit the result.',
    modelId: 'fake-model-row',
    toolIds,
    permissions: { native: options.native } as never,
    executionConfig: { maxSteps: 8 }
  });
  return agent.id;
}

/** A workflow that processes the given Object Type. */
async function workflowFor(name: string, objectTypeId: string) {
  const fixture = await createWorkflow(handle.db, workspaceId, {
    name,
    states: [
      { name: 'Intake', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Reviewing', kind: 'agent', category: 'active' },
      { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
    ]
  });
  handle.db.update(workflows).set({ objectTypeId }).where(eq(workflows.id, fixture.id)).run();
  return fixture;
}

beforeEach(async () => {
  handle = createTestDatabase();
  clearJobHandlers();
  resetToolRegistry();
  registerCoreNativeTools(getDefaultToolRegistry());
  registerExecutionJobHandlers();
  const workspace = await createWorkspace(handle.db, 'Records Co');
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

describe('record-bound agent runs', () => {
  test('nudges an unfinished answer, then accepts a validated submission', async () => {
    const objectType = createObjectType(handle.db, owner, { name: 'Policy' });
    await setBaseFields(handle.db, owner, objectType.id, [
      {
        key: 'policy_number',
        name: 'Policy Number',
        type: 'short_text',
        isPrimaryDisplay: true,
        required: true
      },
      { key: 'premium', name: 'Premium', type: 'number' }
    ] as never);

    const workflow = await workflowFor('Underwriting', objectType.id);
    const agentId = await seedAgent({
      workflowId: workflow.id,
      toolKeys: ['workflowItems.submit'],
      native: ['workflowItems.submit']
    });
    const reviewState = workflow.stateIds.Reviewing as string;
    updateState(handle.db, owner, {
      stateId: reviewState,
      agentId,
      config: {
        requiredSubmission: { toolKey: 'workflowItems.submit', maxNudges: 2 },
        context: { includeRecordSchema: true }
      } as never
    });

    const record = await createRecord(handle.db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 10 }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: reviewState,
      deferExecution: true
    });

    const provider = installProvider([
      { content: 'I have looked at it.' },
      {
        content: 'Submitting.',
        toolCalls: [
          {
            name: 'workflowItems.submit',
            arguments: {
              record: { policy_number: 'POL-1', premium: 140 },
              workflow: { stateId: workflow.stateIds.Done }
            }
          }
        ]
      },
      { content: 'Submitted.' }
    ]);

    const result = await handleWorkflowItemStateEntry(handle.db, {
      workspaceId,
      workflowItemId: item.id,
      stateId: reviewState,
      workflowId: workflow.id,
      recordId: record.id,
      enteredAt: item.enteredStateAt
    });

    expect(result.outcome).toBe('ran');
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0];
    expect(run?.status).toBe('succeeded');
    expect(run?.recordId).toBe(record.id);
    expect(provider.calls.length).toBe(3);

    const steps = handle.db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, run!.id))
      .all();
    expect(steps.some((step) => step.name === 'contract.nudge')).toBe(true);

    const recordDetail = await getRecordDetail(handle.db, owner, record.id);
    expect(recordDetail.fields.premium).toBe(140);
    const itemDetail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(itemDetail.stateId).toBe(workflow.stateIds.Done as string);
    expect(itemDetail.completedAt).not.toBeNull();
  });

  test('fails the run when the submission never arrives', async () => {
    const objectType = createObjectType(handle.db, owner, { name: 'Policy' });
    await setBaseFields(handle.db, owner, objectType.id, [
      {
        key: 'policy_number',
        name: 'Policy Number',
        type: 'short_text',
        isPrimaryDisplay: true,
        required: true
      }
    ] as never);
    const workflow = await workflowFor('Review', objectType.id);
    const agentId = await seedAgent({
      workflowId: workflow.id,
      toolKeys: ['workflowItems.submit'],
      native: ['workflowItems.submit']
    });
    const state = workflow.stateIds.Reviewing as string;
    updateState(handle.db, owner, {
      stateId: state,
      agentId,
      config: { requiredSubmission: { maxNudges: 1 } } as never
    });
    const record = await createRecord(handle.db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-2' }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: state,
      deferExecution: true
    });

    installProvider([
      { content: 'Thinking.' },
      { content: 'Still thinking.' },
      { content: 'Done thinking.' }
    ]);

    const result = await handleWorkflowItemStateEntry(handle.db, {
      workspaceId,
      workflowItemId: item.id,
      stateId: state,
      workflowId: workflow.id,
      recordId: record.id,
      enteredAt: item.enteredStateAt
    });
    expect(result.outcome).toBe('failed');
    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0];
    expect(run?.status).toBe('failed');
  });

  test('rejects a submission whose record does not match the schema', async () => {
    const objectType = createObjectType(handle.db, owner, { name: 'Policy' });
    await setBaseFields(handle.db, owner, objectType.id, [
      {
        key: 'policy_number',
        name: 'Policy Number',
        type: 'short_text',
        isPrimaryDisplay: true,
        required: true
      },
      { key: 'premium', name: 'Premium', type: 'number' }
    ] as never);
    const workflow = await workflowFor('Review', objectType.id);
    const agentId = await seedAgent({
      workflowId: workflow.id,
      toolKeys: ['workflowItems.submit'],
      native: ['workflowItems.submit']
    });
    const state = workflow.stateIds.Reviewing as string;
    updateState(handle.db, owner, {
      stateId: state,
      agentId,
      config: { requiredSubmission: { maxNudges: 2 } } as never
    });
    const record = await createRecord(handle.db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-3', premium: 1 }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: state,
      deferExecution: true
    });

    installProvider([
      { content: 'Attempt.' },
      {
        content: 'Bad submit.',
        toolCalls: [
          {
            name: 'workflowItems.submit',
            arguments: {
              record: { policy_number: 'POL-3', premium: 'not-a-number' },
              workflow: { stateId: workflow.stateIds.Done }
            }
          }
        ]
      },
      { content: 'Give up.' }
    ]);

    const result = await handleWorkflowItemStateEntry(handle.db, {
      workspaceId,
      workflowItemId: item.id,
      stateId: state,
      workflowId: workflow.id,
      recordId: record.id,
      enteredAt: item.enteredStateAt
    });
    // The failed tool call is fed back; without a valid submission the run fails.
    expect(result.outcome).toBe('failed');
    const recordDetail = await getRecordDetail(handle.db, owner, record.id);
    expect(recordDetail.fields.premium).toBe(1);
    const itemDetail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(itemDetail.stateId).toBe(state);
  });
});
