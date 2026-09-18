/**
 * Mapping against a persisted trigger.
 *
 * This is the integration half of the mapping contract: a stored trigger row is
 * read back and applied to a payload, and the real records + workflow-items
 * services must produce the work. Assertions read the persisted
 * `records` / `workflow_items` / field values directly (ADR-0021) rather than a
 * recording ticket stand-in.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { systemActor } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import {
  labels,
  records,
  workflowItemLabels,
  workflowItemRelationships,
  workflowItems
} from '../../../src/lib/server/db/schema';
import { applyTriggerMapping } from '../../../src/lib/server/triggers/mapping';
import { requireTriggerRow } from '../../../src/lib/server/triggers/service';
import { getWorkflowItemDetail } from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createFakeFileService,
  createObjectType,
  createRecord,
  createTriggerRecord,
  createUser,
  createWorkflow,
  createWorkflowItem,
  createWorkspace,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let workflow: WorkflowFixture;
let files: ReturnType<typeof createFakeFileService>;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Mapping');
  workspaceId = workspace.id;
  ownerId = (await createUser(handle.db, { name: 'Owner' })).id;
  const objectType = await createObjectType(handle.db, {
    workspaceId,
    name: 'Order',
    fields: [
      { key: 'name', type: 'short_text' },
      { key: 'externalId', type: 'short_text' },
      { key: 'status', type: 'short_text' }
    ]
  });
  workflow = await createWorkflow(handle.db, workspaceId, { objectTypeId: objectType.id });
  files = createFakeFileService();
});

afterEach(() => {
  handle.cleanup();
});

/** Insert a trigger and read back the persisted row. */
async function persistTrigger(options: {
  name: string;
  upsertOnDedupe?: boolean;
  targetStateId?: string | null;
  mapping: Record<string, unknown>;
}) {
  const created = await createTriggerRecord(handle.db, {
    workspaceId,
    workflowId: workflow.id,
    name: options.name,
    type: 'manual',
    upsertOnDedupe: options.upsertOnDedupe,
    targetStateId: options.targetStateId ?? null,
    config: { mapping: options.mapping }
  });
  return requireTriggerRow(handle.db, workspaceId, created.id);
}

function recordRow(id: string) {
  return handle.db.select().from(records).where(eq(records.id, id)).all()[0];
}

function itemRow(id: string) {
  return handle.db.select().from(workflowItems).where(eq(workflowItems.id, id)).all()[0];
}

function fieldValues(workflowItemId: string) {
  return getWorkflowItemDetail(handle.db, systemActor(workspaceId), workflowItemId);
}

describe('triggers/mapping integration', () => {
  test('creates work with typed fields, priority, ownership and labels', async () => {
    const trigger = await persistTrigger({
      name: 'Fields',
      targetStateId: workflow.states[1],
      mapping: {
        titleTemplate: '{{subject}}',
        fieldPaths: { externalId: 'id' },
        priorityPath: 'priority',
        ownerUserId: ownerId,
        labels: ['intake']
      }
    });

    const result = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'New order', id: 'ORD-1', priority: 'urgent' },
      fileService: files.service
    });

    const record = recordRow(result.recordId);
    expect(record?.displayName).toBe('New order');
    expect((await fieldValues(result.workflowItemId)).fields.externalId).toBe('ORD-1');

    const item = itemRow(result.workflowItemId);
    expect(item?.ownerUserId).toBe(ownerId);
    expect((item?.structuredData as Record<string, unknown>)?.priority).toBe('urgent');

    const applied = handle.db
      .select({ name: labels.name })
      .from(workflowItemLabels)
      .innerJoin(labels, eq(labels.id, workflowItemLabels.labelId))
      .where(eq(workflowItemLabels.workflowItemId, result.workflowItemId))
      .all()
      .map((row) => row.name);
    expect(applied).toEqual(['intake']);

    expect(result.fieldKeysSet).toContain('externalId');
    expect(result.stateId).toBe(workflow.states[1]!);
  });

  test('ingests attachments with incoming_email provenance and links to work', async () => {
    const trigger = await persistTrigger({
      name: 'Attachments',
      mapping: {
        titleTemplate: '{{subject}}',
        attachmentPaths: ['attachments']
      }
    });

    const result = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: {
        subject: 'Email intake',
        attachments: [
          {
            filename: 'contract.pdf',
            contentBase64: Buffer.from('contract').toString('base64'),
            mimeType: 'application/pdf'
          }
        ]
      },
      fileService: files.service,
      sourceType: 'incoming_email',
      reference: 'imap-message-9',
      triggerEventId: 'event-9'
    });

    expect(result.filesIngested).toBe(1);
    expect(files.ingestCalls[0]).toMatchObject({
      filename: 'contract.pdf',
      relationship: 'attachment',
      workflowItemId: result.workflowItemId,
      recordId: result.recordId,
      workflowId: workflow.id
    });
    expect(files.ingestCalls[0]?.source).toMatchObject({
      type: 'incoming_email',
      reference: 'imap-message-9',
      triggerEventId: 'event-9'
    });
  });

  test('parentRecordPath links the created work under the parent work item', async () => {
    const parent = await createWorkflowItem(handle.db, { workspaceId, workflow });
    const trigger = await persistTrigger({
      name: 'Sub task',
      mapping: { titlePath: 'subject', parentRecordPath: 'parent' }
    });

    const result = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Child', parent: parent.recordId },
      fileService: files.service
    });
    const relationship = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(
        and(
          eq(workflowItemRelationships.fromWorkflowItemId, result.workflowItemId),
          eq(workflowItemRelationships.type, 'parent')
        )
      )
      .all()[0];
    expect(relationship?.toWorkflowItemId).toBe(parent.id);
  });

  test('parentRecordPath for a record with no active work is skipped, not failed', async () => {
    // A Record that has no WorkflowItem in the destination workflow.
    const record = await createRecord(handle.db, {
      workspaceId,
      objectTypeId: workflow.objectTypeId,
      displayName: 'Orphan record'
    });
    const trigger = await persistTrigger({
      name: 'Skip parent',
      mapping: { titlePath: 'subject', parentRecordPath: 'parent' }
    });
    const result = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Child', parent: record.id },
      fileService: files.service
    });
    expect(itemRow(result.workflowItemId)?.recordId).toBeTruthy();
    expect(
      handle.db
        .select()
        .from(workflowItemRelationships)
        .where(eq(workflowItemRelationships.fromWorkflowItemId, result.workflowItemId))
        .all()
    ).toHaveLength(0);
  });

  test('upsertOnDedupe refreshes rather than duplicating', async () => {
    const trigger = await persistTrigger({
      name: 'Upserting',
      upsertOnDedupe: true,
      mapping: {
        titlePath: 'subject',
        dedupeTemplate: 'ext-{{id}}',
        fieldPaths: { status: 'status' }
      }
    });

    const first = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'One', id: 'X', status: 'open' },
      fileService: files.service
    });
    const second = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Two', id: 'X', status: 'closed' },
      fileService: files.service
    });

    expect(first.upserted).toBe(false);
    expect(second.upserted).toBe(true);
    expect(second.recordId).toBe(first.recordId);
    expect(second.workflowItemId).toBe(first.workflowItemId);
    expect(handle.db.select().from(records).all()).toHaveLength(1);
    expect(handle.db.select().from(workflowItems).all()).toHaveLength(1);
    expect((await fieldValues(second.workflowItemId)).fields.status).toBe('closed');
  });

  test('missing required template input fails the mapping', async () => {
    const trigger = await persistTrigger({
      name: 'Strict',
      mapping: { titleTemplate: 'Order {{missing.value}}' }
    });

    await expect(
      applyTriggerMapping(handle.db as Executor, {
        trigger,
        payload: {},
        fileService: files.service,
        actor: systemActor(workspaceId)
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(handle.db.select().from(records).all()).toHaveLength(0);
  });

  test('records trigger provenance on the created record and work item', async () => {
    const trigger = await persistTrigger({
      name: 'Provenance',
      mapping: { titleTemplate: '{{subject}}' }
    });

    const result = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Prov' },
      fileService: files.service,
      reference: 'delivery-7',
      triggerEventId: 'event-7'
    });
    expect(recordRow(result.recordId)?.provenance).toMatchObject({
      triggerId: trigger.id,
      triggerEventId: 'event-7',
      sourceReference: 'delivery-7'
    });
    expect(itemRow(result.workflowItemId)?.provenance).toMatchObject({
      triggerId: trigger.id,
      triggerEventId: 'event-7',
      sourceReference: 'delivery-7'
    });
  });
});
