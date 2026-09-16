/**
 * Workspace and workflow environment variables.
 *
 * Why this exists: an agent, tool or HTTP operation must be able to read a
 * configuration value without knowing whether it was defined for the workspace or
 * overridden for one workflow. Resolution is always
 * **`Workflow override > Workspace value`** and every read reports *where* the
 * value came from, so the provenance UI never has to guess (ADR-0006).
 *
 * Secret-backed variables are a reference, not a value. This module deliberately
 * never decrypts them: a secret-backed variable resolves to
 * `{ isSecret: true, secretId, lastFour }` and plaintext is obtained only at
 * execution time through `secrets/environment.ts`, which routes through the one
 * function allowed to decrypt (ADR-0020).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import { type EnvironmentVariable, environmentVariables, secrets, workflows } from '../db/schema';

export type EnvironmentScope = 'workspace' | 'workflow';
export type EnvironmentSource = 'workspace' | 'workflow' | 'default';

/** Where an effective value sits relative to the workflow being viewed. */
export type EnvironmentProvenance = 'inherited' | 'overridden' | 'local';

/** Non-sensitive view of one stored variable. `value` is null for secrets. */
export interface EnvironmentVariableView {
  id: string;
  workspaceId: string;
  scope: EnvironmentScope;
  workflowId: string | null;
  key: string;
  value: string | null;
  secretId: string | null;
  isSecret: boolean;
  lastFour: string | null;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One key as the provenance UI renders it: effective value plus its origin. */
export interface EffectiveEnvironmentEntry {
  key: string;
  value: string | null;
  isSecret: boolean;
  secretId: string | null;
  lastFour: string | null;
  source: EnvironmentSource;
  state: EnvironmentProvenance;
  workspaceVariableId: string | null;
  workflowVariableId: string | null;
}

export interface ResolvedEnvironmentValue {
  key: string;
  value: string | null;
  source: EnvironmentSource;
  secretId: string | null;
  isSecret: boolean;
  lastFour: string | null;
}

export interface SetEnvironmentVariableInput {
  key: string;
  /** Plaintext value; mutually exclusive with `secretId`. */
  value?: string | null;
  /** Reference to a workspace secret; the plaintext never enters this table. */
  secretId?: string | null;
  description?: string | null;
  workflowId?: string | null;
  scope?: EnvironmentScope;
}

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MAX_KEY_LENGTH = 64;

/**
 * Canonicalise an environment key. Lowercase and separators are folded because
 * shell-style names are conventionally upper snake case; anything that still does
 * not look like a portable environment name (for example a leading digit) is a
 * validation error rather than a silently mangled key.
 */
export function normalizeEnvironmentKey(key: string): string {
  const normalized = key
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/__+/g, '_')
    .replace(/_+$/, '');
  if (normalized.length === 0) {
    throw errors.validation('Environment variable key must not be empty');
  }
  if (normalized.length > MAX_KEY_LENGTH) {
    throw errors.validation(
      `Environment variable key must be ${MAX_KEY_LENGTH} characters or fewer`
    );
  }
  if (!ENV_KEY_PATTERN.test(normalized)) {
    throw errors.validation(
      `Invalid environment variable key "${key}": expected letters, digits and underscores (not starting with a digit)`,
      { key }
    );
  }
  return normalized;
}

function secretHints(
  db: Executor,
  workspaceId: string,
  ids: Array<string | null>
): Map<string, string | null> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = db
    .select({ id: secrets.id, lastFour: secrets.lastFour })
    .from(secrets)
    .where(and(eq(secrets.workspaceId, workspaceId), inArray(secrets.id, unique)))
    .all();
  return new Map(rows.map((row) => [row.id, row.lastFour]));
}

function toView(row: EnvironmentVariable, lastFour: string | null): EnvironmentVariableView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope,
    workflowId: row.workflowId,
    key: row.key,
    // A secret-backed variable stores no plaintext, so there is nothing to show.
    value: row.isSecret ? null : row.value,
    secretId: row.secretId,
    isSecret: row.isSecret,
    lastFour: row.isSecret ? lastFour : null,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function requireWorkflowInWorkspace(db: Executor, workspaceId: string, workflowId: string): void {
  const rows = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
    .limit(1)
    .all();
  // Cross-tenant probing must not distinguish "missing" from "another tenant".
  if (!rows[0]) throw errors.notFound('Workflow', workflowId);
}

function requireSecretInWorkspace(db: Executor, workspaceId: string, secretId: string): void {
  const rows = db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(eq(secrets.id, secretId), eq(secrets.workspaceId, workspaceId), isNull(secrets.deletedAt))
    )
    .limit(1)
    .all();
  if (!rows[0]) throw errors.notFound('Secret', secretId);
}

/**
 * Create or replace a variable in its scope. Upsert is explicit (not
 * `ON CONFLICT`) because SQLite treats NULL workflow ids as distinct in the
 * unique index, so a workspace-scoped key would otherwise be duplicated.
 */
export async function setEnvironmentVariable(
  db: Executor,
  actor: ActorContext,
  input: SetEnvironmentVariableInput
): Promise<EnvironmentVariableView> {
  assertPermission(
    actor,
    Permissions.configWrite,
    'Not permitted to configure environment variables'
  );
  const key = normalizeEnvironmentKey(input.key);
  const workflowId = input.workflowId ?? null;
  const scope: EnvironmentScope = input.scope ?? (workflowId ? 'workflow' : 'workspace');
  if (scope === 'workflow' && !workflowId) {
    throw errors.validation('A workflow-scoped environment variable requires a workflowId');
  }
  if (scope === 'workspace' && workflowId) {
    throw errors.validation('A workspace-scoped environment variable cannot carry a workflowId');
  }
  if (workflowId) requireWorkflowInWorkspace(db, actor.workspaceId, workflowId);

  const hasSecret = typeof input.secretId === 'string' && input.secretId.length > 0;
  const hasValue = input.value !== undefined && input.value !== null;
  if (hasSecret && hasValue) {
    throw errors.validation('Provide either a plaintext value or a secretId, not both');
  }
  if (!hasSecret && !hasValue) {
    throw errors.validation('An environment variable requires a value or a secretId');
  }
  if (hasSecret && input.secretId) {
    requireSecretInWorkspace(db, actor.workspaceId, input.secretId);
  }

  const now = Date.now();
  const next = {
    isSecret: hasSecret,
    value: hasSecret ? null : (input.value ?? null),
    secretId: hasSecret ? (input.secretId ?? null) : null,
    description: input.description ?? null,
    updatedAt: now
  };

  const row = await withTransaction(db, (tx) => {
    const existing = tx
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.workspaceId, actor.workspaceId),
          workflowId
            ? eq(environmentVariables.workflowId, workflowId)
            : isNull(environmentVariables.workflowId),
          eq(environmentVariables.key, key)
        )
      )
      .limit(1)
      .all()[0];

    const persisted = existing
      ? tx
          .update(environmentVariables)
          .set(next)
          .where(eq(environmentVariables.id, existing.id))
          .returning()
          .all()[0]
      : tx
          .insert(environmentVariables)
          .values({
            workspaceId: actor.workspaceId,
            scope,
            workflowId,
            key,
            value: next.value,
            secretId: next.secretId,
            isSecret: next.isSecret,
            description: next.description,
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .all()[0];

    if (!persisted) throw errors.internal('Failed to persist environment variable', { key });

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.variableSet,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'environment_variable',
      entityId: persisted.id,
      workflowId,
      summary: `Environment variable "${key}" set (${scope})`,
      // The value is never written to the ledger, only its provenance.
      data: {
        key,
        scope,
        secretId: persisted.secretId,
        isSecret: persisted.isSecret,
        replaced: Boolean(existing)
      }
    });
    return persisted;
  });

  const lastFour = row.secretId
    ? (secretHints(db, actor.workspaceId, [row.secretId]).get(row.secretId) ?? null)
    : null;
  return toView(row, lastFour);
}

export function getEnvironmentVariable(
  db: Executor,
  actor: ActorContext,
  variableId: string
): EnvironmentVariableView {
  assertPermission(actor, Permissions.configRead, 'Not permitted to read configuration');
  const row = db
    .select()
    .from(environmentVariables)
    .where(
      and(
        eq(environmentVariables.id, variableId),
        eq(environmentVariables.workspaceId, actor.workspaceId)
      )
    )
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Environment variable', variableId);
  const lastFour = row.secretId
    ? (secretHints(db, actor.workspaceId, [row.secretId]).get(row.secretId) ?? null)
    : null;
  return toView(row, lastFour);
}

export function listEnvironmentVariables(
  db: Executor,
  actor: ActorContext,
  options: { workflowId?: string | null } = {}
): EnvironmentVariableView[] {
  assertPermission(actor, Permissions.configRead, 'Not permitted to read configuration');
  const rows = db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.workspaceId, actor.workspaceId))
    .orderBy(environmentVariables.key)
    .all();
  const visible = rows.filter(
    (row) =>
      row.workflowId === null || (options.workflowId && row.workflowId === options.workflowId)
  );
  const hints = secretHints(
    db,
    actor.workspaceId,
    visible.map((row) => row.secretId)
  );
  return visible.map((row) => toView(row, row.secretId ? (hints.get(row.secretId) ?? null) : null));
}

export async function deleteEnvironmentVariable(
  db: Executor,
  actor: ActorContext,
  variableId: string
): Promise<void> {
  assertPermission(
    actor,
    Permissions.configWrite,
    'Not permitted to configure environment variables'
  );
  await withTransaction(db, (tx) => {
    const deleted = tx
      .delete(environmentVariables)
      .where(
        and(
          eq(environmentVariables.id, variableId),
          eq(environmentVariables.workspaceId, actor.workspaceId)
        )
      )
      .returning()
      .all()[0];
    if (!deleted) throw errors.notFound('Environment variable', variableId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.variableDeleted,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'environment_variable',
      entityId: deleted.id,
      workflowId: deleted.workflowId,
      summary: `Environment variable "${deleted.key}" deleted`,
      data: { key: deleted.key, scope: deleted.scope, wasSecret: deleted.isSecret }
    });
  });
}

function rowToResolution(
  key: string,
  row: EnvironmentVariable,
  source: EnvironmentSource,
  lastFour: string | null
): ResolvedEnvironmentValue {
  return {
    key,
    value: row.isSecret ? null : row.value,
    source,
    secretId: row.secretId,
    isSecret: row.isSecret,
    lastFour: row.isSecret ? lastFour : null
  };
}

/**
 * Resolve one key for execution. No permission check: this is called from
 * execution paths (tools, HTTP, agents) that already hold an actor and a
 * workspace, and the workspace id is part of the contract.
 */
export function resolveEnvironmentValue(
  db: Executor,
  options: {
    workspaceId: string;
    workflowId?: string | null;
    key: string;
    /** Returned with `source: 'default'` when nothing is configured. */
    defaultValue?: string | null;
  }
): ResolvedEnvironmentValue {
  const key = normalizeEnvironmentKey(options.key);
  const workflowId = options.workflowId ?? null;

  const workspaceRow = db
    .select()
    .from(environmentVariables)
    .where(
      and(
        eq(environmentVariables.workspaceId, options.workspaceId),
        isNull(environmentVariables.workflowId),
        eq(environmentVariables.key, key)
      )
    )
    .limit(1)
    .all()[0];

  const workflowRow = workflowId
    ? db
        .select()
        .from(environmentVariables)
        .where(
          and(
            eq(environmentVariables.workspaceId, options.workspaceId),
            eq(environmentVariables.workflowId, workflowId),
            eq(environmentVariables.key, key)
          )
        )
        .limit(1)
        .all()[0]
    : undefined;

  // Workflow override wins, including when it shadows a workspace value.
  const effective = workflowRow ?? workspaceRow;
  if (!effective) {
    return {
      key,
      value: options.defaultValue ?? null,
      source: 'default',
      secretId: null,
      isSecret: false,
      lastFour: null
    };
  }
  const hints = secretHints(db, options.workspaceId, [effective.secretId]);
  return rowToResolution(
    key,
    effective,
    workflowRow ? 'workflow' : 'workspace',
    effective.secretId ? (hints.get(effective.secretId) ?? null) : null
  );
}

/**
 * Every key visible to a workflow, annotated with provenance. This is the single
 * call the configuration UI needs: it answers inherited / overridden / local for
 * each key without the caller re-implementing the resolution order.
 */
export function listEffectiveEnvironment(
  db: Executor,
  options: { workspaceId: string; workflowId?: string | null }
): EffectiveEnvironmentEntry[] {
  const workspaceId = options.workspaceId;
  const workflowId = options.workflowId ?? null;

  const workspaceRows = db
    .select()
    .from(environmentVariables)
    .where(
      and(
        eq(environmentVariables.workspaceId, workspaceId),
        isNull(environmentVariables.workflowId)
      )
    )
    .all();
  const workflowRows = workflowId
    ? db
        .select()
        .from(environmentVariables)
        .where(
          and(
            eq(environmentVariables.workspaceId, workspaceId),
            eq(environmentVariables.workflowId, workflowId)
          )
        )
        .all()
    : [];

  const hints = secretHints(db, workspaceId, [
    ...workspaceRows.map((row) => row.secretId),
    ...workflowRows.map((row) => row.secretId)
  ]);
  const workspaceByKey = new Map(workspaceRows.map((row) => [row.key, row]));
  const workflowByKey = new Map(workflowRows.map((row) => [row.key, row]));

  const keys = [...new Set([...workspaceByKey.keys(), ...workflowByKey.keys()])].sort();
  return keys.map((key) => {
    const workspaceRow = workspaceByKey.get(key);
    const workflowRow = workflowByKey.get(key);
    const effective = workflowRow ?? workspaceRow;
    if (!effective) throw errors.internal('Unreachable environment resolution', { key });
    const state: EnvironmentProvenance = workflowRow
      ? workspaceRow
        ? 'overridden'
        : 'local'
      : workflowId
        ? 'inherited'
        : 'local';
    const source: EnvironmentSource = workflowRow ? 'workflow' : 'workspace';
    const lastFour = effective.secretId ? (hints.get(effective.secretId) ?? null) : null;
    return {
      key,
      value: effective.isSecret ? null : effective.value,
      isSecret: effective.isSecret,
      secretId: effective.secretId,
      lastFour: effective.isSecret ? lastFour : null,
      source,
      state,
      workspaceVariableId: workspaceRow?.id ?? null,
      workflowVariableId: workflowRow?.id ?? null
    };
  });
}
