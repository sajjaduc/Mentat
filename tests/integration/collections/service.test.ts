import { beforeEach, describe, expect, test } from 'bun:test';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import {
  archiveCollection,
  createCollection,
  deleteRecord,
  findRecords,
  getCollection,
  getRecord,
  insertRecord,
  listCollections,
  resolveCollection,
  updateCollection,
  updateRecord,
  upsertByExternalKey
} from '../../../src/lib/server/collections/service';
import { createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { AppError } from '../../../src/lib/server/core/errors';
import { collectionRecords } from '../../../src/lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkflow, createWorkspace, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceA: string;
let workspaceB: string;
let workflowId: string;

beforeEach(async () => {
  handle = createTestDatabase();
  workspaceA = (await createWorkspace(handle.db, 'A')).id;
  workspaceB = (await createWorkspace(handle.db, 'B')).id;
  workflowId = (await createWorkflow(handle.db, workspaceA)).id;
});

function owner(workspaceId: string) {
  return ownerActor(workspaceId, 'user-1');
}

async function seedCollection(
  options: { workflowId?: string | null; schema?: unknown; key?: string } = {}
): Promise<string> {
  const collection = await createCollection(handle.db, owner(workspaceA), {
    key: options.key ?? 'customers',
    name: 'Customers',
    workflowId: options.workflowId,
    schema: options.schema
  });
  return collection.id;
}

describe('collection CRUD', () => {
  test('creates workspace-level and workflow-scoped collections and lists them', async () => {
    const workspaceLevel = await createCollection(handle.db, owner(workspaceA), {
      key: 'customers',
      name: 'Customers'
    });
    expect(workspaceLevel.workflowId).toBeNull();

    const scoped = await createCollection(handle.db, owner(workspaceA), {
      key: 'research',
      name: 'Research',
      workflowId
    });
    expect(scoped.workflowId).toBe(workflowId);

    const all = listCollections(handle.db, owner(workspaceA));
    expect(all.map((collection) => collection.key).sort()).toEqual(['customers', 'research']);
    expect(listCollections(handle.db, owner(workspaceA), { workflowId }).map((c) => c.key)).toEqual(
      ['research']
    );

    expect(getCollection(handle.db, owner(workspaceA), scoped.id).key).toBe('research');
    expect(
      resolveCollection(handle.db, owner(workspaceA), { key: 'research', workflowId }).id
    ).toBe(scoped.id);
  });

  test('rejects a duplicate key in the same scope', async () => {
    await seedCollection({ key: 'dupe' });
    await expect(seedCollection({ key: 'dupe' })).rejects.toThrow(AppError);
  });

  test('updates metadata and archives a collection', async () => {
    const collectionId = await seedCollection({ key: 'editable' });
    const updated = await updateCollection(handle.db, owner(workspaceA), collectionId, {
      name: 'Renamed'
    });
    expect(updated.name).toBe('Renamed');
    await archiveCollection(handle.db, owner(workspaceA), collectionId);
    expect(listCollections(handle.db, owner(workspaceA))).toHaveLength(0);
    expect(() => getCollection(handle.db, owner(workspaceA), collectionId)).toThrow();
  });

  test('requires data:read and data:write permissions', async () => {
    const collectionId = await seedCollection({ key: 'secured' });
    const silent = createActorContext({
      workspaceId: workspaceA,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: []
    });
    expect(() => getCollection(handle.db, silent, collectionId)).toThrow();
    await expect(
      createCollection(handle.db, silent, { key: 'nope', name: 'Nope' })
    ).rejects.toThrow();
  });

  test('a cross-tenant collection read returns not_found', async () => {
    const collectionId = await seedCollection({ key: 'private' });
    expect(() => getCollection(handle.db, owner(workspaceB), collectionId)).toThrow(AppError);
    try {
      getCollection(handle.db, owner(workspaceB), collectionId);
    } catch (error) {
      expect((error as AppError).code).toBe('not_found');
    }
  });
});

describe('collection records', () => {
  test('inserts, gets, merges, replaces and soft-deletes a record', async () => {
    const collectionId = await seedCollection();
    const actor = owner(workspaceA);

    const created = await insertRecord(handle.db, actor, {
      collectionId,
      data: { name: 'Acme', tier: 'gold' },
      externalKey: 'acme'
    });
    expect(created.version).toBe(1);
    expect(getRecord(handle.db, actor, created.id).data).toEqual({ name: 'Acme', tier: 'gold' });

    const merged = await updateRecord(handle.db, actor, {
      recordId: created.id,
      data: { tier: 'platinum' },
      expectedVersion: 1
    });
    expect(merged.version).toBe(2);
    expect(merged.data).toEqual({ name: 'Acme', tier: 'platinum' });

    const replaced = await updateRecord(handle.db, actor, {
      recordId: created.id,
      data: { name: 'Acme Corp' },
      replace: true,
      expectedVersion: 2
    });
    expect(replaced.data).toEqual({ name: 'Acme Corp' });

    const firstDelete = await deleteRecord(handle.db, actor, { recordId: created.id });
    expect(firstDelete.deleted).toBe(true);
    const secondDelete = await deleteRecord(handle.db, actor, { recordId: created.id });
    expect(secondDelete.deleted).toBe(false);
    expect(() => getRecord(handle.db, actor, created.id)).toThrow(AppError);
    // Soft delete keeps the row for audit/history.
    expect(handle.db.select().from(collectionRecords).all()).toHaveLength(1);
  });

  test('optimistic concurrency rejects a stale expectedVersion', async () => {
    const collectionId = await seedCollection();
    const actor = owner(workspaceA);
    const created = await insertRecord(handle.db, actor, { collectionId, data: { n: 1 } });
    await updateRecord(handle.db, actor, { recordId: created.id, data: { n: 2 } });

    try {
      await updateRecord(handle.db, actor, {
        recordId: created.id,
        data: { n: 3 },
        expectedVersion: 1
      });
      throw new Error('expected a version conflict');
    } catch (error) {
      expect((error as AppError).code).toBe('version_conflict');
    }
    expect(getRecord(handle.db, actor, created.id).data).toEqual({ n: 2 });
  });

  test('validates records against a declared schema and lists every violation', async () => {
    const collectionId = await seedCollection({
      key: 'validated',
      schema: {
        required: ['name'],
        properties: {
          name: { type: 'string' },
          amount: { type: 'number' },
          status: { type: 'string', enum: ['open', 'closed'] }
        }
      }
    });
    const actor = owner(workspaceA);
    try {
      await insertRecord(handle.db, actor, {
        collectionId,
        data: { amount: 'lots', status: 'pending' }
      });
      throw new Error('expected schema validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('validation_failed');
      const violations = appError.details.violations as Array<{ path: string }>;
      expect(violations.map((violation) => violation.path).sort()).toEqual([
        'amount',
        'name',
        'status'
      ]);
    }

    const valid = await insertRecord(handle.db, actor, {
      collectionId,
      data: { name: 'Acme', amount: 10, status: 'open' }
    });
    expect(valid.id).toBeTruthy();
  });

  test('maintains search_text through insert and update', async () => {
    const collectionId = await seedCollection({ key: 'searchable' });
    const actor = owner(workspaceA);
    const created = await insertRecord(handle.db, actor, {
      collectionId,
      data: { name: 'Acme Corp', city: 'Berlin', nested: { note: 'VIP' } },
      externalKey: 'ext-1'
    });
    expect(created.searchText).toContain('acme corp');
    expect(created.searchText).toContain('berlin');
    expect(created.searchText).toContain('vip');
    expect(created.searchText).toContain('ext-1');

    const updated = await updateRecord(handle.db, actor, {
      recordId: created.id,
      data: { city: 'Munich' }
    });
    expect(updated.searchText).toContain('munich');
    expect(updated.searchText).not.toContain('berlin');
  });

  test('find supports every predicate, sort and cursor pagination', async () => {
    const collectionId = await seedCollection({ key: 'findable' });
    const actor = owner(workspaceA);
    const rows = [
      { name: 'Acme', amount: 10, status: 'open', tags: ['vip'] },
      { name: 'Beta', amount: 20, status: 'closed', tags: [] },
      { name: 'Gamma', amount: 30, status: 'open', tags: ['vip', 'new'] },
      { name: 'Delta', amount: 40, status: 'pending' }
    ];
    for (const [index, row] of rows.entries()) {
      await insertRecord(handle.db, actor, {
        collectionId,
        data: row,
        externalKey: `ext-${index}`
      });
    }

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'status', op: 'eq', value: 'open' }]
      })
        .records.map((record) => record.data.name)
        .sort()
    ).toEqual(['Acme', 'Gamma']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'amount', op: 'gt', value: 20 }]
      })
        .records.map((record) => record.data.name)
        .sort()
    ).toEqual(['Delta', 'Gamma']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'name', op: 'contains', value: 'et' }]
      }).records.map((record) => record.data.name)
    ).toEqual(['Beta']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'name', op: 'starts_with', value: 'ac' }]
      }).records.map((record) => record.data.name)
    ).toEqual(['Acme']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'status', op: 'in', value: ['pending'] }]
      }).records.map((record) => record.data.name)
    ).toEqual(['Delta']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'tags', op: 'is_empty' }]
      })
        .records.map((record) => record.data.name)
        .sort()
    ).toEqual(['Beta', 'Delta']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        filter: [{ field: 'externalKey', op: 'eq', value: 'ext-2' }]
      }).records.map((record) => record.data.name)
    ).toEqual(['Gamma']);

    expect(
      findRecords(handle.db, actor, {
        collectionId,
        sort: [{ field: 'amount', direction: 'asc' }]
      }).records.map((record) => record.data.amount)
    ).toEqual([10, 20, 30, 40]);

    const firstPage = findRecords(handle.db, actor, {
      collectionId,
      sort: [{ field: 'amount', direction: 'asc' }],
      limit: 2
    });
    expect(firstPage.records.map((record) => record.data.amount)).toEqual([10, 20]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = findRecords(handle.db, actor, {
      collectionId,
      sort: [{ field: 'amount', direction: 'asc' }],
      limit: 2,
      cursor: firstPage.nextCursor
    });
    expect(secondPage.records.map((record) => record.data.amount)).toEqual([30, 40]);
    expect(secondPage.nextCursor).toBeNull();

    expect(() => findRecords(handle.db, actor, { collectionId, cursor: 'not-a-cursor' })).toThrow();
  });

  test('upserts by external key and revives a soft-deleted record', async () => {
    const collectionId = await seedCollection({ key: 'upserts' });
    const actor = owner(workspaceA);

    const first = await upsertByExternalKey(handle.db, actor, {
      collectionId,
      externalKey: 'crm-1',
      data: { name: 'Acme', version: 1 }
    });
    const second = await upsertByExternalKey(handle.db, actor, {
      collectionId,
      externalKey: 'crm-1',
      data: { name: 'Acme', version: 2 }
    });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.data).toEqual({ name: 'Acme', version: 2 });

    await deleteRecord(handle.db, actor, { recordId: first.id });
    const revived = await upsertByExternalKey(handle.db, actor, {
      collectionId,
      externalKey: 'crm-1',
      data: { name: 'Acme', version: 3 }
    });
    expect(revived.id).toBe(first.id);
    expect(revived.deletedAt).toBeNull();
    expect(revived.version).toBe(3);
  });

  test('insert with a live external key conflicts, and a deleted one is revived', async () => {
    const collectionId = await seedCollection({ key: 'insert-keys' });
    const actor = owner(workspaceA);
    const created = await insertRecord(handle.db, actor, {
      collectionId,
      data: { name: 'Acme' },
      externalKey: 'key-1'
    });
    await expect(
      insertRecord(handle.db, actor, {
        collectionId,
        data: { name: 'Other' },
        externalKey: 'key-1'
      })
    ).rejects.toThrow(AppError);

    await deleteRecord(handle.db, actor, { recordId: created.id });
    const revived = await insertRecord(handle.db, actor, {
      collectionId,
      data: { name: 'Acme again' },
      externalKey: 'key-1'
    });
    expect(revived.id).toBe(created.id);
    expect(revived.data).toEqual({ name: 'Acme again' });
  });

  test('a cross-tenant record read or write returns not_found', async () => {
    const collectionId = await seedCollection({ key: 'tenant' });
    const created = await insertRecord(handle.db, owner(workspaceA), {
      collectionId,
      data: { name: 'Acme' }
    });
    const intruder = owner(workspaceB);
    expect(() => getRecord(handle.db, intruder, created.id)).toThrow(AppError);
    await expect(
      updateRecord(handle.db, intruder, { recordId: created.id, data: { name: 'Hacked' } })
    ).rejects.toThrow(AppError);
    await expect(deleteRecord(handle.db, intruder, { recordId: created.id })).rejects.toThrow(
      AppError
    );
    expect(() => findRecords(handle.db, intruder, { collectionId })).toThrow(AppError);
  });

  test('mutations write audit rows for collection and record changes', async () => {
    const collectionId = await seedCollection({ key: 'audited' });
    const actor = owner(workspaceA);
    const created = await insertRecord(handle.db, actor, { collectionId, data: { n: 1 } });
    await updateRecord(handle.db, actor, { recordId: created.id, data: { n: 2 } });
    await deleteRecord(handle.db, actor, { recordId: created.id });

    const collectionAudit = await queryAudit(handle.db, {
      workspaceId: workspaceA,
      actions: ['collection.created']
    });
    expect(collectionAudit).toHaveLength(1);

    const recordAudit = await queryAudit(handle.db, {
      workspaceId: workspaceA,
      actions: ['collection.record.changed']
    });
    expect(recordAudit).toHaveLength(3);
    expect(recordAudit.map((row) => (row.data as { operation: string }).operation).sort()).toEqual([
      'delete',
      'insert',
      'update'
    ]);
  });

  test('a read-only actor cannot mutate records', async () => {
    const collectionId = await seedCollection({ key: 'read-only' });
    const reader = createActorContext({
      workspaceId: workspaceA,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: [Permissions.dataRead]
    });
    expect(findRecords(handle.db, reader, { collectionId }).records).toEqual([]);
    await expect(insertRecord(handle.db, reader, { collectionId, data: { n: 1 } })).rejects.toThrow(
      AppError
    );
  });
});
