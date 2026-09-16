/**
 * Workspace storage configuration.
 *
 * Storage may point at a bucket with credentials, so the read surface must expose
 * a reference and a hint — never credential material.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_FILE_BYTES,
  deleteStorageConfig,
  getStorageConfig,
  setStorageConfig
} from '../../../src/lib/server/config/storage';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { createSecret } from '../../../src/lib/server/secrets/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, memberActor, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let actor: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Storage');
  workspaceId = workspace.id;
  actor = ownerActor(workspaceId, (await createUser(handle.db)).id);
});

afterEach(() => {
  handle.cleanup();
});

describe('config/storage', () => {
  test('returns a local default when nothing is configured', () => {
    const config = getStorageConfig(handle.db, workspaceId);
    expect(config).toMatchObject({
      id: null,
      workspaceId,
      provider: 'local',
      bucket: null,
      credentialsSecretId: null,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      isDefault: true
    });
  });

  test('creates and updates the configuration', async () => {
    const created = await setStorageConfig(handle.db, actor, {
      provider: 'gcs',
      bucket: 'mentat-bucket',
      prefix: `workspaces/${workspaceId}/`,
      maxFileBytes: 1024
    });
    expect(created).toMatchObject({
      provider: 'gcs',
      bucket: 'mentat-bucket',
      prefix: `workspaces/${workspaceId}/`,
      maxFileBytes: 1024,
      isDefault: false
    });

    const updated = await setStorageConfig(handle.db, actor, {
      provider: 'local',
      localRoot: '/tmp/mentat',
      maxFileBytes: 2048
    });
    expect(updated).toMatchObject({
      provider: 'local',
      localRoot: '/tmp/mentat',
      maxFileBytes: 2048
    });
    expect(updated.bucket).toBeNull();
    // One row per workspace.
    const read = getStorageConfig(handle.db, workspaceId);
    expect(read.id).toBe(updated.id);
    expect(read.provider).toBe('local');
  });

  test('never returns credential material, only a reference and hint', async () => {
    const secret = createSecret(handle.db, actor, {
      key: 'GCS_CREDENTIALS',
      value: '{"private_key":"super-secret-json"}'
    });
    const config = await setStorageConfig(handle.db, actor, {
      provider: 'gcs',
      bucket: 'bucket',
      credentialsSecretId: secret.id
    });

    expect(config.credentialsSecretId).toBe(secret.id);
    expect(config.credentialsLastFour).toBe(secret.lastFour);
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('super-secret-json');
    expect(serialized).not.toContain('private_key');

    // The ciphertext exists at rest but is not part of the configuration view.
    const row = handle.sqlite
      .query<{ ciphertext: string }, [string]>('SELECT ciphertext FROM secrets WHERE id = ?')
      .get(secret.id);
    expect(row?.ciphertext).toBeTruthy();
    expect(serialized).not.toContain(row?.ciphertext ?? 'never-match');
  });

  test('requires a bucket for gcs', async () => {
    await expect(setStorageConfig(handle.db, actor, { provider: 'gcs' })).rejects.toMatchObject({
      code: 'validation_failed'
    });
  });

  test('rejects an unknown credentials secret', async () => {
    await expect(
      setStorageConfig(handle.db, actor, {
        provider: 'gcs',
        bucket: 'b',
        credentialsSecretId: 'does-not-exist'
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('delete restores the default row', async () => {
    await setStorageConfig(handle.db, actor, { provider: 'local', maxFileBytes: 4096 });
    await deleteStorageConfig(handle.db, actor, workspaceId);
    expect(getStorageConfig(handle.db, workspaceId)).toMatchObject({
      provider: 'local',
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      isDefault: true
    });
    await expect(deleteStorageConfig(handle.db, actor, workspaceId)).rejects.toMatchObject({
      code: 'not_found'
    });
  });

  test('readers are not permission-gated but writers are', async () => {
    const member = memberActor(workspaceId, (await createUser(handle.db)).id);
    expect(getStorageConfig(handle.db, workspaceId).isDefault).toBe(true);
    await expect(setStorageConfig(handle.db, member, { provider: 'local' })).rejects.toMatchObject({
      code: 'forbidden'
    });
  });

  test('is workspace scoped', async () => {
    const otherWorkspace = await createWorkspace(handle.db, 'Other storage');
    await setStorageConfig(handle.db, actor, { provider: 'gcs', bucket: 'mine' });
    expect(getStorageConfig(handle.db, otherWorkspace.id)).toMatchObject({
      provider: 'local',
      isDefault: true
    });
  });
});
