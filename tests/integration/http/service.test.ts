import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AuditActions } from '../../../src/lib/server/audit/ledger';
import { createActorContext, permissionsForRole } from '../../../src/lib/server/core/context';
import { auditEvents, tools } from '../../../src/lib/server/db/schema';
import {
  archiveHttpOperation,
  archiveHttpService,
  createHttpOperation,
  createHttpService,
  getHttpOperation,
  getHttpOperationByKey,
  getHttpService,
  listHttpOperations,
  listHttpServices,
  updateHttpOperation,
  updateHttpService
} from '../../../src/lib/server/http/service';
import { createSecret } from '../../../src/lib/server/secrets/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, memberActor, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceA: string;
let workspaceB: string;
let actorA: ReturnType<typeof ownerActor>;
let actorB: ReturnType<typeof ownerActor>;
let member: ReturnType<typeof memberActor>;

beforeEach(async () => {
  handle = createTestDatabase();
  const a = await createWorkspace(handle.db, 'A');
  const b = await createWorkspace(handle.db, 'B');
  workspaceA = a.id;
  workspaceB = b.id;
  const userA = await createUser(handle.db);
  const userB = await createUser(handle.db);
  actorA = ownerActor(workspaceA, userA.id);
  actorB = ownerActor(workspaceB, userB.id);
  member = memberActor(workspaceA, userA.id);
});

afterEach(() => {
  handle.cleanup();
});

async function auditActions(): Promise<string[]> {
  const rows = await handle.db.select({ action: auditEvents.action }).from(auditEvents).all();
  return rows.map((row) => row.action);
}

describe('http service CRUD', () => {
  test('creates, updates and archives a service with audit rows', async () => {
    const service = await createHttpService(handle.db, actorA, {
      name: 'HubSpot',
      baseUrl: 'https://api.hubapi.com',
      timeoutMs: 5000,
      defaultHeaders: { 'X-Tenant': 'acme' }
    });
    expect(service.name).toBe('HubSpot');
    expect(service.authType).toBe('none');

    const updated = await updateHttpService(handle.db, actorA, service.id, {
      description: 'CRM',
      timeoutMs: 9000
    });
    expect(updated.timeoutMs).toBe(9000);
    expect(updated.description).toBe('CRM');

    const archived = await archiveHttpService(handle.db, actorA, service.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(listHttpServices(handle.db, actorA)).toHaveLength(0);
    expect(listHttpServices(handle.db, actorA, { includeArchived: true })).toHaveLength(1);

    const actions = await auditActions();
    expect(actions).toContain(AuditActions.serviceCreated);
    expect(actions).toContain(AuditActions.serviceUpdated);
  });

  test('rejects a duplicate service name in the same scope', async () => {
    await createHttpService(handle.db, actorA, { name: 'Dup', baseUrl: 'https://a.example.com' });
    await expect(
      createHttpService(handle.db, actorA, { name: 'Dup', baseUrl: 'https://b.example.com' })
    ).rejects.toThrow(/already exists/i);
  });

  test('validates a bearer service secret reference in this workspace', async () => {
    await expect(
      createHttpService(handle.db, actorA, {
        name: 'NoSecret',
        baseUrl: 'https://a.example.com',
        authType: 'bearer'
      })
    ).rejects.toThrow(/secret reference/i);

    const secretB = createSecret(handle.db, actorB, { key: 'B_TOKEN', value: 'other-tenant' });
    await expect(
      createHttpService(handle.db, actorA, {
        name: 'CrossTenant',
        baseUrl: 'https://a.example.com',
        authType: 'bearer',
        authConfig: { secretId: secretB.id }
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe('http operation CRUD and tool sync', () => {
  async function service() {
    return createHttpService(handle.db, actorA, {
      name: 'HubSpot',
      baseUrl: 'https://api.hubapi.com'
    });
  }

  test('creating an exposed operation creates a tools row and links toolId', async () => {
    const svc = await service();
    const operation = await createHttpOperation(handle.db, actorA, {
      serviceId: svc.id,
      key: 'hubspot.get_contact',
      name: 'Get contact',
      path: '/contacts/{{id}}',
      parameters: [{ name: 'id', location: 'path', required: true, type: 'string' }]
    });

    expect(operation.toolId).not.toBeNull();
    const rows = await handle.db.select().from(tools).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('hubspot.get_contact');
    expect(rows[0]?.kind).toBe('http');
    expect(rows[0]?.enabled).toBe(true);
    expect(rows[0]?.implementation).toEqual({
      kind: 'http',
      operationId: operation.id,
      serviceId: svc.id
    });
    expect(rows[0]?.inputSchema).toMatchObject({ type: 'object', required: ['id'] });
  });

  test('disabling exposeAsTool disables the tool but keeps its id', async () => {
    const svc = await service();
    const operation = await createHttpOperation(handle.db, actorA, {
      serviceId: svc.id,
      key: 'hubspot.update_contact',
      path: '/contacts/{{id}}',
      method: 'PATCH'
    });
    const toolId = operation.toolId;
    expect(toolId).not.toBeNull();

    const disabled = await updateHttpOperation(handle.db, actorA, operation.id, {
      exposeAsTool: false
    });
    expect(disabled.toolId).toBe(toolId);
    let rows = await handle.db.select().from(tools).where(eq(tools.id, toolId!)).all();
    expect(rows[0]?.enabled).toBe(false);

    const reenabled = await updateHttpOperation(handle.db, actorA, operation.id, {
      exposeAsTool: true
    });
    expect(reenabled.toolId).toBe(toolId);
    rows = await handle.db.select().from(tools).where(eq(tools.id, toolId!)).all();
    expect(rows[0]?.enabled).toBe(true);
    expect(rows).toHaveLength(1);
  });

  test('archiving an operation disables its tool', async () => {
    const svc = await service();
    const operation = await createHttpOperation(handle.db, actorA, {
      serviceId: svc.id,
      key: 'hubspot.delete_contact',
      path: '/contacts/{{id}}',
      method: 'DELETE'
    });
    await archiveHttpOperation(handle.db, actorA, operation.id);
    const rows = await handle.db.select().from(tools).all();
    expect(rows[0]?.enabled).toBe(false);
    expect(listHttpOperations(handle.db, actorA)).toHaveLength(0);
  });

  test('an operation key must be unique per workspace', async () => {
    const svc = await service();
    await createHttpOperation(handle.db, actorA, {
      serviceId: svc.id,
      key: 'hubspot.list',
      path: '/contacts'
    });
    await expect(
      createHttpOperation(handle.db, actorA, {
        serviceId: svc.id,
        key: 'hubspot.list',
        path: '/other'
      })
    ).rejects.toThrow(/already exists/i);
  });

  test('refuses to expose an operation whose key collides with a native tool', async () => {
    const svc = await service();
    await handle.db
      .insert(tools)
      .values({
        workspaceId: workspaceA,
        key: 'ticket.fields.set',
        name: 'Set field',
        description: '',
        kind: 'native',
        implementation: { kind: 'native', key: 'ticket.fields.set' }
      })
      .run();

    await expect(
      createHttpOperation(handle.db, actorA, {
        serviceId: svc.id,
        key: 'ticket.fields.set',
        path: '/x'
      })
    ).rejects.toThrow(/native/i);
  });
});

describe('http service permissions and tenant isolation', () => {
  test('a member cannot write services or operations', async () => {
    await expect(
      createHttpService(handle.db, member, { name: 'Nope', baseUrl: 'https://a.example.com' })
    ).rejects.toThrow(/not permitted/i);
  });

  test('an actor without http:read cannot list services', async () => {
    const user = await createUser(handle.db);
    const noRead = createActorContext({
      workspaceId: workspaceA,
      actorType: 'user',
      actorId: user.id,
      role: 'member',
      permissions: [...permissionsForRole('member')].filter((key) => key !== 'http:read')
    });
    expect(() => listHttpServices(handle.db, noRead)).toThrow(/not permitted/i);
  });

  test('another workspace cannot read a service or operation', async () => {
    const svc = await createHttpService(handle.db, actorA, {
      name: 'Tenant',
      baseUrl: 'https://a.example.com'
    });
    const operation = await createHttpOperation(handle.db, actorA, {
      serviceId: svc.id,
      key: 'tenant.get',
      path: '/tenant'
    });

    expect(() => getHttpService(handle.db, actorB, svc.id)).toThrow(/not found/i);
    expect(() => getHttpOperation(handle.db, actorB, operation.id)).toThrow(/not found/i);
    expect(() => getHttpOperationByKey(handle.db, actorB, 'tenant.get')).toThrow(/not found/i);
    expect(listHttpServices(handle.db, actorB)).toHaveLength(0);
    expect(listHttpOperations(handle.db, actorB)).toHaveLength(0);
  });
});
