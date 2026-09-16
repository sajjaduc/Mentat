/**
 * Trigger configuration CRUD.
 *
 * Covers the service boundary: workspace scoping, permission checks, schedule
 * validation, token generation and soft archiving.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import { triggers } from '../../../src/lib/server/db/schema';
import {
  archiveTrigger,
  createTrigger,
  getTrigger,
  listTriggers,
  recordFire,
  recordTriggerError,
  rotateWebhookToken,
  triggerStats,
  updateTrigger
} from '../../../src/lib/server/triggers/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createUser,
  createWorkflow,
  createWorkspace,
  memberActor,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let workflow: WorkflowFixture;
let actor: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Trigger service');
  workspaceId = workspace.id;
  actor = ownerActor(workspaceId, (await createUser(handle.db)).id);
  workflow = await createWorkflow(handle.db, workspaceId);
});

afterEach(() => {
  handle.cleanup();
});

describe('triggers/service CRUD', () => {
  test('creates a webhook trigger with a generated token', async () => {
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Inbound email',
      type: 'webhook',
      description: 'Receives mail',
      config: { signatureRequired: true, signatureSecretId: 'secret-1' }
    });
    expect(created.webhookToken).toMatch(/^[0-9a-f]{64}$/);
    expect(created).toMatchObject({
      name: 'Inbound email',
      type: 'webhook',
      enabled: true,
      nextRunAt: null,
      fireCount: 0
    });
    expect(created.description).toBe('Receives mail');
  });

  test('creates a cron trigger with a validated next run', async () => {
    const from = Date.now();
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Every five minutes',
      type: 'cron',
      config: { expression: '*/5 * * * *', timezone: 'UTC' }
    });
    expect(created.nextRunAt).toBeTruthy();
    expect(created.nextRunAt ?? 0).toBeGreaterThan(from - 1000);
    expect((created.nextRunAt ?? 0) % 300_000).toBe(0);
  });

  test('rejects invalid configuration at the boundary', async () => {
    await expect(
      createTrigger(handle.db, actor, {
        workflowId: workflow.id,
        name: 'Bad cron',
        type: 'cron',
        config: { expression: 'definitely not cron' }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      createTrigger(handle.db, actor, {
        workflowId: workflow.id,
        name: 'Unsafe webhook',
        type: 'webhook',
        config: { signatureRequired: true }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      createTrigger(handle.db, actor, { workflowId: workflow.id, name: '   ', type: 'manual' })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('enforces a unique name per workflow', async () => {
    await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Duplicate',
      type: 'manual'
    });
    await expect(
      createTrigger(handle.db, actor, {
        workflowId: workflow.id,
        name: 'Duplicate',
        type: 'manual'
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('cannot create a trigger against another workspace workflow', async () => {
    const otherWorkspace = await createWorkspace(handle.db, 'Other triggers');
    const otherWorkflow = await createWorkflow(handle.db, otherWorkspace.id);
    await expect(
      createTrigger(handle.db, actor, {
        workflowId: otherWorkflow.id,
        name: 'Cross tenant',
        type: 'manual'
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('updates configuration and recomputes the cron cursor', async () => {
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Editable',
      type: 'cron',
      config: { expression: '0 9 * * *', timezone: 'UTC' }
    });
    const updated = await updateTrigger(handle.db, actor, created.id, {
      name: 'Renamed',
      enabled: false,
      config: { expression: '0 10 * * *', timezone: 'UTC' }
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(false);
    expect(updated.config).toMatchObject({ expression: '0 10 * * *' });
    expect(updated.nextRunAt).toBeTruthy();
  });

  test('lists workspace triggers and hides archived rows by default', async () => {
    const first = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Visible',
      type: 'manual'
    });
    const second = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Archived',
      type: 'manual'
    });
    await archiveTrigger(handle.db, actor, second.id);

    expect(listTriggers(handle.db, actor, { workflowId: workflow.id }).map((t) => t.id)).toEqual([
      first.id
    ]);
    const withArchived = listTriggers(handle.db, actor, {
      workflowId: workflow.id,
      includeArchived: true
    });
    expect(withArchived).toHaveLength(2);
    expect(withArchived.find((t) => t.id === second.id)?.archivedAt).toBeTruthy();
    expect(() => getTrigger(handle.db, actor, second.id)).toThrow();
    expect(triggerStats(handle.db, actor, workspaceId)).toMatchObject({ total: 1, enabled: 1 });
  });

  test('rotates the webhook token and refuses non-webhook triggers', async () => {
    const webhook = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Rotatable',
      type: 'webhook'
    });
    const rotated = await rotateWebhookToken(handle.db, actor, webhook.id);
    expect(rotated.webhookToken).not.toBe(webhook.webhookToken);

    const manual = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Not rotatable',
      type: 'manual'
    });
    await expect(rotateWebhookToken(handle.db, actor, manual.id)).rejects.toMatchObject({
      code: 'validation_failed'
    });
  });

  test('recordFire and recordTriggerError update counters', async () => {
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Counted',
      type: 'manual'
    });
    recordFire(handle.db, created.id, { firedAt: 1000 });
    recordFire(handle.db, created.id, { firedAt: 2000, error: 'previous failure' });
    recordTriggerError(handle.db, created.id, 'still failing');

    const row = handle.db
      .select()
      .from(triggers)
      .where(eq(triggers.id, created.id))
      .limit(1)
      .all()[0];
    expect(row?.fireCount).toBe(2);
    expect(row?.lastFiredAt).toBe(2000);
    expect(row?.lastError).toBe('still failing');
  });
});

describe('triggers/service permissions and isolation', () => {
  test('members may read triggers but not change them', async () => {
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Read only',
      type: 'manual',
      enabled: false
    });
    const member = memberActor(workspaceId, (await createUser(handle.db)).id);
    expect(getTrigger(handle.db, member, created.id).name).toBe('Read only');
    expect(listTriggers(handle.db, member, { workflowId: workflow.id })).toHaveLength(1);

    await expect(
      createTrigger(handle.db, member, { workflowId: workflow.id, name: 'Nope', type: 'manual' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      updateTrigger(handle.db, member, created.id, { enabled: true })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(archiveTrigger(handle.db, member, created.id)).rejects.toMatchObject({
      code: 'forbidden'
    });
    await expect(rotateWebhookToken(handle.db, member, created.id)).rejects.toMatchObject({
      code: 'forbidden'
    });
  });

  test('another workspace never sees a trigger', async () => {
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Private',
      type: 'manual'
    });
    const otherWorkspace = await createWorkspace(handle.db, 'Other isolation');
    const otherActor = ownerActor(otherWorkspace.id, (await createUser(handle.db)).id);

    expect(listTriggers(handle.db, otherActor)).toHaveLength(0);
    expect(() => getTrigger(handle.db, otherActor, created.id)).toThrow();
    await expect(
      updateTrigger(handle.db, otherActor, created.id, { enabled: false })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(archiveTrigger(handle.db, otherActor, created.id)).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  test('loads a trigger by webhook token without exposing it cross-tenant', async () => {
    const created = await createTrigger(handle.db, actor, {
      workflowId: workflow.id,
      name: 'Token lookup',
      type: 'webhook'
    });
    // The token lookup is intentionally not permission-gated; the webhook receipt
    // path re-checks the workspace.
    const { findTriggerByWebhookToken } = await import('../../../src/lib/server/triggers/service');
    expect(findTriggerByWebhookToken(handle.db as Executor, created.webhookToken ?? '')?.id).toBe(
      created.id
    );
    expect(findTriggerByWebhookToken(handle.db as Executor, 'not-a-token')).toBeNull();
  });
});
