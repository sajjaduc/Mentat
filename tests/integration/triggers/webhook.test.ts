/**
 * Webhook receipt: authentication, size limits, idempotency and redaction.
 *
 * The contract is that a sender may retry freely (redelivery is a no-op), an
 * unsigned or wrongly signed payload never creates work, and whatever is
 * persisted is safe to look at later. Accepted deliveries become a Record +
 * WorkflowItem through the real services (ADR-0021).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { systemActor } from '../../../src/lib/server/core/context';
import { hmacSha256Hex } from '../../../src/lib/server/core/crypto';
import type { Executor } from '../../../src/lib/server/db/client';
import { clearJobHandlers, requireJobHandler } from '../../../src/lib/server/jobs/handlers';
import { SqliteJobQueue } from '../../../src/lib/server/jobs/queue';
import { createSecret } from '../../../src/lib/server/secrets/service';
import { registerTriggerJobHandlers } from '../../../src/lib/server/triggers/handlers';
import { receiveWebhook } from '../../../src/lib/server/triggers/webhook';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createTriggerRecord,
  createUser,
  createWorkflow,
  createWorkspace,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';

const SIGNATURE_SECRET = 'super-secret-signing-value';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;
let actor: ActorContext;
let system: ActorContext;
let secretId: string;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Webhooks');
  workspaceId = workspace.id;
  actor = ownerActor(workspaceId, (await createUser(handle.db)).id);
  system = systemActor(workspaceId);
  workflow = await createWorkflow(handle.db, workspaceId);
  const secret = createSecret(handle.db, actor, {
    key: 'WEBHOOK_SIGNING',
    value: SIGNATURE_SECRET
  });
  secretId = secret.id;
  clearJobHandlers();
  registerTriggerJobHandlers();
});

afterEach(() => {
  clearJobHandlers();
  handle.cleanup();
});

function sign(body: string, prefix = true): string {
  const digest = hmacSha256Hex(SIGNATURE_SECRET, body, 'hex');
  return prefix ? `sha256=${digest}` : digest;
}

function count(table: 'records' | 'workflow_items'): number {
  return Number(
    handle.sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0
  );
}

async function createWebhook(
  options: {
    signatureRequired?: boolean;
    signatureHeader?: string;
    maxPayloadBytes?: number;
    enabled?: boolean;
    token?: string;
    mapping?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const token = options.token ?? 'webhook-token-abc';
  await createTriggerRecord(handle.db, {
    workspaceId,
    workflowId: workflow.id,
    name: `Hook ${token}`,
    type: 'webhook',
    enabled: options.enabled ?? true,
    webhookToken: token,
    config: {
      signatureRequired: options.signatureRequired ?? true,
      signatureSecretId: secretId,
      signatureHeader: options.signatureHeader,
      maxPayloadBytes: options.maxPayloadBytes,
      mapping: options.mapping ?? { titlePath: 'subject' }
    }
  });
  return token;
}

/** Drain all pending jobs through the registered handlers. */
async function runPendingJobs(db: Executor): Promise<number> {
  const queue = new SqliteJobQueue(db);
  let processed = 0;
  for (;;) {
    const job = await queue.lease({ workerId: 'test-worker' });
    if (!job) break;
    const handler = requireJobHandler(job.type);
    await handler({
      job,
      db,
      workerId: 'test-worker',
      heartbeat: async () => {},
      signal: new AbortController().signal
    });
    processed += 1;
  }
  return processed;
}

describe('triggers/webhook authentication', () => {
  test('accepts a valid sha256= signature', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Signed' });
    const result = await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'X-Mentat-Signature': sign(body) }
    });
    expect(result.duplicate).toBe(false);
    expect(result.status).toBe('received');
    expect(result.jobId).toBeTruthy();
  });

  test('accepts a bare hex signature', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Bare' });
    const result = await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'x-mentat-signature': sign(body, false) }
    });
    expect(result.duplicate).toBe(false);
  });

  test('rejects a wrong signature', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Tampered' });
    await expect(
      receiveWebhook(handle.db, system, {
        token,
        rawBody: body,
        headers: { 'X-Mentat-Signature': sign(`${body} `) }
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('rejects a missing signature header when required', async () => {
    const token = await createWebhook();
    await expect(
      receiveWebhook(handle.db, system, {
        token,
        rawBody: JSON.stringify({ subject: 'Unsigned' }),
        headers: {}
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  test('supports a configurable signature header', async () => {
    const token = await createWebhook({ signatureHeader: 'X-Hub-Signature-256' });
    const body = JSON.stringify({ subject: 'Custom header' });
    const result = await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'x-hub-signature-256': sign(body) }
    });
    expect(result.duplicate).toBe(false);
  });

  test('does not require a signature when the trigger does not ask for one', async () => {
    const token = await createWebhook({ signatureRequired: false });
    const result = await receiveWebhook(handle.db, system, {
      token,
      rawBody: JSON.stringify({ subject: 'Open' }),
      headers: {}
    });
    expect(result.duplicate).toBe(false);
  });

  test('an unknown token is a not-found error', async () => {
    await expect(
      receiveWebhook(handle.db, system, {
        token: 'no-such-token',
        rawBody: '{}',
        headers: {}
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('another workspace cannot address the trigger by token', async () => {
    const token = await createWebhook();
    const otherWorkspace = await createWorkspace(handle.db, 'Other hooks');
    const otherActor = systemActor(otherWorkspace.id);
    await expect(
      receiveWebhook(handle.db, otherActor, {
        token,
        rawBody: JSON.stringify({ subject: 'Cross tenant' }),
        headers: { 'X-Mentat-Signature': sign(JSON.stringify({ subject: 'Cross tenant' })) }
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('triggers/webhook size limits and disabled triggers', () => {
  test('rejects an oversize payload', async () => {
    const token = await createWebhook({ maxPayloadBytes: 32 });
    const body = JSON.stringify({ subject: 'x'.repeat(100) });
    await expect(
      receiveWebhook(handle.db, system, {
        token,
        rawBody: body,
        headers: { 'X-Mentat-Signature': sign(body) }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(handle.sqlite.query('SELECT count(*) AS n FROM trigger_events').get()).toMatchObject({
      n: 0
    });
  });

  test('accepts a payload exactly at the limit', async () => {
    const body = JSON.stringify({ subject: 'ok' });
    const token = await createWebhook({ maxPayloadBytes: body.length });
    const result = await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'X-Mentat-Signature': sign(body) }
    });
    expect(result.duplicate).toBe(false);
  });

  test('a disabled trigger records an ignored event and enqueues nothing', async () => {
    const token = await createWebhook({ enabled: false });
    const body = JSON.stringify({ subject: 'Ignored' });
    const result = await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'X-Mentat-Signature': sign(body) }
    });
    expect(result.ignored).toBe(true);
    expect(result.status).toBe('ignored');
    expect(result.jobId).toBeNull();
    expect(handle.sqlite.query('SELECT count(*) AS n FROM jobs').get()).toMatchObject({ n: 0 });
  });
});

describe('triggers/webhook idempotency and redaction', () => {
  test('redelivery returns duplicate and creates exactly one unit of work', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Idempotent', data: { id: 1 } });
    const headers = {
      'X-Mentat-Signature': sign(body),
      'Idempotency-Key': 'delivery-1'
    };

    const first = await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    const second = await receiveWebhook(handle.db, system, { token, rawBody: body, headers });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.recordId).toBeNull();
    expect(second.workflowItemId).toBeNull();

    expect(await runPendingJobs(handle.db)).toBe(1);
    expect(count('records')).toBe(1);
    expect(count('workflow_items')).toBe(1);
    expect(handle.sqlite.query('SELECT count(*) AS n FROM trigger_events').get()).toMatchObject({
      n: 1
    });

    // Once processed, a redelivery reports the original record/work item.
    const third = await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    expect(third.duplicate).toBe(true);
    expect(third.recordId).toBeTruthy();
    expect(third.workflowItemId).toBeTruthy();
    expect(await runPendingJobs(handle.db)).toBe(0);
    expect(count('records')).toBe(1);
    expect(count('workflow_items')).toBe(1);
  });

  test('uses the body hash when no idempotency header is present', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Hash dedupe' });
    const headers = { 'X-Mentat-Signature': sign(body) };

    await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    const second = await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    expect(second.duplicate).toBe(true);
    expect(handle.sqlite.query('SELECT count(*) AS n FROM trigger_events').get()).toMatchObject({
      n: 1
    });
  });

  test('uses X-GitHub-Delivery as the idempotency key', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'GitHub' });
    const headers = {
      'X-Mentat-Signature': sign(body),
      'X-GitHub-Delivery': 'gh-123'
    };
    await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    const second = await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    expect(second.duplicate).toBe(true);
  });

  test('persists the payload redacted, never the raw secret', async () => {
    const token = await createWebhook({
      mapping: { titlePath: 'subject' }
    });
    const body = JSON.stringify({
      subject: 'Redaction',
      password: 'hunter2-should-not-persist',
      note: SIGNATURE_SECRET,
      nested: { api_key: 'sk-should-not-persist' }
    });
    await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'X-Mentat-Signature': sign(body) }
    });

    const rows = handle.sqlite
      .query<{ payload: string }, []>('SELECT payload FROM trigger_events')
      .all();
    const persisted = rows.map((row) => row.payload).join('\n');
    expect(persisted).not.toContain('hunter2-should-not-persist');
    expect(persisted).not.toContain('sk-should-not-persist');
    // The signature secret was resolved for verification and value-redacted.
    expect(persisted).not.toContain(SIGNATURE_SECRET);
    expect(persisted).toContain('[redacted]');
  });

  test('audits received and duplicate deliveries', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Audited' });
    const headers = { 'X-Mentat-Signature': sign(body), 'Idempotency-Key': 'dupe-audit' };
    await receiveWebhook(handle.db, system, { token, rawBody: body, headers });
    await receiveWebhook(handle.db, system, { token, rawBody: body, headers });

    const received = handle.sqlite
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'trigger.received'"
      )
      .get();
    const duplicates = handle.sqlite
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'trigger.duplicate'"
      )
      .get();
    expect(received?.n).toBe(1);
    expect(duplicates?.n).toBe(1);
  });

  test('trigger events are scoped to their workspace', async () => {
    const token = await createWebhook();
    const body = JSON.stringify({ subject: 'Scoped events' });
    await receiveWebhook(handle.db, system, {
      token,
      rawBody: body,
      headers: { 'X-Mentat-Signature': sign(body) }
    });

    const mine = handle.sqlite
      .query<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM trigger_events WHERE workspace_id = ?'
      )
      .get(workspaceId);
    const foreign = handle.sqlite
      .query<{ n: number }, [string]>(
        'SELECT count(*) AS n FROM trigger_events WHERE workspace_id = ?'
      )
      .get('not-this-workspace');
    expect(mine?.n).toBe(1);
    expect(foreign?.n).toBe(0);
  });
});
