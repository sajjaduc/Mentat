/**
 * Per-workspace object storage settings.
 *
 * Why this exists: files must be stored somewhere well-defined, and a workspace
 * must be able to move from the local filesystem to a bucket without code
 * changes. Credentials are never stored here — only a reference to a secret
 * (`credentialsSecretId`), and reads expose at most the secret's `lastFour`
 * hint, never ciphertext or plaintext (ADR-0020).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import { secrets, workspaceStorageConfig } from '../db/schema';

/** 50 MiB — the platform default until a workspace overrides it. */
export const DEFAULT_MAX_FILE_BYTES = 52_428_800;

export interface StorageConfigView {
  id: string | null;
  workspaceId: string;
  provider: 'local' | 'gcs';
  bucket: string | null;
  prefix: string | null;
  credentialsSecretId: string | null;
  /** Non-sensitive hint only; the credential material itself never leaves secrets. */
  credentialsLastFour: string | null;
  localRoot: string | null;
  maxFileBytes: number;
  isDefault: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

const storageConfigSchema = z
  .object({
    provider: z.enum(['local', 'gcs']),
    bucket: z.string().trim().min(1).max(255).nullish(),
    prefix: z.string().trim().max(1024).nullish(),
    credentialsSecretId: z.string().trim().min(1).nullish(),
    localRoot: z.string().trim().max(2048).nullish(),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024 * 1024)
      .optional(),
    config: z.record(z.string(), z.unknown()).nullish()
  })
  .refine((value) => value.provider !== 'gcs' || Boolean(value.bucket), {
    message: 'A gcs storage configuration requires a bucket',
    path: ['bucket']
  });

export interface SetStorageConfigInput {
  provider: 'local' | 'gcs';
  bucket?: string | null;
  prefix?: string | null;
  credentialsSecretId?: string | null;
  localRoot?: string | null;
  maxFileBytes?: number;
  config?: Record<string, unknown> | null;
}

function defaultView(workspaceId: string): StorageConfigView {
  return {
    id: null,
    workspaceId,
    provider: 'local',
    bucket: null,
    prefix: null,
    credentialsSecretId: null,
    credentialsLastFour: null,
    localRoot: null,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    isDefault: true,
    createdAt: null,
    updatedAt: null
  };
}

function lastFourFor(db: Executor, workspaceId: string, secretId: string | null): string | null {
  if (!secretId) return null;
  const row = db
    .select({ lastFour: secrets.lastFour })
    .from(secrets)
    .where(
      and(eq(secrets.id, secretId), eq(secrets.workspaceId, workspaceId), isNull(secrets.deletedAt))
    )
    .limit(1)
    .all()[0];
  return row?.lastFour ?? null;
}

/**
 * Read the effective storage settings. Returns a default row when the workspace
 * has never configured storage, so callers never branch on `null`.
 *
 * No actor is required: this is read from the storage/files execution path, where
 * a workspace id is already the security boundary.
 */
export function getStorageConfig(db: Executor, workspaceId: string): StorageConfigView {
  const row = db
    .select()
    .from(workspaceStorageConfig)
    .where(eq(workspaceStorageConfig.workspaceId, workspaceId))
    .limit(1)
    .all()[0];
  if (!row) return defaultView(workspaceId);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider,
    bucket: row.bucket,
    prefix: row.prefix,
    credentialsSecretId: row.credentialsSecretId,
    credentialsLastFour: lastFourFor(db, workspaceId, row.credentialsSecretId),
    localRoot: row.localRoot,
    maxFileBytes: row.maxFileBytes,
    isDefault: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** Create or replace the single storage configuration row for a workspace. */
export async function setStorageConfig(
  db: Executor,
  actor: ActorContext,
  input: SetStorageConfigInput
): Promise<StorageConfigView> {
  assertPermission(actor, Permissions.configWrite, 'Not permitted to configure storage');
  const parsed = storageConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation('Invalid storage configuration', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
  }
  const value = parsed.data;
  if (value.credentialsSecretId) {
    const secret = db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.id, value.credentialsSecretId),
          eq(secrets.workspaceId, actor.workspaceId),
          isNull(secrets.deletedAt)
        )
      )
      .limit(1)
      .all()[0];
    if (!secret) throw errors.notFound('Secret', value.credentialsSecretId);
  }

  const now = Date.now();
  const maxFileBytes = value.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  await withTransaction(db, (tx) => {
    const existing = tx
      .select({ id: workspaceStorageConfig.id })
      .from(workspaceStorageConfig)
      .where(eq(workspaceStorageConfig.workspaceId, actor.workspaceId))
      .limit(1)
      .all()[0];

    if (existing) {
      tx.update(workspaceStorageConfig)
        .set({
          provider: value.provider,
          bucket: value.bucket ?? null,
          prefix: value.prefix ?? null,
          credentialsSecretId: value.credentialsSecretId ?? null,
          localRoot: value.localRoot ?? null,
          maxFileBytes,
          config: (value.config as never) ?? null,
          updatedAt: now
        })
        .where(eq(workspaceStorageConfig.id, existing.id))
        .run();
    } else {
      tx.insert(workspaceStorageConfig)
        .values({
          workspaceId: actor.workspaceId,
          provider: value.provider,
          bucket: value.bucket ?? null,
          prefix: value.prefix ?? null,
          credentialsSecretId: value.credentialsSecretId ?? null,
          localRoot: value.localRoot ?? null,
          maxFileBytes,
          config: (value.config as never) ?? null,
          createdAt: now,
          updatedAt: now
        })
        .run();
    }

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.workspaceUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'workspace_storage_config',
      entityId: actor.workspaceId,
      summary: `Storage configured for provider "${value.provider}"`,
      // Credential id + provider metadata only; never material.
      data: {
        provider: value.provider,
        bucket: value.bucket ?? null,
        prefix: value.prefix ?? null,
        credentialsSecretId: value.credentialsSecretId ?? null,
        maxFileBytes,
        replaced: Boolean(existing)
      }
    });
  });

  return getStorageConfig(db, actor.workspaceId);
}

/** Remove the row and fall back to the platform defaults. */
export async function deleteStorageConfig(
  db: Executor,
  actor: ActorContext,
  workspaceId: string
): Promise<void> {
  assertPermission(actor, Permissions.configWrite, 'Not permitted to configure storage');
  if (workspaceId !== actor.workspaceId) throw errors.notFound('Workspace', workspaceId);
  await withTransaction(db, (tx) => {
    const deleted = tx
      .delete(workspaceStorageConfig)
      .where(eq(workspaceStorageConfig.workspaceId, workspaceId))
      .returning()
      .all()[0];
    if (!deleted) throw errors.notFound('Storage configuration', workspaceId);
    writeAudit(tx, {
      workspaceId,
      action: AuditActions.workspaceUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'workspace_storage_config',
      entityId: workspaceId,
      summary: 'Storage configuration removed; platform defaults restored',
      data: { provider: deleted.provider }
    });
  });
}
