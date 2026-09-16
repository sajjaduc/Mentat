/**
 * UI payload contract.
 *
 * The browser builds request bodies in `$ui/**` and the server validates them with Zod.
 * Neither side's tests would catch a mismatch between them, and the user-visible
 * symptom is a 422 on a form that looks complete — which is exactly how the HTTP
 * operation editor shipped with `headers: null` against a schema that wanted a record.
 *
 * These tests take the *client's* own payload builders, fill them the way the forms do
 * for a minimal valid entry, and post them through the real dispatcher. A field the
 * client sends but the server rejects fails here rather than in a browser.
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
import type { ServiceDraft } from '../../../src/lib/ui/http/draft';
import {
  draftFromOperation,
  emptyOperation,
  operationPayload,
  validateOperationDraft,
  validateServiceDraft
} from '../../../src/lib/ui/http/draft';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let actor: ActorContext;

/** A service draft as the create form starts it: only the required fields filled. */
function minimalServiceDraft(): ServiceDraft {
  return {
    name: 'Contract service',
    description: '',
    baseUrl: 'http://127.0.0.1:9',
    allowedHosts: [],
    timeoutMs: 10_000,
    rateLimit: null,
    retryPolicy: null,
    cachePolicy: null,
    defaultApprovalPolicy: null,
    authType: 'none',
    authConfig: {},
    defaultHeaders: {}
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const result = await dispatchApi({
    db: handle.db,
    method,
    pathname: path,
    actor,
    query: {},
    rawBody,
    request: new Request(`http://127.0.0.1/api${path}`, {
      method,
      ...(rawBody === undefined
        ? {}
        : { body: rawBody, headers: { 'content-type': 'application/json' } })
    })
  });
  return { status: result.status, body: result.body };
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();

  const workspace = await createWorkspace(handle.db, 'Contract Co');
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@contract.test`,
      name: 'Contract Owner',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, userId, 'owner');
  actor = createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: userId,
    actorLabel: 'Contract Owner',
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

describe('http service and operation payloads', () => {
  test('a minimal service draft passes both client and server validation', async () => {
    const draft = minimalServiceDraft();
    expect(validateServiceDraft(draft)).toEqual([]);

    const response = await call('POST', '/http/services', {
      ...draft,
      description: draft.description.length > 0 ? draft.description : undefined
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  test('a minimal operation draft is accepted', async () => {
    const service = await call('POST', '/http/services', {
      name: 'Operations service',
      baseUrl: 'http://127.0.0.1:9'
    });
    const serviceId = (service.body as { service: { id: string } }).service.id;

    const draft = emptyOperation(serviceId);
    draft.path = '/customers';
    draft.key = 'contract.customers.list';
    draft.name = 'List customers';

    // The client-side validator and the server must agree that this is complete.
    expect(validateOperationDraft(draft)).toEqual([]);

    const response = await call('POST', '/http/operations', operationPayload(draft));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  test('an untouched operation draft is accepted, so the default form can save', async () => {
    const service = await call('POST', '/http/services', {
      name: 'Defaults service',
      baseUrl: 'http://127.0.0.1:9'
    });
    const serviceId = (service.body as { service: { id: string } }).service.id;

    // Only the fields the user must type; everything else is at its default.
    const draft = emptyOperation(serviceId);
    draft.path = '/';
    draft.key = 'contract.defaults';
    draft.name = 'Defaults';

    const response = await call('POST', '/http/operations', operationPayload(draft));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  test('every optional collection is either omitted or shaped as the schema expects', async () => {
    const service = await call('POST', '/http/services', {
      name: 'Shapes service',
      baseUrl: 'http://127.0.0.1:9'
    });
    const serviceId = (service.body as { service: { id: string } }).service.id;

    const draft = emptyOperation(serviceId);
    draft.path = '/';
    draft.key = 'contract.shapes';
    draft.name = 'Shapes';

    const payload = operationPayload(draft);
    // `null` is a value the schema may or may not accept; `undefined` disappears from
    // the JSON entirely. Optional collections should use the latter.
    for (const [key, value] of Object.entries(payload)) {
      if (value === null) {
        // Explicitly nullable fields are fine; collections are not.
        expect(
          [
            'body',
            'successRules',
            'responseMapping',
            'retryPolicy',
            'cachePolicy',
            'approvalPolicy',
            'rateLimitOverride',
            'timeoutMs',
            // `z.unknown()` accepts null, and an operation with no schema is normal.
            'inputSchema',
            'outputSchema'
          ],
          `${key} was sent as null`
        ).toContain(key);
      }
    }

    const response = await call('POST', '/http/operations', payload);
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const created = response.body as { operation: { id: string } };
    const fetched = await call('GET', `/http/operations/${created.operation.id}`);
    expect(fetched.status).toBe(200);

    // Round-trip through the editor's own loader: what came back must be editable and
    // savable, which is what a user does after opening an operation.
    const operation = (fetched.body as { operation: never }).operation;
    const reloaded = draftFromOperation(operation);
    expect(validateOperationDraft(reloaded)).toEqual([]);

    const saved = await call(
      'PATCH',
      `/http/operations/${created.operation.id}`,
      operationPayload(reloaded)
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });
});
