/**
 * Scoped agent state (`state.get/set/delete/list`).
 *
 * State is durable key/value scratch space for agents and workflow authors. Its
 * whole design is the *scope*: a ticket-scoped value travels with the ticket, a
 * workflow-scoped value is shared inside one workflow, and a workspace-scoped value
 * is visible everywhere in the tenant. Arbitrary SQL is never exposed anywhere in
 * this module.
 *
 * ## Two decisions worth calling out
 *
 * **Owner slots use `''`, not NULL.** The uniqueness index spans the four nullable
 * owner columns, and both SQLite and PostgreSQL treat NULLs as distinct in unique
 * indexes. Storing `''` for "not applicable to this scope" makes the index actually
 * enforce one row per `(workspace, scope, owners, namespace, key)`, so `set` is a
 * true upsert instead of silently inserting duplicates. Views map `''` back to
 * `null` for callers.
 *
 * **Pure state writes are not audited.** The frozen `AuditActions` list has no
 * `state.*` action; the nearest constants (`variable.set`, `collection.record.changed`)
 * belong to environment variables and collections respectively, and reusing them
 * would corrupt those audit filters. Rather than invent an action in a frozen file,
 * this module does not write service-level audit rows for state. Agent state changes
 * remain traceable because every mutation happens through a tool call, and the
 * execution engine records `tool.call.*` audit rows around it. Human/UI callers read
 * `updatedAt`/`version` on the row itself.
 *
 * Expiry is honoured on read: an expired entry is treated as absent and removed
 * lazily. Values are JSON; a serialized value larger than 256 KiB is rejected.
 */
import { and, eq, isNotNull, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { stableStringify } from '../core/hash';
import type { Executor } from '../db/client';
import type { AgentStateScope } from '../db/schema';
import { agentState } from '../db/schema';

export type StateScope = AgentStateScope;

export const DEFAULT_STATE_NAMESPACE = 'default';
export const MAX_STATE_KEY_LENGTH = 512;
export const MAX_STATE_NAMESPACE_LENGTH = 128;
/** Hard cap on a serialized state value, so state can never become a blob store. */
export const MAX_STATE_VALUE_BYTES = 256 * 1024;

const MAX_LIST_LIMIT = 200;
const SCOPES: StateScope[] = ['workspace', 'workflow', 'ticket', 'agent', 'run'];

/** Which owner id a scope must carry to be addressable. */
const REQUIRED_OWNER: Record<StateScope, OwnerField | null> = {
  workspace: null,
  workflow: 'workflowId',
  ticket: 'ticketId',
  agent: 'agentId',
  run: 'runId'
};

export type OwnerField = 'workflowId' | 'ticketId' | 'agentId' | 'runId';

export interface StateOwners {
  workflowId?: string | null;
  ticketId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}

export interface StateEntryView {
  id: string;
  workspaceId: string;
  scope: StateScope;
  workflowId: string | null;
  ticketId: string | null;
  agentId: string | null;
  runId: string | null;
  namespace: string;
  key: string;
  value: unknown;
  version: number;
  expiresAt: number | null;
  createdByType: string | null;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SetStateInput extends StateOwners {
  scope: StateScope;
  key: string;
  value: unknown;
  namespace?: string;
  ttlSeconds?: number | null;
  /** Injectable clock for deterministic TTL tests and maintenance. */
  now?: number;
}

export interface ReadStateInput extends StateOwners {
  scope: StateScope;
  key: string;
  namespace?: string;
  now?: number;
}

export interface ListStateInput extends StateOwners {
  scope: StateScope;
  namespace?: string;
  prefix?: string;
  limit?: number;
  now?: number;
}

interface NormalizedOwners {
  workflowId: string;
  ticketId: string;
  agentId: string;
  runId: string;
}

/**
 * Upsert a state value. The version is bumped on every write so readers can detect
 * concurrent updates; a repeated set of the same key/value is safe (it converges on
 * the same row, bumping the version).
 */
export function setStateValue(
  db: Executor,
  actor: ActorContext,
  input: SetStateInput
): StateEntryView {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to write state');
  const owners = normalizeOwners(input.scope, input);
  assertWorkspaceStateGrant(actor, input.scope);

  const now = input.now ?? Date.now();
  const namespace = normalizeNamespace(input.namespace);
  const key = assertKey(input.key);
  const expiresAt = resolveExpiry(input.ttlSeconds, now);
  assertValueSize(input.value);

  const rows = db
    .insert(agentState)
    .values({
      workspaceId: actor.workspaceId,
      scope: input.scope,
      ...owners,
      namespace,
      key,
      value: input.value as never,
      version: 1,
      expiresAt,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        agentState.workspaceId,
        agentState.scope,
        agentState.workflowId,
        agentState.ticketId,
        agentState.agentId,
        agentState.runId,
        agentState.namespace,
        agentState.key
      ],
      set: {
        value: input.value as never,
        version: sql`${agentState.version} + 1`,
        expiresAt,
        updatedAt: now,
        createdByType: actor.actorType,
        createdById: actor.actorId
      }
    })
    .returning()
    .all();

  const row = rows[0];
  if (!row) throw errors.internal('Failed to write state value');
  return toStateView(row);
}

/** Read a state value. Expired entries are deleted lazily and reported as absent. */
export function getStateValue(
  db: Executor,
  actor: ActorContext,
  input: ReadStateInput
): StateEntryView | null {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read state');
  const owners = normalizeOwners(input.scope, input);
  const now = input.now ?? Date.now();
  const row = db
    .select()
    .from(agentState)
    .where(
      identityWhere(
        actor.workspaceId,
        input.scope,
        owners,
        normalizeNamespace(input.namespace),
        input.key
      )
    )
    .limit(1)
    .all()[0];
  if (!row) return null;
  if (isExpired(row.expiresAt, now)) {
    db.delete(agentState).where(eq(agentState.id, row.id)).run();
    return null;
  }
  return toStateView(row);
}

/** Delete a state value. Idempotent: a missing/expired entry returns `false`. */
export function deleteStateValue(
  db: Executor,
  actor: ActorContext,
  input: ReadStateInput
): boolean {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to delete state');
  const owners = normalizeOwners(input.scope, input);
  assertWorkspaceStateGrant(actor, input.scope);
  const removed = db
    .delete(agentState)
    .where(
      identityWhere(
        actor.workspaceId,
        input.scope,
        owners,
        normalizeNamespace(input.namespace),
        input.key
      )
    )
    .returning({ id: agentState.id })
    .all();
  return removed.length > 0;
}

/**
 * List the newest entries in a scope, optionally filtered by namespace and key
 * prefix. Non-workspace scopes require their owner id, so a caller cannot
 * accidentally enumerate every ticket's state in one call.
 */
export function listState(
  db: Executor,
  actor: ActorContext,
  input: ListStateInput
): StateEntryView[] {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read state');
  const owners = normalizeOwners(input.scope, input);
  const now = input.now ?? Date.now();

  const conditions: SQL[] = [
    eq(agentState.workspaceId, actor.workspaceId),
    eq(agentState.scope, input.scope),
    eq(agentState.workflowId, owners.workflowId),
    eq(agentState.ticketId, owners.ticketId),
    eq(agentState.agentId, owners.agentId),
    eq(agentState.runId, owners.runId),
    eq(agentState.namespace, normalizeNamespace(input.namespace))
  ];
  // Expired rows are excluded at query time and reaped afterwards, so a caller
  // never sees them without paying for a per-row delete on the happy path.
  conditions.push(or(isNull(agentState.expiresAt), sql`${agentState.expiresAt} > ${now}`) as SQL);
  if (input.prefix) {
    conditions.push(sql`${agentState.key} LIKE ${`${escapeLike(input.prefix)}%`} ESCAPE '\\'`);
  }

  const rows = db
    .select()
    .from(agentState)
    .where(and(...conditions))
    .orderBy(sql`${agentState.updatedAt} DESC`, sql`${agentState.key} ASC`)
    .limit(clampLimit(input.limit))
    .all();

  reapExpired(db, actor.workspaceId, input.scope, owners, now);
  return rows.map(toStateView);
}

/** Remove expired rows for a scope so listing stays clean without a maintenance run. */
function reapExpired(
  db: Executor,
  workspaceId: string,
  scope: StateScope,
  owners: NormalizedOwners,
  now: number
): void {
  db.delete(agentState)
    .where(
      and(
        eq(agentState.workspaceId, workspaceId),
        eq(agentState.scope, scope),
        eq(agentState.workflowId, owners.workflowId),
        eq(agentState.ticketId, owners.ticketId),
        eq(agentState.agentId, owners.agentId),
        eq(agentState.runId, owners.runId),
        isNotNull(agentState.expiresAt),
        lte(agentState.expiresAt, now)
      )
    )
    .run();
}

function assertWorkspaceStateGrant(actor: ActorContext, scope: StateScope): void {
  if (scope !== 'workspace') return;
  // Workspace-wide state is shared across every workflow, so it is opt-in: the
  // execution engine surfaces `AgentPermissions.canWriteWorkspaceState` as
  // `config:write`. A bare `data:write` grant is not enough.
  assertPermission(
    actor,
    Permissions.configWrite,
    'Workspace-scoped state writes require an explicit workspace grant'
  );
}

function normalizeOwners(scope: StateScope, input: StateOwners): NormalizedOwners {
  if (!SCOPES.includes(scope)) {
    throw errors.validation(`Unknown state scope "${String(scope)}"`, { scopes: SCOPES });
  }
  const owners: NormalizedOwners = {
    workflowId: emptyToSentinel(input.workflowId),
    ticketId: emptyToSentinel(input.ticketId),
    agentId: emptyToSentinel(input.agentId),
    runId: emptyToSentinel(input.runId)
  };
  const required = REQUIRED_OWNER[scope];
  if (required && owners[required].length === 0) {
    throw errors.validation(`State scope "${scope}" requires ${required}`, { scope, required });
  }
  return owners;
}

function emptyToSentinel(value: string | null | undefined): string {
  return value ?? '';
}

function normalizeNamespace(namespace: string | undefined): string {
  const normalized = namespace?.trim() ? namespace.trim() : DEFAULT_STATE_NAMESPACE;
  if (normalized.length > MAX_STATE_NAMESPACE_LENGTH) {
    throw errors.validation(
      `State namespace must be ${MAX_STATE_NAMESPACE_LENGTH} characters or fewer`
    );
  }
  return normalized;
}

function assertKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw errors.validation('State key must be a non-empty string');
  }
  if (key.length > MAX_STATE_KEY_LENGTH) {
    throw errors.validation(`State key must be ${MAX_STATE_KEY_LENGTH} characters or fewer`);
  }
  return key;
}

function resolveExpiry(ttlSeconds: number | null | undefined, now: number): number | null {
  if (ttlSeconds === null || ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw errors.validation('ttlSeconds must be a positive number when provided');
  }
  return now + Math.floor(ttlSeconds) * 1000;
}

function assertValueSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = stableStringify(value);
  } catch (error) {
    throw errors.validation('State value must be JSON-serializable', {
      reason: error instanceof Error ? error.message : 'unknown'
    });
  }
  if (typeof serialized !== 'string') {
    throw errors.validation('State value must be JSON-serializable');
  }
  const sizeBytes = new TextEncoder().encode(serialized).length;
  if (sizeBytes > MAX_STATE_VALUE_BYTES) {
    throw errors.validation(
      `State value exceeds the ${MAX_STATE_VALUE_BYTES} byte limit (got ${sizeBytes})`,
      { sizeBytes, limit: MAX_STATE_VALUE_BYTES }
    );
  }
}

function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

function identityWhere(
  workspaceId: string,
  scope: StateScope,
  owners: NormalizedOwners,
  namespace: string,
  key: string
) {
  return and(
    eq(agentState.workspaceId, workspaceId),
    eq(agentState.scope, scope),
    eq(agentState.workflowId, owners.workflowId),
    eq(agentState.ticketId, owners.ticketId),
    eq(agentState.agentId, owners.agentId),
    eq(agentState.runId, owners.runId),
    eq(agentState.namespace, namespace),
    eq(agentState.key, key)
  );
}

function toStateView(row: {
  id: string;
  workspaceId: string;
  scope: StateScope;
  workflowId: string | null;
  ticketId: string | null;
  agentId: string | null;
  runId: string | null;
  namespace: string;
  key: string;
  value: unknown;
  version: number;
  expiresAt: number | null;
  createdByType: string | null;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
}): StateEntryView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope,
    workflowId: sentinelToNull(row.workflowId),
    ticketId: sentinelToNull(row.ticketId),
    agentId: sentinelToNull(row.agentId),
    runId: sentinelToNull(row.runId),
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    version: row.version,
    expiresAt: row.expiresAt ?? null,
    createdByType: row.createdByType,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function sentinelToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}
