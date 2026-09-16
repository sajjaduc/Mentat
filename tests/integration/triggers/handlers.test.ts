/**
 * Trigger job handlers.
 *
 * The handler is the boundary between "an event was persisted" and "a ticket
 * exists". It must mark the event processed with the ticket id, be safe to run
 * twice, and record failures visibly without losing the event.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import { systemActor } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import { setFileService } from '../../../src/lib/server/files/contracts';
import { clearJobHandlers, requireJobHandler } from '../../../src/lib/server/jobs/handlers';
import { SqliteJobQueue } from '../../../src/lib/server/jobs/queue';
import { setTicketService } from '../../../src/lib/server/tickets/contracts';
import { scheduleDueTriggers } from '../../../src/lib/server/triggers/cron';
import { registerTriggerJobHandlers } from '../../../src/lib/server/triggers/handlers';
import { receiveWebhook } from '../../../src/lib/server/triggers/webhook';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createFakeFileService,
  createFakeTicketService,
  createTriggerRecord,
  createWorkflow,
  createWorkspace,
  type WorkflowFixture
} from '../../helpers/factories';
import { runPendingJobs } from './support';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;
let tickets: ReturnType<typeof createFakeTicketService>;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Handlers');
  workspaceId = workspace.id;
  workflow = await createWorkflow(handle.db, workspaceId);
  tickets = createFakeTicketService({ defaultStateId: workflow.states[0] });
  setTicketService(tickets.service);
  setFileService(createFakeFileService().service);
  clearJobHandlers();
  registerTriggerJobHandlers();
});

afterEach(() => {
  setTicketService(null);
  setFileService(null);
  clearJobHandlers();
  handle.cleanup();
});

async function createWebhookTrigger(mapping: Record<string, unknown>) {
  return createTriggerRecord(handle.db, {
    workspaceId,
    workflowId: workflow.id,
    name: `Hook ${JSON.stringify(mapping)}`,
    type: 'webhook',
    webhookToken: `token-${Math.random().toString(36).slice(2, 10)}`,
    config: { signatureRequired: false, mapping }
  });
}

describe('triggers/handlers', () => {
  test('marks an event processed with the created ticket id', async () => {
    const trigger = await createWebhookTrigger({ titlePath: 'subject' });
    await receiveWebhook(handle.db, systemActor(workspaceId), {
      token: trigger.webhookToken ?? '',
      rawBody: JSON.stringify({ subject: 'Process me' }),
      headers: {}
    });

    expect(await runPendingJobs(handle.db)).toBe(1);
    const event = handle.sqlite
      .query<{ status: string; ticket_id: string | null; processed_at: number | null }, []>(
        'SELECT status, ticket_id, processed_at FROM trigger_events'
      )
      .get();
    expect(event?.status).toBe('processed');
    expect(event?.ticket_id).toBeTruthy();
    expect(event?.processed_at).toBeTruthy();
    expect(tickets.createCalls).toHaveLength(1);

    const processed = await queryAudit(handle.db, {
      workspaceId,
      actions: ['trigger.processed']
    });
    expect(processed).toHaveLength(1);
    expect(processed[0]?.ticketId).toBe(event?.ticket_id ?? null);
  });

  test('processing the same event twice is idempotent', async () => {
    const trigger = await createWebhookTrigger({ titlePath: 'subject' });
    const received = await receiveWebhook(handle.db, systemActor(workspaceId), {
      token: trigger.webhookToken ?? '',
      rawBody: JSON.stringify({ subject: 'Once only' }),
      headers: {}
    });
    expect(await runPendingJobs(handle.db)).toBe(1);
    expect(tickets.createCalls).toHaveLength(1);

    // A second delivery of the same event must not create a second ticket.
    const queue = new SqliteJobQueue(handle.db);
    await queue.enqueue({
      workspaceId,
      type: 'trigger.webhook',
      payload: { eventId: received.eventId },
      dedupeKey: `replay:${received.eventId}`
    });
    const handler = requireJobHandler('trigger.webhook');
    const leased = await queue.lease({ workerId: 'replay-worker' });
    expect(leased).toBeTruthy();
    const result = await handler({
      job: leased!,
      db: handle.db as Executor,
      workerId: 'replay-worker',
      heartbeat: async () => {},
      signal: new AbortController().signal
    });
    expect(result?.skipRetry).toBe(true);
    expect(tickets.createCalls).toHaveLength(1);
    expect(handle.sqlite.query('SELECT count(*) AS n FROM jobs').get()).toMatchObject({ n: 2 });
  });

  test('records a failed event and the trigger error when mapping fails', async () => {
    const trigger = await createWebhookTrigger({ titleTemplate: 'Order {{missing.value}}' });
    const received = await receiveWebhook(handle.db, systemActor(workspaceId), {
      token: trigger.webhookToken ?? '',
      rawBody: JSON.stringify({ subject: 'Will fail' }),
      headers: {}
    });

    const queue = new SqliteJobQueue(handle.db);
    const handler = requireJobHandler('trigger.webhook');
    const leased = await queue.lease({ workerId: 'fail-worker' });
    expect(leased?.payload).toMatchObject({ eventId: received.eventId });
    await expect(
      handler({
        job: leased!,
        db: handle.db as Executor,
        workerId: 'fail-worker',
        heartbeat: async () => {},
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const event = handle.sqlite
      .query<{ status: string; error: string | null }, []>(
        'SELECT status, error FROM trigger_events'
      )
      .get();
    expect(event?.status).toBe('failed');
    expect(event?.error).toContain('missing.value');

    const triggerRow = handle.sqlite
      .query<{ last_error: string | null }, [string]>(
        'SELECT last_error FROM triggers WHERE id = ?'
      )
      .get(trigger.id);
    expect(triggerRow?.last_error).toBeTruthy();

    const failed = await queryAudit(handle.db, { workspaceId, actions: ['trigger.failed'] });
    expect(failed).toHaveLength(1);
    expect(tickets.createCalls).toHaveLength(0);
  });

  test('rejects a job whose payload lacks an eventId', async () => {
    const queue = new SqliteJobQueue(handle.db);
    await queue.enqueue({ workspaceId, type: 'trigger.webhook', payload: {} });
    const leased = await queue.lease({ workerId: 'bad-worker' });
    const handler = requireJobHandler('trigger.webhook');
    await expect(
      handler({
        job: leased!,
        db: handle.db as Executor,
        workerId: 'bad-worker',
        heartbeat: async () => {},
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('processes a cron event through the same handler', async () => {
    await createTriggerRecord(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      name: 'Scheduled',
      type: 'cron',
      nextRunAt: Date.now() - 1000,
      config: {
        expression: '*/5 * * * *',
        timezone: 'UTC',
        mapping: { titleTemplate: 'Scheduled run' }
      }
    });
    const fires = await scheduleDueTriggers(handle.db, { now: Date.now() });
    expect(fires).toHaveLength(1);
    expect(fires[0]?.jobId).toBeTruthy();

    expect(await runPendingJobs(handle.db)).toBe(1);
    const event = handle.sqlite
      .query<{ status: string; ticket_id: string | null }, []>(
        'SELECT status, ticket_id FROM trigger_events'
      )
      .get();
    expect(event?.status).toBe('processed');
    expect(event?.ticket_id).toBeTruthy();
    expect(tickets.createCalls[0]?.title).toBe('Scheduled run');
  });
});
