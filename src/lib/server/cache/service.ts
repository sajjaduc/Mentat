/**
 * Native cache with TTL, tags, namespaces and stampede protection.
 *
 * Design decisions worth knowing:
 *
 *  - **Identity is a security boundary.** Every read and write filters by
 *    `(workspaceId, namespace, authScope, key)`. A value cached under one
 *    workspace, namespace or credential is never returned for another; the
 *    `authScope` component exists precisely so that two agents with different
 *    resolved credentials cannot observe each other's responses.
 *  - **Expiry is lazy.** An expired row is treated as a miss and deleted by the
 *    reader; `purgeExpired` exists for maintenance so expired rows also disappear
 *    without traffic.
 *  - **No external infrastructure (ADR-0016).** Locks, TTL and counters live in the
 *    same SQLite/PostgreSQL store as everything else.
 *  - **`compute` never runs inside a transaction (ADR-0004).** `cacheGetOrCompute`
 *    acquires the advisory lock with a single statement, awaits the producer, then
 *    persists the result. A producer that throws releases the lock and propagates
 *    the error; nothing is cached.
 *  - **Hit/miss counters.** Hits are incremented on the `cache_entries` row. The
 *    frozen schema has no `misses` column, so durable miss counts live in the
 *    existing generic `counters` table under the well-known name `cache.misses` per
 *    workspace. This keeps `cacheStats` durable across processes without inventing
 *    schema. Hits are surfaced per entry too, so the inspection UI can rank entries.
 *  - **Cache is an internal primitive.** Read/write/delete take a `workspaceId`
 *    because callers (the HTTP runtime, native tools, jobs) have already authorized
 *    the action; only `cacheList` can expose raw values, and only when the caller
 *    asks for them *and* holds `cache:read`.
 */
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { MINUTE } from '../core/clock';
import { type ActorContext, assertPermission, hasPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { stableStringify } from '../core/hash';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import { cacheEntries, counters } from '../db/schema';
import {
  type CacheKeyInput,
  DEFAULT_AUTH_SCOPE,
  normalizeCacheKey,
  validateCacheKey
} from './identity';
import { acquireLock, releaseLock } from './locks';

/** Bounded so a single cache entry can never balloon the store or a model prompt. */
export const MAX_CACHE_VALUE_BYTES = 1024 * 1024;
/** "Expiring soon" window reported by {@link cacheStats}. */
export const EXPIRING_SOON_MS = 5 * MINUTE;
/** Name of the per-workspace miss counter stored in the generic counters table. */
export const CACHE_MISS_COUNTER = 'cache.misses';

const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_POLL_MS = 25;
const MAX_LIST_LIMIT = 200;

export interface CacheGetResult<T = unknown> {
  value: T | null;
  hit: boolean;
  ageMs: number | null;
  expiresAt: number | null;
  storedAt: number | null;
}

export interface CacheSetOptions extends CacheKeyInput {
  value: unknown;
  /** Omit or pass null for an entry that never expires. */
  ttlSeconds?: number | null;
  tags?: string[];
  now?: number;
}

export interface CacheSetResult {
  sizeBytes: number;
  storedAt: number;
  expiresAt: number | null;
  tags: string[];
}

export interface CacheClearOptions {
  workspaceId: string;
  namespace?: string;
  tag?: string;
  authScope?: string;
  actor?: ActorContext;
  now?: number;
}

export interface CacheListOptions {
  workspaceId: string;
  namespace?: string;
  prefix?: string;
  limit?: number;
  /** Requires the caller to hold `cache:read`; returns decrypted raw values. */
  includeValues?: boolean;
  actor?: ActorContext;
  now?: number;
}

export interface CacheListEntry {
  id: string;
  key: string;
  namespace: string;
  authScope: string;
  sizeBytes: number;
  hits: number;
  tags: string[];
  expiresAt: number | null;
  storedAt: number;
  ageMs: number;
  expired: boolean;
  value?: unknown;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  expiringSoon: number;
  expired: number;
  hits: number;
  misses: number;
  namespaces: number;
}

export interface CacheGetOrComputeOptions<T> extends CacheKeyInput {
  ttlSeconds?: number | null;
  tags?: string[];
  /** Async producer. Runs outside any transaction and at most once per slot. */
  compute: () => T | Promise<T>;
  lockTtlMs?: number;
  waitTimeoutMs?: number;
  waitPollMs?: number;
  /** Override the generated lock holder identity (tests). */
  holder?: string;
  now?: number;
}

export interface CacheGetOrComputeResult<T> {
  value: T;
  hit: boolean;
  computed: boolean;
  cacheStatus: 'hit' | 'stored';
  ageMs: number | null;
  expiresAt: number | null;
  storedAt: number;
}

/**
 * Read a cached value. An expired entry is treated as a miss and deleted lazily.
 * A miss is counted for the workspace so `cacheStats` can report a real hit rate.
 */
export function cacheGet<T = unknown>(
  db: Executor,
  options: CacheKeyInput & { now?: number }
): CacheGetResult<T> {
  const key = normalizeCacheKey(options);
  validateCacheKey(key);
  const now = options.now ?? Date.now();
  const row = readEntry(db, key, now);
  if (!row) {
    recordMiss(db, key.workspaceId, now);
    return { value: null, hit: false, ageMs: null, expiresAt: null, storedAt: null };
  }
  incrementHits(db, row.id, now);
  return {
    value: row.value as T,
    hit: true,
    ageMs: Math.max(0, now - row.updatedAt),
    expiresAt: row.expiresAt ?? null,
    storedAt: row.updatedAt
  };
}

/**
 * Insert or replace a cached value. Idempotent for a fixed key and value: the
 * unique identity means a repeated set overwrites rather than duplicating, and
 * per-entry hit stats restart for the new value.
 */
export function cacheSet(db: Executor, options: CacheSetOptions): CacheSetResult {
  const key = normalizeCacheKey(options);
  validateCacheKey(key);
  const now = options.now ?? Date.now();

  const serialized = serializeValue(options.value);
  const sizeBytes = byteLength(serialized);
  if (sizeBytes > MAX_CACHE_VALUE_BYTES) {
    throw errors.validation(
      `Cache value exceeds the ${MAX_CACHE_VALUE_BYTES} byte limit (got ${sizeBytes})`,
      { sizeBytes, limit: MAX_CACHE_VALUE_BYTES }
    );
  }

  const ttlSeconds = options.ttlSeconds ?? null;
  if (ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
    throw errors.validation('ttlSeconds must be a positive number when provided');
  }
  const expiresAt = ttlSeconds === null ? null : now + Math.floor(ttlSeconds) * 1000;
  const tags = options.tags ?? [];

  db.insert(cacheEntries)
    .values({
      workspaceId: key.workspaceId,
      namespace: key.namespace,
      authScope: key.authScope,
      key: key.key,
      value: options.value as never,
      sizeBytes,
      tags,
      hits: 0,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      expiresAt
    })
    .onConflictDoUpdate({
      target: [
        cacheEntries.workspaceId,
        cacheEntries.namespace,
        cacheEntries.authScope,
        cacheEntries.key
      ],
      set: {
        value: options.value as never,
        sizeBytes,
        tags,
        hits: 0,
        updatedAt: now,
        lastAccessedAt: now,
        expiresAt
      }
    })
    .run();

  return { sizeBytes, storedAt: now, expiresAt, tags };
}

/** Delete one cache slot. Idempotent: a second delete returns `false`. */
export function cacheDelete(db: Executor, options: CacheKeyInput): boolean {
  const key = normalizeCacheKey(options);
  validateCacheKey(key);
  const removed = db
    .delete(cacheEntries)
    .where(identityWhere(key))
    .returning({ id: cacheEntries.id })
    .all();
  return removed.length > 0;
}

/**
 * Clear entries for a workspace, optionally narrowed by namespace, tag and/or
 * auth scope. Tag matching is done in memory because tags are a JSON array and a
 * portable array-membership operator does not exist across SQLite and PostgreSQL;
 * the row set is already narrowed by the indexed identity columns first.
 *
 * Clearing is the only cache operation that is audited (`cache.cleared`), and the
 * audit row is written in the same transaction as the deletion.
 */
export async function cacheClear(db: Executor, options: CacheClearOptions): Promise<number> {
  if (options.actor) {
    assertPermission(options.actor, Permissions.cacheWrite, 'Not permitted to clear the cache');
  }
  const conditions = [eq(cacheEntries.workspaceId, options.workspaceId)];
  if (options.namespace) conditions.push(eq(cacheEntries.namespace, options.namespace));
  if (options.authScope !== undefined) {
    conditions.push(eq(cacheEntries.authScope, options.authScope));
  }

  return withTransaction(db, (tx) => {
    const candidates = tx
      .select()
      .from(cacheEntries)
      .where(and(...conditions))
      .all();
    const tag = options.tag;
    const matching = tag
      ? candidates.filter((row) => (row.tags ?? []).includes(tag)).map((row) => row.id)
      : candidates.map((row) => row.id);
    if (matching.length === 0) return 0;

    tx.delete(cacheEntries).where(inArray(cacheEntries.id, matching)).run();
    writeAudit(tx, {
      workspaceId: options.workspaceId,
      action: AuditActions.cacheCleared,
      actorType: options.actor?.actorType ?? 'system',
      actorId: options.actor?.actorId ?? null,
      actorLabel: options.actor?.actorLabel ?? null,
      entityType: 'cache',
      summary: `Cleared ${matching.length} cache entr${matching.length === 1 ? 'y' : 'ies'}`,
      data: {
        namespace: options.namespace ?? null,
        tag: tag ?? null,
        authScope: options.authScope ?? null,
        removed: matching.length
      },
      occurredAt: options.now
    });
    return matching.length;
  });
}

/**
 * Inspection listing for the cache UI. Values are omitted unless the caller asks
 * for them *and* holds `cache:read`, so a member with `cache:read` but no
 * credential-scoped value access still sees sizes, TTLs and hit counts only.
 */
export function cacheList(db: Executor, options: CacheListOptions): CacheListEntry[] {
  if (options.includeValues) {
    if (!options.actor) {
      throw errors.forbidden('Listing cached values requires an actor with cache:read');
    }
    assertPermission(options.actor, Permissions.cacheRead, 'Not permitted to read cached values');
  } else if (options.actor && !hasPermission(options.actor, Permissions.cacheRead)) {
    assertPermission(options.actor, Permissions.cacheRead, 'Not permitted to inspect the cache');
  }

  const now = options.now ?? Date.now();
  const conditions = [eq(cacheEntries.workspaceId, options.workspaceId)];
  if (options.namespace) conditions.push(eq(cacheEntries.namespace, options.namespace));
  if (options.prefix) {
    conditions.push(sql`${cacheEntries.key} LIKE ${`${escapeLike(options.prefix)}%`} ESCAPE '\\'`);
  }

  const limit = clampLimit(options.limit);
  const rows = db
    .select()
    .from(cacheEntries)
    .where(and(...conditions))
    .orderBy(sql`${cacheEntries.updatedAt} DESC`, sql`${cacheEntries.key} ASC`)
    .limit(limit)
    .all();

  return rows.map((row) => {
    const entry: CacheListEntry = {
      id: row.id,
      key: row.key,
      namespace: row.namespace,
      authScope: row.authScope,
      sizeBytes: row.sizeBytes,
      hits: row.hits,
      tags: row.tags ?? [],
      expiresAt: row.expiresAt ?? null,
      storedAt: row.updatedAt,
      ageMs: Math.max(0, now - row.updatedAt),
      expired: row.expiresAt !== null && row.expiresAt <= now
    };
    if (options.includeValues) entry.value = row.value;
    return entry;
  });
}

/** Aggregate cache health for a workspace, including durable hit/miss counters. */
export function cacheStats(
  db: Executor,
  options: { workspaceId: string; now?: number }
): CacheStats {
  const now = options.now ?? Date.now();
  const soon = now + EXPIRING_SOON_MS;

  const totals = db
    .select({
      entries: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${cacheEntries.sizeBytes}), 0)`,
      hits: sql<number>`coalesce(sum(${cacheEntries.hits}), 0)`,
      namespaces: sql<number>`count(distinct ${cacheEntries.namespace})`
    })
    .from(cacheEntries)
    .where(eq(cacheEntries.workspaceId, options.workspaceId))
    .all()[0];

  const expiringSoon = countWhere(
    db,
    and(
      eq(cacheEntries.workspaceId, options.workspaceId),
      isNotNull(cacheEntries.expiresAt),
      lte(cacheEntries.expiresAt, soon)
    )
  );
  const expired = countWhere(
    db,
    and(
      eq(cacheEntries.workspaceId, options.workspaceId),
      isNotNull(cacheEntries.expiresAt),
      lte(cacheEntries.expiresAt, now)
    )
  );

  return {
    entries: totals?.entries ?? 0,
    bytes: totals?.bytes ?? 0,
    expiringSoon,
    expired,
    hits: totals?.hits ?? 0,
    misses: readMissCounter(db, options.workspaceId),
    namespaces: totals?.namespaces ?? 0
  };
}

/**
 * Read-through cache with stampede protection.
 *
 * When the slot is missing, exactly one caller acquires the advisory lock and
 * runs `compute`; the others wait briefly and re-read. A waiter that times out
 * computes anyway rather than deadlocking, so progress never depends on another
 * process being healthy. `compute` runs outside any transaction (ADR-0004).
 */
export async function cacheGetOrCompute<T>(
  db: Executor,
  options: CacheGetOrComputeOptions<T>
): Promise<CacheGetOrComputeResult<T>> {
  const key = normalizeCacheKey(options);
  validateCacheKey(key);
  if (typeof options.compute !== 'function') {
    throw errors.validation('cacheGetOrCompute requires a compute function');
  }

  const initialNow = options.now ?? Date.now();
  const existing = readEntry(db, key, initialNow);
  if (existing) {
    const now = Date.now();
    incrementHits(db, existing.id, now);
    return hitResult<T>(existing, now);
  }
  recordMiss(db, key.workspaceId, initialNow);

  const holder = options.holder ?? `compute:${uuidv7()}`;
  const lock = acquireLock(db, {
    ...key,
    holder,
    ttlMs: options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    now: initialNow
  });

  if (lock.acquired) {
    try {
      const value = await options.compute();
      const stored = cacheSet(db, {
        ...key,
        value,
        ttlSeconds: options.ttlSeconds,
        tags: options.tags
      });
      return storedResult(value, stored);
    } finally {
      releaseLock(db, { ...key, holder });
    }
  }

  const deadline = Date.now() + (options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const pollMs = Math.max(1, options.waitPollMs ?? DEFAULT_WAIT_POLL_MS);
  while (Date.now() < deadline) {
    await delay(pollMs);
    const now = Date.now();
    const retried = readEntry(db, key, now);
    if (retried) {
      incrementHits(db, retried.id, now);
      return hitResult<T>(retried, now);
    }
  }

  // The lock holder is gone or wedged. Computing anyway is strictly better than
  // waiting forever; a duplicate computation is acceptable, a deadlock is not.
  const value = await options.compute();
  const stored = cacheSet(db, {
    ...key,
    value,
    ttlSeconds: options.ttlSeconds,
    tags: options.tags
  });
  return storedResult(value, stored);
}

function hitResult<T>(
  row: { value: unknown; expiresAt: number | null; updatedAt: number },
  now: number
): CacheGetOrComputeResult<T> {
  return {
    value: row.value as T,
    hit: true,
    computed: false,
    cacheStatus: 'hit',
    ageMs: Math.max(0, now - row.updatedAt),
    expiresAt: row.expiresAt ?? null,
    storedAt: row.updatedAt
  };
}

function storedResult<T>(value: T, stored: CacheSetResult): CacheGetOrComputeResult<T> {
  return {
    value,
    hit: false,
    computed: true,
    cacheStatus: 'stored',
    ageMs: 0,
    expiresAt: stored.expiresAt,
    storedAt: stored.storedAt
  };
}

function readEntry(db: Executor, key: ReturnType<typeof normalizeCacheKey>, now: number) {
  const row = db.select().from(cacheEntries).where(identityWhere(key)).limit(1).all()[0];
  if (!row) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) {
    db.delete(cacheEntries).where(eq(cacheEntries.id, row.id)).run();
    return null;
  }
  return row;
}

function incrementHits(db: Executor, id: string, now: number): void {
  db.update(cacheEntries)
    .set({ hits: sql`${cacheEntries.hits} + 1`, lastAccessedAt: now })
    .where(eq(cacheEntries.id, id))
    .run();
}

function recordMiss(db: Executor, workspaceId: string, now: number): void {
  incrementCounter(db, workspaceId, CACHE_MISS_COUNTER, now);
}

function readMissCounter(db: Executor, workspaceId: string): number {
  const row = db
    .select({ value: counters.value })
    .from(counters)
    .where(and(eq(counters.workspaceId, workspaceId), eq(counters.name, CACHE_MISS_COUNTER)))
    .limit(1)
    .all()[0];
  return row?.value ?? 0;
}

/**
 * Synchronous, portable counter increment. Mirrors `nextCounter` in the frozen
 * client but stays callable from the synchronous cache read path; the upsert makes
 * it atomic when two misses race.
 */
function incrementCounter(db: Executor, workspaceId: string, name: string, now: number): void {
  const updated = db
    .update(counters)
    .set({ value: sql`${counters.value} + 1`, updatedAt: now })
    .where(and(eq(counters.workspaceId, workspaceId), eq(counters.name, name)))
    .returning({ value: counters.value })
    .all();
  if (updated[0]) return;

  db.insert(counters)
    .values({ id: `${workspaceId}:${name}`, workspaceId, name, value: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [counters.workspaceId, counters.name],
      set: { value: sql`${counters.value} + 1`, updatedAt: now }
    })
    .run();
}

function countWhere(db: Executor, condition: ReturnType<typeof and>): number {
  return (
    db.select({ count: sql<number>`count(*)` }).from(cacheEntries).where(condition).all()[0]
      ?.count ?? 0
  );
}

function identityWhere(key: ReturnType<typeof normalizeCacheKey>) {
  return and(
    eq(cacheEntries.workspaceId, key.workspaceId),
    eq(cacheEntries.namespace, key.namespace),
    eq(cacheEntries.authScope, key.authScope),
    eq(cacheEntries.key, key.key)
  );
}

function serializeValue(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = stableStringify(value);
  } catch (error) {
    throw errors.validation('Cache value must be JSON-serializable', {
      reason: error instanceof Error ? error.message : 'unknown'
    });
  }
  if (typeof serialized !== 'string') {
    throw errors.validation('Cache value must be JSON-serializable');
  }
  return serialized;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit) || limit <= 0) return 50;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_AUTH_SCOPE };
