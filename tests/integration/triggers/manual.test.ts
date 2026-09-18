/**
 * Manual/API trigger firing.
 *
 * Manual firing must reuse the same durable event path as webhooks and cron, so
 * these tests assert the event/job shape, that the caller-supplied idempotency
 * key makes retries free, and that processing produces a Record + WorkflowItem.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { systemActor } from '../../../src/lib/server/core/context';
import { clearJobHandlers } from '../../../src/lib/server/jobs/handlers';
import { registerTriggerJobHandlers } from '../../../src/lib/server/triggers/handlers';
import { fireManual } from '../../../src/lib/server/triggers/manual';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createTriggerRecord,
  createUser,
  createWorkflow,
  createWorkspace,
  memberActor,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';
import { runPendingJobs } from './support';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;
let actor: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Manual');
  workspaceId = workspace.id;
  actor = ownerActor(workspaceId, (await createUser(handle.db)).id);
  workflow = await createWorkflow(handle.db, workspaceId);
  clearJobHandlers();
  registerTriggerJobHandlers();
});

afterEach(() => {
  clearJobHandlers();
  handle.cleanup();
});

async function createManual(options: {
  name?: string;
  type?: 'manual' | 'api';
  enabled?: boolean;
  inputSchema?: unknown;
}) {
  return createTriggerRecord(handle.db, {
    workspaceId,
    workflowId: workflow.id,
    name: options.name ?? 'Manual intake',
    type: options.type ?? 'manual',
    enabled: options.enabled ?? true,
    config: {
      inputSchema: options.inputSchema,
      mapping: { titleTemplate: '{{subject}}' }
    }
  });
}

describe('triggers/manual firing', () => {
  test('fires through the same durable event path as automated triggers', async () => {
    const trigger = await createManual({});
    const result = await fireManual(handle.db, actor, {
      triggerId: trigger.id,
      input: { subject: 'Created by hand' },
      idempotencyKey: 'manual-1'
    });

    expect(result.duplicate).toBe(false);
    expect(result.status).toBe('received');
    expect(result.jobId).toBeTruthy();

    const event = handle.sqlite
      .query<{ idempotency_key: string; status: string; source: string }, []>(
        'SELECT idempotency_key, status, source FROM trigger_events'
      )
      .get();
    expect(event).toMatchObject({
      idempotency_key: 'manual-1',
      status: 'received',
      source: 'manual'
    });

    expect(await runPendingJobs(handle.db)).toBe(1);
    const processed = handle.sqlite
      .query<{ status: string; record_id: string | null; workflow_item_id: string | null }, []>(
        'SELECT status, record_id, workflow_item_id FROM trigger_events'
      )
      .get();
    expect(processed?.status).toBe('processed');
    expect(processed?.record_id).toBeTruthy();
    expect(processed?.workflow_item_id).toBeTruthy();

    const record = handle.sqlite
      .query<{ display_name: string }, []>('SELECT display_name FROM records LIMIT 1')
      .get();
    expect(record?.display_name).toBe('Created by hand');
  });

  test('dedupes on a caller-provided idempotency key', async () => {
    const trigger = await createManual({});
    const first = await fireManual(handle.db, actor, {
      triggerId: trigger.id,
      input: { subject: 'Once' },
      idempotencyKey: 'same-key'
    });
    const second = await fireManual(handle.db, actor, {
      triggerId: trigger.id,
      input: { subject: 'Twice' },
      idempotencyKey: 'same-key'
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const events = handle.sqlite
      .query<{ n: number }, []>('SELECT count(*) AS n FROM trigger_events')
      .get();
    expect(events?.n).toBe(1);
  });

  test('validates the declared input schema', async () => {
    const trigger = await createManual({
      inputSchema: {
        type: 'object',
        required: ['subject'],
        properties: { subject: { type: 'string' }, count: { type: 'number' } }
      }
    });

    await expect(
      fireManual(handle.db, actor, { triggerId: trigger.id, input: {} })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      fireManual(handle.db, actor, { triggerId: trigger.id, input: { subject: 42 } })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const ok = await fireManual(handle.db, actor, {
      triggerId: trigger.id,
      input: { subject: 'fine', count: 2 }
    });
    expect(ok.duplicate).toBe(false);
  });

  test('accepts an api trigger and members with run:execute', async () => {
    const trigger = await createManual({ type: 'api' });
    const member = memberActor(workspaceId, (await createUser(handle.db)).id);
    const result = await fireManual(handle.db, member, {
      triggerId: trigger.id,
      input: { subject: 'API call' }
    });
    expect(result.duplicate).toBe(false);
  });

  test('refuses a disabled trigger', async () => {
    const trigger = await createManual({ enabled: false });
    await expect(
      fireManual(handle.db, actor, { triggerId: trigger.id, input: { subject: 'x' } })
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  test('refuses to fire a non-manual trigger', async () => {
    const trigger = await createTriggerRecord(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      name: 'A webhook',
      type: 'webhook',
      webhookToken: 'manual-test-token',
      config: { mapping: { titleTemplate: '{{subject}}' } }
    });
    await expect(
      fireManual(handle.db, actor, { triggerId: trigger.id, input: { subject: 'x' } })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('is tenant scoped', async () => {
    const trigger = await createManual({});
    const otherWorkspace = await createWorkspace(handle.db, 'Other manual');
    const otherActor = systemActor(otherWorkspace.id);
    await expect(
      fireManual(handle.db, otherActor, { triggerId: trigger.id, input: { subject: 'x' } })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
