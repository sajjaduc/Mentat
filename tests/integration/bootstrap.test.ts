/**
 * End-to-end bootstrap test.
 *
 * This test is the integration gate: it proves that the locators, job handlers,
 * native tools and worker are wired together well enough to run a real piece of
 * work from a persisted state entry through to a completed agent run — without any
 * test-only shortcut such as calling the runner directly.
 *
 * It deliberately drives the *durable* path: start work (which enqueues
 * `workflow_item.enter` in the same transaction), then run the worker until the
 * queue is drained, then assert on the persisted outcome. ADR-0021 removed the
 * Ticket primitive; the work model is Records + WorkflowItems.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createAgent } from '../../src/lib/server/agents/service';
import { resetBootstrap, runBootstrap } from '../../src/lib/server/bootstrap';
import { uuidv7 } from '../../src/lib/server/core/ids';
import {
  agentRuns,
  jobs,
  models,
  providers,
  records,
  runEvents,
  tools,
  users,
  workflowItemFieldValues,
  workflowItems
} from '../../src/lib/server/db/schema';
import { createFieldDefinition, setWorkflowFields } from '../../src/lib/server/fields/service';
import { filterWorkflowItems } from '../../src/lib/server/filters/compile';
import { registeredJobTypes } from '../../src/lib/server/jobs/handlers';
import { FakeProvider } from '../../src/lib/server/providers/fake';
import {
  clearProviderOverrides,
  setProviderOverride
} from '../../src/lib/server/providers/registry';
import { createRecord } from '../../src/lib/server/records/service';
import { getDefaultToolRegistry, resetToolRegistry } from '../../src/lib/server/tools/registry';
import { listWorkflowItems } from '../../src/lib/server/workflow-items/query';
import {
  createWorkflowItem as createWorkflowItemService,
  getWorkflowItemDetail
} from '../../src/lib/server/workflow-items/service';
import { createState } from '../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import {
  createWorkflow,
  createWorkflowItem as createWorkflowItemFixture,
  createWorkspace,
  ownerActor
} from '../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let owner: ReturnType<typeof ownerActor>;

/**
 * `workflow_item.enter` jobs for one item. Filtered through the payload rather
 * than the `jobs.workflow_item_id` column because the workflow-item enqueue paths
 * do not populate that column (see the migration report).
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

async function seedProviderWithModel(): Promise<{ providerId: string; modelId: string }> {
  const now = Date.now();
  const providerId = uuidv7(now);
  const modelId = uuidv7(now);
  handle.db
    .insert(providers)
    .values({
      id: providerId,
      workspaceId,
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      enabled: true,
      createdAt: now,
      updatedAt: now
    })
    .run();
  handle.db
    .insert(models)
    .values({
      id: modelId,
      workspaceId,
      providerId,
      modelKey: 'llama3.1:8b',
      displayName: 'Llama 3.1 8B',
      capabilities: {
        streaming: false,
        toolCalling: true,
        jsonMode: true,
        vision: false,
        embeddings: false
      },
      enabled: true,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return { providerId, modelId };
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();
  const workspace = await createWorkspace(handle.db, 'Bootstrap Co');
  workspaceId = workspace.id;
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@example.test`,
      name: 'Operator',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  owner = ownerActor(workspaceId, userId, 'Operator');

  await runBootstrap({
    db: handle.db,
    sqlite: handle.sqlite,
    skipMigrations: true,
    startWorker: false
  });
});

describe('bootstrap wiring', () => {
  test('registers every durable job type', () => {
    const types = registeredJobTypes();
    for (const expected of [
      'workflow_item.enter',
      'approval.resume',
      'maintenance.reap',
      'file.process',
      'trigger.webhook',
      'trigger.cron'
    ]) {
      expect(types, `missing job handler: ${expected}`).toContain(expected);
    }
  });

  test('registers the full native tool surface', () => {
    const registry = getDefaultToolRegistry();
    const keys = registry.list().map((tool) => tool.key);
    expect(keys.length).toBeGreaterThan(25);
    // One tool from each owning module proves the composition worked.
    expect(keys).toContain('workflowItems.setFields');
    expect(keys).toContain('mentat.state.set');
    expect(keys).toContain('mentat.data.find');
    expect(keys).toContain('mentat.cache.getOrCompute');
    expect(keys).toContain('files.read');
    // Every registered tool must declare a usable schema.
    for (const tool of registry.list()) {
      expect(tool.inputSchema.type, `${tool.key} schema`).toBe('object');
      expect(tool.description.length, `${tool.key} description`).toBeGreaterThan(10);
    }
  });

  test('is idempotent across repeated calls', async () => {
    const first = await runBootstrap({
      db: handle.db,
      sqlite: handle.sqlite,
      skipMigrations: true,
      startWorker: false
    });
    expect(first.nativeToolCount).toBeGreaterThan(25);
  });

  test('installs the shared workflow-item filter compiler, so record facts filter', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Filtered' });
    await createWorkflowItemFixture(handle.db, { workspaceId, workflow, title: 'High' });
    await createWorkflowItemFixture(handle.db, { workspaceId, workflow, title: 'Low' });

    const page = await filterWorkflowItems(handle.db, {
      workspaceId,
      filter: {
        type: 'condition',
        kind: 'system',
        key: 'displayName',
        operator: 'eq',
        value: 'High'
      } as never
    });
    expect(page.rows).toHaveLength(1);
    const record = handle.db
      .select()
      .from(records)
      .where(eq(records.id, page.rows[0]!.recordId))
      .all()[0];
    expect(record?.displayName).toBe('High');
  });

  test('reports unknown filter keys instead of failing', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Unknown key' });
    await createWorkflowItemFixture(handle.db, { workspaceId, workflow, title: 'Anything' });
    const page = await filterWorkflowItems(handle.db, {
      workspaceId,
      filter: {
        type: 'condition',
        kind: 'field',
        key: 'does_not_exist',
        operator: 'eq',
        value: 'x'
      } as never
    });
    expect(page.rows).toHaveLength(0);
    expect(page.unresolved).toContain('does_not_exist');
  });
});

describe('bootstrap end-to-end durable execution', () => {
  test('a state entry reaches a completed agent run through the queue and worker', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
    const { providerId, modelId } = await seedProviderWithModel();

    const field = createFieldDefinition(handle.db, owner, {
      key: 'reply',
      name: 'Reply',
      type: 'long_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: field.id }]);

    const toolId = uuidv7();
    handle.db
      .insert(tools)
      .values({
        id: toolId,
        workspaceId,
        key: 'workflowItems.setFields',
        name: 'Set work item fields',
        description: 'Set typed field values on the work item.',
        kind: 'native',
        implementation: { kind: 'native', key: 'workflowItems.setFields' } as never,
        inputSchema: {
          type: 'object',
          properties: { values: { type: 'object' } },
          required: ['values'],
          additionalProperties: false
        } as never,
        permissions: ['workflow_item:write'] as never,
        timeoutSeconds: 15,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .run();

    const agent = createAgent(handle.db, owner, {
      name: 'Reply Agent',
      workflowId: workflow.id,
      instructions: 'Draft and file a reply.',
      providerId,
      modelId,
      toolIds: [toolId],
      permissions: { native: ['workflowItems.setFields'] } as never
    });

    // A deterministic scripted provider stands in for a real model.
    setProviderOverride(
      providerId,
      new FakeProvider({
        generate: [
          {
            content: '',
            toolCalls: [
              {
                id: 'call_reply',
                name: 'workflowItems.setFields',
                arguments: { values: { reply: 'Thanks for getting in touch.' } }
              }
            ],
            finishReason: 'tool_calls'
          },
          { content: 'Reply filed.', finishReason: 'stop' }
        ]
      })
    );

    const state = createState(handle.db, owner, workflow.id, {
      name: 'Drafting',
      kind: 'agent',
      agentId: agent.id,
      maxAttempts: 2
    });

    const record = await createRecord(handle.db, owner, {
      objectTypeId: workflow.objectTypeId,
      displayName: 'Customer question'
    });
    const item = await createWorkflowItemService(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: state.id
    });

    // The state entry job was written in the work item's transaction.
    const queued = entryJobsFor(item.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe('pending');

    const { drainQueue } = await import('../../src/lib/server/jobs/worker');
    const processed = await drainQueue({
      db: handle.db,
      concurrency: 1,
      idleTimeoutMs: 60,
      leaseSeconds: 30,
      maxJobs: 20
    });
    expect(processed).toBeGreaterThanOrEqual(1);

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workflowItemId, item.id))
      .all()[0];
    expect(run?.status, run?.error ?? 'no error').toBe('succeeded');
    expect(run?.outputText).toBe('Reply filed.');

    const values = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(values[0]?.valueText).toBe('Thanks for getting in touch.');

    // The streamed facts are persisted, which is what makes the timeline and SSE
    // replay work without any in-memory state.
    const events = handle.db.select().from(runEvents).where(eq(runEvents.runId, run!.id)).all();
    const types = events.map((event) => event.type);
    expect(types).toContain('run.queued');
    expect(types).toContain('run.started');
    expect(types).toContain('run.completed');

    // The job finished and is no longer leasable.
    const finished = handle.db.select().from(jobs).where(eq(jobs.id, queued[0]!.id)).all()[0]!;
    expect(finished.status).toBe('completed');

    // The board still shows the work in its state (the agent did not move it).
    const board = await listWorkflowItems(handle.db, { workspaceId, workflowId: workflow.id });
    expect(board.items[0]?.stateId).toBe(state.id);
    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.fields.reply).toBe('Thanks for getting in touch.');
  });

  test('a human-gated state produces no job at all', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Gated',
      states: [
        {
          name: 'Review',
          kind: 'manual',
          category: 'review',
          isStart: true,
          humanGate: { enabled: true }
        },
        { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
      ],
      transitions: [['Review', 'Done', 'Approve']]
    });
    const record = await createRecord(handle.db, owner, {
      objectTypeId: workflow.objectTypeId,
      displayName: 'Needs a human'
    });
    const item = await createWorkflowItemService(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });
    const queued = entryJobsFor(item.id);
    expect(queued).toHaveLength(0);
    const row = handle.db
      .select()
      .from(workflowItems)
      .where(eq(workflowItems.id, item.id))
      .all()[0]!;
    expect(row.waitingOn).toBe('human');
  });
});
