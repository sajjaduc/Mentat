/**
 * Secrets: encrypted at rest, never returned, resolved only at execution time.
 *
 * Invariants enforced here (ADR-0020):
 *  - plaintext is never returned by any read path, including the API;
 *  - plaintext is registered with the process-wide redactor on decrypt, so it
 *    cannot be logged or persisted even by accident;
 *  - every decrypt writes an audit row naming the secret *id*, not its value;
 *  - resolution order is `Workflow override > Workspace value`.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { env, resolveMasterKey } from '../config/env';
import type { ActorContext } from '../core/context';
import { assertPermission, Permissions } from '../core/context';
import { createSecretBox, type SecretBox } from '../core/crypto';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { secretHint } from '../core/redaction';
import { registerSecretValue } from '../core/secret-registry';
import type { Executor } from '../db/client';
import { type Secret, secrets } from '../db/schema';

let cachedBox: SecretBox | null = null;

/** Process-wide secret box built from the deployment master key. */
export function secretBox(): SecretBox {
  if (!cachedBox) {
    const currentVersion = Number.parseInt(process.env.MENTAT_MASTER_KEY_VERSION ?? '1', 10);
    const previousKey = process.env.MENTAT_MASTER_KEY_PREVIOUS;
    const previousVersion = Number.parseInt(
      process.env.MENTAT_MASTER_KEY_PREVIOUS_VERSION ?? String(Math.max(0, currentVersion - 1)),
      10
    );
    cachedBox = createSecretBox(resolveMasterKey(), {
      version: Number.isFinite(currentVersion) ? currentVersion : 1,
      previous:
        previousKey && previousKey.trim().length > 0
          ? { key: previousKey, version: Number.isFinite(previousVersion) ? previousVersion : 0 }
          : null
    });
  }
  return cachedBox;
}

/** Test-only: drop the cached box so a changed master key is picked up. */
export function resetSecretBox(): void {
  cachedBox = null;
}

/**
 * A secret as seen by the application: everything except the ciphertext. There is
 * deliberately no accessor that yields plaintext outside {@link resolveSecretValue}.
 */
export interface SecretPublicView {
  id: string;
  workspaceId: string;
  scope: 'workspace' | 'workflow';
  workflowId: string | null;
  key: string;
  name: string;
  description: string | null;
  lastFour: string | null;
  valueLength: number | null;
  version: number;
  bindingMode: string;
  sourceSecretId: string | null;
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
  /** True when a workflow override shadows a workspace secret of the same key. */
  hasWorkflowOverride: boolean;
}

export function toPublicSecret(row: Secret, hasWorkflowOverride = false): SecretPublicView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope,
    workflowId: row.workflowId,
    key: row.key,
    name: row.name,
    description: row.description,
    lastFour: row.lastFour,
    valueLength: row.valueLength,
    version: row.version,
    bindingMode: row.bindingMode,
    sourceSecretId: row.sourceSecretId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rotatedAt: row.rotatedAt,
    hasWorkflowOverride
  };
}

export interface CreateSecretInput {
  key: string;
  name?: string;
  value: string;
  description?: string;
  scope?: 'workspace' | 'workflow';
  workflowId?: string | null;
}

export function createSecret(
  db: Executor,
  actor: ActorContext,
  input: CreateSecretInput
): SecretPublicView {
  assertPermission(actor, Permissions.secretWrite, 'Not permitted to create secrets');
  const key = normalizeSecretKey(input.key);
  if (input.value.length === 0) throw errors.validation('Secret value must not be empty');

  const now = Date.now();
  const scope = input.scope ?? (input.workflowId ? 'workflow' : 'workspace');
  const workflowId = scope === 'workflow' ? (input.workflowId ?? null) : null;
  if (scope === 'workflow' && !workflowId) {
    throw errors.validation('A workflow-scoped secret requires a workflowId');
  }

  const existing = db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.workspaceId, actor.workspaceId),
        workflowId ? eq(secrets.workflowId, workflowId) : isNull(secrets.workflowId),
        eq(secrets.key, key),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1)
    .all();
  if (existing[0]) {
    throw errors.conflict(`A secret with key "${key}" already exists in this scope`, {
      key,
      scope
    });
  }

  // A workflow-scoped secret inherits provenance from the workspace one when present.
  let sourceSecretId: string | null = null;
  if (workflowId) {
    const source = db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.workspaceId, actor.workspaceId),
          isNull(secrets.workflowId),
          eq(secrets.key, key),
          isNull(secrets.deletedAt)
        )
      )
      .limit(1)
      .all();
    sourceSecretId = source[0]?.id ?? null;
  }

  const payload = secretBox().encrypt(input.value);
  const hint = secretHint(input.value);

  const inserted = db
    .insert(secrets)
    .values({
      id: uuidv7(),
      workspaceId: actor.workspaceId,
      scope,
      workflowId,
      sourceSecretId,
      bindingMode: sourceSecretId ? 'override' : 'use_asis',
      key,
      name: input.name ?? key,
      description: input.description ?? null,
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.authTag,
      algorithm: payload.algorithm,
      keyVersion: payload.keyVersion,
      lastFour: hint.lastFour,
      valueLength: hint.length,
      version: 1,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();

  const row = inserted[0];
  if (!row) throw errors.internal('Failed to create secret');

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.secretCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'secret',
    entityId: row.id,
    workflowId,
    summary: `Secret "${row.name}" created`,
    // Only non-sensitive metadata is recorded.
    data: { key: row.key, scope: row.scope, lastFour: row.lastFour, version: row.version }
  });

  return toPublicSecret(row, Boolean(sourceSecretId));
}

export function rotateSecret(
  db: Executor,
  actor: ActorContext,
  secretId: string,
  value: string
): SecretPublicView {
  assertPermission(actor, Permissions.secretWrite, 'Not permitted to rotate secrets');
  if (value.length === 0) throw errors.validation('Secret value must not be empty');

  const payload = secretBox().encrypt(value);
  const hint = secretHint(value);
  const now = Date.now();

  const updated = db
    .update(secrets)
    .set({
      ciphertext: payload.ciphertext,
      iv: payload.iv,
      authTag: payload.authTag,
      algorithm: payload.algorithm,
      keyVersion: payload.keyVersion,
      lastFour: hint.lastFour,
      valueLength: hint.length,
      version: sql`${secrets.version} + 1`,
      rotatedAt: now,
      updatedAt: now
    })
    .where(and(eq(secrets.id, secretId), eq(secrets.workspaceId, actor.workspaceId)))
    .returning()
    .all();

  const row = updated[0];
  if (!row) throw errors.notFound('Secret', secretId);

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.secretRotated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'secret',
    entityId: row.id,
    summary: `Secret "${row.name}" rotated`,
    data: { key: row.key, lastFour: row.lastFour }
  });

  return toPublicSecret(row);
}

export function listSecrets(
  db: Executor,
  actor: ActorContext,
  options: { workflowId?: string | null; scope?: 'workspace' | 'workflow' } = {}
): SecretPublicView[] {
  assertPermission(actor, Permissions.secretRead, 'Not permitted to list secrets');
  const conditions = [eq(secrets.workspaceId, actor.workspaceId), isNull(secrets.deletedAt)];
  if (options.scope) conditions.push(eq(secrets.scope, options.scope));
  if (options.workflowId) conditions.push(eq(secrets.workflowId, options.workflowId));

  const rows = db
    .select()
    .from(secrets)
    .where(and(...conditions))
    .orderBy(secrets.key)
    .all();

  const workspaceKeys = new Set(
    rows.filter((row) => row.workflowId === null).map((row) => row.key)
  );
  return rows.map((row) =>
    toPublicSecret(row, row.workflowId !== null && workspaceKeys.has(row.key))
  );
}

export function getSecretById(
  db: Executor,
  actor: ActorContext,
  secretId: string
): SecretPublicView {
  assertPermission(actor, Permissions.secretRead, 'Not permitted to read secrets');
  const rows = db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.id, secretId),
        eq(secrets.workspaceId, actor.workspaceId),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) throw errors.notFound('Secret', secretId);
  return toPublicSecret(row);
}

/**
 * Resolve plaintext for execution.
 *
 * This is the only function in Mentat that returns a secret value. It registers
 * the value with the redactor before returning so that nothing downstream can leak
 * it, and records an audit row referencing the secret id.
 */
export function resolveSecretValue(
  db: Executor,
  options: {
    workspaceId: string;
    secretId: string;
    /** Populated for attribution; never persisted with the value. */
    runId?: string | null;
    purpose?: string;
  }
): string {
  const rows = db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.id, options.secretId),
        eq(secrets.workspaceId, options.workspaceId),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) throw errors.notFound('Secret', options.secretId);

  let plaintext: string;
  try {
    plaintext = secretBox().decrypt({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      algorithm: row.algorithm as 'aes-256-gcm',
      keyVersion: row.keyVersion
    });
  } catch (error) {
    throw errors.internal(`Unable to decrypt secret "${row.key}"`, {
      secretId: row.id,
      reason: error instanceof Error ? error.message : 'unknown'
    });
  }

  registerSecretValue(plaintext);

  writeAudit(db, {
    workspaceId: options.workspaceId,
    action: AuditActions.secretAccessed,
    actorType: 'system',
    entityType: 'secret',
    entityId: row.id,
    runId: options.runId ?? null,
    summary: `Secret "${row.key}" resolved for ${options.purpose ?? 'execution'}`,
    data: { key: row.key, keyVersion: row.keyVersion, purpose: options.purpose ?? 'execution' }
  });

  return plaintext;
}

/**
 * Resolve a secret by key honouring `Workflow override > Workspace value`.
 * Returns null when nothing is configured, so callers can produce a precise error.
 */
export function resolveSecretByKey(
  db: Executor,
  options: {
    workspaceId: string;
    key: string;
    workflowId?: string | null;
    runId?: string | null;
    purpose?: string;
  }
): string | null {
  const key = normalizeSecretKey(options.key);
  if (options.workflowId) {
    const override = db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.workspaceId, options.workspaceId),
          eq(secrets.workflowId, options.workflowId),
          eq(secrets.key, key),
          isNull(secrets.deletedAt)
        )
      )
      .limit(1)
      .all();
    if (override[0]) {
      return resolveSecretValue(db, {
        workspaceId: options.workspaceId,
        secretId: override[0].id,
        runId: options.runId,
        purpose: options.purpose
      });
    }
  }

  const workspaceRow = db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.workspaceId, options.workspaceId),
        isNull(secrets.workflowId),
        eq(secrets.key, key),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1)
    .all();
  const workspaceSecret = workspaceRow[0];
  if (!workspaceSecret) return null;

  return resolveSecretValue(db, {
    workspaceId: options.workspaceId,
    secretId: workspaceSecret.id,
    runId: options.runId,
    purpose: options.purpose
  });
}

/** Soft-delete: history keeps referencing the secret id. */
export function deleteSecret(db: Executor, actor: ActorContext, secretId: string): void {
  assertPermission(actor, Permissions.secretWrite, 'Not permitted to delete secrets');
  const now = Date.now();
  const updated = db
    .update(secrets)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(secrets.id, secretId), eq(secrets.workspaceId, actor.workspaceId)))
    .returning()
    .all();
  const row = updated[0];
  if (!row) throw errors.notFound('Secret', secretId);
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.secretDeleted,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'secret',
    entityId: row.id,
    workflowId: row.workflowId,
    summary: `Secret "${row.name}" deleted`,
    data: { key: row.key, scope: row.scope }
  });
}

/** True when the deployment is configured with a real master key from the env. */
export function usingEnvMasterKey(): boolean {
  const configured = env().MENTAT_MASTER_KEY;
  return typeof configured === 'string' && configured.trim().length > 0;
}

export function normalizeSecretKey(key: string): string {
  const normalized = key
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized.length === 0) throw errors.validation('Secret key must not be empty');
  if (normalized.length > 64) throw errors.validation('Secret key must be 64 characters or fewer');
  return normalized;
}
