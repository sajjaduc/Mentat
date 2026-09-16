/**
 * BlobStore resolution.
 *
 * Which physical store a workspace uses is workspace configuration, not a
 * workflow concern: logical Files belong to the workspace and workflows merely
 * contextualise them, so making provider choice a workflow override would make
 * cross-workflow movement ambiguous (files brief §6). Resolution therefore reads
 * `workspace_storage_config` once per configuration key and caches the resulting
 * `BlobStore`; instances are stateless apart from a lazily-initialised client, so
 * sharing them per configuration is safe.
 *
 * GCS credentials are resolved from the secret subsystem at construction time,
 * parsed as JSON, and handed straight to the store, which keeps them in an
 * ECMAScript private field. They are never logged, returned or serialised
 * (ADR-0020).
 */
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { blobRoot, fileMaxBytes } from '../config/env';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { workspaceStorageConfig } from '../db/schema';
import { resolveSecretValue } from '../secrets/service';
import { assertSafeKey, type BlobStore } from './blob-store';
import { GcsBlobStore } from './gcs-blob-store';
import { LocalBlobStore } from './local-blob-store';

export interface WorkspaceStorageSettings {
  provider: 'local' | 'gcs';
  bucket: string | null;
  prefix: string | null;
  credentialsSecretId: string | null;
  localRoot: string | null;
  maxFileBytes: number;
}

/** Effective storage settings for a workspace, with sensible local defaults. */
export function readWorkspaceStorageSettings(
  db: Executor,
  workspaceId: string
): WorkspaceStorageSettings {
  const rows = db
    .select()
    .from(workspaceStorageConfig)
    .where(eq(workspaceStorageConfig.workspaceId, workspaceId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    return {
      provider: 'local',
      bucket: null,
      prefix: null,
      credentialsSecretId: null,
      localRoot: null,
      maxFileBytes: fileMaxBytes()
    };
  }
  return {
    provider: row.provider,
    bucket: row.bucket,
    prefix: row.prefix,
    credentialsSecretId: row.credentialsSecretId,
    localRoot: row.localRoot,
    maxFileBytes: row.maxFileBytes > 0 ? row.maxFileBytes : fileMaxBytes()
  };
}

const cache = new Map<string, BlobStore>();

/** Stable cache key for a configuration; changing any value yields a new store. */
export function blobStoreConfigKey(settings: WorkspaceStorageSettings): string {
  return [
    settings.provider,
    settings.bucket ?? '',
    settings.prefix ?? '',
    settings.credentialsSecretId ?? '',
    settings.localRoot ?? ''
  ].join('|');
}

/** Drop cached stores. Tests and configuration changes call this explicitly. */
export function clearBlobStoreCache(): void {
  cache.clear();
}

/**
 * Resolve the workspace's BlobStore, defaulting to local filesystem storage when
 * no configuration row exists. The returned promise resolves the credentials
 * secret (an auditing operation) outside any transaction.
 */
export async function resolveBlobStore(db: Executor, workspaceId: string): Promise<BlobStore> {
  const settings = readWorkspaceStorageSettings(db, workspaceId);
  const key = blobStoreConfigKey(settings);
  const cached = cache.get(key);
  if (cached) return cached;

  const store =
    settings.provider === 'gcs'
      ? buildGcsStore(db, workspaceId, settings)
      : buildLocalStore(settings);
  cache.set(key, store);
  return store;
}

function buildLocalStore(settings: WorkspaceStorageSettings): BlobStore {
  const root = settings.localRoot ? path.resolve(settings.localRoot) : blobRoot();
  return new LocalBlobStore({
    root: settings.prefix ? scopedLocalRoot(root, settings.prefix) : root
  });
}

/**
 * Apply a configured prefix as a sub-directory while refusing traversal: the
 * prefix is validated segment-by-segment, then the resolved path is re-checked
 * against the root.
 */
function scopedLocalRoot(root: string, prefix: string): string {
  const normalised = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalised.length === 0) return root;
  assertSafeKey(normalised);
  const candidate = path.resolve(root, normalised);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw errors.validation('Storage prefix escapes the configured local root');
  }
  return candidate;
}

function buildGcsStore(
  db: Executor,
  workspaceId: string,
  settings: WorkspaceStorageSettings
): BlobStore {
  if (!settings.bucket || settings.bucket.trim().length === 0) {
    throw errors.validation('GCS storage requires a bucket name', { workspaceId });
  }
  const credentials = readGcsCredentials(db, workspaceId, settings.credentialsSecretId);
  return new GcsBlobStore({
    bucket: settings.bucket,
    prefix: settings.prefix,
    credentials
  });
}

function readGcsCredentials(
  db: Executor,
  workspaceId: string,
  secretId: string | null
): Record<string, unknown> | null {
  if (!secretId) {
    // No secret configured: fall back to ambient credentials (workload identity /
    // GOOGLE_APPLICATION_CREDENTIALS). A configured secret always wins.
    return null;
  }
  const raw = resolveSecretValue(db, {
    workspaceId,
    secretId,
    purpose: 'gcs storage credentials'
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errors.validation('GCS credentials secret must contain valid JSON', { secretId });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.validation('GCS credentials secret must contain a JSON object', { secretId });
  }
  return parsed as Record<string, unknown>;
}
