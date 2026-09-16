/**
 * End-to-end bootstrap test.
 *
 * This test is the integration gate: it proves that the locators, job handlers,
 * native tools and worker are wired together well enough to run a real piece of
 * work from a persisted state entry through to a completed agent run — without any
 * test-only shortcut such as calling the runner directly.
 *
 * It deliberately drives the *durable* path: create a ticket (which enqueues
 * `state.enter` in the same transaction), then run the worker until the queue is
 * drained, then assert on the persisted outcome.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createAgent } from '../../src/lib/server/agents/service';
import { resetBootstrap, runBootstrap } from '../../src/lib/server/bootstrap';
import { uuidv7 } from '../../src/lib/server/core/ids';
import {
  agentRuns,
  jobs,
  models,
  providers,
  runEvents,
  ticketFieldValues,
  tickets,
  tools,
  users
} from '../../src/lib/server/db/schema';
import { createFieldDefinition, setWorkflowFields } from '../../src/lib/server/fields/service';
import { registeredJobTypes } from '../../src/lib/server/jobs/handlers';
import { FakeProvider } from '../../src/lib/server/providers/fake';
import {
  clearProviderOverrides,
  setProviderOverride
} from '../../src/lib/server/providers/registry';
import { listTickets } from '../../src/lib/server/tickets/query';
import { createTicketSync } from '../../src/lib/server/tickets/service';
import { getDefaultToolRegistry, resetToolRegistry } from '../../src/lib/server/tools/registry';
import { createState } from '../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../helpers/db';
import { createWorkflow, createWorkspace, ownerActor } from '../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let owner: ReturnType<typeof ownerActor>;

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
      'state.enter',
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
    expect(keys).toContain('mentat.ticket.fields.set');
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

  test('installs the ticket filter compiler, so the board query filters', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Filtered' });
    createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'High',
      priority: 'high'
    });
    createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Low', priority: 'low' });

    const page = await listTickets(handle.db, {
      workspaceId,
      filter: { type: 'condition', kind: 'system', key: 'priority', operator: 'eq', value: 'high' }
    });
    expect(page.rows.map((row) => row.ticket.title)).toEqual(['High']);
  });

  test('reports unknown filter keys instead of failing', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Unknown key' });
    createTicketSync(handle.db, owner, { workflowId: workflow.id, title: 'Anything' });
    const page = await listTickets(handle.db, {
      workspaceId,
      filter: {
        type: 'condition',
        kind: 'field',
        key: 'does_not_exist',
        operator: 'eq',
        value: 'x'
      }
    });
    expect(page.rows).toHaveLength(0);
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
        key: 'mentat.ticket.fields.set',
        name: 'Set a ticket field',
        description: 'Set one typed field value.',
        kind: 'native',
        implementation: { kind: 'native', key: 'mentat.ticket.fields.set' } as never,
        inputSchema: {
          type: 'object',
          properties: { fieldKey: { type: 'string' }, value: {} },
          required: ['fieldKey'],
          additionalProperties: false
        } as never,
        permissions: ['ticket:write'] as never,
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
      permissions: { native: ['mentat.ticket.fields.set'] } as never
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
                name: 'mentat.ticket.fields.set',
                arguments: { fieldKey: 'reply', value: 'Thanks for getting in touch.' }
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

    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      stateId: state.id,
      title: 'Customer question'
    });

    // The state entry job was written in the ticket's transaction.
    const queued = handle.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ticketId, ticket.id), eq(jobs.type, 'state.enter')))
      .all();
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
      .where(eq(agentRuns.ticketId, ticket.id))
      .all()[0];
    expect(run?.status, run?.error ?? 'no error').toBe('succeeded');
    expect(run?.outputText).toBe('Reply filed.');

    const values = handle.db
      .select()
      .from(ticketFieldValues)
      .where(eq(ticketFieldValues.ticketId, ticket.id))
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

    // The board still shows the ticket in its state (the agent did not move it).
    const board = await listTickets(handle.db, { workspaceId, workflowId: workflow.id });
    expect(board.rows[0]?.ticket.stateId).toBe(state.id);
    expect(board.rows[0]?.fields.reply).toBe('Thanks for getting in touch.');
  });

  test('a human-gated state produces no job at all', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Gated',
      states: [
        { name: 'Review', kind: 'manual', category: 'review', isStart: true },
        { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
      ],
      transitions: [['Review', 'Done', 'Approve']]
    });
    const state = createState(handle.db, owner, workflow.id, {
      name: 'Gate check',
      kind: 'manual'
    });
    void state;
    const ticket = createTicketSync(handle.db, owner, {
      workflowId: workflow.id,
      title: 'Needs a human'
    });
    const queued = handle.db.select().from(jobs).where(eq(jobs.ticketId, ticket.id)).all();
    expect(queued).toHaveLength(0);
    const row = handle.db.select().from(tickets).where(eq(tickets.id, ticket.id)).all()[0]!;
    expect(row.waitingOn).toBe('human');
  });
});
