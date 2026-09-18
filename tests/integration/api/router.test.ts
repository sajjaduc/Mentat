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
import { users, workflowStates, workspaceMembers } from '../../../src/lib/server/db/schema';
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

/**
 * Object Types are explicit in the universal model (ADR-0021): a workflow must
 * name one, and a Record instantiates one. Tests create their own rather than
 * relying on a seeded Ticket type.
 */
async function createObjectTypeViaApi(
  name = 'Claim',
  settings?: Record<string, unknown>
): Promise<string> {
  const result = await call('POST', '/object-types', { body: { name, settings } });
  expect(result.status).toBe(201);
  return (result.body as { objectType: { id: string } }).objectType.id;
}

async function createWorkflowViaApi(options: {
  name?: string;
  template?: 'blank' | 'basic' | 'intake' | 'claims' | 'support';
  objectTypeId: string;
}): Promise<string> {
  const result = await call('POST', '/workflows', {
    body: {
      name: options.name ?? 'Claims',
      template: options.template ?? 'claims',
      objectTypeId: options.objectTypeId
    }
  });
  expect(result.status).toBe(201);
  return (result.body as { workflow: { id: string } }).workflow.id;
}

/** Start work: put a Record into a workflow and return the work item. */
async function startWorkViaApi(options: {
  workflowId: string;
  stateId?: string;
  displayName?: string;
  fields?: Record<string, unknown>;
}): Promise<{ id: string; recordId: string }> {
  const result = await call('POST', '/workflow-items', {
    body: {
      workflowId: options.workflowId,
      stateId: options.stateId,
      fields: options.fields,
      record: { displayName: options.displayName ?? 'Work' }
    }
  });
  expect(result.status).toBe(201);
  const item = (result.body as { workflowItem: { id: string; recordId: string } }).workflowItem;
  return { id: item.id, recordId: item.recordId };
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
    expect(matchPath('/workflow-items/:id', '/workflow-items/abc')).toEqual({ id: 'abc' });
    expect(matchPath('/workflow-items/:id', '/workflow-items/abc/notes')).toBeNull();
    expect(matchPath('/workflow-items', '/workflow-items')).toEqual({});
  });

  test('resolves a route by method', () => {
    expect(matchRoute('GET', '/workflows')?.route.method).toBe('GET');
    expect(matchRoute('DELETE', '/workflows')).toBeNull();
  });

  test('a literal segment beats a parameter', () => {
    // `/files/search` and `/files/:id` have the same shape; the search handler must
    // win, otherwise a static route is unreachable behind its dynamic sibling.
    expect(matchRoute('GET', '/files/search')?.route.path).toBe('/files/search');
    expect(matchRoute('GET', '/files/abc')?.route.path).toBe('/files/:id');
  });

  test('an unknown sub-path of a known resource is a 404, not a silent match', () => {
    expect(matchRoute('GET', '/files/abc/def/ghi')).toBeNull();
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

  test('gives a new account a workspace even when the instance already has one', async () => {
    // Regression guard: registration used to provision a workspace only on an empty
    // database, so on a warmed instance it returned `workspaceId: null`. The account
    // could sign in but every workspace-scoped request failed with
    // "Workspace none not found" and no way to create one from the UI.
    const result = await dispatchApi({
      db: handle.db,
      method: 'POST',
      pathname: '/auth/register',
      actor: null,
      query: {},
      rawBody: JSON.stringify({
        email: 'second-account@example.test',
        name: 'Second Account',
        password: 'second-account-password'
      }),
      request: new Request('http://localhost/api/auth/register', { method: 'POST' })
    });
    expect(result.status).toBe(201);
    const registered = result.body as { user: { id: string }; workspaceId: string | null };
    const registeredWorkspaceId = registered.workspaceId;
    if (!registeredWorkspaceId) throw new Error('registration returned no workspace');
    expect(registeredWorkspaceId).not.toBe(workspaceId);

    const memberships = handle.db
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, registered.user.id))
      .all();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.workspaceId).toBe(registeredWorkspaceId);
    expect(memberships[0]?.role).toBe('owner');
  });

  test('lets a signed-in account with no workspace create its first one', async () => {
    // The self-heal path the shell falls back to when an admin removes an account's
    // last membership: creating a workspace must not require a permission that only
    // members of an existing workspace can hold.
    const userId = uuidv7();
    const now = Date.now();
    handle.db
      .insert(users)
      .values({
        id: userId,
        email: 'workspace-less@example.test',
        name: 'Workspace Less',
        createdAt: now,
        updatedAt: now
      })
      .run();
    const workspaceLess = createActorContext({
      workspaceId: 'none',
      actorType: 'user',
      actorId: userId,
      actorLabel: 'Workspace Less',
      role: 'member',
      permissions: []
    });

    const created = await call('POST', '/workspaces', {
      actor: workspaceLess,
      body: { name: 'First Workspace' }
    });
    expect(created.status).toBe(201);
    const createdId = (created.body as { workspace: { id: string } }).workspace.id;
    const memberships = handle.db
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .all();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.workspaceId).toBe(createdId);
    expect(memberships[0]?.role).toBe('owner');
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

describe('workflow and work-item lifecycle through the API', () => {
  test('creates a workflow from a template with states and transitions', async () => {
    const objectTypeId = await createObjectTypeViaApi();
    const workflowId = await createWorkflowViaApi({ objectTypeId });
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

  test('starts work, moves it and reads it back with its history', async () => {
    const objectTypeId = await createObjectTypeViaApi('Claim', {
      numbered: true,
      keyPrefix: 'CLM'
    });
    const workflowId = await createWorkflowViaApi({ objectTypeId });
    const item = await startWorkViaApi({ workflowId, displayName: 'Customer question' });

    const detail = await call('GET', `/workflow-items/${item.id}`);
    expect(detail.status).toBe(200);
    const record = (detail.body as { record: { id: string; key: string | null } }).record;
    expect(record.key).toMatch(/^[A-Z]+-\d+$/);

    const transitions = (
      detail.body as {
        availableTransitions: Array<{ id: string; toStateName: string }>;
      }
    ).availableTransitions;
    expect(transitions.length).toBeGreaterThan(0);

    const target = transitions[0];
    expect(target).toBeDefined();

    const moved = await call('POST', `/workflow-items/${item.id}/transitions`, {
      body: { transitionId: target?.id, comment: 'Starting work' }
    });
    expect(moved.status).toBe(200);

    const timeline = await call('GET', `/workflow-items/${item.id}/timeline`);
    const events = (timeline.body as { events: Array<{ action: string }> }).events;
    const actions = events.map((event) => event.action);
    expect(actions).toContain('workflow_item.created');
    expect(actions).toContain('workflow_item.state.entered');

    const board = await call('GET', `/workflows/${workflowId}/board`);
    expect(board.status).toBe(200);
    const columns = (board.body as { columns: Array<{ items: unknown[] }> }).columns;
    expect(columns.some((column) => column.items.length > 0)).toBe(true);
  });

  test('sets typed field values and validates them', async () => {
    const objectTypeId = await createObjectTypeViaApi();
    const configured = await call('PUT', `/object-types/${objectTypeId}/fields`, {
      body: {
        fields: [
          { key: 'claim_amount', name: 'Claim Amount', type: 'currency' },
          { key: 'claim_title', name: 'Claim Title', type: 'short_text', isPrimaryDisplay: true }
        ]
      }
    });
    expect(configured.status).toBe(200);

    const workflowId = await createWorkflowViaApi({ objectTypeId });
    const item = await startWorkViaApi({
      workflowId,
      displayName: 'Amounts',
      fields: { claim_amount: 1200 }
    });

    const read = await call('GET', `/workflow-items/${item.id}/fields`);
    expect((read.body as { fields: Record<string, unknown> }).fields.claim_amount).toBe(1200);

    const invalid = await call('PUT', `/workflow-items/${item.id}/fields`, {
      body: { values: { claim_amount: 'not money' } }
    });
    expect(invalid.status).toBe(422);
  });

  test('refuses to delete a state that still holds work items', async () => {
    const objectTypeId = await createObjectTypeViaApi();
    const workflowId = await createWorkflowViaApi({ objectTypeId });
    await startWorkViaApi({ workflowId, displayName: 'Occupies a state' });
    const detail = await call('GET', `/workflows/${workflowId}`);
    const states = (detail.body as { states: Array<{ id: string }> }).states;
    const populated = states[0] as { id: string };
    // The start state holds the work item, so removal must be refused.
    expect(states.length).toBeGreaterThan(0);
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

describe('schema source routes', () => {
  test('tests a Zod source against a sample without saving anything', async () => {
    const result = await call('POST', '/schemas/test', {
      body: { source: `z.object({ code: z.string().min(3) })`, sample: { code: 'ab' } }
    });
    expect(result.status).toBe(200);
    const body = result.body as {
      ok: boolean;
      compiled: boolean;
      issues: Array<{ path: string }>;
      fields: Array<{ key: string }>;
    };
    expect(body.compiled).toBe(true);
    expect(body.ok).toBe(false);
    expect(body.issues.some((issue) => issue.path === 'code')).toBe(true);
    expect(body.fields.map((field) => field.key)).toEqual(['code']);
  });

  test('saves an Object Type schema and returns its projected fields', async () => {
    const objectTypeId = await createObjectTypeViaApi('Policy');
    const saved = await call('PUT', `/object-types/${objectTypeId}/zod-schema`, {
      body: { source: `z.object({ policy_number: z.string().min(3) })` }
    });
    expect(saved.status).toBe(200);
    const body = saved.body as { fields: Array<{ key: string; type: string }> };
    expect(body.fields[0]?.key).toBe('policy_number');

    const listed = await call('GET', `/object-types/${objectTypeId}/fields`);
    const fields = (listed.body as { fields: Array<{ key: string }> }).fields;
    expect(fields.map((field) => field.key)).toEqual(['policy_number']);
  });

  test('saves a workflow overlay schema', async () => {
    const objectTypeId = await createObjectTypeViaApi('Policy');
    const workflowId = await createWorkflowViaApi({ objectTypeId });
    const saved = await call('PUT', `/workflows/${workflowId}/zod-schema`, {
      body: { source: `z.object({ reviewer: z.string().min(3) })` }
    });
    expect(saved.status).toBe(200);
    const fields = (saved.body as { fields: Array<{ definition: { key: string } }> }).fields;
    expect(fields[0]?.definition.key).toBe('reviewer');
  });

  test('denies schema authoring to a member', async () => {
    const objectTypeId = await createObjectTypeViaApi('Policy');
    const deniedSave = await call('PUT', `/object-types/${objectTypeId}/zod-schema`, {
      actor: viewer,
      body: { source: `z.object({ a: z.string() })` }
    });
    expect(deniedSave.status).toBe(403);

    const deniedTest = await call('POST', '/schemas/test', {
      actor: viewer,
      body: { source: `z.object({ a: z.string() })`, sample: { a: 'x' } }
    });
    expect(deniedTest.status).toBe(403);
  });
});

describe('human gates and cross-workflow transfer through the API', () => {
  test('an agent cannot move work out of a human-gated state', async () => {
    const objectTypeId = await createObjectTypeViaApi('Claim');
    const id = await createWorkflowViaApi({ name: 'Review', objectTypeId });
    const detail = await call('GET', `/workflows/${id}`);
    const states = (detail.body as { states: Array<{ id: string; name: string }> }).states;
    const review = states.find((state) => state.name === 'Human review');
    expect(review).toBeDefined();

    const item = await startWorkViaApi({
      workflowId: id,
      stateId: review?.id,
      displayName: 'Needs review'
    });

    const agent: ActorContext = {
      ...owner,
      actorType: 'agent',
      role: 'agent',
      actorId: uuidv7(),
      actorLabel: 'Triage agent'
    };
    const attempt = await call('POST', `/workflow-items/${item.id}/transitions`, {
      actor: agent,
      body: { targetStateId: states.find((state) => state.name === 'Approved')?.id }
    });
    // A human gate admits only a human decision; an agent is refused.
    expect(attempt.status).toBe(403);
    expect((attempt.body as { error: { code: string } }).error.code).toBe('forbidden');
  });

  test('a human decides the gate and the decision is recorded', async () => {
    const objectTypeId = await createObjectTypeViaApi('Claim');
    const workflowId = await createWorkflowViaApi({ name: 'Gated', objectTypeId });
    const detail = await call('GET', `/workflows/${workflowId}`);
    const states = (detail.body as { states: Array<{ id: string; name: string }> }).states;
    const reviewState = states.find((state) => state.name === 'Human review');
    const approvedState = states.find((state) => state.name === 'Approved');
    const investigative = states.find((state) => state.name === 'Investigation');

    const item = await startWorkViaApi({
      workflowId,
      stateId: investigative?.id,
      displayName: 'Claim'
    });

    // Move into the gate.
    const intoGate = await call('GET', `/workflow-items/${item.id}`);
    const available = (
      intoGate.body as { availableTransitions: Array<{ id: string; toStateId: string }> }
    ).availableTransitions;
    const toReview = available.find((transition) => transition.toStateId === reviewState?.id);
    expect(toReview).toBeDefined();
    await call('POST', `/workflow-items/${item.id}/transitions`, {
      body: { transitionId: toReview?.id }
    });

    // A decision needs a comment (the template requires one).
    const noComment = await call('POST', `/workflow-items/${item.id}/transitions`, {
      body: { targetStateId: approvedState?.id }
    });
    expect(noComment.status).toBe(422);

    const decided = await call('POST', `/workflow-items/${item.id}/transitions`, {
      body: { targetStateId: approvedState?.id, comment: 'Reviewed and approved' }
    });
    expect(decided.status).toBe(200);

    const after = await call('GET', `/workflow-items/${item.id}`);
    expect((after.body as { state: { id: string } }).state.id).toBe(approvedState!.id);

    // The gate decision and its comment are recorded on the state interval.
    const history = (
      after.body as { stateHistory: Array<{ stateName: string; reason: string | null }> }
    ).stateHistory;
    const approvedInterval = history.find((entry) => entry.stateName === 'Approved');
    expect(approvedInterval?.reason).toBe('Reviewed and approved');
  });

  test('transfers work to another workflow preserving Record identity', async () => {
    const objectTypeId = await createObjectTypeViaApi('Claim', {
      numbered: true,
      keyPrefix: 'CLM'
    });
    const intake = await createWorkflowViaApi({
      name: 'Intake',
      template: 'intake',
      objectTypeId
    });
    const claims = await createWorkflowViaApi({ name: 'Claims', objectTypeId });

    const item = await startWorkViaApi({
      workflowId: intake,
      displayName: 'Inbound claim'
    });
    const original = await call('GET', `/workflow-items/${item.id}`);
    const originalKey = (original.body as { record: { key: string } }).record.key;

    const preview = await call('POST', `/workflow-items/${item.id}/transfer-preview`, {
      body: { targetWorkflowId: claims }
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { policy: { allowed: boolean } }).policy.allowed).toBe(true);

    const transferred = await call('POST', `/workflow-items/${item.id}/transfer`, {
      body: { targetWorkflowId: claims, reason: 'Classified as a claim' }
    });
    expect(transferred.status).toBe(200);

    const destinationId = (transferred.body as { workflowItem: { id: string } }).workflowItem.id;
    const after = await call('GET', `/workflow-items/${destinationId}`);
    expect((after.body as { record: { key: string } }).record.key).toBe(originalKey);
    expect((after.body as { workflowId: string }).workflowId).toBe(claims);
  });
});

describe('tenant isolation', () => {
  test('another workspace cannot read a workflow by id', async () => {
    const objectTypeId = await createObjectTypeViaApi();
    const created = await createWorkflowViaApi({ name: 'Private', objectTypeId });

    const result = await call('GET', `/workflows/${created}`, { actor: outsider });
    expect(result.status).toBe(404);
  });

  test('another workspace cannot read a work item by id', async () => {
    const objectTypeId = await createObjectTypeViaApi();
    const workflowId = await createWorkflowViaApi({ name: 'Private work', objectTypeId });
    const item = await startWorkViaApi({ workflowId, displayName: 'Secret' });

    const result = await call('GET', `/workflow-items/${item.id}`, { actor: outsider });
    expect(result.status).toBe(404);
  });

  test('listing work items only ever returns the caller’s workspace', async () => {
    const objectTypeId = await createObjectTypeViaApi();
    const workflowId = await createWorkflowViaApi({ name: 'Mine', objectTypeId });
    await startWorkViaApi({ workflowId, displayName: 'Mine' });

    const mine = await call('GET', '/workflow-items');
    expect((mine.body as { rows: unknown[] }).rows.length).toBe(1);
    const theirs = await call('GET', '/workflow-items', { actor: outsider });
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
    const objectTypeId = await createObjectTypeViaApi();
    const createdIntake = await createWorkflowViaApi({ name: 'Intake', objectTypeId });
    const trigger = await call('POST', '/triggers', {
      body: {
        workflowId: createdIntake,
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

  test('model PATCH applies capabilities and reasoning defaults together', async () => {
    const provider = await call('POST', '/providers', {
      body: { name: 'Local', type: 'ollama', baseUrl: 'http://localhost:11434' }
    });
    expect(provider.status).toBe(201);
    const providerId = (provider.body as { provider: { id: string } }).provider.id;

    const created = await call('POST', '/models', {
      body: {
        providerId,
        modelKey: 'qwen3:8b',
        capabilities: { reasoning: true, reasoningEfforts: ['off', 'low'] }
      }
    });
    expect(created.status).toBe(201);
    const modelId = (created.body as { model: { id: string } }).model.id;

    const patched = await call('PATCH', `/models/${modelId}`, {
      body: {
        capabilities: { reasoning: true, reasoningEfforts: ['off', 'low', 'medium'] },
        inferenceDefaults: { reasoningEffort: 'medium', reasoningOptions: { think: 'medium' } }
      }
    });
    expect(patched.status).toBe(200);

    const listed = await call('GET', '/models');
    const model = (
      listed.body as {
        models: Array<{ id: string; capabilities: unknown; inferenceDefaults: unknown }>;
      }
    ).models.find((entry) => entry.id === modelId);
    expect(model?.capabilities).toEqual({
      reasoning: true,
      reasoningEfforts: ['off', 'low', 'medium']
    });
    expect(model?.inferenceDefaults).toEqual({
      reasoningEffort: 'medium',
      reasoningOptions: { think: 'medium' }
    });
  });

  test('agent execution config accepts a level and rejects an unknown one', async () => {
    const created = await call('POST', '/agents', { body: { name: 'Thinker' } });
    expect(created.status).toBe(201);
    const agentId = (created.body as { agent: { id: string } }).agent.id;

    const bad = await call('PATCH', `/agents/${agentId}`, {
      body: { executionConfig: { reasoningEffort: 'turbo' } }
    });
    expect(bad.status).toBe(422);

    const good = await call('PATCH', `/agents/${agentId}`, {
      body: {
        executionConfig: { reasoningEffort: 'high', reasoningOptions: { think: 'high' } }
      }
    });
    expect(good.status).toBe(200);
    expect(
      (good.body as { agent: { executionConfig: { reasoningEffort?: string } } }).agent
        .executionConfig.reasoningEffort
    ).toBe('high');
  });
});
