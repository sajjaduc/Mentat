import { beforeEach, describe, expect, test } from 'bun:test';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import { createCollection } from '../../../src/lib/server/collections/service';
import { createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { agentState } from '../../../src/lib/server/db/schema';
import { nativeTools } from '../../../src/lib/server/tools/native';
import type { NativeToolHandler, ToolInvocationContext } from '../../../src/lib/server/tools/types';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceA: string;
let workspaceB: string;

beforeEach(async () => {
  handle = createTestDatabase();
  workspaceA = (await createWorkspace(handle.db, 'A')).id;
  workspaceB = (await createWorkspace(handle.db, 'B')).id;
});

function tool(key: string): NativeToolHandler {
  const found = nativeTools.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Unknown native tool ${key}`);
  return found;
}

interface ContextOptions {
  workspaceId?: string;
  permissions?: Iterable<string>;
  actorId?: string;
  workflowItemId?: string;
  workflowId?: string;
  runId?: string;
}

function context(options: ContextOptions = {}): ToolInvocationContext {
  const workspaceId = options.workspaceId ?? workspaceA;
  const actor = createActorContext({
    workspaceId,
    actorType: 'agent',
    actorId: options.actorId ?? 'agent-1',
    actorLabel: 'Agent',
    role: 'agent',
    permissions: options.permissions ?? Object.values(Permissions),
    runId: options.runId ?? null
  });
  return {
    actor,
    db: handle.db,
    workflowItemId: options.workflowItemId ?? null,
    workflowId: options.workflowId ?? null,
    runId: options.runId ?? null
  };
}

async function seedCollection(key = 'customers'): Promise<string> {
  const collection = await createCollection(handle.db, ownerActor(workspaceA, 'user-1'), {
    key,
    name: key
  });
  return collection.id;
}

describe('mentat.state tools', () => {
  test('set, get, list and delete round-trip through a hand-built context', async () => {
    const ctx = context({ workflowItemId: 'wi-1' });
    const set = await tool('mentat.state.set').execute(
      { scope: 'workflowItem', key: 'cursor', value: { step: 3 } },
      ctx
    );
    expect(set.ok).toBe(true);

    const got = await tool('mentat.state.get').execute(
      { scope: 'workflowItem', key: 'cursor' },
      ctx
    );
    expect(got.ok).toBe(true);
    expect((got.output as { found: boolean }).found).toBe(true);
    expect((got.output as { entry: { value: unknown } }).entry.value).toEqual({ step: 3 });

    const listed = await tool('mentat.state.list').execute({ scope: 'workflowItem' }, ctx);
    expect((listed.output as { entries: unknown[] }).entries).toHaveLength(1);

    const deleted = await tool('mentat.state.delete').execute(
      { scope: 'workflowItem', key: 'cursor' },
      ctx
    );
    expect(deleted.ok).toBe(true);
    expect((deleted.output as { deleted: boolean }).deleted).toBe(true);

    const missing = await tool('mentat.state.get').execute(
      { scope: 'workflowItem', key: 'cursor' },
      ctx
    );
    expect((missing.output as { found: boolean }).found).toBe(false);
  });

  test('refuses workspace-scope writes without the explicit grant', async () => {
    const ctx = context({ permissions: [Permissions.dataRead, Permissions.dataWrite] });
    const result = await tool('mentat.state.set').execute(
      { scope: 'workspace', key: 'global', value: 1 },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_denied');
    expect(handle.db.select().from(agentState).all()).toHaveLength(0);
  });

  test('allows workspace-scope writes with the explicit grant', async () => {
    const ctx = context({
      permissions: [Permissions.dataRead, Permissions.dataWrite, Permissions.configWrite]
    });
    const result = await tool('mentat.state.set').execute(
      { scope: 'workspace', key: 'global', value: { enabled: true } },
      ctx
    );
    expect(result.ok).toBe(true);
  });

  test('reports a permission denial as a structured failure', async () => {
    const ctx = context({ permissions: [] });
    const result = await tool('mentat.state.get').execute({ scope: 'workspace', key: 'k' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden');
  });

  test('reports invalid input as a validation failure', async () => {
    const result = await tool('mentat.state.get').execute({ scope: 'workspace' }, context());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('validation_failed');
    expect(Array.isArray(result.error?.details?.issues)).toBe(true);
  });

  test('state writes emit no service-level audit rows by design', async () => {
    const ctx = context({ workflowItemId: 'wi-1' });
    await tool('mentat.state.set').execute({ scope: 'workflowItem', key: 'k', value: 1 }, ctx);
    const rows = await queryAudit(handle.db, { workspaceId: workspaceA });
    expect(rows).toHaveLength(0);
  });
});

describe('mentat.data tools', () => {
  test('insert, get, find, update and delete round-trip', async () => {
    const collectionId = await seedCollection();
    const ctx = context();

    const inserted = await tool('mentat.data.insert').execute(
      { collectionId, data: { name: 'Acme', amount: 10 }, externalKey: 'acme' },
      ctx
    );
    expect(inserted.ok).toBe(true);
    const record = (inserted.output as { record: { id: string; version: number } }).record;
    expect(record.version).toBe(1);

    const got = await tool('mentat.data.get').execute({ recordId: record.id }, ctx);
    expect(got.ok).toBe(true);

    const found = await tool('mentat.data.find').execute(
      { collectionId, filter: [{ field: 'amount', op: 'gte', value: 10 }] },
      ctx
    );
    expect(found.ok).toBe(true);
    expect((found.output as { records: unknown[] }).records).toHaveLength(1);

    const updated = await tool('mentat.data.update').execute(
      { recordId: record.id, data: { amount: 20 }, expectedVersion: 1 },
      ctx
    );
    expect(updated.ok).toBe(true);
    expect((updated.output as { record: { version: number } }).record.version).toBe(2);

    const deleted = await tool('mentat.data.delete').execute({ recordId: record.id }, ctx);
    expect(deleted.ok).toBe(true);
    expect((deleted.output as { deleted: boolean }).deleted).toBe(true);

    const secondDelete = await tool('mentat.data.delete').execute({ recordId: record.id }, ctx);
    expect((secondDelete.output as { deleted: boolean }).deleted).toBe(false);
  });

  test('reports a stale expectedVersion as a version conflict', async () => {
    const collectionId = await seedCollection();
    const ctx = context();
    const inserted = await tool('mentat.data.insert').execute(
      { collectionId, data: { name: 'Acme' } },
      ctx
    );
    const recordId = (inserted.output as { record: { id: string } }).record.id;
    await tool('mentat.data.update').execute({ recordId, data: { name: 'Acme 2' } }, ctx);
    const conflict = await tool('mentat.data.update').execute(
      { recordId, data: { name: 'Acme 3' }, expectedVersion: 1 },
      ctx
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe('version_conflict');
  });

  test('a read-only actor is denied mutating data tools', async () => {
    const collectionId = await seedCollection();
    const ctx = context({ permissions: [Permissions.dataRead] });
    const result = await tool('mentat.data.insert').execute(
      { collectionId, data: { name: 'Nope' } },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden');
  });

  test('invalid input is a structured validation failure', async () => {
    const result = await tool('mentat.data.insert').execute({ collectionId: 'c1' }, context());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('validation_failed');
  });

  test('a cross-tenant record read returns not_found', async () => {
    const collectionId = await seedCollection();
    const inserted = await tool('mentat.data.insert').execute(
      { collectionId, data: { name: 'Secret' } },
      context()
    );
    const recordId = (inserted.output as { record: { id: string } }).record.id;
    const other = context({ workspaceId: workspaceB });
    const result = await tool('mentat.data.get').execute({ recordId }, other);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_found');
  });

  test('data mutations audit collection.record.changed with the acting run', async () => {
    const collectionId = await seedCollection();
    const ctx = context({ runId: 'run-9' });
    await tool('mentat.data.insert').execute({ collectionId, data: { name: 'Acme' } }, ctx);
    const rows = await queryAudit(handle.db, {
      workspaceId: workspaceA,
      runId: 'run-9',
      actions: ['collection.record.changed']
    });
    expect(rows).toHaveLength(1);
  });
});

describe('mentat.cache tools', () => {
  test('set, get, getOrCompute and delete round-trip', async () => {
    const ctx = context();
    const set = await tool('mentat.cache.set').execute(
      { key: 'k', value: { hello: 'world' }, ttlSeconds: 60 },
      ctx
    );
    expect(set.ok).toBe(true);

    const got = await tool('mentat.cache.get').execute({ key: 'k' }, ctx);
    expect(got.ok).toBe(true);
    expect((got.output as { hit: boolean; value: unknown }).hit).toBe(true);
    expect((got.output as { value: unknown }).value).toEqual({ hello: 'world' });

    const computed = await tool('mentat.cache.getOrCompute').execute(
      { key: 'lazy', value: 'computed' },
      ctx
    );
    expect(computed.ok).toBe(true);
    expect((computed.output as { computed: boolean }).computed).toBe(true);
    const cached = await tool('mentat.cache.getOrCompute').execute(
      { key: 'lazy', value: 'other' },
      ctx
    );
    expect((cached.output as { hit: boolean; value: unknown }).hit).toBe(true);
    expect((cached.output as { value: unknown }).value).toBe('computed');

    const deleted = await tool('mentat.cache.delete').execute({ key: 'k' }, ctx);
    expect((deleted.output as { deleted: boolean }).deleted).toBe(true);
    const gone = await tool('mentat.cache.get').execute({ key: 'k' }, ctx);
    expect((gone.output as { hit: boolean }).hit).toBe(false);
  });

  test('isolates values by authScope and workspace', async () => {
    const ctx = context();
    await tool('mentat.cache.set').execute(
      { key: 'k', value: 'credential-one', authScope: 'credential-1' },
      ctx
    );
    const otherScope = await tool('mentat.cache.get').execute(
      { key: 'k', authScope: 'credential-2' },
      ctx
    );
    expect((otherScope.output as { hit: boolean }).hit).toBe(false);

    const otherWorkspace = context({ workspaceId: workspaceB });
    const crossTenant = await tool('mentat.cache.get').execute({ key: 'k' }, otherWorkspace);
    expect((crossTenant.output as { hit: boolean }).hit).toBe(false);
  });

  test('denies cache tools without the required permission', async () => {
    const ctx = context({ permissions: [] });
    const read = await tool('mentat.cache.get').execute({ key: 'k' }, ctx);
    expect(read.error?.code).toBe('forbidden');
    const write = await tool('mentat.cache.set').execute({ key: 'k', value: 1 }, ctx);
    expect(write.error?.code).toBe('forbidden');
  });

  test('rejects invalid cache input', async () => {
    const result = await tool('mentat.cache.set').execute({ value: 1 }, context());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('validation_failed');
  });

  test('declares a destructive approval policy for cache delete', () => {
    expect(tool('mentat.cache.delete').approvalPolicy?.mode).toBe('conditional');
  });
});

const MINIMAL_VALID_INPUT: Record<string, unknown> = {
  'mentat.state.get': { scope: 'workspace', key: 'k' },
  'mentat.state.set': { scope: 'workspace', key: 'k', value: 1 },
  'mentat.state.delete': { scope: 'workspace', key: 'k' },
  'mentat.state.list': { scope: 'workspace' },
  'mentat.data.get': { recordId: 'r' },
  'mentat.data.find': { collectionId: 'c' },
  'mentat.data.insert': { collectionId: 'c', data: {} },
  'mentat.data.update': { recordId: 'r', data: {} },
  'mentat.data.delete': { recordId: 'r' },
  'mentat.cache.get': { key: 'k' },
  'mentat.cache.set': { key: 'k', value: 1 },
  'mentat.cache.delete': { key: 'k' },
  'mentat.cache.getOrCompute': { key: 'k', value: 1 }
};

const INVALID_INPUT: Record<string, unknown> = {
  'mentat.state.get': { scope: 'workspace' },
  'mentat.state.set': { scope: 'workspace', key: 'k' },
  'mentat.state.delete': { key: 'k' },
  'mentat.state.list': { scope: 'not-a-scope' },
  'mentat.data.get': {},
  'mentat.data.find': {},
  'mentat.data.insert': { collectionId: 'c' },
  'mentat.data.update': { recordId: 'r' },
  'mentat.data.delete': {},
  'mentat.cache.get': {},
  'mentat.cache.set': { key: 'k' },
  'mentat.cache.delete': {},
  'mentat.cache.getOrCompute': { key: 'k' }
};

describe('every native tool enforces its boundary', () => {
  test('the tables above cover every registered tool', () => {
    const keys = nativeTools.map((candidate) => candidate.key).sort();
    expect(Object.keys(MINIMAL_VALID_INPUT).sort()).toEqual(keys);
    expect(Object.keys(INVALID_INPUT).sort()).toEqual(keys);
  });

  test('an actor with no permissions is denied by every tool', async () => {
    const ctx = context({ permissions: [] });
    for (const candidate of nativeTools) {
      const result = await candidate.execute(MINIMAL_VALID_INPUT[candidate.key], ctx);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('forbidden');
    }
  });

  test('malformed input fails validation before any work happens', async () => {
    const ctx = context();
    for (const candidate of nativeTools) {
      const result = await candidate.execute(INVALID_INPUT[candidate.key], ctx);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('validation_failed');
    }
  });
});
