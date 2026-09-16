/**
 * Workspace storage resolution.
 *
 * Provider choice is workspace configuration (files brief §6). These tests cover
 * the default, local configuration, per-configuration caching, and GCS credential
 * handling via a resolved secret — including that the credential JSON is never
 * serialisable from the store.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { workspaceStorageConfig } from '../../../src/lib/server/db/schema';
import { createSecret } from '../../../src/lib/server/secrets/service';
import {
  blobStoreConfigKey,
  clearBlobStoreCache,
  readWorkspaceStorageSettings,
  resolveBlobStore
} from '../../../src/lib/server/storage/index';
import { LocalBlobStore } from '../../../src/lib/server/storage/local-blob-store';
import { configureGcsStorage, configureLocalStorage } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, ownerActor } from '../../helpers/factories';

const encoder = new TextEncoder();
const CREDENTIAL_JSON = JSON.stringify({
  client_email: 'mentat@example.test',
  private_key: 'super-secret-private-key'
});

let handle: TestDatabase;
let workspaceId: string;
let actor: ReturnType<typeof ownerActor>;

beforeEach(async () => {
  clearBlobStoreCache();
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Storage Workspace');
  workspaceId = workspace.id;
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
});

describe('resolveBlobStore', () => {
  test('defaults to local storage when no configuration row exists', async () => {
    const settings = readWorkspaceStorageSettings(handle.db, workspaceId);
    expect(settings.provider).toBe('local');
    expect(settings.localRoot).toBeNull();

    const store = await resolveBlobStore(handle.db, workspaceId);
    expect(store).toBeInstanceOf(LocalBlobStore);
    expect(store.kind).toBe('local');

    const key = `workspaces/${workspaceId}/blobs/aa/bb/deadbeef`;
    await store.put(key, encoder.encode('default root'));
    expect(new TextDecoder().decode(await store.get(key))).toBe('default root');
    await store.delete(key);
  });

  test('uses the configured local root', async () => {
    await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
    const store = await resolveBlobStore(handle.db, workspaceId);
    expect(store).toBeInstanceOf(LocalBlobStore);
    const key = `workspaces/${workspaceId}/blobs/cc/dd/cafebabe`;
    await store.put(key, encoder.encode('scoped root'));
    const local = store as LocalBlobStore;
    expect(local.resolvePath(key).startsWith(handle.tempDir)).toBe(true);
  });

  test('caches per configuration key and invalidates when configuration changes', async () => {
    await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
    const first = await resolveBlobStore(handle.db, workspaceId);
    const second = await resolveBlobStore(handle.db, workspaceId);
    expect(second).toBe(first);

    await handle.db
      .update(workspaceStorageConfig)
      .set({ localRoot: `${handle.tempDir}/moved`, updatedAt: Date.now() })
      .where(eq(workspaceStorageConfig.workspaceId, workspaceId))
      .run();
    const moved = await resolveBlobStore(handle.db, workspaceId);
    expect(moved).not.toBe(first);

    clearBlobStoreCache();
    expect(await resolveBlobStore(handle.db, workspaceId)).not.toBe(moved);
  });

  test('builds the cache key from provider, bucket, prefix, secret and root', () => {
    const base = {
      provider: 'local' as const,
      bucket: null,
      prefix: null,
      credentialsSecretId: null,
      localRoot: '/tmp/a',
      maxFileBytes: 1
    };
    expect(blobStoreConfigKey(base)).not.toBe(blobStoreConfigKey({ ...base, localRoot: '/tmp/b' }));
    expect(blobStoreConfigKey(base)).not.toBe(
      blobStoreConfigKey({ ...base, provider: 'gcs', bucket: 'b' })
    );
  });
});

describe('GCS configuration', () => {
  test('resolves a GCS store from a credentials secret without exposing the secret', async () => {
    const secret = createSecret(handle.db, actor, {
      key: 'GCS_CREDENTIALS',
      value: CREDENTIAL_JSON
    });
    await configureGcsStorage(handle.db, workspaceId, {
      bucket: 'mentat-test-bucket',
      prefix: `workspaces/${workspaceId}`,
      credentialsSecretId: secret.id
    });

    const store = await resolveBlobStore(handle.db, workspaceId);
    expect(store.kind).toBe('gcs');
    expect(JSON.stringify(store)).not.toContain('super-secret-private-key');
    expect(JSON.stringify(store)).not.toContain('mentat@example.test');
    expect(Object.getOwnPropertyNames(store)).not.toContain('credentials');
    expect(String(store)).not.toContain('super-secret-private-key');
  });

  test('rejects a credentials secret that is not a JSON object', async () => {
    const secret = createSecret(handle.db, actor, {
      key: 'BAD_CREDENTIALS',
      value: 'not-json'
    });
    await configureGcsStorage(handle.db, workspaceId, {
      bucket: 'mentat-test-bucket',
      credentialsSecretId: secret.id
    });
    await expect(resolveBlobStore(handle.db, workspaceId)).rejects.toThrow();
  });

  test('requires a bucket for GCS provider', async () => {
    await handle.db
      .insert(workspaceStorageConfig)
      .values({
        workspaceId,
        provider: 'gcs',
        bucket: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .run();
    await expect(resolveBlobStore(handle.db, workspaceId)).rejects.toThrow();
  });
});
