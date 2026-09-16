/**
 * Worker-safe cron claiming.
 *
 * The schedule row is the lock: concurrent schedulers must observe exactly one
 * fire per slot, and the cursor must advance deterministically from the injected
 * reference time.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import { jobs, triggers } from '../../../src/lib/server/db/schema';
import {
  claimDueSchedules,
  computeNextRun,
  scheduleDueTriggers
} from '../../../src/lib/server/triggers/cron';
import { insertTriggerEvent } from '../../../src/lib/server/triggers/events';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createTriggerRecord,
  createWorkflow,
  createWorkspace,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;
const NOW = Date.UTC(2024, 5, 1, 12, 0, 0);

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Cron');
  workspaceId = workspace.id;
  workflow = await createWorkflow(handle.db, workspaceId);
});

afterEach(() => {
  handle.cleanup();
});

async function createCron(options: {
  name?: string;
  expression?: string;
  timezone?: string;
  nextRunAt?: number | null;
  enabled?: boolean;
  skipIfRunning?: boolean;
}) {
  return createTriggerRecord(handle.db, {
    workspaceId,
    workflowId: workflow.id,
    name: options.name ?? 'Nightly',
    type: 'cron',
    enabled: options.enabled ?? true,
    nextRunAt: options.nextRunAt === undefined ? NOW - 60_000 : options.nextRunAt,
    config: {
      expression: options.expression ?? '0 12 * * *',
      timezone: options.timezone ?? 'UTC',
      skipIfRunning: options.skipIfRunning ?? false
    }
  });
}

function jobCount(): number {
  const row = handle.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM jobs').get();
  return row?.n ?? 0;
}

function eventCount(): number {
  const row = handle.sqlite
    .query<{ n: number }, []>('SELECT count(*) AS n FROM trigger_events')
    .get();
  return row?.n ?? 0;
}

describe('triggers/cron claiming', () => {
  test('claims a due trigger, advances the cursor and enqueues one job', async () => {
    const trigger = await createCron({});
    const fires = await scheduleDueTriggers(handle.db, { now: NOW });

    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ triggerId: trigger.id, skipped: false, duplicate: false });
    expect(fires[0]?.jobId).toBeTruthy();
    expect(eventCount()).toBe(1);
    expect(jobCount()).toBe(1);

    const expected = computeNextRun('0 12 * * *', 'UTC', NOW);
    const stored = handle.sqlite
      .query<{ next_run_at: number; fire_count: number; last_fired_at: number }, [string]>(
        'SELECT next_run_at, fire_count, last_fired_at FROM triggers WHERE id = ?'
      )
      .get(trigger.id);
    expect(stored?.next_run_at).toBe(expected);
    expect(stored?.fire_count).toBe(1);
    expect(stored?.last_fired_at).toBe(NOW);
  });

  test('does not fire a schedule that is not yet due', async () => {
    await createCron({ nextRunAt: NOW + 3_600_000 });
    expect(await scheduleDueTriggers(handle.db, { now: NOW })).toHaveLength(0);
    expect(eventCount()).toBe(0);
  });

  test('two concurrent claimDueSchedules calls claim each trigger exactly once', async () => {
    await createCron({});
    const [first, second] = await Promise.all([
      claimDueSchedules(handle.db, { now: NOW, workerId: 'w1' }),
      claimDueSchedules(handle.db, { now: NOW, workerId: 'w2' })
    ]);
    expect(first.length + second.length).toBe(1);
  });

  test('two concurrent scheduleDueTriggers calls create one event and one job', async () => {
    await createCron({});
    const [first, second] = await Promise.all([
      scheduleDueTriggers(handle.db, { now: NOW, workerId: 'w1' }),
      scheduleDueTriggers(handle.db, { now: NOW, workerId: 'w2' })
    ]);
    expect(first.length + second.length).toBe(1);
    expect(eventCount()).toBe(1);
    expect(jobCount()).toBe(1);
  });

  test('a second tick after the cursor advanced fires nothing', async () => {
    await createCron({});
    await scheduleDueTriggers(handle.db, { now: NOW });
    expect(await scheduleDueTriggers(handle.db, { now: NOW })).toHaveLength(0);
    expect(eventCount()).toBe(1);
    expect(jobCount()).toBe(1);
  });

  test('disabled triggers never fire', async () => {
    await createCron({ enabled: false });
    expect(await scheduleDueTriggers(handle.db, { now: NOW })).toHaveLength(0);
    expect(eventCount()).toBe(0);
    expect(jobCount()).toBe(0);
  });

  test('archived triggers never fire', async () => {
    const trigger = await createCron({});
    handle.db.update(triggers).set({ archivedAt: NOW }).where(eq(triggers.id, trigger.id)).run();
    expect(await scheduleDueTriggers(handle.db, { now: NOW })).toHaveLength(0);
    expect(eventCount()).toBe(0);
  });

  test('skipIfRunning suppresses a fire while the previous job is active', async () => {
    const trigger = await createCron({ skipIfRunning: true });
    handle.db
      .insert(jobs)
      .values({
        workspaceId,
        type: 'trigger.cron',
        payload: { triggerId: trigger.id, eventId: 'in-flight' },
        status: 'leased',
        availableAt: NOW - 1000,
        dedupeKey: `cron:${trigger.id}`,
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000
      })
      .run();

    const fires = await scheduleDueTriggers(handle.db, { now: NOW });
    expect(fires).toHaveLength(1);
    expect(fires[0]?.skipped).toBe(true);
    // The cursor still advances so the slot is not retried on every tick.
    expect(fires[0]?.nextRunAt).toBe(computeNextRun('0 12 * * *', 'UTC', NOW));
    // Only the pre-existing job remains.
    expect(jobCount()).toBe(1);
    expect(eventCount()).toBe(0);
  });

  test('is timezone aware when advancing the cursor', async () => {
    await createCron({ expression: '0 12 * * *', timezone: 'America/New_York' });
    const fires = await scheduleDueTriggers(handle.db, { now: NOW });
    expect(fires[0]?.nextRunAt).toBe(computeNextRun('0 12 * * *', 'America/New_York', NOW));
    // 12:00 New York on 1 June 2024 is 16:00Z (EDT).
    expect(fires[0]?.nextRunAt).toBe(Date.UTC(2024, 5, 1, 16, 0));
  });

  test('audits trigger.received for each scheduled fire', async () => {
    await createCron({});
    await scheduleDueTriggers(handle.db, { now: NOW });
    const audits = await queryAudit(handle.db, { workspaceId, actions: ['trigger.received'] });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityType).toBe('trigger_event');
  });

  test('re-enqueues an event that was persisted but never enqueued', async () => {
    // Simulates a crash between committing the event and enqueueing its job.
    const trigger = await createCron({ nextRunAt: NOW + 3_600_000 });
    insertTriggerEvent(handle.db, {
      workspaceId,
      triggerId: trigger.id,
      idempotencyKey: 'orphan-1',
      source: 'webhook',
      payload: { subject: 'recovered' },
      receivedAt: NOW - 60_000
    });
    expect(jobCount()).toBe(0);

    await scheduleDueTriggers(handle.db, { now: NOW });

    expect(jobCount()).toBe(1);
    const event = handle.sqlite
      .query<{ job_id: string | null; status: string }, []>(
        'SELECT job_id, status FROM trigger_events'
      )
      .get();
    expect(event?.job_id).toBeTruthy();
    expect(event?.status).toBe('received');
  });
});
