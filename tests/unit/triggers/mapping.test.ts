/**
 * Mapping templates and dot-paths.
 *
 * ADR-0021 removed the Ticket primitive: mapping now routes work through the real
 * records + workflow-items services. These tests therefore run against a real
 * in-memory database with an Object Type and workflow, and assert on the persisted
 * `records` / `workflow_items` / field values rather than a recording stand-in.
 *
 * The mapping contract itself is unchanged and remains data-driven: templates read
 * exactly the paths they name, missing required inputs fail loudly instead of
 * producing blank work, and attachments carry provenance into the file store.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { systemActor } from '../../../src/lib/server/core/context';
import { isAppError } from '../../../src/lib/server/core/errors';
import {
  labels,
  recordExternalIds,
  records,
  type Trigger,
  workflowItemLabels,
  workflowItemRelationships,
  workflowItems
} from '../../../src/lib/server/db/schema';
import {
  applyTriggerMapping,
  TRIGGER_EXTERNAL_SYSTEM
} from '../../../src/lib/server/triggers/mapping';
import { getWorkflowItemDetail } from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createFakeFileService,
  createObjectType,
  createTeam,
  createUser,
  createWorkflow,
  createWorkflowItem,
  createWorkspace,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Mapping unit');
  workspaceId = workspace.id;
  const objectType = await createObjectType(handle.db, {
    workspaceId,
    name: 'Order',
    fields: [
      { key: 'orderId', type: 'short_text' },
      { key: 'firstTag', type: 'short_text' },
      { key: 'summary', type: 'short_text' },
      { key: 'status', type: 'short_text' },
      { key: 'externalId', type: 'short_text' }
    ]
  });
  workflow = await createWorkflow(handle.db, workspaceId, { objectTypeId: objectType.id });
});

afterEach(() => {
  handle.cleanup();
});

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    workspaceId,
    workflowId: workflow.id,
    name: 'Intake',
    description: null,
    type: 'webhook',
    enabled: true,
    webhookToken: 'tok-1',
    config: {},
    targetStateId: null,
    upsertOnDedupe: false,
    createdByUserId: null,
    lastFiredAt: null,
    nextRunAt: null,
    lastError: null,
    fireCount: 0,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...overrides
  };
}

function recordRow(id: string) {
  return handle.db.select().from(records).where(eq(records.id, id)).all()[0];
}

function itemRow(id: string) {
  return handle.db.select().from(workflowItems).where(eq(workflowItems.id, id)).all()[0];
}

function itemFieldValues(workflowItemId: string) {
  return getWorkflowItemDetail(handle.db, systemActor(workspaceId), workflowItemId);
}

describe('triggers/mapping title and description', () => {
  test('renders templates from nested dot-paths', async () => {
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: {
          mapping: {
            titleTemplate: 'Order {{data.id}} for {{customer.name}}',
            descriptionTemplate: 'Raised by {{customer.email}}'
          }
        }
      }),
      payload: {
        data: { id: 42 },
        customer: { name: 'Ada', email: 'ada@example.test' }
      }
    });

    const record = recordRow(result.recordId);
    expect(record?.displayName).toBe('Order 42 for Ada');
    expect((record?.structuredData as Record<string, unknown>)?.description).toBe(
      'Raised by ada@example.test'
    );
    expect(result.workflowId).toBe(workflow.id);
    expect(result.upserted).toBe(false);
  });

  test('reads a plain dot-path title', async () => {
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({ config: { mapping: { titlePath: 'subject' } } }),
      payload: { subject: 'Broken printer' }
    });
    expect(recordRow(result.recordId)?.displayName).toBe('Broken printer');
  });

  test('falls back to the trigger name when no title is configured', async () => {
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({ name: 'Nightly import', config: { mapping: {} } }),
      payload: {}
    });
    expect(recordRow(result.recordId)?.displayName).toBe('Nightly import');
  });

  test('fails with a validation error when a template input is missing', async () => {
    try {
      await applyTriggerMapping(handle.db, {
        trigger: makeTrigger({
          config: { mapping: { titleTemplate: 'Order {{data.missing}}' } }
        }),
        payload: { data: {} }
      });
      throw new Error('expected mapping to throw');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('validation_failed');
        expect(error.details).toMatchObject({ missing: ['data.missing'] });
      }
    }
    expect(handle.db.select().from(records).all()).toHaveLength(0);
    expect(handle.db.select().from(workflowItems).all()).toHaveLength(0);
  });

  test('fails when a required title path resolves to nothing', async () => {
    await expect(
      applyTriggerMapping(handle.db, {
        trigger: makeTrigger({ config: { mapping: { titlePath: 'data.subject' } } }),
        payload: { data: {} }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('triggers/mapping fields, priority, ownership and labels', () => {
  test('sets typed fields from dot-paths and templates', async () => {
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: {
          mapping: {
            titleTemplate: 'Ticket {{data.id}}',
            fieldPaths: { orderId: 'data.order.id', firstTag: 'tags[0]' },
            fieldTemplates: { summary: 'Order {{data.order.id}} ({{data.id}})' }
          }
        }
      }),
      payload: { data: { id: 7, order: { id: 'ORD-9' } }, tags: ['alpha', 'beta'] }
    });

    const detail = await itemFieldValues(result.workflowItemId);
    expect(detail.fields).toEqual({
      orderId: 'ORD-9',
      firstTag: 'alpha',
      summary: 'Order ORD-9 (7)'
    });
    expect(result.fieldKeysSet.sort()).toEqual(['firstTag', 'orderId', 'summary']);
  });

  test('skips a field path that is absent rather than writing null', async () => {
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: { mapping: { titlePath: 'subject', fieldPaths: { status: 'data.nope' } } }
      }),
      payload: { subject: 'x' }
    });
    const fields = (await itemFieldValues(result.workflowItemId)).fields;
    expect(fields.status).toBeUndefined();
    expect(result.fieldKeysSet).not.toContain('status');
  });

  test('maps priority, owner, team and labels', async () => {
    const owner = await createUser(handle.db, { name: 'Owner' });
    const teamId = await createTeam(handle.db, workspaceId, 'Triage');
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: {
          mapping: {
            titlePath: 'subject',
            priorityPath: 'priority',
            ownerUserId: owner.id,
            ownerTeamId: teamId,
            labels: ['vip', 'urgent']
          }
        }
      }),
      payload: { subject: 'Escalation', priority: 'HIGH' }
    });

    const item = itemRow(result.workflowItemId);
    expect((item?.structuredData as Record<string, unknown>)?.priority).toBe('high');
    expect(item?.ownerUserId).toBe(owner.id);
    expect(item?.ownerTeamId).toBe(teamId);

    const applied = handle.db
      .select({ name: labels.name })
      .from(workflowItemLabels)
      .innerJoin(labels, eq(labels.id, workflowItemLabels.labelId))
      .where(eq(workflowItemLabels.workflowItemId, result.workflowItemId))
      .all()
      .map((row) => row.name)
      .sort();
    expect(applied).toEqual(['urgent', 'vip']);
    expect(result.stateId).toBe(workflow.states[0]!);
  });

  test('rejects an unknown priority value', async () => {
    await expect(
      applyTriggerMapping(handle.db, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', priorityPath: 'priority' } }
        }),
        payload: { subject: 'x', priority: 'whenever' }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('honours target workflow and state overrides', async () => {
    const otherObjectType = await createObjectType(handle.db, {
      workspaceId,
      name: 'Routing'
    });
    const otherWorkflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Routing workflow',
      objectTypeId: otherObjectType.id
    });
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        targetStateId: workflow.states[1],
        config: {
          mapping: {
            titlePath: 'subject',
            targetWorkflowId: otherWorkflow.id,
            targetStateId: otherWorkflow.states[1]
          }
        }
      }),
      payload: { subject: 'Routed' }
    });
    expect(itemRow(result.workflowItemId)?.workflowId).toBe(otherWorkflow.id);
    expect(result.workflowId).toBe(otherWorkflow.id);
    expect(result.stateId).toBe(otherWorkflow.states[1]!);
  });
});

describe('triggers/mapping dedupe and parent links', () => {
  test('computes a dedupe key from a template and records the external id', async () => {
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: {
          mapping: { titlePath: 'subject', dedupeTemplate: 'ext-{{data.id}}' }
        }
      }),
      payload: { subject: 'x', data: { id: 42 } }
    });
    expect(result.dedupeKey).toBe('ext-42');
    const external = handle.db
      .select()
      .from(recordExternalIds)
      .where(eq(recordExternalIds.externalId, 'ext-42'))
      .all()[0];
    expect(external).toMatchObject({
      recordId: result.recordId,
      system: TRIGGER_EXTERNAL_SYSTEM
    });
  });

  test('upsertOnDedupe refreshes the existing work instead of duplicating', async () => {
    const trigger = makeTrigger({
      upsertOnDedupe: true,
      config: {
        mapping: {
          titlePath: 'subject',
          dedupeTemplate: 'ext-{{data.id}}',
          fieldPaths: { status: 'status' }
        }
      }
    });
    const first = await applyTriggerMapping(handle.db, {
      trigger,
      payload: { subject: 'first', status: 'open', data: { id: 42 } }
    });
    const second = await applyTriggerMapping(handle.db, {
      trigger,
      payload: { subject: 'second', status: 'closed', data: { id: 42 } }
    });

    expect(first.upserted).toBe(false);
    expect(second.upserted).toBe(true);
    expect(second.recordId).toBe(first.recordId);
    expect(second.workflowItemId).toBe(first.workflowItemId);
    expect(handle.db.select().from(records).all()).toHaveLength(1);
    expect(handle.db.select().from(workflowItems).all()).toHaveLength(1);
    // The latest payload wins on the mapped field; work is never duplicated.
    expect((await itemFieldValues(second.workflowItemId)).fields.status).toBe('closed');
  });

  test('links the new work item to a parent referenced by the payload', async () => {
    const parent = await createWorkflowItem(handle.db, { workspaceId, workflow });
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: { mapping: { titlePath: 'subject', parentRecordPath: 'parentRecordId' } }
      }),
      payload: { subject: 'Sub-task', parentRecordId: parent.recordId }
    });
    const relationship = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(eq(workflowItemRelationships.fromWorkflowItemId, result.workflowItemId))
      .all()[0];
    expect(relationship).toMatchObject({
      toWorkflowItemId: parent.id,
      type: 'parent'
    });
  });

  test('fails when parentRecordPath does not resolve to a record id', async () => {
    await expect(
      applyTriggerMapping(handle.db, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', parentRecordPath: 'parentRecordId' } }
        }),
        payload: { subject: 'Sub-task' }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('fails when parentRecordPath names an unknown record', async () => {
    await expect(
      applyTriggerMapping(handle.db, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', parentRecordPath: 'parentRecordId' } }
        }),
        payload: { subject: 'Sub-task', parentRecordId: 'record-missing' }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('triggers/mapping attachments', () => {
  test('ingests attachments with source provenance and links to record and work item', async () => {
    const files = createFakeFileService();
    const content = Buffer.from('invoice-bytes').toString('base64');
    const result = await applyTriggerMapping(handle.db, {
      trigger: makeTrigger({
        config: { mapping: { titlePath: 'subject', attachmentPaths: ['attachments'] } }
      }),
      payload: {
        subject: 'Invoice',
        attachments: [
          { filename: 'invoice.pdf', contentBase64: content, mimeType: 'application/pdf' },
          { filename: 'note.txt', content: 'hello', mimeType: 'text/plain' }
        ]
      },
      fileService: files.service,
      sourceType: 'incoming_email',
      reference: 'message-1',
      triggerEventId: 'event-1'
    });

    expect(result.filesIngested).toBe(2);
    expect(files.ingestCalls).toHaveLength(2);
    const first = files.ingestCalls[0];
    expect(first?.source.type).toBe('incoming_email');
    expect(first?.source.reference).toBe('message-1');
    expect(first?.source.triggerEventId).toBe('event-1');
    expect(first?.workflowItemId).toBe(result.workflowItemId);
    expect(first?.recordId).toBe(result.recordId);
    expect(first?.relationship).toBe('attachment');
    expect(first?.filename).toBe('invoice.pdf');
    expect(new TextDecoder().decode(first?.bytes)).toBe('invoice-bytes');
    expect(new TextDecoder().decode(files.ingestCalls[1]?.bytes)).toBe('hello');
  });

  test('rejects an attachment path that resolves to nothing', async () => {
    const files = createFakeFileService();
    await expect(
      applyTriggerMapping(handle.db, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', attachmentPaths: ['attachments'] } }
        }),
        payload: { subject: 'x' },
        fileService: files.service
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
