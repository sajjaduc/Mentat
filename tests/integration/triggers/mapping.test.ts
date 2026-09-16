/**
 * Mapping against a persisted trigger.
 *
 * This is the integration half of the mapping contract: a stored trigger row is
 * read back and applied to a payload, with the recording ticket/file services
 * standing in for the separately owned implementations.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { systemActor } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import { applyTriggerMapping } from '../../../src/lib/server/triggers/mapping';
import { requireTriggerRow } from '../../../src/lib/server/triggers/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createFakeFileService,
  createFakeTicketService,
  createTriggerRecord,
  createWorkflow,
  createWorkspace,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;
let tickets: ReturnType<typeof createFakeTicketService>;
let files: ReturnType<typeof createFakeFileService>;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Mapping');
  workspaceId = workspace.id;
  workflow = await createWorkflow(handle.db, workspaceId);
  tickets = createFakeTicketService({ defaultStateId: workflow.states[1] });
  files = createFakeFileService();
});

afterEach(() => {
  handle.cleanup();
});

/** Insert a trigger and read back the persisted row. */
async function persistTrigger(options: {
  name: string;
  upsertOnDedupe?: boolean;
  mapping: Record<string, unknown>;
}) {
  const created = await createTriggerRecord(handle.db, {
    workspaceId,
    workflowId: workflow.id,
    name: options.name,
    type: 'manual',
    upsertOnDedupe: options.upsertOnDedupe,
    config: { mapping: options.mapping }
  });
  return requireTriggerRow(handle.db, workspaceId, created.id);
}

describe('triggers/mapping integration', () => {
  test('creates a ticket with typed fields, priority, ownership and labels', async () => {
    const trigger = await persistTrigger({
      name: 'Fields',
      mapping: {
        titleTemplate: '{{subject}}',
        fieldPaths: { externalId: 'id' },
        priorityPath: 'priority',
        ownerUserId: 'user-owner',
        labels: ['intake']
      }
    });

    const result = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'New order', id: 'ORD-1', priority: 'urgent' },
      ticketService: tickets.service,
      fileService: files.service
    });

    expect(tickets.createCalls).toHaveLength(1);
    expect(tickets.createCalls[0]).toMatchObject({
      title: 'New order',
      workflowId: workflow.id,
      priority: 'urgent',
      ownerUserId: 'user-owner',
      labelNames: ['intake'],
      fields: { externalId: 'ORD-1' }
    });
    expect(result.fieldKeysSet).toEqual(['externalId']);
    expect(result.stateId).toBe(workflow.states[1]!);
  });

  test('ingests attachments with incoming_email provenance and a ticket link', async () => {
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
      ticketService: tickets.service,
      fileService: files.service,
      sourceType: 'incoming_email',
      reference: 'imap-message-9',
      triggerEventId: 'event-9'
    });

    expect(result.filesIngested).toBe(1);
    expect(files.ingestCalls[0]).toMatchObject({
      filename: 'contract.pdf',
      relationship: 'attachment',
      ticketId: result.ticketId,
      workflowId: workflow.id
    });
    expect(files.ingestCalls[0]?.source).toMatchObject({
      type: 'incoming_email',
      reference: 'imap-message-9',
      triggerEventId: 'event-9'
    });
  });

  test('parentTicketPath asks the ticket service to create a child', async () => {
    const trigger = await persistTrigger({
      name: 'Sub task',
      mapping: { titlePath: 'subject', parentTicketPath: 'parent' }
    });

    await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Child', parent: 'TICKET-1' },
      ticketService: tickets.service,
      fileService: files.service
    });
    expect(tickets.createCalls[0]?.parentTicketId).toBe('TICKET-1');
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
      ticketService: tickets.service,
      fileService: files.service
    });
    const second = await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Two', id: 'X', status: 'closed' },
      ticketService: tickets.service,
      fileService: files.service
    });

    expect(first.ticketId).toBe(second.ticketId);
    expect(tickets.tickets()).toHaveLength(1);
    expect(tickets.fieldCalls.at(-1)?.values).toEqual({ status: 'closed' });
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
        ticketService: tickets.service,
        fileService: files.service,
        actor: systemActor(workspaceId)
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(tickets.createCalls).toHaveLength(0);
  });

  test('records trigger provenance on the created ticket', async () => {
    const trigger = await persistTrigger({
      name: 'Provenance',
      mapping: { titleTemplate: '{{subject}}' }
    });

    await applyTriggerMapping(handle.db as Executor, {
      trigger,
      payload: { subject: 'Prov' },
      ticketService: tickets.service,
      fileService: files.service,
      reference: 'delivery-7',
      triggerEventId: 'event-7'
    });
    expect(tickets.createCalls[0]?.provenance).toMatchObject({
      triggerId: trigger.id,
      triggerEventId: 'event-7',
      sourceReference: 'delivery-7'
    });
  });
});
