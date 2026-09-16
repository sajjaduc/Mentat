/**
 * API router integration tests.
 *
 * The router is exercised directly (no HTTP server) so these tests assert the
 * boundary itself: authentication, permission denial, validation errors, tenant
 * isolation and error mapping — the places where a hand-rolled route handler
 * usually leaks.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { dispatchApi, matchPath, matchRoute } from '../../../src/lib/server/api/router';
import { apiRoutes, publicWebhookRoutes } from '../../../src/lib/server/api/routes';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole,
  systemActor
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import { users, workflowStates } from '../../../src/lib/server/db/schema';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let owner: ActorContext;
let viewer: ActorContext;
let outsider: ActorContext;

async function call(
  method: string,
  path: string,
  options: {
    actor?: ActorContext | null;
    body?: unknown;
    query?: Record<string, string>;
  } = {}
) {
  const result = await dispatchApi({
    db: handle.db,
    method,
    pathname: path,
    actor: options.actor === undefined ? owner : options.actor,
    query: options.query ?? {},
    rawBody: options.body === undefined ? undefined : JSON.stringify(options.body),
    request: new Request(`http://localhost/api${path}`, { method })
  });
  return result;
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();

  const workspace = await createWorkspace(handle.db, 'API Co');
  workspaceId = workspace.id;

  const ownerId = uuidv7();
  const viewerId = uuidv7();
  const strangerId = uuidv7();
  const now = Date.now();
  for (const [id, name] of [
    [ownerId, 'Owner'],
    [viewerId, 'Viewer'],
    [strangerId, 'Stranger']
  ] as const) {
    handle.db
      .insert(users)
      .values({ id, email: `${id}@example.test`, name, createdAt: now, updatedAt: now })
      .run();
  }
  await addMember(handle.db, workspaceId, ownerId, 'owner');
  await addMember(handle.db, workspaceId, viewerId, 'member');

  owner = createActorContext({
    workspaceId,
    actorType: 'user',
    actorId: ownerId,
    actorLabel: 'Owner',
    role: 'owner',
    permissions: permissionsForRole('owner')
  });
  viewer = createActorContext({
    workspaceId,
    actorType: 'user',
    actorId: viewerId,
    actorLabel: 'Viewer',
    role: 'member',
    permissions: permissionsForRole('member')
  });
  const otherWorkspace = await createWorkspace(handle.db, 'Other Co');
  outsider = createActorContext({
    workspaceId: otherWorkspace.id,
    actorType: 'user',
    actorId: strangerId,
    actorLabel: 'Stranger',
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

describe('route matching', () => {
  test('captures path parameters and refuses wrong shapes', () => {
    expect(matchPath('/tickets/:id', '/tickets/abc')).toEqual({ id: 'abc' });
    expect(matchPath('/tickets/:id', '/tickets/abc/notes')).toBeNull();
    expect(matchPath('/tickets', '/tickets')).toEqual({});
  });

  test('resolves a route by method', () => {
    expect(matchRoute('GET', '/workflows')?.route.method).toBe('GET');
    expect(matchRoute('DELETE', '/workflows')).toBeNull();
  });

  test('every route declares a method, path and handler', () => {
    for (const entry of apiRoutes) {
      expect(entry.method, entry.path).toMatch(/^[A-Z]+$/);
      expect(entry.path.startsWith('/'), entry.path).toBe(true);
      expect(typeof entry.handler).toBe('function');
    }
  });

  test('only the webhook routes are public', () => {
    const publicPaths = apiRoutes.filter((entry) => entry.public).map((entry) => entry.path);
    // Only sign-in/registration, health and the token-authenticated webhooks are
    // reachable without a session.
    const allowed = [
      '/health',
      '/auth/login',
      '/auth/register',
      ...publicWebhookRoutes.map((entry) => entry.path)
    ];
    for (const path of publicPaths) {
      expect(allowed, `unexpected public route: ${path}`).toContain(path);
    }
    expect(publicPaths).toContain('/health');
    expect(publicPaths).toContain('/webhooks/:token');
  });
});

describe('authentication and permissions', () => {
  test('rejects an unauthenticated request to a protected route', async () => {
    const result = await call('GET', '/workflows', { actor: null });
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  test('serves the public health route without a session', async () => {
    const result = await call('GET', '/health', { actor: null });
    expect(result.status).toBe(200);
    expect((result.body as { ok: boolean }).ok).toBe(true);
  });

  test('denies a member the workflow-write permission with a stable code', async () => {
    const result = await call('POST', '/workflows', {
      actor: viewer,
      body: { name: 'Not allowed' }
    });
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe('forbidden');
  });

  test('allows a member to read workflows', async () => {
    const result = await call('GET', '/workflows', { actor: viewer });
    expect(result.status).toBe(200);
  });

  test('returns 405 with an Allow header for a wrong method', async () => {
    const result = await call('DELETE', '/workflows');
    expect(result.status).toBe(405);
    expect(result.headers.Allow).toContain('GET');
  });

  test('returns 404 for an unknown path', async () => {
    const result = await call('GET', '/nothing/here');
    expect(result.status).toBe(404);
  });
});

describe('validation', () => {
  test('rejects a malformed body with field-level detail', async () => {
    const result = await call('POST', '/workflows', { body: { name: '' } });
    expect(result.status).toBe(422);
    const error = (result.body as { error: { code: string; details: { issues: unknown[] } } })
      .error;
    expect(error.code).toBe('validation_failed');
    expect(error.details.issues.length).toBeGreaterThan(0);
  });

  test('rejects invalid JSON', async () => {
    const result = await dispatchApi({
      db: handle.db,
      method: 'POST',
      pathname: '/workflows',
      actor: owner,
      query: {},
      rawBody: '{ not json',
      request: new Request('http://localhost/api/workflows', { method: 'POST' })
    });
    expect(result.status).toBe(400);
  });
});

describe('workflow and ticket lifecycle through the API', () => {
  async function createWorkflowViaApi(): Promise<string> {
    const result = await call('POST', '/workflows', {
      body: { name: 'Claims', template: 'claims' }
    });
    expect(result.status).toBe(201);
    return (result.body as { workflow: { id: string } }).workflow.id;
  }

  test('creates a workflow from a template with states and transitions', async () => {
    const workflowId = await createWorkflowViaApi();
    const detail = await call('GET', `/workflows/${workflowId}`);
    expect(detail.status).toBe(200);
    const body = detail.body as {
      states: unknown[];
      transitions: unknown[];
      workflow: { key: string };
    };
    expect(body.states).toHaveLength(5);
    expect(body.transitions.length).toBeGreaterThan(3);
    expect(body.workflow.key.length).toBeGreaterThanOrEqual(2);
  });

  test('creates a ticket, moves it and reads it back with its history', async () => {
    const workflowId = await createWorkflowViaApi();

    const created = await call('POST', '/tickets', {
      body: { workflowId, title: 'Customer question' }
    });
    expect(created.status).toBe(201);
    const ticketId = (created.body as { ticket: { id: string; key: string } }).ticket.id;
    expect((created.body as { ticket: { key: string } }).ticket.key).toMatch(/^[A-Z]+-\d+$/);

    const detail = await call('GET', `/tickets/${ticketId}`);
    expect(detail.status).toBe(200);
    const transitions = (
      detail.body as {
        availableTransitions: Array<{ id: string; toStateName: string; allowed: boolean }>;
      }
    ).availableTransitions;
    expect(transitions.length).toBeGreaterThan(0);

    const target = transitions.find((transition) => transition.allowed);
    expect(target).toBeDefined();

    const moved = await call('POST', `/tickets/${ticketId}/transitions`, {
      body: { transitionId: target?.id, comment: 'Starting work' }
    });
    expect(moved.status).toBe(200);

    const timeline = await call('GET', `/tickets/${ticketId}/timeline`);
    const events = (timeline.body as { events: Array<{ action: string }> }).events;
    const actions = events.map((event) => event.action);
    expect(actions).toContain('ticket.created');
    expect(actions).toContain('ticket.state.entered');

    const board = await call('GET', `/workflows/${workflowId}/board`);
    expect(board.status).toBe(200);
    const columns = (board.body as { columns: Array<{ tickets: unknown[] }> }).columns;
    expect(columns.some((column) => column.tickets.length > 0)).toBe(true);
  });

  test('sets typed field values and validates them', async () => {
    const workflowId = await createWorkflowViaApi();
    const field = await call('POST', '/fields', {
      body: { key: 'claim_amount', name: 'Claim Amount', type: 'currency' }
    });
    expect(field.status).toBe(201);
    const fieldId = (field.body as { field: { id: string } }).field.id;

    const configured = await call('PUT', `/workflows/${workflowId}/fields`, {
      body: { fields: [{ fieldDefinitionId: fieldId, required: true }] }
    });
    expect(configured.status).toBe(200);

    const ticket = await call('POST', '/tickets', {
      body: { workflowId, title: 'Amounts', fields: { claim_amount: 1200 } }
    });
    const ticketId = (ticket.body as { ticket: { id: string } }).ticket.id;

    const read = await call('GET', `/tickets/${ticketId}/fields`);
    expect((read.body as { fields: Record<string, unknown> }).fields.claim_amount).toBe(1200);

    const invalid = await call('PUT', `/tickets/${ticketId}/fields`, {
      body: { values: { claim_amount: 'not money' } }
    });
    expect(invalid.status).toBe(422);
  });

  test('refuses to delete a state that still holds tickets', async () => {
    const workflowId = await createWorkflowViaApi();
    await call('POST', '/tickets', { body: { workflowId, title: 'Occupies a state' } });
    const detail = await call('GET', `/workflows/${workflowId}`);
    const states = (detail.body as { states: Array<{ id: string }> }).states;
    const populated = states[0] as { id: string };
    // The start state holds the ticket, so removal must be refused.
    const occupants = (detail.body as { states: Array<{ id: string }> }).states.length;
    expect(occupants).toBeGreaterThan(0);
    const workflowStatesRows = handle.db
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId))
      .all();
    const start = workflowStatesRows.find((state) => state.isStart);
    const result = await call('DELETE', `/states/${start?.id ?? populated.id}`);
    expect(result.status).toBe(412);
  });
});

describe('human gates and cross-workflow transfer through the API', () => {
  test('an agent cannot move a ticket out of a human-gated state', async () => {
    const created = (
      await call('POST', '/workflows', { body: { name: 'Review', template: 'claims' } })
    ).body as { workflow: { id: string } };
    const id = created.workflow.id;
    const detail = await call('GET', `/workflows/${id}`);
    const states = (detail.body as { states: Array<{ id: string; name: string }> }).states;
    const review = states.find((state) => state.name === 'Human review');
    expect(review).toBeDefined();

    const ticket = await call('POST', '/tickets', {
      body: { workflowId: id, stateId: review?.id, title: 'Needs review' }
    });
    const ticketId = (ticket.body as { ticket: { id: string } }).ticket.id;

    const agent: ActorContext = {
      ...owner,
      actorType: 'agent',
      role: 'agent',
      actorId: uuidv7(),
      actorLabel: 'Triage agent'
    };
    const attempt = await call('POST', `/tickets/${ticketId}/transitions`, {
      actor: agent,
      body: { targetStateId: states.find((state) => state.name === 'Approved')?.id }
    });
    expect(attempt.status).toBe(409);
    expect((attempt.body as { error: { code: string } }).error.code).toBe('human_gate_required');
  });

  test('a human decides the gate and the decision is recorded', async () => {
    const created = (
      await call('POST', '/workflows', { body: { name: 'Gated', template: 'claims' } })
    ).body as { workflow: { id: string } };
    const workflowId = created.workflow.id;
    const detail = await call('GET', `/workflows/${workflowId}`);
    const states = (detail.body as { states: Array<{ id: string; name: string }> }).states;
    const reviewState = states.find((state) => state.name === 'Human review');
    const approvedState = states.find((state) => state.name === 'Approved');
    const investigative = states.find((state) => state.name === 'Investigation');

    const ticket = await call('POST', '/tickets', {
      body: { workflowId, stateId: investigative?.id, title: 'Claim' }
    });
    const ticketId = (ticket.body as { ticket: { id: string } }).ticket.id;

    // Move into the gate.
    const intoGate = await call('GET', `/tickets/${ticketId}`);
    const available = (
      intoGate.body as { availableTransitions: Array<{ id: string; toStateId: string }> }
    ).availableTransitions;
    const toReview = available.find((transition) => transition.toStateId === reviewState?.id);
    expect(toReview).toBeDefined();
    await call('POST', `/tickets/${ticketId}/transitions`, {
      body: { transitionId: toReview?.id }
    });

    // A decision needs a comment (the template requires one).
    const noComment = await call('POST', `/tickets/${ticketId}/transitions`, {
      body: { targetStateId: approvedState?.id }
    });
    expect(noComment.status).toBe(422);

    const decided = await call('POST', `/tickets/${ticketId}/transitions`, {
      body: { targetStateId: approvedState?.id, comment: 'Reviewed and approved' }
    });
    expect(decided.status).toBe(200);

    const after = await call('GET', `/tickets/${ticketId}`);
    expect((after.body as { gateDecisions: unknown[] }).gateDecisions).toHaveLength(1);
  });

  test('transfers a ticket to another workflow preserving identity', async () => {
    const intake = (
      await call('POST', '/workflows', { body: { name: 'Intake', template: 'intake' } })
    ).body as { workflow: { id: string } };
    const claims = (
      await call('POST', '/workflows', { body: { name: 'Claims', template: 'claims' } })
    ).body as { workflow: { id: string } };

    const ticket = await call('POST', '/tickets', {
      body: { workflowId: intake.workflow.id, title: 'Inbound claim' }
    });
    const ticketId = (ticket.body as { ticket: { id: string; key: string } }).ticket.id;
    const originalKey = (ticket.body as { ticket: { key: string } }).ticket.key;

    const preview = await call('POST', `/tickets/${ticketId}/transfer-preview`, {
      body: { targetWorkflowId: claims.workflow.id }
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { policy: { allowed: boolean } }).policy.allowed).toBe(true);

    const transferred = await call('POST', `/tickets/${ticketId}/transfer`, {
      body: { targetWorkflowId: claims.workflow.id, reason: 'Classified as a claim' }
    });
    expect(transferred.status).toBe(200);

    const after = await call('GET', `/tickets/${ticketId}`);
    expect((after.body as { ticket: { key: string; workflowId: string } }).ticket.key).toBe(
      originalKey
    );
    expect((after.body as { ticket: { workflowId: string } }).ticket.workflowId).toBe(
      claims.workflow.id
    );
  });
});

describe('tenant isolation', () => {
  test('another workspace cannot read a workflow by id', async () => {
    const created = (await call('POST', '/workflows', { body: { name: 'Private' } })).body as {
      workflow: { id: string };
    };
    const workflowId = created.workflow.id;

    const result = await call('GET', `/workflows/${workflowId}`, { actor: outsider });
    expect(result.status).toBe(404);
  });

  test('another workspace cannot read a ticket by id', async () => {
    const workflowId = (await call('POST', '/workflows', { body: { name: 'Private tickets' } }))
      .body as { workflow: { id: string } };
    const ticket = await call('POST', '/tickets', {
      body: { workflowId: workflowId.workflow.id, title: 'Secret' }
    });
    const ticketId = (ticket.body as { ticket: { id: string } }).ticket.id;

    const result = await call('GET', `/tickets/${ticketId}`, { actor: outsider });
    expect(result.status).toBe(404);
  });

  test('listing tickets only ever returns the caller’s workspace', async () => {
    const createdMine = (await call('POST', '/workflows', { body: { name: 'Mine' } })).body as {
      workflow: { id: string };
    };
    await call('POST', '/tickets', {
      body: { workflowId: createdMine.workflow.id, title: 'Mine' }
    });

    const mine = await call('GET', '/tickets');
    expect((mine.body as { rows: unknown[] }).rows.length).toBe(1);
    const theirs = await call('GET', '/tickets', { actor: outsider });
    expect((theirs.body as { rows: unknown[] }).rows.length).toBe(0);
  });
});

describe('secrets through the API', () => {
  test('never returns plaintext and reports only a hint', async () => {
    const created = await call('POST', '/secrets', {
      body: { key: 'HUBSPOT_TOKEN', value: 'sk-live-abcdef123456', name: 'HubSpot token' }
    });
    expect(created.status).toBe(201);
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain('sk-live-abcdef123456');
    expect(serialized).toContain('3456');

    const listed = await call('GET', '/secrets');
    expect(JSON.stringify(listed.body)).not.toContain('sk-live-abcdef123456');
  });

  test('a member cannot write secrets', async () => {
    const result = await call('POST', '/secrets', {
      actor: viewer,
      body: { key: 'NOPE', value: 'another-secret-value' }
    });
    expect(result.status).toBe(403);
  });
});

describe('webhooks', () => {
  test('an unknown token is a 404 and never a 500', async () => {
    const result = await call('POST', '/webhooks/does-not-exist', { actor: null });
    expect(result.status).toBe(404);
  });

  test('a probe reveals only the trigger name', async () => {
    const createdIntake = (await call('POST', '/workflows', { body: { name: 'Intake' } })).body as {
      workflow: { id: string };
    };
    const trigger = await call('POST', '/triggers', {
      body: {
        workflowId: createdIntake.workflow.id,
        name: 'Inbound',
        type: 'webhook',
        config: { mapping: { titleTemplate: 'Inbound {{message.subject}}' } }
      }
    });
    expect(trigger.status).toBe(201);
    const token = (trigger.body as { trigger: { webhookToken: string } }).trigger.webhookToken;

    const probe = await call('GET', `/webhooks/${token}`, { actor: null });
    expect(probe.status).toBe(200);
    expect(JSON.stringify(probe.body)).not.toContain('secret');
  });
});

describe('operational endpoints', () => {
  test('reports job, approval and configuration views', async () => {
    const jobs = await call('GET', '/jobs');
    expect(jobs.status).toBe(200);
    const approvals = await call('GET', '/approvals');
    expect(approvals.status).toBe(200);
    const work = await call('GET', '/my-work');
    expect(work.status).toBe(200);
    const state = await call('GET', '/state', { query: { scope: 'workspace' } });
    expect(state.status).toBe(200);
    const cache = await call('GET', '/cache');
    expect(cache.status).toBe(200);
  });

  test('the system actor cannot be impersonated through a request', async () => {
    // A route that requires a permission the viewer lacks must refuse even though a
    // system actor exists in the process.
    const result = await call('POST', '/providers', {
      actor: viewer,
      body: { name: 'Sneaky', type: 'ollama' }
    });
    expect(result.status).toBe(403);
    void systemActor;
  });
});
