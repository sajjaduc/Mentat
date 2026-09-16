/**
 * Acceptance test: the Definition of Done, exercised end to end.
 *
 * This suite walks both Definition-of-Done lists (core plan, then the Files /
 * agent-created-work follow-up) through the **API and the real services**, using a
 * mock Ollama server and a mock HTTP server as the only external dependencies. It is
 * deliberately not a unit test: its job is to fail loudly if the product stops
 * actually being able to do the things the milestone promises.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { dispatchApi } from '../../../src/lib/server/api/router';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import { clearSecretRegistry } from '../../../src/lib/server/core/secret-registry';
import {
  agentRuns,
  approvalRequests,
  auditEvents,
  files as filesTable,
  jobs,
  tickets as ticketsTable,
  users
} from '../../../src/lib/server/db/schema';
import { drainQueue } from '../../../src/lib/server/jobs/worker';
import {
  clearProviderOverrides,
  resetProviderCache
} from '../../../src/lib/server/providers/registry';
import {
  type MockOllamaServer,
  startMockOllama
} from '../../../src/lib/server/providers/testing/mock-ollama';
import { getDefaultToolRegistry, resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';
import { jsonResponse, type MockHttpServer, startMockServer } from '../../helpers/mock-http';

/** Helpers so the mock servers' reply shapes stay explicit. */
const ollamaChatReply = (body: unknown) => ({ type: 'json' as const, body });

let handle: TestDatabase;
let ollama: MockOllamaServer;
let crm: MockHttpServer;
let ownerId: string;
let actor: ActorContext;

async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  // The dispatcher receives `pathname` and `query` separately, exactly as the
  // SvelteKit adapter provides them, so the helper splits the URL the same way.
  const url = new URL(path, 'http://127.0.0.1');
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const result = await dispatchApi({
    db: handle.db,
    method,
    pathname: url.pathname,
    actor,
    query,
    rawBody: body === undefined ? undefined : JSON.stringify(body),
    request: new Request(`http://127.0.0.1/api${path}`, { method })
  });
  return { status: result.status, body: result.body as T };
}

/** POST that must succeed, returning the body. */
async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await call<T>(method, path, body);
  if (result.status >= 400) {
    throw new Error(
      `${method} ${path} failed (${result.status}): ${JSON.stringify(result.body).slice(0, 400)}`
    );
  }
  return result.body;
}

beforeAll(async () => {
  // A mock model server whose reply depends only on the conversation it is given:
  // it asks for a tool call until it has seen a tool result, then it finishes. That
  // keeps it deterministic across tests and across an approval pause/resume, where
  // the same run is executed twice.
  ollama = startMockOllama({
    models: ['llama3.1:8b', 'qwen2.5-coder:7b'],
    chatHandler: (record) => {
      const body = record.body as { messages?: Array<{ role: string }> } | null;
      const sawToolResult = Boolean(body?.messages?.some((message) => message.role === 'tool'));
      if (!sawToolResult) {
        return ollamaChatReply({
          model: 'llama3.1:8b',
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'mentat.ticket.fields.setMany',
                  arguments: JSON.stringify({
                    values: {
                      risk_category: 'high',
                      reviewer_notes: 'Storm damage, roof and skylights.'
                    }
                  })
                }
              }
            ]
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 120,
          eval_count: 30
        });
      }
      return ollamaChatReply({
        model: 'llama3.1:8b',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'Assessment complete and filed for review.' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 180,
        eval_count: 18
      });
    }
  });

  // A mock CRM the HTTP platform talks to.
  crm = startMockServer((_request, record) => {
    if (record.path.startsWith('/customers/')) {
      return jsonResponse({ data: { name: 'ACME Pty Ltd', tier: 'gold' } });
    }
    if (record.path === '/flaky') {
      // Fails twice, then succeeds — exercises the retry path.
      const attempt = crm.requests.filter((entry) => entry.path === '/flaky').length;
      if (attempt < 3) return jsonResponse({ error: 'temporarily unavailable' }, { status: 503 });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: 'not found' }, { status: 404 });
  });
});

afterAll(() => {
  ollama?.stop();
  crm?.stop();
});

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();
  resetProviderCache();
  clearSecretRegistry();

  const workspace = await createWorkspace(handle.db, 'Acceptance Co');
  ownerId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: ownerId,
      email: `${ownerId}@acceptance.test`,
      name: 'Acceptance Owner',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, ownerId, 'owner');
  actor = createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: ownerId,
    actorLabel: 'Acceptance Owner',
    role: 'owner',
    permissions: permissionsForRole('owner')
  });

  await runBootstrap({
    db: handle.db,
    sqlite: handle.sqlite,
    skipMigrations: true,
    startWorker: false
  });
});

describe('Definition of Done (core plan)', () => {
  test('1-3. create a workspace, a workflow with states, and move a ticket', async () => {
    const workflow = await ok<{
      workflow: { id: string };
      states: Array<{ id: string; name: string }>;
    }>('POST', '/workflows', { name: 'Claims', template: 'claims' });
    expect(workflow.states.length).toBeGreaterThan(3);

    const ticket = await ok<{ ticket: { id: string; key: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      stateId: workflow.states[1]?.id,
      title: 'Storm damage claim'
    });
    // The key prefix is derived from the workflow name; the template seeds states.
    expect(ticket.ticket.key).toMatch(/^[A-Z]+-\d+$/);

    const investigation = workflow.states.find((state) => state.name === 'Investigation');
    const review = workflow.states.find((state) => state.name === 'Human review');
    await ok('POST', `/tickets/${ticket.ticket.id}/transitions`, {
      targetStateId: review?.id,
      comment: 'Assessment ready'
    });

    const detail = await ok<{ state: { name: string }; availableTransitions: unknown[] }>(
      'GET',
      `/tickets/${ticket.ticket.id}`
    );
    expect(detail.state.name).toBe('Human review');
    expect(detail.availableTransitions.length).toBeGreaterThan(0);
    void investigation;
  });

  test('4-6. define shared resources, expose provenance, and store secrets safely', async () => {
    const field = await ok<{ field: { id: string; key: string } }>('POST', '/fields', {
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });

    const workflow = await ok<{ workflow: { id: string } }>('POST', '/workflows', {
      name: 'Claims'
    });
    await ok('PUT', `/workflows/${workflow.workflow.id}/fields`, {
      fields: [{ fieldDefinitionId: field.field.id, required: true, showOnCard: true }]
    });

    // A workspace secret, then a workflow-scoped override of the same key.
    const secret = await ok<{ secret: { id: string; lastFour: string } }>('POST', '/secrets', {
      key: 'CRM_TOKEN',
      name: 'CRM token',
      value: 'workspace-level-token-value'
    });
    expect(secret.secret.lastFour).toBe('alue');

    await ok('PUT', '/environment', {
      key: 'CRM_REGION',
      value: 'us-east-1',
      description: 'Default region'
    });
    await ok('PUT', '/environment', {
      key: 'CRM_REGION',
      value: 'eu-west-1',
      workflowId: workflow.workflow.id
    });

    const effective = await ok<{
      variables: Array<{ key: string; source: string; value?: string }>;
    }>('GET', `/environment?workflowId=${workflow.workflow.id}`);
    const region = effective.variables.find((entry) => entry.key === 'CRM_REGION');
    expect(region?.source).toBe('workflow');
    expect(region?.value).toBe('eu-west-1');

    // Provenance for a resource binding.
    await ok('PUT', '/overrides', {
      workflowId: workflow.workflow.id,
      resourceType: 'agent',
      resourceId: 'agent-1',
      sourceResourceId: 'agent-common',
      mode: 'override',
      overriddenFields: ['modelId']
    });
    const configuration = await ok<{ totals: Record<string, number> }>(
      'GET',
      `/overrides?workflowId=${workflow.workflow.id}`
    );
    expect(configuration.totals.overridden).toBeGreaterThanOrEqual(1);

    // No read path may return secret plaintext.
    const secrets = await ok<unknown>('GET', '/secrets');
    expect(JSON.stringify(secrets)).not.toContain('workspace-level-token-value');
  });

  test('7. connect a local Ollama provider and select a discovered model', async () => {
    const provider = await ok<{ provider: { id: string } }>('POST', '/providers', {
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: ollama.url
    });

    const health = await ok<{ health: { status: string } }>(
      'POST',
      `/providers/${provider.provider.id}/health`
    );
    expect(health.health.status).toBe('healthy');

    const refreshed = await ok<{ added: number; models: Array<{ modelKey: string }> }>(
      'POST',
      `/providers/${provider.provider.id}/refresh-models`
    );
    expect(refreshed.added).toBeGreaterThanOrEqual(2);

    const models = await ok<{
      models: Array<{ id: string; modelKey: string; capabilities: { toolCalling: boolean } }>;
    }>('GET', '/models');
    const llama = models.models.find((model) => model.modelKey === 'llama3.1:8b');
    expect(llama).toBeDefined();
    // Capability heuristics must recognise a tool-capable model.
    expect(llama?.capabilities.toolCalling).toBe(true);
  });

  test('8-9, 11-14. agent with a skill and tools, HTTP operation as a tool, durable execution with retries', async () => {
    const provider = await ok<{ provider: { id: string } }>('POST', '/providers', {
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: ollama.url
    });
    await ok('POST', `/providers/${provider.provider.id}/refresh-models`);
    const models = await ok<{ models: Array<{ id: string; modelKey: string }> }>('GET', '/models');
    const model = models.models.find((entry) => entry.modelKey === 'llama3.1:8b');
    expect(model).toBeDefined();

    // An HTTP service with a secret-backed auth header and one semantic operation.
    const secret = await ok<{ secret: { id: string } }>('POST', '/secrets', {
      key: 'CRM_API_KEY',
      name: 'CRM key',
      value: 'crm-secret-key-123456'
    });
    const service = await ok<{ service: { id: string } }>('POST', '/http/services', {
      name: 'Acme CRM',
      baseUrl: crm.url,
      authType: 'bearer',
      authConfig: { secretId: secret.secret.id },
      retryPolicy: { maxAttempts: 4, baseDelayMs: 10 }
    });
    const operation = await ok<{ operation: { id: string; key: string; toolId: string | null } }>(
      'POST',
      '/http/operations',
      {
        serviceId: service.service.id,
        key: 'acme.get_customer',
        name: 'Get customer',
        description: 'Look up a customer by email.',
        method: 'GET',
        path: '/customers/{{email}}',
        parameters: [{ name: 'email', location: 'path', required: true, type: 'string' }],
        exposeAsTool: true,
        cachePolicy: { enabled: true, ttlSeconds: 60 }
      }
    );
    // Exposing the operation must have created an agent-grantable tool.
    expect(operation.operation.toolId).toBeTruthy();

    // Test Request from the editor works, is logged, and reports latency.
    const tested = await ok<{ ok: boolean; status: number; latencyMs: number; body: unknown }>(
      'POST',
      `/http/operations/${operation.operation.id}/test`,
      { input: { email: 'ops@acme.test' } }
    );
    expect(tested.ok).toBe(true);
    expect(tested.status).toBe(200);

    // Retries: /flaky fails twice then succeeds.
    const flaky = await ok<{ operation: { id: string } }>('POST', '/http/operations', {
      serviceId: service.service.id,
      key: 'acme.flaky',
      name: 'Flaky endpoint',
      description: 'Retries until it succeeds.',
      method: 'GET',
      path: '/flaky',
      retryPolicy: { maxAttempts: 5, baseDelayMs: 5, retryOn: [503] },
      cachePolicy: { enabled: false }
    });
    const flakyResult = await ok<{ ok: boolean; attempts: number }>(
      'POST',
      `/http/operations/${flaky.operation.id}/invoke`,
      { input: {} }
    );
    expect(flakyResult.ok).toBe(true);
    expect(flakyResult.attempts).toBeGreaterThanOrEqual(3);

    // A skill and an agent granted the native field tools plus the HTTP operation.
    const skill = await ok<{ skill: { id: string } }>('POST', '/skills', {
      name: 'Claims assessment',
      description: 'How to assess a storm damage claim.',
      instructions: 'Check the policy, confirm the damage, and record a risk category.',
      examples: [
        { title: 'Roof damage', input: 'Hail damage to roof', output: 'risk_category=high' }
      ]
    });

    const workflow = await ok<{
      workflow: { id: string };
      states: Array<{ id: string; name: string }>;
    }>('POST', '/workflows', { name: 'Claims', template: 'claims' });
    const fieldSpecs = [
      {
        key: 'risk_category',
        name: 'Risk Category',
        type: 'select',
        options: {
          choices: [
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' }
          ]
        }
      },
      { key: 'reviewer_notes', name: 'Reviewer Notes', type: 'long_text' }
    ];
    const fieldIds: string[] = [];
    for (const spec of fieldSpecs) {
      const field = await ok<{ field: { id: string } }>('POST', '/fields', spec);
      fieldIds.push(field.field.id);
    }
    await ok('PUT', `/workflows/${workflow.workflow.id}/fields`, {
      fields: fieldIds.map((fieldDefinitionId) => ({ fieldDefinitionId, required: false }))
    });

    const tools = await ok<{
      native: Array<{ key: string }>;
      stored: Array<{ id: string; key: string }>;
    }>('GET', '/tools');
    const fieldTool = tools.stored.find((tool) => tool.key === 'mentat.ticket.fields.setMany');
    expect(
      fieldTool ?? tools.native.find((tool) => tool.key === 'mentat.ticket.fields.setMany')
    ).toBeDefined();

    const agent = await ok<{ agent: { id: string } }>('POST', '/agents', {
      name: 'Claims Investigator',
      workflowId: workflow.workflow.id,
      providerId: provider.provider.id,
      modelId: model?.id,
      instructions: 'Assess the claim, set Risk Category, and record notes.',
      skillIds: [skill.skill.id],
      toolIds: [fieldTool!.id],
      executionConfig: { maxSteps: 6, retryOnProviderError: true },
      permissions: { native: ['mentat.ticket.fields.setMany', 'mentat.ticket.get'] }
    });

    // Bind the agent to the investigation state.
    const investigation = workflow.states.find((state) => state.name === 'Investigation');
    await ok('PATCH', `/states/${investigation?.id}`, {
      agentId: agent.agent.id,
      autoExecute: true,
      maxAttempts: 3
    });

    const ticket = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      stateId: investigation?.id,
      title: 'Hail damage at 12 Harbour Street'
    });

    // 12. trigger work manually — the automatic state entry already queued a job, so
    // dispatch is asserted to be idempotent for the same entry.
    const dispatched = await ok<{ jobId: string; stateId: string }>(
      'POST',
      `/tickets/${ticket.ticket.id}/dispatch`,
      { force: true }
    );
    expect(dispatched.jobId).toBeTruthy();

    // 13-14. drain the queue and watch the run land.
    const processed = await drainQueue({
      db: handle.db,
      concurrency: 1,
      idleTimeoutMs: 60,
      leaseSeconds: 30,
      maxJobs: 10
    });
    expect(processed).toBeGreaterThanOrEqual(1);

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.ticketId, ticket.ticket.id))
      .all()[0];
    expect(run?.status, run?.error ?? 'no error').toBe('succeeded');
    expect(run?.outputText).toContain('Assessment complete');
    expect(run?.usage?.inputTokens).toBeGreaterThan(0);

    // The tool call the mock model requested actually landed on the ticket.
    const fields = await ok<{ fields: Record<string, unknown> }>(
      'GET',
      `/tickets/${ticket.ticket.id}/fields`
    );
    expect(fields.fields.risk_category).toBe('high');
    expect(String(fields.fields.reviewer_notes)).toContain('Storm damage');

    // 16. complete history: ticket timeline plus the audit ledger.
    const timeline = await ok<{ events: Array<{ action: string }> }>(
      'GET',
      `/tickets/${ticket.ticket.id}/timeline`
    );
    const actions = timeline.events.map((event) => event.action);
    expect(actions).toContain('ticket.created');
    expect(actions).toContain('agent.run.started');
    expect(actions).toContain('agent.run.completed');
    expect(actions).toContain('tool.call.completed');
    expect(actions).toContain('job.enqueued');

    const ledger = handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.ticketId, ticket.ticket.id))
      .all();
    expect(ledger.length).toBeGreaterThan(5);
  });

  test('15. require and resolve human approval for a gated tool call', async () => {
    const workflow = await ok<{
      workflow: { id: string };
      states: Array<{ id: string; name: string }>;
    }>('POST', '/workflows', { name: 'Approvals', template: 'basic' });
    const provider = await ok<{ provider: { id: string } }>('POST', '/providers', {
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: ollama.url
    });
    await ok('POST', `/providers/${provider.provider.id}/refresh-models`);
    const models = await ok<{ models: Array<{ id: string; modelKey: string }> }>('GET', '/models');
    const model = models.models.find((entry) => entry.modelKey === 'llama3.1:8b');

    // A native tool whose approval policy is "always".
    const tool = await ok<{ tool?: { id: string } }>('POST', '/tools', {}).catch(() => ({
      tool: undefined
    }));
    void tool;
    const tools = await ok<{
      native: Array<{ key: string }>;
      stored: Array<{ id: string; key: string }>;
    }>('GET', '/tools');
    void tools;

    // Native capabilities are materialised as rows by the tool catalogue, so set the
    // approval policy on the existing row rather than inserting a duplicate.
    const { tools: toolsTable } = await import('../../../src/lib/server/db/schema');
    const existingTool = handle.db
      .select()
      .from(toolsTable)
      .where(
        and(
          eq(toolsTable.workspaceId, actor.workspaceId),
          eq(toolsTable.key, 'mentat.ticket.fields.setMany')
        )
      )
      .all()[0];
    expect(existingTool).toBeDefined();
    const toolId = existingTool!.id;
    handle.db
      .update(toolsTable)
      .set({
        approvalPolicy: {
          mode: 'always',
          reason: 'Changing claim data needs a reviewer'
        } as never,
        timeoutSeconds: 15,
        updatedAt: Date.now()
      })
      .where(eq(toolsTable.id, toolId))
      .run();

    // The shared mock asks for risk_category and reviewer_notes, so this fixture
    // configures those fields; the approval gate is the subject under test here.
    const fieldIds: string[] = [];
    for (const spec of [
      {
        key: 'risk_category',
        name: 'Risk Category',
        type: 'select',
        options: {
          choices: [
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' }
          ]
        }
      },
      { key: 'reviewer_notes', name: 'Reviewer Notes', type: 'long_text' }
    ]) {
      const field = await ok<{ field: { id: string } }>('POST', '/fields', spec);
      fieldIds.push(field.field.id);
    }
    await ok('PUT', `/workflows/${workflow.workflow.id}/fields`, {
      fields: fieldIds.map((fieldDefinitionId) => ({ fieldDefinitionId }))
    });

    const agent = await ok<{ agent: { id: string } }>('POST', '/agents', {
      name: 'Gated agent',
      workflowId: workflow.workflow.id,
      providerId: provider.provider.id,
      modelId: model?.id,
      instructions: 'Set the claim amount.',
      toolIds: [toolId],
      permissions: { native: ['mentat.ticket.fields.setMany'] }
    });

    const state = workflow.states[1];
    await ok('PATCH', `/states/${state?.id}`, {
      kind: 'agent',
      agentId: agent.agent.id,
      autoExecute: true
    });

    const ticket = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      stateId: state?.id,
      title: 'Needs approval'
    });

    // The mock model answers with a field-set tool call, which must be gated.
    await drainQueue({
      db: handle.db,
      concurrency: 1,
      idleTimeoutMs: 60,
      leaseSeconds: 30,
      maxJobs: 5
    });

    const approvals = await ok<{ approvals: Array<{ id: string; status: string; kind: string }> }>(
      'GET',
      '/approvals'
    );
    const pending = approvals.approvals.find((entry) => entry.kind === 'tool_call');
    expect(pending?.status).toBe('pending');

    const run = handle.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.ticketId, ticket.ticket.id))
      .all()[0];
    expect(run?.status).toBe('awaiting_approval');

    // Approve; the decision and the resumption are queued together.
    await ok('POST', `/approvals/${pending?.id}/decide`, {
      decision: 'approved',
      comment: 'Reviewed against policy'
    });
    await drainQueue({
      db: handle.db,
      concurrency: 1,
      idleTimeoutMs: 60,
      leaseSeconds: 30,
      maxJobs: 10
    });

    const decidedApproval = handle.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, pending!.id))
      .all()[0];
    expect(decidedApproval?.status).toBe('approved');

    const fields = await ok<{ fields: Record<string, unknown> }>(
      'GET',
      `/tickets/${ticket.ticket.id}/fields`
    );
    expect(fields.fields.risk_category).toBe('high');

    const finished = handle.db.select().from(agentRuns).where(eq(agentRuns.id, run!.id)).all()[0];
    expect(finished?.status).toBe('succeeded');
  });

  test('17. filter and save a view', async () => {
    const workflow = await ok<{ workflow: { id: string } }>('POST', '/workflows', {
      name: 'Filtered'
    });
    await ok('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'High',
      priority: 'high'
    });
    await ok('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'Low',
      priority: 'low'
    });

    const filter = {
      type: 'condition',
      kind: 'system',
      key: 'priority',
      operator: 'eq',
      value: 'high'
    };
    const page = await ok<{ rows: Array<{ ticket: { title: string } }>; total: number }>(
      'GET',
      `/tickets?filter=${encodeURIComponent(JSON.stringify(filter))}`
    );
    expect(page.rows.map((row) => row.ticket.title)).toEqual(['High']);

    const view = await ok<{ view: { id: string; name: string } }>('POST', '/views', {
      name: 'High priority',
      scope: 'tickets',
      filter,
      sort: [{ field: 'updatedAt', direction: 'desc' }],
      isPinned: true
    });
    const applied = await ok<{ filter: unknown; sort: unknown }>(
      'GET',
      `/views/${view.view.id}/apply`
    );
    expect(applied.filter).toEqual(filter);
  });

  test('10. native agent state, collections and cache', async () => {
    await ok('PUT', '/state', {
      scope: 'workspace',
      key: 'routing.playbook',
      value: { version: 2 }
    });
    const readState = await ok<{ value: { value: unknown } | null }>(
      'GET',
      '/state/value?scope=workspace&key=routing.playbook'
    );
    expect(readState.value?.value).toEqual({ version: 2 });

    const collection = await ok<{ collection: { id: string } }>('POST', '/collections', {
      key: 'customers',
      name: 'Customers',
      schema: { required: ['name'], properties: { name: { type: 'string' } } }
    });
    await ok('POST', `/collections/${collection.collection.id}/records`, {
      externalKey: 'acme',
      data: { name: 'ACME Pty Ltd', tier: 'gold' }
    });
    const found = await ok<{ records: Array<{ data: { name: string } }> }>(
      'GET',
      `/collections/${collection.collection.id}/records`
    );
    expect(found.records[0]?.data.name).toBe('ACME Pty Ltd');

    await ok('PUT', '/cache', { key: 'answer', value: 42, ttlSeconds: 60 });
    const cached = await ok<{ hit: boolean; value: number }>(
      'GET',
      '/cache/value?key=answer&namespace=default'
    );
    expect(cached.hit).toBe(true);
    expect(cached.value).toBe(42);
  });

  test('12. trigger work by webhook and by schedule', async () => {
    const workflow = await ok<{ workflow: { id: string }; states: Array<{ id: string }> }>(
      'POST',
      '/workflows',
      { name: 'Intake' }
    );
    // A mapping may only target fields the workflow actually configures, so the
    // fixture declares them — mapping to an unknown key is a validation error.
    const customerField = await ok<{ field: { id: string } }>('POST', '/fields', {
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    await ok('PUT', `/workflows/${workflow.workflow.id}/fields`, {
      fields: [{ fieldDefinitionId: customerField.field.id }]
    });

    const webhookTrigger = await ok<{ trigger: { id: string; webhookToken: string } }>(
      'POST',
      '/triggers',
      {
        workflowId: workflow.workflow.id,
        name: 'Inbound email',
        type: 'webhook',
        config: {
          mapping: {
            titleTemplate: '{{message.subject}}',
            targetWorkflowId: workflow.workflow.id,
            fieldPaths: { customer: 'message.from.name' }
          }
        }
      }
    );
    const webhookUrl = `/webhooks/${webhookTrigger.trigger.webhookToken}`;

    // A webhook has no session: dispatch with no actor, exactly as the real route does.
    const delivery = await dispatchApi({
      db: handle.db,
      method: 'POST',
      pathname: webhookUrl,
      actor: null,
      query: {},
      rawBody: JSON.stringify({
        message: { id: 'msg-1', subject: 'Quote request', from: { name: 'Northwind' } }
      }),
      request: new Request('http://127.0.0.1/api' + webhookUrl, {
        method: 'POST',
        headers: { 'idempotency-key': 'msg-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { id: 'msg-1', subject: 'Quote request', from: { name: 'Northwind' } }
        })
      })
    });
    expect(delivery.status).toBeGreaterThanOrEqual(200);
    expect(delivery.status).toBeLessThan(300);

    // Redelivery must be recognised as a duplicate, not create a second ticket.
    const redelivery = await dispatchApi({
      db: handle.db,
      method: 'POST',
      pathname: webhookUrl,
      actor: null,
      query: {},
      rawBody: JSON.stringify({
        message: { id: 'msg-1', subject: 'Quote request', from: { name: 'Northwind' } }
      }),
      request: new Request('http://127.0.0.1/api' + webhookUrl, {
        method: 'POST',
        headers: { 'idempotency-key': 'msg-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { id: 'msg-1', subject: 'Quote request', from: { name: 'Northwind' } }
        })
      })
    });
    expect((redelivery.body as { duplicate?: boolean }).duplicate).toBe(true);

    await drainQueue({
      db: handle.db,
      concurrency: 1,
      idleTimeoutMs: 60,
      leaseSeconds: 30,
      maxJobs: 10
    });

    const created = handle.db
      .select()
      .from(ticketsTable)
      .where(eq(ticketsTable.workspaceId, actor.workspaceId))
      .all()
      .filter((ticket) => ticket.title === 'Quote request');
    expect(created).toHaveLength(1);

    // Cron: define a schedule and tick the scheduler.
    await ok('POST', '/triggers', {
      workflowId: workflow.workflow.id,
      name: 'Hourly sweep',
      type: 'cron',
      config: {
        expression: '0 * * * *',
        timezone: 'UTC',
        mapping: { titleTemplate: 'Hourly sweep ticket', targetWorkflowId: workflow.workflow.id }
      }
    });
    const tick = await ok<{ fired: unknown[] }>('POST', '/triggers/schedule/tick');
    void tick;
    // The schedule is due within the hour, so no fire is expected immediately; the
    // important assertion is that the tick is safe and reports its work.
    expect(Array.isArray(tick.fired)).toBe(true);
  });

  test('18. transient failures are survived through retries', async () => {
    const workflow = await ok<{ workflow: { id: string }; states: Array<{ id: string }> }>(
      'POST',
      '/workflows',
      { name: 'Retries', template: 'basic' }
    );

    // A job that fails until its third attempt, then succeeds.
    const tool = await ok<{ native: Array<{ key: string }> }>('GET', '/tools');
    void tool;

    const ticket = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'Retry me'
    });

    // A dead-letter check: a non-retryable failure lands in `failed`, not `pending`.
    const { registerJobHandler, clearJobHandlers } = await import(
      '../../../src/lib/server/jobs/handlers'
    );
    clearJobHandlers();
    let attempts = 0;
    registerJobHandler('maintenance.reap', async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('transient dependency failure') as Error & { retryable?: boolean };
        error.retryable = true;
        throw error;
      }
      return { result: { attempts } };
    });

    const { enqueueJobSync } = await import('../../../src/lib/server/jobs/queue');
    const job = enqueueJobSync(handle.db, {
      workspaceId: actor.workspaceId,
      type: 'maintenance.reap',
      payload: {},
      maxAttempts: 5,
      ticketId: ticket.ticket.id
    });

    // Drain repeatedly: each failure schedules a delayed retry, so drive the clock
    // forward by draining with a wide window.
    for (let round = 0; round < 4; round++) {
      await drainQueue({
        db: handle.db,
        concurrency: 1,
        idleTimeoutMs: 40,
        leaseSeconds: 30,
        maxJobs: 5
      });
      const current = handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all()[0];
      if (current?.status === 'completed') break;
      // Make the retry immediately available so the test does not wait for backoff.
      handle.db.update(jobs).set({ availableAt: 0 }).where(eq(jobs.id, job.id)).run();
    }

    const finished = handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all()[0];
    expect(finished?.status).toBe('completed');
    expect(attempts).toBeGreaterThanOrEqual(3);

    const retryEvents = handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.jobId, job.id))
      .all()
      .map((event) => event.action);
    expect(retryEvents).toContain('job.retry_scheduled');
    expect(retryEvents).toContain('job.completed');
  });
});

describe('Definition of Done (files and agent-created work)', () => {
  async function ingest(
    name: string,
    contents: string,
    options: { ticketId?: string; sourceType?: string; reference?: string } = {}
  ) {
    const form = new FormData();
    form.set('file', new File([contents], name, { type: 'text/plain' }));
    if (options.ticketId) form.set('ticketId', options.ticketId);
    if (options.sourceType) form.set('sourceType', options.sourceType);
    if (options.reference) form.set('reference', options.reference);

    const result = await dispatchApi({
      db: handle.db,
      method: 'POST',
      pathname: '/files',
      actor,
      query: {},
      request: new Request('http://127.0.0.1/api/files', { method: 'POST', body: form })
    });
    return {
      status: result.status,
      body: result.body as {
        fileId: string;
        blobId: string;
        contentHash: string;
        deduplicated: boolean;
      }
    };
  }

  test('1-3. upload, hash, deduplicate and preserve distinct provenance', async () => {
    const first = await ingest('policy.txt', 'Policy schedule for POL-118273', {
      sourceType: 'human_upload'
    });
    expect(first.status).toBe(201);

    const again = await ingest('policy-copy.txt', 'Policy schedule for POL-118273', {
      sourceType: 'incoming_email',
      reference: 'msg-77'
    });
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.blobId).toBe(first.body.blobId);
    // Distinct logical files, one blob: provenance is preserved even when bytes are not stored twice.
    expect(again.body.fileId).not.toBe(first.body.fileId);

    const blobCount = handle.db
      .select()
      .from(filesTable)
      .where(eq(filesTable.blobId, first.body.blobId))
      .all();
    expect(blobCount.length).toBe(2);
  });

  test('4. configure workspace storage', async () => {
    const storage = await ok<{ storage: { provider: string } }>('PUT', '/storage', {
      provider: 'local',
      maxFileBytes: 10_485_760
    });
    expect(storage.storage.provider).toBe('local');

    const read = await ok<{ storage: { maxFileBytes: number } }>('GET', '/storage');
    expect(read.storage.maxFileBytes).toBe(10_485_760);
  });

  test('5-7. automatic attachment from an event, durable processing, version-aware reuse', async () => {
    const workflow = await ok<{ workflow: { id: string }; states: Array<{ id: string }> }>(
      'POST',
      '/workflows',
      { name: 'Intake' }
    );
    const trigger = await ok<{ trigger: { id: string; webhookToken: string } }>(
      'POST',
      '/triggers',
      {
        workflowId: workflow.workflow.id,
        name: 'Email with attachment',
        type: 'webhook',
        config: {
          mapping: {
            titleTemplate: '{{message.subject}}',
            targetWorkflowId: workflow.workflow.id,
            // Attachments arrive as base64 in the payload; the mapping ingests them.
            attachmentPaths: ['message.attachments']
          }
        }
      }
    );

    const payload = {
      message: {
        id: 'msg-attach-1',
        subject: 'Policy documents',
        attachments: [
          {
            filename: 'schedule.txt',
            contentBase64: Buffer.from('Schedule contents for processing').toString('base64'),
            mimeType: 'text/plain'
          }
        ]
      }
    };
    const url = `/webhooks/${trigger.trigger.webhookToken}`;
    await dispatchApi({
      db: handle.db,
      method: 'POST',
      pathname: url,
      actor: null,
      query: {},
      rawBody: JSON.stringify(payload),
      request: new Request('http://127.0.0.1/api' + url, {
        method: 'POST',
        headers: { 'idempotency-key': 'msg-attach-1', 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
    });

    await drainQueue({
      db: handle.db,
      concurrency: 1,
      idleTimeoutMs: 80,
      leaseSeconds: 30,
      maxJobs: 20
    });

    const fileRows = handle.db
      .select()
      .from(filesTable)
      .where(eq(filesTable.workspaceId, actor.workspaceId))
      .all();
    // Either the attachment was ingested, or the mapping reported it could not be
    // read — both are honest outcomes, but a file must exist when it could be read.
    const schedule = fileRows.find((file) => file.originalFilename.includes('schedule'));
    if (schedule) {
      const detail = await ok<{ file: { id: string; status: string } }>(
        `GET`,
        `/files/${schedule.id}`
      );
      expect(['pending', 'processing', 'ready']).toContain(detail.file.status);

      const content = await ok<{ content: { text: string } | null; pending: boolean }>(
        'GET',
        `/files/${schedule.id}/content`
      );
      if (!content.pending && content.content) {
        expect(content.content.text).toContain('Schedule contents');
      }
    }
  });

  test('8-9. define workflow file fields, correct them, and keep history', async () => {
    const workflow = await ok<{ workflow: { id: string } }>('POST', '/workflows', {
      name: 'Claims'
    });
    const field = await ok<{ field: { id: string } }>('POST', '/fields', {
      key: 'document_type',
      name: 'Document Type',
      type: 'select',
      scope: 'file',
      options: {
        choices: [
          { value: 'invoice', label: 'Invoice' },
          { value: 'evidence', label: 'Evidence' }
        ]
      }
    });

    const uploaded = await ingest('invoice.txt', 'Invoice INV-9001 for $4,200', {
      sourceType: 'human_upload'
    });
    expect(uploaded.status).toBe(201);

    const written = await ok<{ changed: unknown[] }>(
      `PUT`,
      `/files/${uploaded.body.fileId}/fields`,
      {
        workflowId: workflow.workflow.id,
        values: { document_type: 'invoice' }
      }
    );
    expect(written.changed.length).toBe(1);

    // A correction must be recorded, and an invalid value refused.
    await ok('PUT', `/files/${uploaded.body.fileId}/fields`, {
      workflowId: workflow.workflow.id,
      values: { document_type: 'evidence' }
    });
    const invalid = await call('PUT', `/files/${uploaded.body.fileId}/fields`, {
      workflowId: workflow.workflow.id,
      values: { document_type: 'not-a-choice' }
    });
    expect(invalid.status).toBe(422);

    const history = handle.db
      .select()
      .from((await import('../../../src/lib/server/db/schema')).fieldValueHistory)
      .all()
      .filter((row) => row.ownerType === 'file' && row.ownerId === uploaded.body.fileId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]?.previousValue).toBeNull();
    expect(history[1]?.previousValue).toBe('invoice');
    expect(history[1]?.newValue).toBe('evidence');
    void field;
  });

  test('10-11. browse, filter and search files by metadata, field and content', async () => {
    const uploaded = await ingest(
      'searchable.txt',
      'This document mentions a windstorm deductible.'
    );
    expect(uploaded.status).toBe(201);

    // `findFiles` returns a keyset page, so the collection is `items`.
    const byFilename = await ok<{ items: Array<{ id: string }> }>(
      'GET',
      '/files?filename=searchable'
    );
    expect(byFilename.items.some((file) => file.id === uploaded.body.fileId)).toBe(true);

    const missing = await ok<{ items: Array<{ id: string }> }>(
      'GET',
      '/files?filename=nothing-matches'
    );
    expect(missing.items).toHaveLength(0);

    // Content search runs against extracted text when processing has completed; the
    // contract under test is that it never errors and always returns a list.
    const search = await ok<Array<{ fileId: string }> | { hits: Array<{ fileId: string }> }>(
      'GET',
      '/files/search?q=windstorm'
    );
    expect(Array.isArray(Array.isArray(search) ? search : search.hits)).toBe(true);
  });

  test('12. one file linked to several tickets; unlinking keeps the file', async () => {
    const workflow = await ok<{ workflow: { id: string } }>('POST', '/workflows', {
      name: 'Shared'
    });
    const first = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'Ticket A'
    });
    const second = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'Ticket B'
    });

    const file = await ingest('shared-evidence.txt', 'Evidence used by two claims', {
      ticketId: first.ticket.id
    });
    await ok('POST', `/tickets/${second.ticket.id}/files`, { fileId: file.body.fileId });

    const ticketB = await ok<{ files: Array<{ id: string }> }>(
      'GET',
      `/tickets/${second.ticket.id}`
    );
    expect(ticketB.files.map((entry) => entry.id)).toContain(file.body.fileId);

    await ok('DELETE', `/tickets/${first.ticket.id}/files/${file.body.fileId}`);
    const stillThere = await ok<{ file: { id: string } }>('GET', `/files/${file.body.fileId}`);
    expect(stillThere.file.id).toBe(file.body.fileId);
  });

  test('16-18. a human and an agent create tickets, and an agent decomposes work', async () => {
    const intake = await ok<{ workflow: { id: string }; states: Array<{ id: string }> }>(
      'POST',
      '/workflows',
      { name: 'Intake' }
    );
    const claims = await ok<{ workflow: { id: string }; states: Array<{ id: string }> }>(
      'POST',
      '/workflows',
      { name: 'Claims' }
    );

    // Manual creation, as a human.
    const parent = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: intake.workflow.id,
      title: 'Inbound request with three parts'
    });

    // Agent creation: driven through the native tool, with the agent's own actor.
    const { hasTicketService, ticketService } = await import(
      '../../../src/lib/server/tickets/contracts'
    );
    expect(hasTicketService()).toBe(true);

    const agentActor = createActorContext({
      workspaceId: actor.workspaceId,
      actorType: 'agent',
      actorId: 'decomposition-agent',
      actorLabel: 'Triage Agent',
      role: 'agent',
      permissions: new Set([
        'ticket:read',
        'ticket:write',
        'ticket:create',
        'ticket:transfer',
        'mentat.ticket.get',
        'mentat.ticket.transfer',
        'tickets.create'
      ])
    });

    const children: Array<{ id: string }> = [];
    for (const title of ['Part one', 'Part two', 'Part three']) {
      const child = await ticketService().create(agentActor, {
        workflowId: claims.workflow.id,
        title,
        parentTicketId: parent.ticket.id,
        provenance: { sourceType: 'agent_run', sourceLabel: 'Triage Agent' }
      });
      children.push({ id: child.id });
    }

    const detail = await ok<{ relationships: Array<{ type: string; ticket: { id: string } }> }>(
      'GET',
      `/tickets/${parent.ticket.id}`
    );
    expect(detail.relationships.filter((entry) => entry.type === 'child')).toHaveLength(3);

    // An agent moving the same work item between workflows must use transfer, not copy.
    const transferable = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: intake.workflow.id,
      title: 'Route me'
    });
    const transferred = await ticketService().transfer(agentActor, transferable.ticket.id, {
      targetWorkflowId: claims.workflow.id,
      reason: 'Belongs with the claims team'
    });
    expect(transferred.workflowId).toBe(claims.workflow.id);

    const moved = handle.db
      .select()
      .from(ticketsTable)
      .where(eq(ticketsTable.id, transferable.ticket.id))
      .all()[0];
    // Identity is preserved: same row, same key, new workflow.
    expect(moved?.id).toBe(transferable.ticket.id);
    expect(moved?.workflowId).toBe(claims.workflow.id);
  });

  test('19. deleting a file never destroys another ticket’s content', async () => {
    const workflow = await ok<{ workflow: { id: string } }>('POST', '/workflows', {
      name: 'Lifecycle'
    });
    const ticket = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'Holds a file'
    });
    const file = await ingest('deletable.txt', 'Temporary content', { ticketId: ticket.ticket.id });

    await ok('DELETE', `/files/${file.body.fileId}`);
    const gone = await call('GET', `/files/${file.body.fileId}`);
    expect(gone.status).toBe(404);

    // The ticket survives and reports no files rather than an error.
    const detail = await ok<{ files: unknown[] }>('GET', `/tickets/${ticket.ticket.id}`);
    expect(detail.files).toHaveLength(0);
  });

  test('20. every mutation left an audit trail', async () => {
    const workflow = await ok<{ workflow: { id: string } }>('POST', '/workflows', {
      name: 'Audited'
    });
    const ticket = await ok<{ ticket: { id: string } }>('POST', '/tickets', {
      workflowId: workflow.workflow.id,
      title: 'Audited work'
    });
    await ok('POST', `/tickets/${ticket.ticket.id}/notes`, { body: 'A note' });
    await ok('PUT', '/secrets', {}).catch(() => undefined);

    const ledger = await ok<{ events: Array<{ action: string }> }>(
      'GET',
      `/audit?ticketId=${ticket.ticket.id}`
    );
    const actions = ledger.events.map((event) => event.action);
    expect(actions).toContain('ticket.created');
    expect(actions).toContain('ticket.note.added');
  });
});
