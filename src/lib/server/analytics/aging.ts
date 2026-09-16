/**
 * Time-in-state, cycle-time and throughput reports.
 *
 * All three read `ticket_state_history` intervals rather than current ticket
 * rows, because current state cannot answer "how long did tickets spend in Human
 * Review" or "how many entered Claims last month" (ADR-0013, ADR-0017).
 *
 * An interval is open while `exited_at IS NULL`; open intervals are measured
 * against an injectable `now` so work that is still in progress is counted, not
 * silently dropped. Percentiles and medians are computed over the full ordered
 * sample (`stats.ts`) rather than a streaming approximation, because p90 of a
 * dwell-time distribution is an operational decision input.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { ticketStateHistory, tickets, type WidgetTimeRange, workflowStates } from '../db/schema';
import type { FilterAst } from '../filters/ast';
import { compileTicketFilterDetailed } from '../filters/compile';
import { type BucketUnit, bucketExpression, enumerateBuckets, resolveTimeWindow } from './series';
import { maxOf, meanOf, medianOf, p90Of } from './stats';

export interface AgingScope {
  workspaceId: string;
  workflowId?: string | null;
  stateIds?: string[];
  filter?: FilterAst | null;
  timeRange?: WidgetTimeRange | null;
  now?: number;
}

export interface TimeInStateEntry {
  stateId: string;
  stateName: string;
  /** Intervals that started inside the window. */
  entered: number;
  /** Intervals that ended inside the window. */
  exited: number;
  /** Intervals still open right now. */
  currentlyIn: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  avgSeconds: number | null;
  maxSeconds: number | null;
}

interface IntervalRow {
  stateId: string;
  stateName: string;
  enteredAt: number;
  exitedAt: number | null;
}

/**
 * History reports default their window to *entry* time even when the caller
 * omits `basis`, because a dwell-time question is about the interval that
 * started, not about when the ticket was created.
 */
function historyWindow(
  timeRange: WidgetTimeRange | null | undefined,
  now: number
): ReturnType<typeof resolveTimeWindow> {
  const withBasis = timeRange
    ? { ...timeRange, basis: timeRange.basis ?? 'entered_state' }
    : timeRange;
  return resolveTimeWindow(withBasis, now);
}

/**
 * Shared scoping for history queries: workspace + optional workflow/state,
 * the compiled ticket filter (which references `tickets.*`, hence the join), and
 * the caller's time window on the requested timestamp.
 */
async function historyScope(
  db: Executor,
  scope: AgingScope,
  eventExpr: SQL,
  now: number
): Promise<{ where: SQL; from: SQL; unresolved: string[] }> {
  const compiled = await compileTicketFilterDetailed(db, {
    workspaceId: scope.workspaceId,
    filter: scope.filter ?? null,
    now
  });
  const conditions: SQL[] = [sql`h.workspace_id = ${scope.workspaceId}`, compiled.sql];
  if (scope.workflowId) conditions.push(sql`h.workflow_id = ${scope.workflowId}`);
  const stateIds = scope.stateIds ?? [];
  if (stateIds.length > 0) {
    conditions.push(
      sql`h.state_id IN (${sql.join(
        stateIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }
  const window = historyWindow(scope.timeRange, now);
  if (window.from !== null) conditions.push(sql`${eventExpr} >= ${window.from}`);
  if (window.to !== null) conditions.push(sql`${eventExpr} <= ${window.to}`);
  return {
    where: sql.join(conditions, sql` AND `),
    from: sql`${ticketStateHistory} h JOIN ${tickets} ON ${tickets.id} = h.ticket_id AND ${tickets.workspaceId} = h.workspace_id`,
    unresolved: compiled.unresolved
  };
}

async function loadIntervals(
  db: Executor,
  scope: AgingScope,
  eventExpr: SQL,
  now: number
): Promise<IntervalRow[]> {
  const { where, from } = await historyScope(db, scope, eventExpr, now);
  const rows = await db.all<{
    state_id: string;
    state_name: string;
    entered_at: number;
    exited_at: number | null;
  }>(sql`SELECT h.state_id, h.state_name, h.entered_at, h.exited_at FROM ${from} WHERE ${where}`);
  return rows.map((row) => ({
    stateId: row.state_id,
    stateName: row.state_name,
    enteredAt: Number(row.entered_at),
    exitedAt: row.exited_at === null ? null : Number(row.exited_at)
  }));
}

/**
 * Per-state dwell-time report. `entered`/`exited`/`currentlyIn` are interval
 * counts; the duration statistics treat an open interval as running until `now`.
 */
export async function timeInStateReport(
  db: Executor,
  scope: AgingScope
): Promise<TimeInStateEntry[]> {
  const now = scope.now ?? Date.now();
  const window = historyWindow(scope.timeRange, now);
  const basisExpr =
    window.basis === 'created'
      ? sql`${tickets.createdAt}`
      : window.basis === 'updated'
        ? sql`${tickets.updatedAt}`
        : sql`h.entered_at`;
  const intervals = await loadIntervals(db, scope, basisExpr, now);

  const byState = new Map<string, { stateName: string; rows: IntervalRow[] }>();
  for (const interval of intervals) {
    const bucket = byState.get(interval.stateId) ?? {
      stateName: interval.stateName,
      rows: []
    };
    bucket.rows.push(interval);
    byState.set(interval.stateId, bucket);
  }

  const report: TimeInStateEntry[] = [];
  for (const [stateId, group] of byState) {
    const durations: number[] = [];
    let exited = 0;
    let currentlyIn = 0;
    for (const row of group.rows) {
      const end = row.exitedAt ?? now;
      durations.push((end - row.enteredAt) / 1000);
      if (row.exitedAt === null) currentlyIn += 1;
      else exited += 1;
    }
    report.push({
      stateId,
      stateName: group.stateName,
      entered: group.rows.length,
      exited,
      currentlyIn,
      medianSeconds: medianOf(durations),
      p90Seconds: p90Of(durations),
      avgSeconds: meanOf(durations),
      maxSeconds: maxOf(durations)
    });
  }
  return report.sort((a, b) =>
    a.stateName < b.stateName ? -1 : a.stateName > b.stateName ? 1 : 0
  );
}

export interface CycleTimeReport {
  count: number;
  medianSeconds: number | null;
  avgSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
}

/**
 * Creation → first terminal entry, per ticket. A ticket that never reached a
 * terminal state contributes no measurement (it has no cycle time yet).
 */
export async function cycleTimeReport(db: Executor, scope: AgingScope): Promise<CycleTimeReport> {
  const now = scope.now ?? Date.now();
  const compiled = await compileTicketFilterDetailed(db, {
    workspaceId: scope.workspaceId,
    filter: scope.filter ?? null,
    now
  });
  const conditions: SQL[] = [sql`${tickets.workspaceId} = ${scope.workspaceId}`, compiled.sql];
  if (scope.workflowId) conditions.push(sql`${tickets.workflowId} = ${scope.workflowId}`);
  const window = resolveTimeWindow(scope.timeRange, now);
  if (window.from !== null) conditions.push(sql`${tickets.createdAt} >= ${window.from}`);
  if (window.to !== null) conditions.push(sql`${tickets.createdAt} <= ${window.to}`);
  const where = sql.join(conditions, sql` AND `);

  const terminal = sql`(SELECT MIN(hist.entered_at) FROM ${ticketStateHistory} hist JOIN ${workflowStates} st ON st.id = hist.state_id AND st.workspace_id = hist.workspace_id WHERE hist.ticket_id = ${tickets.id} AND hist.workspace_id = ${scope.workspaceId} AND (st.is_terminal = 1 OR st.category IN ('done', 'cancelled')))`;
  const rows = await db.all<{ cycle_ms: number | null }>(
    sql`SELECT (${terminal} - ${tickets.createdAt}) AS cycle_ms FROM ${tickets} WHERE ${where} AND ${terminal} IS NOT NULL`
  );
  const seconds = rows
    .map((row) => (row.cycle_ms === null ? null : Number(row.cycle_ms) / 1000))
    .filter((value): value is number => value !== null);
  return {
    count: seconds.length,
    medianSeconds: medianOf(seconds),
    avgSeconds: meanOf(seconds),
    p90Seconds: p90Of(seconds),
    maxSeconds: maxOf(seconds)
  };
}

export interface ThroughputOptions extends AgingScope {
  by?: BucketUnit;
}

export interface ThroughputPoint {
  bucket: string;
  entered: number;
  exited: number;
}

/**
 * Tickets entering and leaving states per bucket. Both series use the same
 * deterministic UTC axis and are zero-filled so a chart never implies a gap in
 * the data where there was only an absence of activity.
 */
export async function throughputSeries(
  db: Executor,
  options: ThroughputOptions
): Promise<ThroughputPoint[]> {
  const now = options.now ?? Date.now();
  const by: BucketUnit = options.by ?? 'day';
  const enteredScope = await historyScope(db, options, sql`h.entered_at`, now);
  const exitedScope = await historyScope(db, options, sql`h.exited_at`, now);
  const enteredBucket = bucketExpression(by, sql`h.entered_at`);
  const exitedBucket = bucketExpression(by, sql`h.exited_at`);

  const rows = await db.all<{ bucket: string; entered: number; exited: number }>(
    sql`SELECT bucket, SUM(entered) AS entered, SUM(exited) AS exited FROM (
      SELECT ${enteredBucket} AS bucket, 1 AS entered, 0 AS exited FROM ${enteredScope.from} WHERE ${enteredScope.where}
      UNION ALL
      SELECT ${exitedBucket} AS bucket, 0 AS entered, 1 AS exited FROM ${exitedScope.from} WHERE ${exitedScope.where} AND h.exited_at IS NOT NULL
    ) GROUP BY bucket`
  );

  const byBucket = new Map<string, ThroughputPoint>();
  for (const row of rows) {
    byBucket.set(row.bucket, {
      bucket: row.bucket,
      entered: Number(row.entered) || 0,
      exited: Number(row.exited) || 0
    });
  }

  const window = resolveTimeWindow(options.timeRange, now);
  const keys = byBucket.keys();
  const first = keys.next();
  const from =
    window.from ?? (first.done ? now : new Date(`${first.value}T00:00:00.000Z`).getTime());
  const sortedKeys = [...byBucket.keys()].sort();
  const lastKey = sortedKeys[sortedKeys.length - 1];
  const to = window.to ?? (lastKey ? new Date(`${lastKey}T00:00:00.000Z`).getTime() : now);

  return enumerateBuckets(from, to, by).map(
    (bucket) => byBucket.get(bucket) ?? { bucket, entered: 0, exited: 0 }
  );
}
