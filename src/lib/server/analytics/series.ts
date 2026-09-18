/**
 * Time-bucket helpers for analytics charts.
 *
 * Charts need two things that must agree: the SQL that assigns a row to a bucket
 * and the axis that fills missing buckets with explicit zeros. If those disagree
 * by even one boundary, a line chart silently misleads. Both live here, so the
 * bucket key produced by SQL and the key produced by `bucketKey` are the same
 * string.
 *
 * ## Dialect
 *
 * Buckets are computed from epoch-millisecond columns with SQLite `strftime` on
 * `column / 1000, 'unixepoch'`, which is UTC and therefore timezone- and
 * DST-stable. The PostgreSQL equivalent is
 * `to_char(to_timestamp(column / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
 * (day), `date_trunc('week', ... AT TIME ZONE 'UTC')` (week, ISO Monday start),
 * and `to_char(..., 'YYYY-MM')` (month). Weeks always start on Monday so a week
 * boundary never depends on a workspace locale.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { type WidgetTimeRange, workflowItems } from '../db/schema';

export type BucketUnit = 'day' | 'week' | 'month';

/** Which timestamp a report's time window applies to. */
export type TimeBasis = 'created' | 'updated' | 'entered_state';

export interface ResolvedWindow {
  basis: TimeBasis;
  from: number | null;
  to: number | null;
  range: WidgetTimeRange;
}

/**
 * Resolve a widget/report time range against an injectable `now`. `relative`
 * always ends at `now`; `absolute` may omit either bound; `all` has none. The
 * window is inclusive on both ends and expressed in UTC epoch milliseconds.
 */
export function resolveTimeWindow(
  timeRange: WidgetTimeRange | null | undefined,
  now: number
): ResolvedWindow {
  const range = timeRange ?? { kind: 'all' };
  const basis: TimeBasis = range.basis ?? 'created';
  switch (range.kind) {
    case 'relative': {
      const days = typeof range.lastDays === 'number' && range.lastDays > 0 ? range.lastDays : 30;
      return { basis, from: now - days * 86_400_000, to: now, range };
    }
    case 'absolute':
      return {
        basis,
        from: typeof range.from === 'number' ? range.from : null,
        to: typeof range.to === 'number' ? range.to : null,
        range
      };
    case 'all':
      return { basis, from: null, to: null, range };
  }
}

export interface BucketPoint {
  bucket: string;
  value: number;
  [key: string]: unknown;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Canonical UTC bucket key for an epoch-millisecond instant.
 * Day `YYYY-MM-DD`, week the ISO Monday `YYYY-MM-DD`, month `YYYY-MM`.
 */
export function bucketKey(epochMs: number, by: BucketUnit): string {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  switch (by) {
    case 'day':
      return `${year}-${pad(month + 1, 2)}-${pad(day, 2)}`;
    case 'week': {
      // getUTCDay: 0 = Sunday. Shift so Monday is the first day of the week.
      const offset = (date.getUTCDay() + 6) % 7;
      const monday = new Date(Date.UTC(year, month, day - offset));
      return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1, 2)}-${pad(monday.getUTCDate(), 2)}`;
    }
    case 'month':
      return `${year}-${pad(month + 1, 2)}`;
  }
}

/** Display alias for `bucketKey`, kept so chart code reads naturally. */
export function bucketLabel(value: number | Date, by: BucketUnit): string {
  return bucketKey(value instanceof Date ? value.getTime() : value, by);
}

/**
 * SQL expression that groups a timestamp column into a canonical bucket key.
 * Defaults to the work-item creation timestamp, which is the natural axis for
 * throughput; callers pass the measure's time basis when it differs.
 */
export function bucketExpression(
  by: BucketUnit,
  column: SQL | AnySQLiteColumn = workflowItems.createdAt
): SQL {
  const seconds = sql`(${column} / 1000)`;
  switch (by) {
    case 'day':
      return sql`date(${seconds}, 'unixepoch')`;
    case 'week':
      // Monday-start: subtract the number of days since Monday.
      return sql`date(${seconds}, 'unixepoch', '-' || ((strftime('%w', ${seconds}, 'unixepoch') + 6) % 7) || ' days')`;
    case 'month':
      return sql`strftime('%Y-%m', ${seconds}, 'unixepoch')`;
  }
}

function addUnit(bucket: string, by: BucketUnit): string {
  const date = new Date(`${bucket}T00:00:00.000Z`);
  switch (by) {
    case 'day':
      date.setUTCDate(date.getUTCDate() + 1);
      break;
    case 'week':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'month':
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
  }
  return bucketKey(date.getTime(), by);
}

/**
 * Every bucket key from `from` to `to` inclusive. Deterministic and UTC; used to
 * drive both `fillMissingBuckets` and chart axis construction.
 */
export function enumerateBuckets(from: number, to: number, by: BucketUnit): string[] {
  if (to < from) return [];
  const buckets: string[] = [];
  const end = to;
  let cursor = bucketKey(from, by);
  // Guard the loop against pathological ranges (e.g. 100 years of days) while
  // still covering every realistic dashboard window.
  for (let guard = 0; guard < 40_000; guard++) {
    const cursorMs = new Date(`${cursor}T00:00:00.000Z`).getTime();
    if (cursorMs > end) break;
    buckets.push(cursor);
    cursor = addUnit(cursor, by);
  }
  return buckets;
}

/**
 * Force a continuous axis: every bucket between `from` and `to` appears exactly
 * once, with `value: 0` where the query returned no row. When SQL returns the
 * same bucket twice (only possible when a caller groups by something else too)
 * the last row wins; the caller is responsible for pre-aggregating per series.
 */
export function fillMissingBuckets(
  rows: readonly BucketPoint[],
  from: number,
  to: number,
  by: BucketUnit
): BucketPoint[] {
  const byBucket = new Map<string, BucketPoint>();
  for (const row of rows) byBucket.set(row.bucket, row);
  return enumerateBuckets(from, to, by).map(
    (bucket) => byBucket.get(bucket) ?? { bucket, value: 0 }
  );
}
