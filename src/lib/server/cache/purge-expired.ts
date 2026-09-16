/**
 * Cache maintenance.
 *
 * The supervisor owns the `maintenance.reap` job type, so this module deliberately
 * registers nothing with the job handler registry. It only exports the function a
 * maintenance handler should call, keeping ownership of the job in one place while
 * the cache owns its own cleanup semantics (ADR-0016: no external infrastructure).
 */
import { and, isNotNull, lte } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { cacheEntries } from '../db/schema';
import { purgeExpiredLocks } from './locks';

export interface PurgeBreakdown {
  entries: number;
  locks: number;
}

/**
 * Delete cache entries whose expiry has passed and return how many were removed.
 * Expired advisory locks are cleared as well, since a stale lock is never useful.
 * `now` is injectable so maintenance is deterministic under test.
 */
export function purgeExpired(db: Executor, now: number = Date.now()): number {
  return purgeExpiredDetailed(db, now).entries;
}

/** Same sweep as {@link purgeExpired}, with the lock count exposed separately. */
export function purgeExpiredDetailed(db: Executor, now: number = Date.now()): PurgeBreakdown {
  const removedEntries = db
    .delete(cacheEntries)
    .where(and(isNotNull(cacheEntries.expiresAt), lte(cacheEntries.expiresAt, now)))
    .returning({ id: cacheEntries.id })
    .all();
  const removedLocks = purgeExpiredLocks(db, now);
  return { entries: removedEntries.length, locks: removedLocks };
}
