/**
 * Create-response shape.
 *
 * A client that appends a created resource to a list — which is what every one of
 * these surfaces does — depends on the create response having the same shape as a
 * listed row. When it does not, the page crashes on the first render after a
 * successful write: creating a team returned the bare row without `memberIds`, and
 * the teams page threw `Cannot read properties of undefined (reading 'length')`.
 *
 * These tests create a resource, list its siblings, and assert the created object has
 * every key the listed ones have.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { dispatchApi } from '../../../src/lib/server/api/router';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import { users } from '../../../src/lib/server/db/schema';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let actor: ActorContext;

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  // The router matches on the pathname alone, so a query string is split out here the
  // way the SvelteKit adapter does it.
  const url = new URL(path, 'http://127.0.0.1');
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const result = await dispatchApi({
    db: handle.db,
    method,
    pathname: url.pathname,
    actor,
    query,
    rawBody,
    request: new Request(`http://127.0.0.1/api${path}`, {
      method,
      ...(rawBody === undefined
        ? {}
        : { body: rawBody, headers: { 'content-type': 'application/json' } })
    })
  });
  return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();

  const workspace = await createWorkspace(handle.db, 'Shape Co');
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@shape.test`,
      name: 'Shape Owner',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, userId, 'owner');
  actor = createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: userId,
    actorLabel: 'Shape Owner',
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

/** Assert the created row is shaped like its listed siblings. */
async function assertMatchesList<T extends Record<string, unknown>>(
  created: T,
  listed: Array<Record<string, unknown>>,
  label: string
): Promise<void> {
  expect(listed.length, `${label}: need a listed row to compare against`).toBeGreaterThan(0);
  const reference = listed[0] as Record<string, unknown>;
  const missing = Object.keys(reference).filter((key) => !(key in created));
  expect(missing, `${label}: created row is missing ${missing.join(', ')}`).toEqual([]);
}

describe('create responses match list rows', () => {
  test('teams', async () => {
    // Seed one so the list has a reference row with the same shape.
    await call('POST', '/teams', { name: 'First team', memberIds: [actor.actorId] });

    const created = await call('POST', '/teams', { name: 'Second team' });
    expect(created.status).toBe(201);
    const team = (created.body as { team: Record<string, unknown> }).team;

    const listed = await call('GET', '/teams');
    const teams = (listed.body as { teams: Array<Record<string, unknown>> }).teams;

    await assertMatchesList(team, teams, 'team');
    expect(Array.isArray(team.memberIds), 'memberIds must be an array').toBe(true);
    expect(team.memberIds).toEqual([]);
  });

  test('a team created with members reports them immediately', async () => {
    const created = await call('POST', '/teams', {
      name: 'Members team',
      memberIds: [actor.actorId]
    });
    const team = (created.body as { team: Record<string, unknown> }).team;
    expect(team.memberIds).toEqual([actor.actorId]);
  });

  test('updating team membership returns the updated row', async () => {
    const created = await call('POST', '/teams', { name: 'Editable team' });
    const teamId = (created.body as { team: { id: string } }).team.id;

    const updated = await call('PUT', `/teams/${teamId}/members`, { userIds: [actor.actorId] });
    expect(updated.status).toBe(200);
    const team = (updated.body as { team: Record<string, unknown> }).team;
    expect(team.memberIds).toEqual([actor.actorId]);

    const listed = await call('GET', '/teams');
    const rows = (listed.body as { teams: Array<Record<string, unknown>> }).teams;
    await assertMatchesList(team, rows, 'updated team');
  });

  test('agents', async () => {
    await call('POST', '/agents', { name: 'First agent' });
    const created = await call('POST', '/agents', { name: 'Second agent' });
    expect(created.status).toBe(201);

    const listed = await call('GET', '/agents');
    await assertMatchesList(
      (created.body as { agent: Record<string, unknown> }).agent,
      (listed.body as { agents: Array<Record<string, unknown>> }).agents,
      'agent'
    );
  });

  test('http operations', async () => {
    const service = await call('POST', '/http/services', {
      name: 'Shape service',
      baseUrl: 'http://127.0.0.1:9'
    });
    const serviceId = (service.body as { service: { id: string } }).service.id;

    await call('POST', '/http/operations', {
      serviceId,
      key: 'shape.first',
      name: 'First',
      path: '/'
    });
    const created = await call('POST', '/http/operations', {
      serviceId,
      key: 'shape.second',
      name: 'Second',
      path: '/'
    });
    expect(created.status).toBe(201);

    const listed = await call('GET', `/http/operations?serviceId=${serviceId}`);
    await assertMatchesList(
      (created.body as { operation: Record<string, unknown> }).operation,
      (listed.body as { operations: Array<Record<string, unknown>> }).operations,
      'operation'
    );
  });

  test('dashboards and their widgets', async () => {
    const dashboard = await call('POST', '/dashboards', { name: 'Shape board' });
    const dashboardId = (dashboard.body as { dashboard: { id: string } }).dashboard.id;

    const widget = await call('POST', `/dashboards/${dashboardId}/widgets`, {
      title: 'Count',
      type: 'kpi',
      dataSource: { kind: 'workflow_items' },
      measure: { aggregation: 'count' }
    });
    expect(widget.status).toBe(201);

    // The detail endpoint returns the dashboard flat, with its widgets alongside.
    const fetched = await call('GET', `/dashboards/${dashboardId}`);
    const widgets = (fetched.body as { widgets: Array<Record<string, unknown>> }).widgets;
    expect(widgets).toHaveLength(1);
    await assertMatchesList(
      (widget.body as { widget: Record<string, unknown> }).widget,
      widgets,
      'widget'
    );
  });

  test('saved views', async () => {
    const filter = {
      type: 'condition',
      kind: 'system',
      key: 'priority',
      operator: 'eq',
      value: 'high'
    };
    await call('POST', '/views', { name: 'First view', filter });
    const created = await call('POST', '/views', { name: 'Second view', filter });
    expect(created.status).toBe(201);

    // The response's own field name (`filterAst`) round-trips as an input alias.
    const view = (created.body as { view: Record<string, unknown> }).view;
    expect(view.filterAst).toEqual(filter);

    const roundTripped = await call('POST', '/views', {
      name: 'Third view',
      filterAst: view.filterAst
    });
    expect(roundTripped.status).toBe(201);

    const listed = await call('GET', '/views?scope=tickets');
    await assertMatchesList(
      view,
      (listed.body as { views: Array<Record<string, unknown>> }).views,
      'view'
    );
  });
});
