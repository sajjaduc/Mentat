/**
 * Universal Records + WorkflowItems integration tests (ADR-0021).
 *
 * These prove the architectural invariants directly: no Ticket primitive is
 * required, state lives on the WorkflowItem, one Record can participate in
 * several Workflows, transfer and add-participation differ, base and overlay
 * fields resolve and survive completion, and notes/files/relationships keep their
 * durable-vs-work scope.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  type ActorContext,
  createActorContext,
  Permissions
} from '../../../src/lib/server/core/context';
import {
  fieldValueHistory,
  fileRecords,
  fileWorkflowItems,
  records,
  workflowItemFieldValues,
  workflowItemStateHistory,
  workflowItems,
  workflows
} from '../../../src/lib/server/db/schema';
import { setWorkflowFields } from '../../../src/lib/server/fields/service';
import { createObjectType, setBaseFields } from '../../../src/lib/server/records/object-types';
import { listRecords } from '../../../src/lib/server/records/query';
import {
  defineRelationship,
  linkRecordsSync,
  listRecordRelationships,
  unlinkRecordsSync
} from '../../../src/lib/server/records/relationships';
import {
  addRecordNote,
  archiveRecord,
  createRecord,
  getRecordDetail,
  listRecordNotes,
  updateRecord
} from '../../../src/lib/server/records/service';
import { recordFieldHistory } from '../../../src/lib/server/records/values';
import { getWorkflowBoard, listWorkflowItems } from '../../../src/lib/server/workflow-items/query';
import {
  addWorkflowItemNote,
  addWorkflowParticipation,
  createWorkflowItem,
  getWorkflowItemDetail,
  linkWorkItemsSync,
  requestWorkflowItemTransition,
  setWorkflowItemFields,
  transferWorkflowItem
} from '../../../src/lib/server/workflow-items/service';
import { createWorkflow as createWorkflowService } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createFileRecord,
  createUser,
  createWorkflow as createWorkflowFixture,
  createWorkspace,
  memberActor,
  ownerActor
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Universal');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Owner' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId);
});

async function makeObjectType(
  name: string,
  fields: Array<{
    key: string;
    name: string;
    type?: 'short_text' | 'number' | 'date' | 'select';
    primary?: boolean;
    identity?: boolean;
    required?: boolean;
    options?: Record<string, unknown>;
  }>
) {
  const objectType = createObjectType(handle.db, owner, { name });
  await setBaseFields(
    handle.db,
    owner,
    objectType.id,
    fields.map((field, index) => ({
      key: field.key,
      name: field.name,
      type: field.type ?? 'short_text',
      options: field.options ?? null,
      required: field.required ?? false,
      isIdentity: field.identity ?? false,
      isPrimaryDisplay: field.primary ?? index === 0
    })) as never
  );
  return objectType;
}

async function makeWorkflow(name: string, objectTypeId: string) {
  return createWorkflowFixture(handle.db, workspaceId, { name, objectTypeId });
}

function agentActor(permissions: string[], extra: Partial<ActorContext> = {}): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'agent',
    actorId: 'agent-1',
    actorLabel: 'Agent',
    role: 'agent',
    permissions,
    ...extra
  });
}

describe('universal model: object types and records', () => {
  test('defines an arbitrary Object Type and creates records without any ticket', async () => {
    const business = await makeObjectType('Business', [
      { key: 'business_name', name: 'Business Name', primary: true, required: true },
      { key: 'abn', name: 'ABN', identity: true }
    ]);

    const record = await createRecord(handle.db, owner, {
      objectTypeId: business.id,
      fields: { business_name: 'ACME Pty Ltd', abn: '12345678901' }
    });

    expect(record.displayName).toBe('ACME Pty Ltd');
    expect(record.objectTypeId).toBe(business.id);

    const stored = handle.db.select().from(records).where(eq(records.id, record.id)).all()[0];
    expect(stored?.displayName).toBe('ACME Pty Ltd');
  });

  test('enforces deterministic identity uniqueness and surfaces the existing record', async () => {
    const business = await makeObjectType('Business', [
      { key: 'business_name', name: 'Business Name', primary: true },
      { key: 'abn', name: 'ABN', identity: true }
    ]);
    await createRecord(handle.db, owner, {
      objectTypeId: business.id,
      fields: { business_name: 'ACME', abn: '99' }
    });
    await expect(
      createRecord(handle.db, owner, {
        objectTypeId: business.id,
        fields: { business_name: 'ACME duplicate', abn: '99' }
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('records field provenance and applies the base schema', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true },
      { key: 'premium', name: 'Premium', type: 'number' }
    ]);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-1', premium: 100 }
    });
    await updateRecord(handle.db, owner, { recordId: record.id, fields: { premium: 250 } });

    const detail = await getRecordDetail(handle.db, owner, record.id);
    expect(detail.fields.premium).toBe(250);
    expect(detail.effectiveFields.map((field) => field.key)).toContain('policy_number');

    const history = await recordFieldHistory(handle.db, workspaceId, record.id);
    expect(history.some((entry) => entry.newValue === 250)).toBe(true);
  });

  test('isolates records by workspace', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const mine = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'MINE-1' }
    });
    // A record in another workspace with the same object type key.
    const otherUser = await createUser(handle.db, { name: 'Other Owner' });
    const otherActor = ownerActor(other.id, otherUser.id);
    const otherType = createObjectType(handle.db, otherActor, { name: 'Policy' });
    await setBaseFields(handle.db, otherActor, otherType.id, [
      { key: 'policy_number', name: 'Policy Number', type: 'short_text', isPrimaryDisplay: true }
    ] as never);
    const theirs = await createRecord(handle.db, otherActor, {
      objectTypeId: otherType.id,
      fields: { policy_number: 'THEIRS-1' }
    });

    const page = await listRecords(handle.db, { workspaceId, objectTypeId: policy.id });
    expect(page.rows.map((row) => row.id)).toEqual([mine.id]);
    await expect(getRecordDetail(handle.db, owner, theirs.id)).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  test('member role can create records but cannot redefine object types', async () => {
    const member = memberActor(workspaceId, 'member-1');
    expect(() => createObjectType(handle.db, member, { name: 'Secret' })).toThrow();
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const record = await createRecord(handle.db, member, {
      objectTypeId: policy.id,
      fields: { policy_number: 'M-1' }
    });
    expect(record.id).toBeTruthy();
    await expect(archiveRecord(handle.db, member, record.id)).rejects.toMatchObject({
      code: 'forbidden'
    });
  });

  test('agents create records only when granted the capability', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const allowed = agentActor([Permissions.recordCreate, Permissions.recordRead]);
    const record = await createRecord(handle.db, allowed, {
      objectTypeId: policy.id,
      fields: { policy_number: 'A-1' }
    });
    expect(record.id).toBeTruthy();

    const denied = agentActor([Permissions.recordRead]);
    await expect(
      createRecord(handle.db, denied, {
        objectTypeId: policy.id,
        fields: { policy_number: 'A-2' }
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('universal model: workflow items', () => {
  test('a Workflow processes an arbitrary Object Type and records need no ticket', async () => {
    const business = await makeObjectType('Business', [
      { key: 'business_name', name: 'Business Name', primary: true }
    ]);
    const workflow = await makeWorkflow('Onboarding', business.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: business.id,
      fields: { business_name: 'Globex' }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });
    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.record.objectTypeKey).toBe('business');
    expect(detail.state.name).toBe('Backlog');

    const page = await listWorkflowItems(handle.db, { workspaceId, workflowId: workflow.id });
    expect(page.items.map((row) => row.id)).toEqual([item.id]);

    const board = await getWorkflowBoard(handle.db, { workspaceId, workflowId: workflow.id });
    expect(board.columns.length).toBeGreaterThan(0);
    expect(board.columns[0]?.items.map((row) => row.id)).toEqual([item.id]);
  });

  test('a record can have zero items and then participate in several workflows, with an optional one-active rule', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const lifecycle = await makeWorkflow('Policy Lifecycle', policy.id);
    const renewal = await makeWorkflow('Renewal', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-9' }
    });

    let page = await listWorkflowItems(handle.db, { workspaceId, recordId: record.id });
    expect(page.items).toHaveLength(0);

    await createWorkflowItem(handle.db, owner, { workflowId: lifecycle.id, recordId: record.id });
    await createWorkflowItem(handle.db, owner, { workflowId: renewal.id, recordId: record.id });
    page = await listWorkflowItems(handle.db, { workspaceId, recordId: record.id });
    expect(page.items).toHaveLength(2);

    await expect(
      createWorkflowItem(handle.db, owner, { workflowId: lifecycle.id, recordId: record.id })
    ).rejects.toMatchObject({ code: 'conflict' });

    handle.db
      .update(workflows)
      .set({ settings: { allowMultipleActiveItems: true } as never })
      .where(eq(workflows.id, lifecycle.id))
      .run();
    const second = await createWorkflowItem(handle.db, owner, {
      workflowId: lifecycle.id,
      recordId: record.id
    });
    expect(second.id).toBeTruthy();
  });

  test('transfer closes the source item while add-participation keeps it active', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const source = await makeWorkflow('Lifecycle', policy.id);
    const target = await makeWorkflow('Renewal', policy.id);
    const other = await makeWorkflow('Compliance', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-10' }
    });

    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: source.id,
      recordId: record.id
    });
    const transferred = await transferWorkflowItem(handle.db, owner, {
      workflowItemId: item.id,
      targetWorkflowId: target.id,
      reason: 'renewal due'
    });
    const sourceAfter = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(sourceAfter.completedAt).not.toBeNull();
    expect(transferred.workflowItem.participation).toBe('transferred');

    const destination = await getWorkflowItemDetail(handle.db, owner, transferred.workflowItem.id);
    expect(destination.workflowId).toBe(target.id);

    // add-participation leaves existing work alive
    const third = await addWorkflowParticipation(handle.db, owner, {
      recordId: record.id,
      workflowId: other.id
    });
    const sourceStillOpen = await listWorkflowItems(handle.db, {
      workspaceId,
      recordId: record.id,
      includeCompleted: true
    });
    const openIds = sourceStillOpen.items
      .filter((row) => row.completedAt === null)
      .map((row) => row.id);
    expect(openIds).toContain(third.id);
  });

  test('state lives on the WorkflowItem, not the Record', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Lifecycle', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-11' }
    });
    const before = handle.db.select().from(records).where(eq(records.id, record.id)).all()[0];
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });
    await requestWorkflowItemTransition(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    const after = handle.db.select().from(records).where(eq(records.id, record.id)).all()[0];
    const moved = handle.db
      .select()
      .from(workflowItems)
      .where(eq(workflowItems.id, item.id))
      .all()[0];
    expect(before?.version).toBe(after?.version);
    expect(moved?.stateId).toBe(workflow.stateIds['In Progress']);
    expect(Object.keys(after ?? {})).not.toContain('stateId');
  });

  test('base and workflow overlay fields resolve together and overlay history survives completion', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true },
      { key: 'premium', name: 'Premium', type: 'number' }
    ]);
    const workflow = await makeWorkflow('Renewal', policy.id);
    const renewalPremium = await createField(handle.db, {
      workspaceId,
      scope: 'record',
      key: 'renewal_premium',
      name: 'Renewal Premium',
      type: 'number'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: renewalPremium, required: false, showOnCard: true }
    ]);

    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-12', premium: 100 }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      fields: { renewal_premium: 140 }
    });

    let detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.fields.premium).toBe(100);
    expect(detail.fields.renewal_premium).toBe(140);

    await requestWorkflowItemTransition(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    await requestWorkflowItemTransition(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds.Done as string
    });
    detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.completedAt).not.toBeNull();
    expect(detail.fields.renewal_premium).toBe(140);

    const overlayRows = handle.db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, item.id))
      .all();
    expect(overlayRows).toHaveLength(1);

    const overlayHistory = handle.db
      .select()
      .from(fieldValueHistory)
      .where(
        and(
          eq(fieldValueHistory.ownerType, 'workflow_item'),
          eq(fieldValueHistory.ownerId, item.id)
        )
      )
      .all();
    expect(overlayHistory.length).toBeGreaterThan(0);

    // A base field set through the item updates the durable record.
    await setWorkflowItemFields(handle.db, owner, {
      workflowItemId: item.id,
      values: { premium: 175 }
    });
    const recordDetail = await getRecordDetail(handle.db, owner, record.id);
    expect(recordDetail.fields.premium).toBe(175);
  });

  test('record notes and workflow-item notes stay distinguishable', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Lifecycle', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-13' }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });

    await addRecordNote(handle.db, owner, {
      recordId: record.id,
      body: 'Prefers quarterly billing.'
    });
    await addWorkflowItemNote(handle.db, owner, {
      workflowItemId: item.id,
      body: 'Waiting on broker.'
    });

    const recordNotes = await listRecordNotes(handle.db, owner, record.id);
    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(recordNotes.map((note) => note.body)).toEqual(['Prefers quarterly billing.']);
    expect(detail.notes.map((note) => note.body)).toEqual(['Waiting on broker.']);
  });

  test('record file links and workflow-item file links are distinguishable', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Lifecycle', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-14' }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });
    const fileId = await createFileRecord(handle.db, { workspaceId });

    handle.db
      .insert(fileRecords)
      .values({ workspaceId, fileId, recordId: record.id, relationship: 'evidence' })
      .run();
    handle.db
      .insert(fileWorkflowItems)
      .values({ workspaceId, fileId, workflowItemId: item.id, relationship: 'output' })
      .run();

    const durable = handle.db
      .select()
      .from(fileRecords)
      .where(eq(fileRecords.recordId, record.id))
      .all();
    const work = handle.db
      .select()
      .from(fileWorkflowItems)
      .where(eq(fileWorkflowItems.workflowItemId, item.id))
      .all();
    expect(durable).toHaveLength(1);
    expect(durable[0]?.relationship).toBe('evidence');
    expect(work).toHaveLength(1);
    expect(work[0]?.relationship).toBe('output');
  });

  test('domain relationships and work relationships are separate concepts', async () => {
    const business = await makeObjectType('Business', [
      { key: 'business_name', name: 'Business Name', primary: true }
    ]);
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Lifecycle', policy.id);
    const hasPolicy = defineRelationship(handle.db, owner, {
      sourceObjectTypeId: business.id,
      targetObjectTypeId: policy.id,
      key: 'HAS_POLICY',
      name: 'Has Policy',
      inverseName: 'Policy Of'
    });
    const acme = await createRecord(handle.db, owner, {
      objectTypeId: business.id,
      fields: { business_name: 'ACME' }
    });
    const pol = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-15' }
    });
    linkRecordsSync(handle.db, owner, {
      fromRecordId: acme.id,
      toRecordId: pol.id,
      definitionId: hasPolicy.id
    });
    const related = await listRecordRelationships(handle.db, owner, acme.id);
    expect(related).toHaveLength(1);
    expect(related[0]?.label).toBe('Has Policy');

    const itemA = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: pol.id
    });
    handle.db
      .update(workflows)
      .set({ settings: { allowMultipleActiveItems: true } as never })
      .where(eq(workflows.id, workflow.id))
      .run();
    const itemB = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: pol.id
    });
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: itemA.id,
      toWorkflowItemId: itemB.id,
      type: 'blocks'
    });
    const workLinks = handle.db.select().from(workflowItems).all();
    expect(workLinks.length).toBe(2);
    const relatedStillDomain = await listRecordRelationships(handle.db, owner, acme.id);
    expect(relatedStillDomain).toHaveLength(1);

    unlinkRecordsSync(handle.db, owner, { relationshipId: related[0]?.relationshipId as string });
    expect(await listRecordRelationships(handle.db, owner, acme.id)).toHaveLength(0);
  });

  test('agents can start work only when granted the capability', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Lifecycle', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-16' }
    });
    const allowed = agentActor([
      Permissions.workflowItemCreate,
      Permissions.workflowItemRead,
      Permissions.recordRead
    ]);
    const item = await createWorkflowItem(handle.db, allowed, {
      workflowId: workflow.id,
      recordId: record.id
    });
    expect(item.id).toBeTruthy();

    const denied = agentActor([Permissions.recordRead]);
    await expect(
      createWorkflowItem(handle.db, denied, { workflowId: workflow.id, recordId: record.id })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('a scheduled-style record query drives work creation without a ticket', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true },
      { key: 'expiry_date', name: 'Expiry Date', type: 'date' }
    ]);
    const workflow = await makeWorkflow('Renewal', policy.id);
    for (const [number, expiry] of [
      ['POL-20', '2026-01-01'],
      ['POL-21', '2030-01-01']
    ]) {
      await createRecord(handle.db, owner, {
        objectTypeId: policy.id,
        fields: { policy_number: number, expiry_date: expiry }
      });
    }

    const page = await listRecords(handle.db, {
      workspaceId,
      objectTypeId: policy.id,
      filter: {
        type: 'group',
        op: 'and',
        children: [
          {
            type: 'condition',
            kind: 'record_field',
            key: 'expiry_date',
            operator: 'lt',
            value: Date.parse('2026-06-01')
          }
        ]
      } as never
    });
    expect(page.rows.map((row) => row.fields.policy_number)).toEqual(['POL-20']);

    for (const row of page.rows) {
      await createWorkflowItem(handle.db, owner, {
        workflowId: workflow.id,
        recordId: row.id,
        reason: 'expiring soon'
      });
    }
    const work = await listWorkflowItems(handle.db, { workspaceId, workflowId: workflow.id });
    expect(work.items).toHaveLength(1);
    expect(work.items[0]?.recordDisplayName).toBe('POL-20');
  });

  test('funnels can be derived from WorkflowItem transition history', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Funnel', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-22' }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });
    await requestWorkflowItemTransition(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds['In Progress'] as string
    });
    await requestWorkflowItemTransition(handle.db, owner, {
      workflowItemId: item.id,
      targetStateId: workflow.stateIds.Done as string
    });
    const intervals = handle.db
      .select()
      .from(workflowItemStateHistory)
      .where(eq(workflowItemStateHistory.workflowItemId, item.id))
      .all();
    expect(intervals).toHaveLength(3);
    const closed = intervals.filter((interval) => interval.exitedAt !== null);
    const open = intervals.filter((interval) => interval.exitedAt === null);
    expect(closed).toHaveLength(2);
    expect(open).toHaveLength(1);
    expect(open[0]?.stateId).toBe(workflow.stateIds.Done as string);
  });
});

describe('universal model: no legacy ticket primitive', () => {
  test('no ticket tables exist in the migrated schema', () => {
    const rows = handle.sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ticket%'")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([]);
  });

  test('records and workflow items are the only work primitives end to end', async () => {
    const business = await makeObjectType('Business', [
      { key: 'business_name', name: 'Business Name', primary: true }
    ]);
    const workflow = await makeWorkflow('Onboarding', business.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: business.id,
      fields: { business_name: 'Initech' }
    });
    const item = await createWorkflowItem(handle.db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });

    const recordPage = await listRecords(handle.db, {
      workspaceId,
      objectTypeId: business.id
    });
    expect(recordPage.rows.map((row) => row.id)).toContain(record.id);

    const work = await listWorkflowItems(handle.db, { workspaceId, workflowId: workflow.id });
    expect(work.items).toHaveLength(1);
    expect(work.items[0]?.id).toBe(item.id);
    expect(work.items[0]?.recordDisplayName).toBe('Initech');

    // State lives on the item; the durable record row has no state column.
    const itemRow = handle.db
      .select()
      .from(workflowItems)
      .where(eq(workflowItems.id, item.id))
      .all()[0];
    expect(itemRow?.stateId).toBe(workflow.stateIds.Backlog as string);
    const storedRecord = handle.db.select().from(records).where(eq(records.id, record.id)).all()[0];
    expect(Object.keys(storedRecord ?? {})).not.toContain('stateId');
  });

  test('archived records stop accepting new work', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    const workflow = await makeWorkflow('Lifecycle', policy.id);
    const record = await createRecord(handle.db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'POL-30' }
    });
    // The member cannot archive; the owner can.
    await archiveRecord(handle.db, owner, record.id);
    await expect(
      createWorkflowItem(handle.db, owner, { workflowId: workflow.id, recordId: record.id })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('unknown record fields are rejected rather than silently dropped', async () => {
    const policy = await makeObjectType('Policy', [
      { key: 'policy_number', name: 'Policy Number', primary: true }
    ]);
    await expect(
      createRecord(handle.db, owner, {
        objectTypeId: policy.id,
        fields: { policy_number: 'POL-31', not_a_field: 'x' }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('universal model: workflow configuration', () => {
  test('a workflow records the Object Type it processes and has no implicit default', async () => {
    const business = await makeObjectType('Business', [
      { key: 'business_name', name: 'Business Name', primary: true }
    ]);
    const custom = createWorkflowService(handle.db, owner, {
      name: 'Onboarding',
      objectTypeId: business.id
    });
    expect(custom.workflow.objectTypeId).toBe(business.id);

    // There is no system Ticket Object Type: a workflow must name its type.
    expect(() => createWorkflowService(handle.db, owner, { name: 'General' })).toThrow();
  });

  test('a workflow rejects an Object Type from another workspace', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const otherUser = await createUser(handle.db, { name: 'Other Owner' });
    const otherActor = ownerActor(other.id, otherUser.id);
    const otherType = createObjectType(handle.db, otherActor, { name: 'Secret' });
    expect(() =>
      createWorkflowService(handle.db, owner, { name: 'Leak', objectTypeId: otherType.id })
    ).toThrow();
  });
});
