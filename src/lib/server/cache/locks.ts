/**
 * Advisory cache locks.
 *
 * Stampede protection needs a lock that is safe on SQLite today and on PostgreSQL
 * later without a `SELECT ... FOR UPDATE` assumption. We get that from one
 * conditional upsert: insert the lock row, or take over an existing row whose
 * `expires_at` has already passed. The uniqueness index on
 * `(workspaceId, namespace, authScope, key)` makes the statement the only arbiter,
 * so two racing callers cannot both acquire.
 *
 * Locks are advisory and *always* carry an expiry: a crashed holder must not wedge
 * a cache key forever. Callers that cannot acquire simply stop using the lock and
 * proceed (see `cacheGetOrCompute`), which trades a rare duplicate computation for
 * guaranteed forward progress rather than a deadlock.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { cacheLocks } from '../db/schema';
import { type CacheKeyInput, normalizeCacheKey, validateCacheKey } from './identity';

export interface AcquireLockOptions extends CacheKeyInput {
  /** Stable identity of the caller expected to release the lock. */
  holder: string;
  /** How long the lock stays valid before another caller may take it over. */
  ttlMs: number;
  now?: number;
}

export type AcquireLockResult =
  | { acquired: true; holder: string; expiresAt: number }
  | { acquired: false; holder: string | null; expiresAt: number | null };

export interface ReleaseLockOptions extends CacheKeyInput {
  holder: string;
}

const MIN_LOCK_TTL_MS = 1000;

/**
 * Attempt to acquire the lock for a cache slot.
 *
 * Returns `acquired: false` with the current holder when the lock is still valid;
 * this is a normal outcome, not an error.
 */
export function acquireLock(db: Executor, options: AcquireLockOptions): AcquireLockResult {
  if (!options.holder) throw errors.validation('A cache lock requires a holder identity');
  const key = normalizeCacheKey(options);
  validateCacheKey(key);
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw errors.validation('Cache lock ttlMs must be a positive number');
  }

  const now = options.now ?? Date.now();
  const expiresAt = now + Math.max(MIN_LOCK_TTL_MS, Math.floor(options.ttlMs));

  const rows = db
    .insert(cacheLocks)
    .values({
      workspaceId: key.workspaceId,
      namespace: key.namespace,
      authScope: key.authScope,
      key: key.key,
      holder: options.holder,
      acquiredAt: now,
      expiresAt
    })
    .onConflictDoUpdate({
      target: [cacheLocks.workspaceId, cacheLocks.namespace, cacheLocks.authScope, cacheLocks.key],
      set: { holder: options.holder, acquiredAt: now, expiresAt },
      // Take-over only when the existing lock has actually expired.
      setWhere: sql`${cacheLocks.expiresAt} <= ${now}`
    })
    .returning()
    .all();

  const acquiredRow = rows[0];
  if (acquiredRow) {
    return { acquired: true, holder: acquiredRow.holder, expiresAt: acquiredRow.expiresAt };
  }

  const current = db
    .select({ holder: cacheLocks.holder, expiresAt: cacheLocks.expiresAt })
    .from(cacheLocks)
    .where(identityWhere(key))
    .limit(1)
    .all()[0];
  return {
    acquired: false,
    holder: current?.holder ?? null,
    expiresAt: current?.expiresAt ?? null
  };
}

/** Release the lock only when `holder` still owns it. Returns whether a row was removed. */
export function releaseLock(db: Executor, options: ReleaseLockOptions): boolean {
  const key = normalizeCacheKey(options);
  const removed = db
    .delete(cacheLocks)
    .where(and(identityWhere(key), eq(cacheLocks.holder, options.holder)))
    .returning({ id: cacheLocks.id })
    .all();
  return removed.length > 0;
}

/** Remove every expired lock; used by cache maintenance. Returns rows removed. */
export function purgeExpiredLocks(db: Executor, now: number = Date.now()): number {
  const removed = db
    .delete(cacheLocks)
    .where(lte(cacheLocks.expiresAt, now))
    .returning({ id: cacheLocks.id })
    .all();
  return removed.length;
}

function identityWhere(key: ReturnType<typeof normalizeCacheKey>) {
  return and(
    eq(cacheLocks.workspaceId, key.workspaceId),
    eq(cacheLocks.namespace, key.namespace),
    eq(cacheLocks.authScope, key.authScope),
    eq(cacheLocks.key, key.key)
  );
}
