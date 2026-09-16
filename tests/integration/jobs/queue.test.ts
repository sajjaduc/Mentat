import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { jobAttempts, jobs } from '../../../src/lib/server/db/schema';
import { getJobAttempts, listJobs, SqliteJobQueue } from '../../../src/lib/server/jobs/queue';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let queue: SqliteJobQueue;
let workspaceId: string;

beforeEach(async () => {
  handle = createTestDatabase();
  queue = new SqliteJobQueue(handle.db);
  const workspace = await createWorkspace(handle.db, 'Queue Workspace');
  workspaceId = workspace.id;
});

describe('job queue: enqueue and complete', () => {
  test('enqueues a pending job and leases it to a worker', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: { ticketId: 't1' },
      priority: 5
    });
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.availableAt).toBeLessThanOrEqual(Date.now());

    const leased = await queue.lease({ workerId: 'worker-a', leaseSeconds: 30 });
    expect(leased).not.toBeNull();
    expect(leased?.id).toBe(job.id);
    expect(leased?.status).toBe('leased');
    expect(leased?.leasedBy).toBe('worker-a');
    expect(leased?.attempts).toBe(1);
    expect(leased?.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  test('records a started attempt when leased and completes it', async () => {
    const job = await queue.enqueue({ workspaceId, type: 'file.process', payload: {} });
    await queue.lease({ workerId: 'worker-a' });
    await queue.complete(job.id, { ok: true });

    const attempts = await getJobAttempts(handle.db, job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('succeeded');
    expect(attempts[0]?.workerId).toBe('worker-a');
    expect(attempts[0]?.finishedAt).toBeGreaterThan(0);

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all();
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.result).toEqual({ ok: true });
    expect(rows[0]?.leasedBy).toBeNull();
  });

  test('returns null when the queue is empty', async () => {
    expect(await queue.lease({ workerId: 'worker-a' })).toBeNull();
  });

  test('does not lease a job before its availability time', async () => {
    const future = Date.now() + 60_000;
    const job = await queue.enqueue({
      workspaceId,
      type: 'trigger.cron',
      payload: {},
      availableAt: future
    });
    expect(await queue.lease({ workerId: 'worker-a' })).toBeNull();

    const leased = await queue.lease({ workerId: 'worker-a', now: future + 1 });
    expect(leased?.id).toBe(job.id);
  });

  test('leases higher priority work first', async () => {
    const low = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {}, priority: 0 });
    const high = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {}, priority: 10 });

    const first = await queue.lease({ workerId: 'worker-a' });
    expect(first?.id).toBe(high.id);
    const second = await queue.lease({ workerId: 'worker-a' });
    expect(second?.id).toBe(low.id);
  });

  test('two workers never lease the same job', async () => {
    await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });
    await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });

    const [a, b] = await Promise.all([
      queue.lease({ workerId: 'worker-a' }),
      queue.lease({ workerId: 'worker-b' })
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
    expect(await queue.lease({ workerId: 'worker-c' })).toBeNull();
  });

  test('scopes leasing to a workspace when requested', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const otherJob = await queue.enqueue({ workspaceId: other.id, type: 'agent.run', payload: {} });

    expect(await queue.lease({ workerId: 'worker-a', workspaceId })).toBeNull();
    const leased = await queue.lease({ workerId: 'worker-a', workspaceId: other.id });
    expect(leased?.id).toBe(otherJob.id);
  });
});

describe('job queue: idempotent enqueue', () => {
  test('reuses an active job with the same dedupe key', async () => {
    const first = await queue.enqueue({
      workspaceId,
      type: 'state.enter',
      payload: { ticketId: 't1' },
      dedupeKey: 'state-enter:t1:state-a:entry-1'
    });
    const second = await queue.enqueue({
      workspaceId,
      type: 'state.enter',
      payload: { ticketId: 't1' },
      dedupeKey: 'state-enter:t1:state-a:entry-1'
    });
    expect(second.id).toBe(first.id);
    const all = await listJobs(handle.db, { workspaceId });
    expect(all).toHaveLength(1);
  });

  test('allows a new job with the same dedupe key after the first completes', async () => {
    const first = await queue.enqueue({
      workspaceId,
      type: 'state.enter',
      payload: {},
      dedupeKey: 'repeatable'
    });
    await queue.lease({ workerId: 'worker-a' });
    await queue.complete(first.id, null);

    const second = await queue.enqueue({
      workspaceId,
      type: 'state.enter',
      payload: {},
      dedupeKey: 'repeatable'
    });
    expect(second.id).not.toBe(first.id);
  });

  test('scopes dedupe keys per workspace', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const a = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {}, dedupeKey: 'k' });
    const b = await queue.enqueue({
      workspaceId: other.id,
      type: 'agent.run',
      payload: {},
      dedupeKey: 'k'
    });
    expect(b.id).not.toBe(a.id);
  });
});

describe('job queue: retries and failure', () => {
  test('schedules a retry with backoff and increments attempts', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      maxAttempts: 3
    });
    await queue.lease({ workerId: 'worker-a' });

    const outcome = await queue.fail(job.id, {
      error: new Error('provider timeout'),
      errorCode: 'timeout'
    });
    expect(outcome.willRetry).toBe(true);
    expect(outcome.status).toBe('pending');
    expect(outcome.attempts).toBe(1);
    expect(outcome.availableAt).toBeGreaterThan(Date.now());

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all();
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.lastError).toBe('provider timeout');
    expect(rows[0]?.lastErrorCode).toBe('timeout');
    expect(rows[0]?.leasedBy).toBeNull();
  });

  test('marks the job dead once attempts are exhausted', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      maxAttempts: 2
    });

    await queue.lease({ workerId: 'worker-a' });
    await queue.fail(job.id, {
      error: new Error('first'),
      now: Date.now(),
      availableAt: Date.now()
    });
    await queue.lease({ workerId: 'worker-a' });
    const outcome = await queue.fail(job.id, { error: new Error('second') });

    expect(outcome.willRetry).toBe(false);
    expect(outcome.status).toBe('dead');

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all();
    expect(rows[0]?.status).toBe('dead');
    expect(rows[0]?.completedAt).toBeGreaterThan(0);
  });

  test('fails permanently when the error is not retryable', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      maxAttempts: 5
    });
    await queue.lease({ workerId: 'worker-a' });
    const outcome = await queue.fail(job.id, {
      error: new Error('validation failed'),
      errorCode: 'validation_failed',
      retryable: false
    });
    expect(outcome.willRetry).toBe(false);
    expect(outcome.status).toBe('failed');
  });

  test('records each attempt and its outcome', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      maxAttempts: 3
    });
    await queue.lease({ workerId: 'worker-a' });
    await queue.fail(job.id, { error: new Error('boom'), availableAt: Date.now() });
    await queue.lease({ workerId: 'worker-b' });
    await queue.complete(job.id, null);

    const attempts = await getJobAttempts(handle.db, job.id);
    expect(attempts.map((row) => row.status)).toEqual(['failed', 'succeeded']);
    expect(attempts.map((row) => row.workerId)).toEqual(['worker-a', 'worker-b']);
  });

  test('honours an explicit Retry-After availability time', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'http.request',
      payload: {},
      maxAttempts: 3
    });
    await queue.lease({ workerId: 'worker-a' });
    const retryAt = Date.now() + 30_000;
    const outcome = await queue.fail(job.id, { error: new Error('429'), availableAt: retryAt });
    expect(outcome.availableAt).toBe(retryAt);
  });
});

describe('job queue: worker death and leases', () => {
  test('an expired lease becomes leasable again without an external reaper', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      maxAttempts: 5
    });
    const start = Date.now();
    const first = await queue.lease({ workerId: 'dead-worker', leaseSeconds: 10, now: start });
    expect(first?.attempts).toBe(1);

    // The worker dies. Another worker may claim the job after the lease expires.
    expect(await queue.lease({ workerId: 'worker-b', now: start + 5_000 })).toBeNull();
    const reclaimed = await queue.lease({ workerId: 'worker-b', now: start + 11_000 });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.leasedBy).toBe('worker-b');
  });

  test('reaping expired leases returns the job to pending and closes the attempt', async () => {
    const start = Date.now();
    const job = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });
    await queue.lease({ workerId: 'dead-worker', leaseSeconds: 5, now: start });

    const reaped = await queue.reapExpiredLeases(start + 6_000);
    expect(reaped).toBe(1);

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all();
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.leasedBy).toBeNull();

    const attempts = await getJobAttempts(handle.db, job.id);
    expect(attempts[0]?.status).toBe('lease_expired');
    expect(attempts[0]?.finishedAt).toBe(start + 6_000);
  });

  test('reaping leaves healthy leases untouched', async () => {
    const start = Date.now();
    await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });
    await queue.lease({ workerId: 'healthy-worker', leaseSeconds: 60, now: start });

    expect(await queue.reapExpiredLeases(start + 1_000)).toBe(0);
    const rows = await listJobs(handle.db, { workspaceId, status: ['leased'] });
    expect(rows).toHaveLength(1);
  });

  test('a worker can extend its own lease but not another worker’s', async () => {
    const start = Date.now();
    const job = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });
    await queue.lease({ workerId: 'worker-a', leaseSeconds: 10, now: start });

    expect(await queue.extendLease(job.id, 'worker-b', 60, start + 1_000)).toBe(false);
    expect(await queue.extendLease(job.id, 'worker-a', 60, start + 1_000)).toBe(true);

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all();
    expect(rows[0]?.leaseExpiresAt).toBe(start + 1_000 + 60_000);
  });

  test('cancelling an active job prevents it from being leased', async () => {
    const job = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });
    expect(await queue.cancel(job.id, 'user cancelled')).toBe(true);
    expect(await queue.lease({ workerId: 'worker-a' })).toBeNull();

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id)).all();
    expect(rows[0]?.status).toBe('cancelled');
    expect(rows[0]?.lastError).toBe('user cancelled');
  });
});

describe('job queue: observability', () => {
  test('reports status counts, the oldest pending age and the next availability', async () => {
    const first = await queue.enqueue({ workspaceId, type: 'agent.run', payload: {} });
    await queue.enqueue({ workspaceId, type: 'agent.run', payload: {}, delayMs: 60_000 });
    await queue.lease({ workerId: 'worker-a' });
    await queue.complete(first.id, null);

    const stats = await queue.stats(workspaceId);
    expect(stats.completed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.oldestPendingAt).toBeGreaterThan(0);
    expect(stats.nextAvailableAt).toBeGreaterThan(Date.now());
  });

  test('writes audit events for the queue lifecycle', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      ticketId: 'ticket-1'
    });
    await queue.lease({ workerId: 'worker-a' });
    await queue.fail(job.id, { error: new Error('nope'), availableAt: Date.now() });

    const events = (await handle.sqlite
      .query('SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY seq')
      .all(workspaceId)) as Array<{ action: string }>;
    expect(events.map((event) => event.action)).toEqual(['job.enqueued', 'job.retry_scheduled']);
  });

  test('lists jobs filtered by ticket and run', async () => {
    await queue.enqueue({ workspaceId, type: 'agent.run', payload: {}, ticketId: 'ticket-1' });
    await queue.enqueue({ workspaceId, type: 'agent.run', payload: {}, runId: 'run-1' });
    const byTicket = await listJobs(handle.db, { workspaceId, ticketId: 'ticket-1' });
    expect(byTicket).toHaveLength(1);
    const byRun = await listJobs(handle.db, { workspaceId, runId: 'run-1' });
    expect(byRun).toHaveLength(1);
  });

  test('stores attempt rows uniquely per attempt number', async () => {
    const job = await queue.enqueue({
      workspaceId,
      type: 'agent.run',
      payload: {},
      maxAttempts: 2
    });
    await queue.lease({ workerId: 'worker-a' });
    await handle.db
      .insert(jobAttempts)
      .values({
        workspaceId,
        jobId: job.id,
        attempt: 1,
        workerId: 'worker-a',
        status: 'started',
        startedAt: Date.now()
      })
      .onConflictDoNothing()
      .run();
    const attempts = await handle.db
      .select()
      .from(jobAttempts)
      .where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.attempt, 1)))
      .all();
    expect(attempts).toHaveLength(1);
  });
});
