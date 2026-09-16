/**
 * Environment resolution and provenance.
 *
 * These tests encode the product promise: `Workflow override > Workspace value`,
 * removing an override resumes inheritance, and a secret-backed variable never
 * yields plaintext through any configuration read path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import {
  deleteEnvironmentVariable,
  getEnvironmentVariable,
  listEffectiveEnvironment,
  listEnvironmentVariables,
  resolveEnvironmentValue,
  setEnvironmentVariable
} from '../../../src/lib/server/config/environment';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { resolveEnvironmentVariableWithSecret } from '../../../src/lib/server/secrets/environment';
import { createSecret } from '../../../src/lib/server/secrets/service';
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
let member: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Config');
  workspaceId = workspace.id;
  const user = await createUser(handle.db);
  const memberUser = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  member = memberActor(workspaceId, memberUser.id);
  workflow = await createWorkflow(handle.db, workspaceId);
});

afterEach(() => {
  handle.cleanup();
});

describe('config/environment resolution', () => {
  test('resolves a workspace-only value', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'API_URL', value: 'https://ws.test' });
    const resolved = resolveEnvironmentValue(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      key: 'API_URL'
    });
    expect(resolved).toMatchObject({
      value: 'https://ws.test',
      source: 'workspace',
      isSecret: false,
      secretId: null
    });
  });

  test('a workflow override wins over the workspace value', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'API_URL', value: 'https://ws.test' });
    await setEnvironmentVariable(handle.db, actor, {
      key: 'API_URL',
      value: 'https://wf.test',
      workflowId: workflow.id
    });

    const resolved = resolveEnvironmentValue(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      key: 'API_URL'
    });
    expect(resolved).toMatchObject({ value: 'https://wf.test', source: 'workflow' });

    const effective = listEffectiveEnvironment(handle.db, {
      workspaceId,
      workflowId: workflow.id
    });
    expect(effective).toHaveLength(1);
    expect(effective[0]).toMatchObject({
      key: 'API_URL',
      value: 'https://wf.test',
      source: 'workflow',
      state: 'overridden'
    });
    expect(effective[0]?.workspaceVariableId).toBeTruthy();
    expect(effective[0]?.workflowVariableId).toBeTruthy();
  });

  test('removing the override resumes inheritance', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'API_URL', value: 'https://ws.test' });
    const override = await setEnvironmentVariable(handle.db, actor, {
      key: 'API_URL',
      value: 'https://wf.test',
      workflowId: workflow.id
    });
    await deleteEnvironmentVariable(handle.db, actor, override.id);

    const resolved = resolveEnvironmentValue(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      key: 'API_URL'
    });
    expect(resolved).toMatchObject({ value: 'https://ws.test', source: 'workspace' });

    const effective = listEffectiveEnvironment(handle.db, {
      workspaceId,
      workflowId: workflow.id
    });
    expect(effective[0]).toMatchObject({ state: 'inherited', source: 'workspace' });
  });

  test('distinguishes inherited, overridden and local provenance', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'INHERITED_ONLY', value: 'ws' });
    await setEnvironmentVariable(handle.db, actor, { key: 'BOTH', value: 'ws' });
    await setEnvironmentVariable(handle.db, actor, {
      key: 'BOTH',
      value: 'wf',
      workflowId: workflow.id
    });
    await setEnvironmentVariable(handle.db, actor, {
      key: 'LOCAL_ONLY',
      value: 'wf',
      workflowId: workflow.id
    });

    const byKey = new Map(
      listEffectiveEnvironment(handle.db, { workspaceId, workflowId: workflow.id }).map((entry) => [
        entry.key,
        entry
      ])
    );
    expect(byKey.get('INHERITED_ONLY')?.state).toBe('inherited');
    expect(byKey.get('BOTH')?.state).toBe('overridden');
    expect(byKey.get('LOCAL_ONLY')?.state).toBe('local');
    expect(byKey.get('LOCAL_ONLY')?.source).toBe('workflow');
  });

  test('returns a default source when nothing is configured', () => {
    const resolved = resolveEnvironmentValue(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      key: 'ABSENT',
      defaultValue: 'fallback'
    });
    expect(resolved).toMatchObject({ value: 'fallback', source: 'default', isSecret: false });
  });

  test('a workspace view reports workspace values as local', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'ONLY', value: 'v' });
    const effective = listEffectiveEnvironment(handle.db, { workspaceId });
    expect(effective[0]).toMatchObject({ state: 'local', source: 'workspace' });
  });
});

describe('config/environment secrets', () => {
  test('a secret-backed variable exposes no plaintext', async () => {
    const secret = createSecret(handle.db, actor, {
      key: 'PAYMENTS_KEY',
      value: 'sk_live_super_secret_value',
      name: 'Payments'
    });
    await setEnvironmentVariable(handle.db, actor, {
      key: 'PAYMENTS_KEY',
      secretId: secret.id
    });

    const [listed] = listEnvironmentVariables(handle.db, actor, { workflowId: workflow.id });
    expect(listed).toMatchObject({
      key: 'PAYMENTS_KEY',
      value: null,
      isSecret: true,
      secretId: secret.id,
      lastFour: 'alue'
    });

    const resolved = resolveEnvironmentValue(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      key: 'PAYMENTS_KEY'
    });
    expect(resolved.value).toBeNull();
    expect(resolved.isSecret).toBe(true);
    expect(resolved.secretId).toBe(secret.id);

    const effective = listEffectiveEnvironment(handle.db, { workspaceId, workflowId: workflow.id });
    expect(effective[0]?.value).toBeNull();
    expect(effective[0]?.lastFour).toBe('alue');
    // The whole JSON view must not contain the plaintext anywhere.
    expect(JSON.stringify(listed)).not.toContain('sk_live_super_secret_value');
  });

  test('execution-time resolution returns plaintext and registers it for redaction', async () => {
    const secret = createSecret(handle.db, actor, {
      key: 'MAIL_PASSWORD',
      value: 'mail-secret-1234'
    });
    await setEnvironmentVariable(handle.db, actor, {
      key: 'MAIL_PASSWORD',
      secretId: secret.id
    });

    const resolved = resolveEnvironmentVariableWithSecret(handle.db, {
      workspaceId,
      workflowId: workflow.id,
      key: 'MAIL_PASSWORD',
      purpose: 'test'
    });
    expect(resolved).toMatchObject({
      value: 'mail-secret-1234',
      fromSecret: true,
      isSecret: true
    });
  });

  test('rejects a secret id from another workspace', async () => {
    await expect(
      setEnvironmentVariable(handle.db, actor, { key: 'X', secretId: 'missing-secret' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('config/environment validation, permissions, tenant isolation and audit', () => {
  test('rejects an invalid key format', async () => {
    await expect(
      setEnvironmentVariable(handle.db, actor, { key: '9BAD KEY', value: 'x' })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('requires a value or a secret, and not both', async () => {
    await expect(setEnvironmentVariable(handle.db, actor, { key: 'EMPTY' })).rejects.toMatchObject({
      code: 'validation_failed'
    });

    await expect(
      setEnvironmentVariable(handle.db, actor, { key: 'BOTH', value: 'v', secretId: 's' })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('members may read configuration but not write it', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'READONLY', value: 'v' });
    expect(listEnvironmentVariables(handle.db, member)).toHaveLength(1);
    await expect(
      setEnvironmentVariable(handle.db, member, { key: 'NOPE', value: 'v' })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('another workspace cannot see or mutate these variables', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'PRIVATE', value: 'v' });
    const otherWorkspace = await createWorkspace(handle.db, 'Other');
    const otherUser = await createUser(handle.db);
    const otherActor = ownerActor(otherWorkspace.id, otherUser.id);

    expect(listEnvironmentVariables(handle.db, otherActor)).toHaveLength(0);
    await expect(
      setEnvironmentVariable(handle.db, otherActor, {
        key: 'PRIVATE',
        value: 'steal',
        workflowId: workflow.id
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('upsert replaces an existing key instead of duplicating it', async () => {
    await setEnvironmentVariable(handle.db, actor, { key: 'DUP', value: 'one' });
    await setEnvironmentVariable(handle.db, actor, { key: 'DUP', value: 'two' });
    const rows = listEnvironmentVariables(handle.db, actor).filter((row) => row.key === 'DUP');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('two');
  });

  test('audits variable.set and variable.deleted without recording the value', async () => {
    const variable = await setEnvironmentVariable(handle.db, actor, {
      key: 'AUDITED',
      value: 'top-secret-value'
    });
    await deleteEnvironmentVariable(handle.db, actor, variable.id);

    const setEvents = await queryAudit(handle.db, {
      workspaceId,
      actions: ['variable.set']
    });
    const deletedEvents = await queryAudit(handle.db, {
      workspaceId,
      actions: ['variable.deleted']
    });
    expect(setEvents).toHaveLength(1);
    expect(deletedEvents).toHaveLength(1);
    expect(JSON.stringify(setEvents)).not.toContain('top-secret-value');
    expect(JSON.stringify(deletedEvents)).not.toContain('top-secret-value');
  });

  test('getEnvironmentVariable is workspace scoped', async () => {
    const variable = await setEnvironmentVariable(handle.db, actor, { key: 'SCOPED', value: 'v' });
    expect(getEnvironmentVariable(handle.db, actor, variable.id).key).toBe('SCOPED');
    const otherWorkspace = await createWorkspace(handle.db, 'Other2');
    const otherActor = ownerActor(otherWorkspace.id, (await createUser(handle.db)).id);
    expect(() => getEnvironmentVariable(handle.db, otherActor, variable.id)).toThrow();
  });
});
