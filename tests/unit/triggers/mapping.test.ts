/**
 * Mapping templates and dot-paths.
 *
 * The mapping is data-driven, so these tests pin the contract: templates read
 * exactly the paths they name, missing required inputs fail loudly instead of
 * producing blank tickets, and attachments carry provenance into the file store.
 */
import { describe, expect, test } from 'bun:test';
import { isAppError } from '../../../src/lib/server/core/errors';
import type { Executor } from '../../../src/lib/server/db/client';
import type { Trigger } from '../../../src/lib/server/db/schema';
import { applyTriggerMapping } from '../../../src/lib/server/triggers/mapping';
import { createFakeFileService, createFakeTicketService } from '../../helpers/factories';

// Mapping never touches the database itself; it delegates through the service
// locators. A stand-in executor keeps these tests pure.
const noDb = {} as unknown as Executor;

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trigger-1',
    workspaceId: 'ws-1',
    workflowId: 'wf-1',
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

describe('triggers/mapping title and description', () => {
  test('renders templates from nested dot-paths', async () => {
    const tickets = createFakeTicketService();
    const result = await applyTriggerMapping(noDb, {
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
      },
      ticketService: tickets.service
    });

    expect(result.ticketId).toBeTruthy();
    expect(tickets.createCalls).toHaveLength(1);
    expect(tickets.createCalls[0]?.title).toBe('Order 42 for Ada');
    expect(tickets.createCalls[0]?.description).toBe('Raised by ada@example.test');
    expect(result.workflowId).toBe('wf-1');
  });

  test('reads a plain dot-path title', async () => {
    const tickets = createFakeTicketService();
    await applyTriggerMapping(noDb, {
      trigger: makeTrigger({ config: { mapping: { titlePath: 'subject' } } }),
      payload: { subject: 'Broken printer' },
      ticketService: tickets.service
    });
    expect(tickets.createCalls[0]?.title).toBe('Broken printer');
  });

  test('falls back to the trigger name when no title is configured', async () => {
    const tickets = createFakeTicketService();
    await applyTriggerMapping(noDb, {
      trigger: makeTrigger({ name: 'Nightly import', config: { mapping: {} } }),
      payload: {},
      ticketService: tickets.service
    });
    expect(tickets.createCalls[0]?.title).toBe('Nightly import');
  });

  test('fails with a validation error when a template input is missing', async () => {
    const tickets = createFakeTicketService();
    try {
      await applyTriggerMapping(noDb, {
        trigger: makeTrigger({
          config: { mapping: { titleTemplate: 'Order {{data.missing}}' } }
        }),
        payload: { data: {} },
        ticketService: tickets.service
      });
      throw new Error('expected mapping to throw');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('validation_failed');
        expect(error.details).toMatchObject({ missing: ['data.missing'] });
      }
    }
    expect(tickets.createCalls).toHaveLength(0);
  });

  test('fails when a required title path resolves to nothing', async () => {
    const tickets = createFakeTicketService();
    await expect(
      applyTriggerMapping(noDb, {
        trigger: makeTrigger({ config: { mapping: { titlePath: 'data.subject' } } }),
        payload: { data: {} },
        ticketService: tickets.service
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('triggers/mapping fields, priority, ownership and labels', () => {
  test('sets typed fields from dot-paths and templates', async () => {
    const tickets = createFakeTicketService();
    const result = await applyTriggerMapping(noDb, {
      trigger: makeTrigger({
        config: {
          mapping: {
            titleTemplate: 'Ticket {{data.id}}',
            fieldPaths: { orderId: 'data.order.id', firstTag: 'tags[0]' },
            fieldTemplates: { summary: 'Order {{data.order.id}} ({{data.id}})' }
          }
        }
      }),
      payload: { data: { id: 7, order: { id: 'ORD-9' } }, tags: ['alpha', 'beta'] },
      ticketService: tickets.service
    });

    expect(tickets.createCalls[0]?.fields).toEqual({
      orderId: 'ORD-9',
      firstTag: 'alpha',
      summary: 'Order ORD-9 (7)'
    });
    expect(result.fieldKeysSet.sort()).toEqual(['firstTag', 'orderId', 'summary']);
  });

  test('skips a field path that is absent rather than writing null', async () => {
    const tickets = createFakeTicketService();
    await applyTriggerMapping(noDb, {
      trigger: makeTrigger({
        config: { mapping: { titlePath: 'subject', fieldPaths: { missing: 'data.nope' } } }
      }),
      payload: { subject: 'x' },
      ticketService: tickets.service
    });
    expect(tickets.createCalls[0]?.fields).toEqual({});
  });

  test('maps priority, owner, team and labels', async () => {
    const tickets = createFakeTicketService();
    const result = await applyTriggerMapping(noDb, {
      trigger: makeTrigger({
        config: {
          mapping: {
            titlePath: 'subject',
            priorityPath: 'priority',
            ownerUserId: 'user-1',
            ownerTeamId: 'team-1',
            labels: ['vip', 'urgent']
          }
        }
      }),
      payload: { subject: 'Escalation', priority: 'HIGH' },
      ticketService: tickets.service
    });

    expect(tickets.createCalls[0]?.priority).toBe('high');
    expect(tickets.createCalls[0]?.ownerUserId).toBe('user-1');
    expect(tickets.createCalls[0]?.ownerTeamId).toBe('team-1');
    expect(tickets.createCalls[0]?.labelNames).toEqual(['vip', 'urgent']);
    expect(result.stateId).toBe('state-default');
  });

  test('rejects an unknown priority value', async () => {
    const tickets = createFakeTicketService();
    await expect(
      applyTriggerMapping(noDb, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', priorityPath: 'priority' } }
        }),
        payload: { subject: 'x', priority: 'whenever' },
        ticketService: tickets.service
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('honours target workflow and state overrides', async () => {
    const tickets = createFakeTicketService();
    const result = await applyTriggerMapping(noDb, {
      trigger: makeTrigger({
        targetStateId: 'state-from-trigger',
        config: {
          mapping: {
            titlePath: 'subject',
            targetWorkflowId: 'wf-2',
            targetStateId: 'state-from-mapping'
          }
        }
      }),
      payload: { subject: 'Routed' },
      ticketService: tickets.service
    });
    expect(tickets.createCalls[0]?.workflowId).toBe('wf-2');
    expect(tickets.createCalls[0]?.stateId).toBe('state-from-mapping');
    expect(result.workflowId).toBe('wf-2');
  });
});

describe('triggers/mapping dedupe and parent links', () => {
  test('computes a dedupe key from a template', async () => {
    const tickets = createFakeTicketService();
    const result = await applyTriggerMapping(noDb, {
      trigger: makeTrigger({
        config: {
          mapping: { titlePath: 'subject', dedupeTemplate: 'ext-{{data.id}}' }
        }
      }),
      payload: { subject: 'x', data: { id: 42 } },
      ticketService: tickets.service
    });
    expect(result.dedupeKey).toBe('ext-42');
    expect(tickets.createCalls[0]?.dedupeKey).toBe('ext-42');
  });

  test('upsertOnDedupe refreshes the existing ticket instead of duplicating', async () => {
    const tickets = createFakeTicketService();
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
    const first = await applyTriggerMapping(noDb, {
      trigger,
      payload: { subject: 'first', status: 'open', data: { id: 42 } },
      ticketService: tickets.service
    });
    const second = await applyTriggerMapping(noDb, {
      trigger,
      payload: { subject: 'second', status: 'closed', data: { id: 42 } },
      ticketService: tickets.service
    });

    expect(first.ticketId).toBe(second.ticketId);
    expect(tickets.tickets()).toHaveLength(1);
    expect(tickets.createCalls).toHaveLength(2);
    // `create` does not report whether it reused the dedupe match, so an upsert
    // re-applies the mapped fields on every delivery; the latest payload wins and
    // the ticket is never duplicated.
    expect(tickets.fieldCalls).toHaveLength(2);
    expect(tickets.fieldCalls[1]).toMatchObject({
      ticketId: first.ticketId,
      values: { status: 'closed' }
    });
    expect(second.upserted).toBe(true);
  });

  test('links the new ticket to a parent referenced by the payload', async () => {
    const tickets = createFakeTicketService();
    await applyTriggerMapping(noDb, {
      trigger: makeTrigger({
        config: { mapping: { titlePath: 'subject', parentTicketPath: 'parentTicketId' } }
      }),
      payload: { subject: 'Sub-task', parentTicketId: 'parent-123' },
      ticketService: tickets.service
    });
    expect(tickets.createCalls[0]?.parentTicketId).toBe('parent-123');
  });

  test('fails when parentTicketPath does not resolve to a ticket id', async () => {
    const tickets = createFakeTicketService();
    await expect(
      applyTriggerMapping(noDb, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', parentTicketPath: 'parentTicketId' } }
        }),
        payload: { subject: 'Sub-task' },
        ticketService: tickets.service
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('triggers/mapping attachments', () => {
  test('ingests attachments with source provenance and a ticket link', async () => {
    const tickets = createFakeTicketService();
    const files = createFakeFileService();
    const content = Buffer.from('invoice-bytes').toString('base64');
    const result = await applyTriggerMapping(noDb, {
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
      ticketService: tickets.service,
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
    expect(first?.ticketId).toBe(result.ticketId);
    expect(first?.relationship).toBe('attachment');
    expect(first?.filename).toBe('invoice.pdf');
    expect(new TextDecoder().decode(first?.bytes)).toBe('invoice-bytes');
    expect(new TextDecoder().decode(files.ingestCalls[1]?.bytes)).toBe('hello');
  });

  test('rejects an attachment path that resolves to nothing', async () => {
    const tickets = createFakeTicketService();
    const files = createFakeFileService();
    await expect(
      applyTriggerMapping(noDb, {
        trigger: makeTrigger({
          config: { mapping: { titlePath: 'subject', attachmentPaths: ['attachments'] } }
        }),
        payload: { subject: 'x' },
        ticketService: tickets.service,
        fileService: files.service
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
