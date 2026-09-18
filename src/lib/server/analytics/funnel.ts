/**
 * Funnels.
 *
 * A funnel definition is an **explicit ordered list of milestones** — never the
 * Kanban column order, because workflows branch (ADR-0017). Each milestone may
 * select states, a field value, or both:
 *
 *  - `stateIds` — the item reached any of those states (earliest entry wins);
 *  - `fieldKey`/`fieldValue` — the item's value history (Record base or workflow
 *    overlay) shows that value;
 *  - both — both must hold, and the milestone is reached at the later of the two.
 *
 * Everything is derived from `workflow_item_state_history` and
 * `field_value_history`, so "how many entered Claims last month" is answerable.
 * Stage counts are cumulative by construction: every stage independently asks
 * "did this item ever reach here inside the window". An item that skipped a stage
 * therefore counts in the later stage and is never counted twice. Inter-stage
 * times are differences of *recorded* entry timestamps for items that reached
 * both stages (a skipped stage contributes no delta).
 */
import { type SQL, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import {
  fieldDefinitions,
  fieldValueHistory,
  records,
  type WidgetDataSource,
  type WidgetTimeRange,
  workflowItemStateHistory,
  workflowItems
} from '../db/schema';
import type { FilterAst } from '../filters/ast';
import { compileWorkflowItemFilterDetailed } from '../filters/compile';
import { resolveTimeWindow } from './series';
import { meanOf, medianOf } from './stats';

export interface FunnelStageDefinition {
  label: string;
  stateIds?: string[];
  fieldKey?: string;
  fieldValue?: unknown;
}

export interface RunFunnelOptions {
  workspaceId: string;
  /** Uses `funnelStages`; `agingStates` and `workflowIds` are also respected. */
  definition: WidgetDataSource;
  filter?: FilterAst | null;
  timeRange?: WidgetTimeRange | null;
  now?: number;
}

export interface FunnelStageResult {
  label: string;
  count: number;
  /** Percent of the previous stage, `null` for the first stage. */
  conversionFromPrevious: number | null;
  /** Percent of the first stage, `100` for the first stage when non-empty. */
  conversionFromFirst: number | null;
  /** Median seconds from the previous reached stage, `null` for the first. */
  medianSecondsToReach: number | null;
  avgSecondsToReach: number | null;
}

export interface FunnelResult {
  stages: FunnelStageResult[];
  overallConversion: number | null;
  /** True when the definition had no milestones to evaluate. */
  empty: boolean;
}

interface StageEntry {
  itemId: string;
  enteredAt: number;
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function serializeFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function resolveFieldId(
  db: Executor,
  workspaceId: string,
  key: string
): Promise<string | null> {
  const rows = await db
    .select({ id: fieldDefinitions.id })
    .from(fieldDefinitions)
    .where(
      sql`${fieldDefinitions.workspaceId} = ${workspaceId} AND ${fieldDefinitions.scope} <> 'file' AND (${fieldDefinitions.key} = ${key} OR ${fieldDefinitions.id} = ${key})`
    )
    .all();
  return rows[0]?.id ?? null;
}

/**
 * Per-item earliest entry for one milestone. Returns one row per candidate
 * workflow item; items that never satisfy the milestone are filtered out in SQL
 * by the `NOT NULL` guard on the entry subqueries.
 */
async function stageEntries(
  db: Executor,
  options: RunFunnelOptions,
  stage: FunnelStageDefinition,
  scopeWhere: SQL
): Promise<StageEntry[]> {
  const workspaceId = options.workspaceId;
  const window = resolveTimeWindow(options.timeRange, options.now ?? Date.now());
  const stateIds = stage.stateIds ?? [];
  const stateClause =
    stateIds.length > 0
      ? sql` AND hs.state_id IN (${sql.join(
          stateIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;
  const stateWindow: SQL[] = [];
  if (window.from !== null) stateWindow.push(sql`hs.entered_at >= ${window.from}`);
  if (window.to !== null) stateWindow.push(sql`hs.entered_at <= ${window.to}`);
  const stateEntry = sql`(SELECT MIN(hs.entered_at) FROM ${workflowItemStateHistory} hs WHERE hs.workflow_item_id = ${workflowItems.id} AND hs.workspace_id = ${workspaceId}${stateClause}${stateWindow.length > 0 ? sql` AND ${sql.join(stateWindow, sql` AND `)}` : sql``})`;

  let fieldEntry: SQL | null = null;
  if (stage.fieldKey) {
    const fieldId = await resolveFieldId(db, workspaceId, stage.fieldKey);
    if (!fieldId) {
      // An unknown stage field can never be satisfied; the stage counts zero.
      return [];
    }
    const fieldWindow: SQL[] = [];
    if (window.from !== null) fieldWindow.push(sql`fv.created_at >= ${window.from}`);
    if (window.to !== null) fieldWindow.push(sql`fv.created_at <= ${window.to}`);
    const valueClause = Array.isArray(stage.fieldValue)
      ? sql`EXISTS (SELECT 1 FROM json_each(fv.new_value) je WHERE je.value IN (${sql.join(
          (stage.fieldValue as unknown[]).map((entry) => sql`${entry}`),
          sql`, `
        )}))`
      : sql`json_extract(fv.new_value, '$') = ${serializeFieldValue(stage.fieldValue)}`;
    // A value may be recorded on the Record (base) or on the participation
    // (overlay); the earliest of the two is when the milestone was reached.
    const ownerClause = sql`((fv.owner_type = 'workflow_item' AND fv.owner_id = ${workflowItems.id}) OR (fv.owner_type = 'record' AND fv.owner_id = ${workflowItems.recordId}))`;
    fieldEntry = sql`(SELECT MIN(fv.created_at) FROM ${fieldValueHistory} fv WHERE ${ownerClause} AND fv.workspace_id = ${workspaceId} AND fv.field_definition_id = ${fieldId} AND ${valueClause}${fieldWindow.length > 0 ? sql` AND ${sql.join(fieldWindow, sql` AND `)}` : sql``})`;
  }

  const hasStates = stateIds.length > 0;
  const conditions: SQL[] = [scopeWhere];
  if (hasStates) conditions.push(sql`${stateEntry} IS NOT NULL`);
  if (fieldEntry) conditions.push(sql`${fieldEntry} IS NOT NULL`);
  const where = sql.join(conditions, sql` AND `);

  const rows = await db.all<{
    item_id: string;
    state_entry: number | null;
    field_entry: number | null;
  }>(
    sql`SELECT ${workflowItems.id} AS item_id, ${stateEntry} AS state_entry, ${fieldEntry ?? sql`NULL`} AS field_entry FROM ${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId} WHERE ${where}`
  );

  const entries: StageEntry[] = [];
  for (const row of rows) {
    const candidates: number[] = [];
    if (hasStates && row.state_entry !== null) candidates.push(Number(row.state_entry));
    if (fieldEntry && row.field_entry !== null) candidates.push(Number(row.field_entry));
    if (candidates.length === 0) continue;
    const enteredAt = candidates.length === 1 ? (candidates[0] as number) : Math.max(...candidates);
    entries.push({ itemId: row.item_id, enteredAt });
  }
  return entries;
}

/**
 * Run a funnel. Returns per-stage counts, conversions and inter-stage times.
 * The time window is applied to *milestone entry* timestamps, and the filter is
 * the shared workflow-item filter AST (field filters included).
 */
export async function runFunnel(db: Executor, options: RunFunnelOptions): Promise<FunnelResult> {
  const stages = options.definition.funnelStages ?? [];
  if (stages.length === 0) {
    return { stages: [], overallConversion: null, empty: true };
  }

  const compiled = await compileWorkflowItemFilterDetailed(db, {
    workspaceId: options.workspaceId,
    filter: options.filter ?? null,
    now: options.now
  });
  const conditions: SQL[] = [
    sql`${workflowItems.workspaceId} = ${options.workspaceId}`,
    compiled.sql
  ];
  const workflowIds = options.definition.workflowIds ?? [];
  if (workflowIds.length > 0) {
    conditions.push(
      sql`${workflowItems.workflowId} IN (${sql.join(
        workflowIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }
  const scopeWhere = sql.join(conditions, sql` AND `);

  const perStage: Map<string, number>[] = [];
  for (const stage of stages) {
    const entries = await stageEntries(db, options, stage, scopeWhere);
    const map = new Map<string, number>();
    for (const entry of entries) {
      const existing = map.get(entry.itemId);
      if (existing === undefined || entry.enteredAt < existing) {
        map.set(entry.itemId, entry.enteredAt);
      }
    }
    perStage.push(map);
  }

  const counts = perStage.map((map) => map.size);
  const results: FunnelStageResult[] = stages.map((stage, index) => {
    const previous = index > 0 ? perStage[index - 1]! : null;
    const current = perStage[index]!;
    const deltas: number[] = [];
    if (previous) {
      for (const [itemId, enteredAt] of current) {
        const previousEntry = previous.get(itemId);
        if (previousEntry !== undefined) deltas.push((enteredAt - previousEntry) / 1000);
      }
    }
    return {
      label: stage.label,
      count: counts[index] ?? 0,
      conversionFromPrevious:
        index === 0 ? null : percent(counts[index] ?? 0, counts[index - 1] ?? 0),
      conversionFromFirst:
        index === 0 ? (counts[0] ? 100 : null) : percent(counts[index] ?? 0, counts[0] ?? 0),
      medianSecondsToReach: index === 0 ? null : medianOf(deltas),
      avgSecondsToReach: index === 0 ? null : meanOf(deltas)
    };
  });

  const first = counts[0] ?? 0;
  const last = counts[counts.length - 1] ?? 0;
  return {
    stages: results,
    overallConversion: percent(last, first),
    empty: false
  };
}

/** Human summary for widget subtitles. */
export function describeFunnel(definition: WidgetDataSource): string {
  const stages = definition.funnelStages ?? [];
  if (stages.length === 0) return 'No stages';
  return stages.map((stage) => stage.label).join(' → ');
}
