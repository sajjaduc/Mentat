/**
 * Widget query engine.
 *
 * A widget is a declarative analytics question: data source + filter + measure +
 * grouping + time range + visualisation (ADR-0017). This module answers it with
 * SQL derived from *history* where the question is historical, and always
 * through the shared workflow-item filter compiler, so a widget can never
 * disagree with a work list about what a filter means (ADR-0012, ADR-0021).
 *
 * ## Grouping and fan-out
 *
 * `COUNT` uses `COUNT(DISTINCT base id)` everywhere, because label grouping joins
 * `workflow_item_labels` and would otherwise multiply an item. `SUM`/`AVG` over a
 * field for a label breakdown intentionally follow the fan-out; label grouping is
 * a count-oriented view.
 *
 * ## Time
 *
 * Relative ranges resolve against an injectable `now`. Buckets are UTC
 * (`strftime(..., 'unixepoch')` in SQLite; `date_trunc`/`to_char` on PostgreSQL —
 * see `series.ts`). `median` is computed with a window function so odd and even
 * samples are both exact; `duration` reads `workflow_item_state_history`
 * intervals rather than current rows; `conversion` uses the widget's *explicitly
 * ordered* funnel stages, never Kanban order.
 */
import { type SQL, sql } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  agentRuns,
  fieldDefinitions,
  fieldValueHistory,
  files,
  fileWorkflowItems,
  labels,
  recordFieldValues,
  records,
  savedViews,
  teams,
  users,
  type WidgetDataSource,
  type WidgetGrouping,
  type WidgetMeasure,
  type WidgetTimeRange,
  type WidgetType,
  workflowItemFieldValues,
  workflowItemLabels,
  workflowItemStateHistory,
  workflowItems,
  workflowStates,
  workflows
} from '../db/schema';
import { combineFilters, describeFilter, type FilterAst, parseFilterAst } from '../filters/ast';
import { compileWorkflowItemFilterDetailed } from '../filters/compile';
import {
  type BucketPoint,
  type BucketUnit,
  bucketExpression,
  fillMissingBuckets,
  resolveTimeWindow
} from './series';

export interface WidgetDefinition {
  type: WidgetType;
  dataSource: WidgetDataSource;
  filter?: unknown;
  measure: WidgetMeasure;
  grouping?: WidgetGrouping | null;
  timeRange?: WidgetTimeRange | null;
  savedViewId?: string | null;
}

export type WidgetBasis = 'created' | 'updated' | 'entered_state';

export interface WidgetRow {
  key: string | null;
  label: string | null;
  bucket?: string;
  value: number;
}

export interface WidgetSeriesPoint {
  label: string;
  bucket?: string;
  value: number;
}

export interface WidgetMeta {
  dataSource: WidgetDataSource['kind'];
  measure: WidgetMeasure;
  grouping: WidgetGrouping['by'];
  timeRange: WidgetTimeRange;
  basis: WidgetBasis;
  from: number | null;
  to: number | null;
  filter: string;
  unresolved: string[];
  /** Rows considered before grouping, when it could be counted cheaply. */
  note?: string;
}

export interface WidgetResult {
  kind: WidgetType;
  value?: number | null;
  series?: WidgetSeriesPoint[];
  rows?: WidgetRow[];
  grouping: WidgetGrouping['by'];
  meta: WidgetMeta;
}

export interface RunWidgetOptions {
  workspaceId: string;
  widget: WidgetDefinition;
  /** Dashboard-level filter ANDed with the widget's own filter. */
  globalFilter?: FilterAst | null;
  now?: number;
}

const NO_JOIN: SQL = sql``;

interface SourcePlan {
  from: SQL;
  workspace: SQL;
  idExpr: SQL;
  stateExpr: SQL;
  workflowExpr: SQL;
  time: Record<WidgetBasis, SQL>;
}

function buildSourcePlan(kind: WidgetDataSource['kind'], workspaceId: string): SourcePlan {
  switch (kind) {
    case 'state_history':
      return {
        from: sql`${workflowItemStateHistory} h JOIN ${workflowItems} ON ${workflowItems.id} = h.workflow_item_id AND ${workflowItems.workspaceId} = h.workspace_id JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`,
        workspace: sql`h.workspace_id = ${workspaceId}`,
        idExpr: sql`h.id`,
        stateExpr: sql`h.state_id`,
        workflowExpr: sql`h.workflow_id`,
        time: {
          created: sql`${workflowItems.createdAt}`,
          updated: sql`${workflowItems.updatedAt}`,
          entered_state: sql`h.entered_at`
        }
      };
    case 'field_history':
      // A value change may be recorded on the participation (overlay) or on the
      // Record (base); a work-item history widget reads both.
      return {
        from: sql`${fieldValueHistory} fvh JOIN ${workflowItems} ON (${workflowItems.id} = fvh.owner_id AND fvh.owner_type = 'workflow_item') OR (${workflowItems.recordId} = fvh.owner_id AND fvh.owner_type = 'record') JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`,
        workspace: sql`fvh.workspace_id = ${workspaceId}`,
        idExpr: sql`fvh.id`,
        stateExpr: sql`${workflowItems.stateId}`,
        workflowExpr: sql`${workflowItems.workflowId}`,
        time: {
          created: sql`fvh.created_at`,
          updated: sql`fvh.created_at`,
          entered_state: sql`${workflowItems.enteredStateAt}`
        }
      };
    case 'runs':
      return {
        from: sql`${agentRuns} ar JOIN ${workflowItems} ON ${workflowItems.id} = ar.workflow_item_id AND ${workflowItems.workspaceId} = ar.workspace_id JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`,
        workspace: sql`ar.workspace_id = ${workspaceId}`,
        idExpr: sql`ar.id`,
        stateExpr: sql`ar.state_id`,
        workflowExpr: sql`ar.workflow_id`,
        time: {
          created: sql`ar.created_at`,
          updated: sql`ar.created_at`,
          entered_state: sql`${workflowItems.enteredStateAt}`
        }
      };
    case 'files':
      return {
        from: sql`${files} fl JOIN ${fileWorkflowItems} fwi ON fwi.file_id = fl.id AND fwi.removed_at IS NULL JOIN ${workflowItems} ON ${workflowItems.id} = fwi.workflow_item_id AND ${workflowItems.workspaceId} = fwi.workspace_id JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`,
        workspace: sql`fl.workspace_id = ${workspaceId} AND fl.deleted_at IS NULL`,
        idExpr: sql`fl.id`,
        stateExpr: sql`${workflowItems.stateId}`,
        workflowExpr: sql`${workflowItems.workflowId}`,
        time: {
          created: sql`fl.created_at`,
          updated: sql`fl.updated_at`,
          entered_state: sql`${workflowItems.enteredStateAt}`
        }
      };
    case 'workflow_items':
      return {
        from: sql`${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`,
        workspace: sql`${workflowItems.workspaceId} = ${workspaceId}`,
        idExpr: sql`${workflowItems.id}`,
        stateExpr: sql`${workflowItems.stateId}`,
        workflowExpr: sql`${workflowItems.workflowId}`,
        time: {
          created: sql`${workflowItems.createdAt}`,
          updated: sql`${workflowItems.updatedAt}`,
          entered_state: sql`${workflowItems.enteredStateAt}`
        }
      };
    case 'records':
      return {
        from: sql`${records}`,
        workspace: sql`${records.workspaceId} = ${workspaceId}`,
        idExpr: sql`${records.id}`,
        stateExpr: sql`NULL`,
        workflowExpr: sql`NULL`,
        time: {
          created: sql`${records.createdAt}`,
          updated: sql`${records.updatedAt}`,
          entered_state: sql`${records.createdAt}`
        }
      };
  }
}

interface GroupPlan {
  by: WidgetGrouping['by'];
  key: SQL | null;
  label: SQL | null;
  joins: SQL;
  timeUnit: BucketUnit | null;
  limit: number | null;
}

function stateNameExpr(expr: SQL, workspaceId: string): SQL {
  return sql`(SELECT ${workflowStates.name} FROM ${workflowStates} WHERE ${workflowStates.id} = ${expr} AND ${workflowStates.workspaceId} = ${workspaceId})`;
}

async function buildGroupPlan(
  db: Executor,
  workspaceId: string,
  grouping: WidgetGrouping | null | undefined,
  source: SourcePlan,
  timeExpr: SQL
): Promise<GroupPlan> {
  const by = grouping?.by ?? 'none';
  const limit = grouping?.limit ?? null;
  switch (by) {
    case 'none':
      return { by, key: null, label: null, joins: NO_JOIN, timeUnit: null, limit: null };
    case 'state':
      return {
        by,
        key: source.stateExpr,
        label: stateNameExpr(source.stateExpr, workspaceId),
        joins: NO_JOIN,
        timeUnit: null,
        limit
      };
    case 'priority':
      // The universal model has no priority column; legacy `priority` grouping
      // reads the Record's structured projection.
      return {
        by,
        key: sql`json_extract(${records.structuredData}, '$.priority')`,
        label: sql`json_extract(${records.structuredData}, '$.priority')`,
        joins: NO_JOIN,
        timeUnit: null,
        limit
      };
    case 'owner':
      return {
        by,
        key: sql`${workflowItems.ownerUserId}`,
        label: sql`(SELECT ${users.name} FROM ${users} WHERE ${users.id} = ${workflowItems.ownerUserId})`,
        joins: NO_JOIN,
        timeUnit: null,
        limit
      };
    case 'team':
      return {
        by,
        key: sql`${workflowItems.ownerTeamId}`,
        label: sql`(SELECT ${teams.name} FROM ${teams} WHERE ${teams.id} = ${workflowItems.ownerTeamId})`,
        joins: NO_JOIN,
        timeUnit: null,
        limit
      };
    case 'workflow':
      return {
        by,
        key: sql`${workflowItems.workflowId}`,
        label: sql`(SELECT ${workflows.name} FROM ${workflows} WHERE ${workflows.id} = ${workflowItems.workflowId})`,
        joins: NO_JOIN,
        timeUnit: null,
        limit
      };
    case 'label':
      return {
        by,
        key: sql`wil.label_id`,
        label: sql`lbl.name`,
        joins: sql`JOIN ${labels} lbl ON lbl.workspace_id = ${workspaceId} JOIN ${workflowItemLabels} wil ON wil.label_id = lbl.id AND wil.workflow_item_id = ${workflowItems.id} AND wil.workspace_id = ${workspaceId}`,
        timeUnit: null,
        limit
      };
    case 'field': {
      const key = grouping?.fieldKey;
      if (!key) throw errors.validation('Field grouping requires fieldKey');
      const definition = await resolveFieldDefinition(db, workspaceId, key);
      if (!definition) throw errors.validation(`Unknown grouping field: ${key}`, { fieldKey: key });
      const valueExpr = mergedFieldValueExpr(workspaceId, definition.id, definition.type);
      return {
        by,
        key: valueExpr,
        label: sql`CAST(${valueExpr} AS TEXT)`,
        joins: NO_JOIN,
        timeUnit: null,
        limit
      };
    }
    case 'day':
    case 'week':
    case 'month': {
      const unit: BucketUnit = by;
      const bucket = bucketExpression(unit, timeExpr);
      return { by, key: bucket, label: bucket, joins: NO_JOIN, timeUnit: unit, limit: null };
    }
    default:
      throw errors.validation(`Unsupported grouping: ${String(by)}`);
  }
}

interface FieldDefinitionRow {
  id: string;
  key: string;
  type: string;
}

async function resolveFieldDefinition(
  db: Executor,
  workspaceId: string,
  key: string
): Promise<FieldDefinitionRow | null> {
  const rows = await db
    .select({ id: fieldDefinitions.id, key: fieldDefinitions.key, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      sql`${fieldDefinitions.workspaceId} = ${workspaceId} AND ${fieldDefinitions.scope} <> 'file' AND (${fieldDefinitions.key} = ${key} OR ${fieldDefinitions.id} = ${key})`
    )
    .all();
  return rows[0] ?? null;
}

/** Typed column name for a field value store (no alias prefix). */
function fieldColumnName(type: string): string {
  switch (type) {
    case 'number':
    case 'currency':
      return 'value_number';
    case 'date':
    case 'datetime':
      return 'value_date';
    case 'boolean':
      return 'value_bool';
    case 'multi_select':
    case 'json':
      return 'value_json';
    default:
      return 'value_text';
  }
}

/** Workflow-overlay value for one definition (NULL when unset). */
function overlayFieldValueExpr(workspaceId: string, fieldId: string, column: string): SQL {
  return sql`(SELECT wifv.${sql.raw(column)} FROM ${workflowItemFieldValues} wifv WHERE wifv.workflow_item_id = ${workflowItems.id} AND wifv.workspace_id = ${workspaceId} AND wifv.field_definition_id = ${fieldId} LIMIT 1)`;
}

/** Record base value for one definition (NULL when unset). */
function baseFieldValueExpr(workspaceId: string, fieldId: string, column: string): SQL {
  return sql`(SELECT rfv.${sql.raw(column)} FROM ${recordFieldValues} rfv WHERE rfv.record_id = ${workflowItems.recordId} AND rfv.workspace_id = ${workspaceId} AND rfv.field_definition_id = ${fieldId} LIMIT 1)`;
}

/** Merged field value: the workflow overlay wins over the Record base. */
function mergedFieldValueExpr(workspaceId: string, fieldId: string, type: string): SQL {
  const column = fieldColumnName(type);
  return sql`COALESCE(${overlayFieldValueExpr(workspaceId, fieldId, column)}, ${baseFieldValueExpr(workspaceId, fieldId, column)})`;
}

interface ResolvedRange {
  basis: WidgetBasis;
  from: number | null;
  to: number | null;
  range: WidgetTimeRange;
}

function resolveTimeRange(
  timeRange: WidgetTimeRange | null | undefined,
  now: number
): ResolvedRange {
  return resolveTimeWindow(timeRange, now);
}

function safeParse(input: unknown): FilterAst | null {
  try {
    return parseFilterAst(input);
  } catch {
    return null;
  }
}

async function savedViewFilter(
  db: Executor,
  workspaceId: string,
  savedViewId: string
): Promise<FilterAst | null> {
  const rows = await db
    .select({ filterAst: savedViews.filterAst })
    .from(savedViews)
    .where(sql`${savedViews.workspaceId} = ${workspaceId} AND ${savedViews.id} = ${savedViewId}`)
    .all();
  return rows[0] ? safeParse(rows[0].filterAst) : null;
}

interface RunContext {
  db: Executor;
  workspaceId: string;
  now: number;
  widget: WidgetDefinition;
  source: SourcePlan;
  group: GroupPlan;
  timeExpr: SQL;
  range: ResolvedRange;
  /** Workspace + filter + workflow scope, without the time window. */
  baseWhere: SQL;
  /** `baseWhere` plus the widget's time window. */
  where: SQL;
  /** The compiled filter on its own, so a different base table can re-scope. */
  compiledSql: SQL;
  workflowIds: string[];
  /** Resolved field-definition id for field-based measures (key or id input). */
  measureFieldId: string | null;
  filterDescription: string;
  unresolved: string[];
}

function metaFor(context: RunContext): WidgetMeta {
  return {
    dataSource: context.widget.dataSource.kind,
    measure: context.widget.measure,
    grouping: context.group.by,
    timeRange: context.range.range,
    basis: context.range.basis,
    from: context.range.from,
    to: context.range.to,
    filter: context.filterDescription,
    unresolved: context.unresolved
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

interface AggregateRow {
  g_key?: unknown;
  g_label?: unknown;
  value?: unknown;
}

function shapeRows(rows: AggregateRow[], group: GroupPlan): WidgetRow[] {
  return rows.map((row) => {
    const key = toKey(row.g_key);
    const label = toKey(row.g_label) ?? key;
    const value = toNumber(row.value) ?? 0;
    return group.timeUnit ? { key, label, bucket: key ?? undefined, value } : { key, label, value };
  });
}

/**
 * Run one widget. The returned shape depends on the widget type: KPI/number
 * widgets carry `value`; chart and table widgets carry `rows` (and `series` for
 * time buckets); funnel and aging widgets delegate to their report modules.
 */
export async function runWidget(db: Executor, options: RunWidgetOptions): Promise<WidgetResult> {
  const now = options.now ?? Date.now();
  const widget = options.widget;

  // Records and WorkflowItems are answered by the universal engine, which compiles
  // filters and field measures against the canonical tables (ADR-0021). History
  // sources keep the report path below (itself workflow-item based) so an aging
  // widget still returns its per-state rows.
  const { isUniversalSource, runUniversalWidget } = await import('./universal');
  if (isUniversalSource(widget.dataSource.kind)) {
    return runUniversalWidget(db, {
      workspaceId: options.workspaceId,
      widget,
      globalFilter: options.globalFilter ?? null,
      now
    });
  }

  if (widget.type === 'funnel') {
    const { runFunnel } = await import('./funnel');
    const definition = widget.dataSource;
    const result = await runFunnel(db, {
      workspaceId: options.workspaceId,
      definition,
      filter: combineFilters(safeParse(widget.filter), options.globalFilter ?? null),
      timeRange: widget.timeRange ?? { kind: 'all' },
      now
    });
    return {
      kind: 'funnel',
      rows: result.stages.map((stage) => ({
        key: stage.label,
        label: stage.label,
        value: stage.count
      })),
      series: result.stages.map((stage) => ({ label: stage.label, value: stage.count })),
      grouping: 'none',
      meta: {
        dataSource: definition.kind,
        measure: widget.measure,
        grouping: 'none',
        timeRange: widget.timeRange ?? { kind: 'all' },
        basis: widget.timeRange?.basis ?? 'entered_state',
        from: null,
        to: null,
        filter: describeFilter(safeParse(widget.filter)),
        unresolved: [],
        note: `overallConversion=${result.overallConversion}`
      }
    };
  }

  if (widget.type === 'aging') {
    const { timeInStateReport } = await import('./aging');
    const report = await timeInStateReport(db, {
      workspaceId: options.workspaceId,
      stateIds: widget.dataSource.agingStates ?? [],
      filter: combineFilters(safeParse(widget.filter), options.globalFilter ?? null),
      timeRange: widget.timeRange ?? { kind: 'all' },
      now
    });
    return {
      kind: 'aging',
      rows: report.map((entry) => ({
        key: entry.stateId,
        label: entry.stateName,
        value: entry.medianSeconds ?? 0
      })),
      series: report.map((entry) => ({
        label: entry.stateName,
        value: entry.medianSeconds ?? 0
      })),
      grouping: 'state',
      meta: {
        dataSource: widget.dataSource.kind,
        measure: widget.measure,
        grouping: 'state',
        timeRange: widget.timeRange ?? { kind: 'all' },
        basis: widget.timeRange?.basis ?? 'entered_state',
        from: null,
        to: null,
        filter: describeFilter(safeParse(widget.filter)),
        unresolved: []
      }
    };
  }

  const context = await buildContext(db, options, now);
  const definition = context.widget;

  if (definition.measure.aggregation === 'conversion') {
    return runConversion(context);
  }
  if (definition.measure.aggregation === 'median') {
    return runMedian(context);
  }
  if (definition.measure.aggregation === 'duration') {
    return runDuration(context);
  }
  return runStandardAggregate(context);
}

async function buildContext(
  db: Executor,
  options: RunWidgetOptions,
  now: number
): Promise<RunContext> {
  const widget = options.widget;
  const viewFilter = widget.savedViewId
    ? await savedViewFilter(db, options.workspaceId, widget.savedViewId)
    : null;
  const combined = combineFilters(
    combineFilters(viewFilter, safeParse(widget.filter)),
    options.globalFilter ?? null
  );
  const compiled = await compileWorkflowItemFilterDetailed(db, {
    workspaceId: options.workspaceId,
    filter: combined,
    now
  });
  const source = buildSourcePlan(widget.dataSource.kind, options.workspaceId);
  const range = resolveTimeRange(widget.timeRange, now);
  const timeExpr = source.time[range.basis];
  const group = await buildGroupPlan(db, options.workspaceId, widget.grouping, source, timeExpr);

  // Measures address fields by key; resolve once so the correlated subquery uses
  // the definition id and never silently aggregates the wrong (missing) column.
  const measureFieldId =
    widget.measure.fieldKey &&
    ['sum', 'avg', 'min', 'max', 'median'].includes(widget.measure.aggregation)
      ? ((await resolveFieldDefinition(db, options.workspaceId, widget.measure.fieldKey))?.id ??
        null)
      : null;

  const conditions: SQL[] = [source.workspace, compiled.sql];
  const workflowIds = widget.dataSource.workflowIds ?? [];
  if (workflowIds.length > 0) {
    conditions.push(
      sql`${source.workflowExpr} IN (${sql.join(
        workflowIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }
  const baseWhere = sql.join(conditions, sql` AND `);
  const windowed = [...conditions];
  if (range.from !== null) windowed.push(sql`${timeExpr} >= ${range.from}`);
  if (range.to !== null) windowed.push(sql`${timeExpr} <= ${range.to}`);

  return {
    db,
    workspaceId: options.workspaceId,
    now,
    widget,
    source,
    group,
    timeExpr,
    range,
    baseWhere,
    where: sql.join(windowed, sql` AND `),
    compiledSql: compiled.sql,
    workflowIds,
    measureFieldId,
    filterDescription: describeFilter(combined),
    unresolved: compiled.unresolved
  };
}

/**
 * Scope conditions for `workflow_items`. Conversion and per-item duration
 * measures always read work items even when the widget declares another source,
 * so they cannot reuse scope conditions that name a source-specific alias.
 */
function workflowItemScope(context: RunContext): SQL {
  const plan = buildSourcePlan('workflow_items', context.workspaceId);
  const conditions: SQL[] = [plan.workspace, context.compiledSql];
  if (context.workflowIds.length > 0) {
    conditions.push(
      sql`${plan.workflowExpr} IN (${sql.join(
        context.workflowIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
  }
  return sql.join(conditions, sql` AND `);
}

function fromWithJoins(source: SourcePlan, group: GroupPlan): SQL {
  return group.joins === NO_JOIN ? source.from : sql`${source.from} ${group.joins}`;
}

function fieldMeasureExpression(workspaceId: string, fieldId: string | null): SQL | null {
  if (!fieldId) return null;
  // Measures are numeric: read the merged numeric value (overlay wins).
  const column = 'value_number';
  return sql`COALESCE(${overlayFieldValueExpr(workspaceId, fieldId, column)}, ${baseFieldValueExpr(workspaceId, fieldId, column)})`;
}

function aggregateExpression(
  context: RunContext,
  measure: WidgetMeasure
): { expression: SQL; fieldExpr: SQL | null } {
  const fieldExpr = fieldMeasureExpression(context.workspaceId, context.measureFieldId);
  const countExpression = sql`COUNT(DISTINCT ${context.source.idExpr})`;
  if (!fieldExpr) {
    // `fieldKey: null` means "count of rows" for every scalar aggregation.
    return { expression: countExpression, fieldExpr: null };
  }
  switch (measure.aggregation) {
    case 'sum':
      return { expression: sql`SUM(${fieldExpr})`, fieldExpr };
    case 'avg':
      return { expression: sql`AVG(${fieldExpr})`, fieldExpr };
    case 'min':
      return { expression: sql`MIN(${fieldExpr})`, fieldExpr };
    case 'max':
      return { expression: sql`MAX(${fieldExpr})`, fieldExpr };
    default:
      return { expression: countExpression, fieldExpr };
  }
}

async function executeRows(db: Executor, query: SQL): Promise<AggregateRow[]> {
  return db.all<AggregateRow>(query);
}

function orderAndLimit(context: RunContext, query: SQL): SQL {
  if (context.group.timeUnit) return sql`${query} ORDER BY g_key ASC`;
  if (!context.group.key) return query;
  const limit = context.group.limit ?? 100;
  return sql`${query} ORDER BY value DESC LIMIT ${limit}`;
}

async function runStandardAggregate(context: RunContext): Promise<WidgetResult> {
  const { expression } = aggregateExpression(context, context.widget.measure);
  const from = fromWithJoins(context.source, context.group);

  if (!context.group.key) {
    const rows = await executeRows(
      context.db,
      sql`SELECT ${expression} AS value FROM ${from} WHERE ${context.where}`
    );
    return {
      kind: context.widget.type,
      value: toNumber(rows[0]?.value) ?? 0,
      grouping: 'none',
      meta: metaFor(context)
    };
  }

  const query = sql`SELECT ${context.group.key} AS g_key, ${context.group.label ?? context.group.key} AS g_label, ${expression} AS value FROM ${from} WHERE ${context.where} GROUP BY g_key, g_label`;
  const rows = await executeRows(context.db, orderAndLimit(context, query));
  const shaped = shapeRows(rows, context.group);
  return finalizeGroupedResult(context, shaped);
}

function finalizeGroupedResult(context: RunContext, rows: WidgetRow[]): WidgetResult {
  const unit = context.group.timeUnit;
  if (unit) {
    const points: BucketPoint[] = rows.map((row) => ({
      bucket: row.bucket ?? row.key ?? '',
      value: row.value
    }));
    const filled = fillContinuous(context, points, unit);
    const filledRows: WidgetRow[] = filled.map((point) => ({
      key: point.bucket,
      label: point.bucket,
      bucket: point.bucket,
      value: point.value
    }));
    return {
      kind: context.widget.type,
      rows: filledRows,
      series: filledRows.map((row) => ({
        label: row.label ?? row.key ?? '',
        bucket: row.bucket,
        value: row.value
      })),
      grouping: context.group.by,
      meta: metaFor(context)
    };
  }
  return {
    kind: context.widget.type,
    rows,
    series: rows.map((row) => ({ label: row.label ?? row.key ?? '', value: row.value })),
    grouping: context.group.by,
    meta: metaFor(context)
  };
}

function fillContinuous(
  context: RunContext,
  points: BucketPoint[],
  unit: BucketUnit
): BucketPoint[] {
  const sorted = [...points].sort((a, b) =>
    a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0
  );
  const from =
    context.range.from ??
    (sorted[0] ? new Date(`${sorted[0].bucket}T00:00:00.000Z`).getTime() : context.now);
  const to =
    context.range.to ??
    (sorted.length > 0
      ? new Date(`${sorted[sorted.length - 1]!.bucket}T00:00:00.000Z`).getTime()
      : context.now);
  return fillMissingBuckets(sorted, from, to, unit);
}

async function runMedian(context: RunContext): Promise<WidgetResult> {
  const fieldExpr = fieldMeasureExpression(context.workspaceId, context.measureFieldId);
  if (!fieldExpr) {
    throw errors.validation('median requires a fieldKey to aggregate');
  }
  const from = fromWithJoins(context.source, context.group);

  if (!context.group.key) {
    const query = sql`SELECT AVG(v) AS value FROM (
      SELECT ${fieldExpr} AS v,
        ROW_NUMBER() OVER (ORDER BY ${fieldExpr}) AS rn,
        COUNT(*) OVER () AS cnt
      FROM ${from} WHERE ${context.where} AND ${fieldExpr} IS NOT NULL
    ) WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)`;
    const rows = await executeRows(context.db, query);
    return {
      kind: context.widget.type,
      value: toNumber(rows[0]?.value),
      grouping: 'none',
      meta: metaFor(context)
    };
  }

  const query = sql`SELECT g_key, g_label, AVG(v) AS value FROM (
      SELECT ${context.group.key} AS g_key, ${context.group.label ?? context.group.key} AS g_label, ${fieldExpr} AS v,
        ROW_NUMBER() OVER (PARTITION BY ${context.group.key}, ${context.group.label ?? context.group.key} ORDER BY ${fieldExpr}) AS rn,
        COUNT(*) OVER (PARTITION BY ${context.group.key}, ${context.group.label ?? context.group.key}) AS cnt
      FROM ${from} WHERE ${context.where} AND ${fieldExpr} IS NOT NULL
    ) WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
    GROUP BY g_key, g_label`;
  const rows = await executeRows(context.db, orderAndLimit(context, query));
  return finalizeGroupedResult(context, shapeRows(rows, context.group));
}

function durationExpression(context: RunContext): SQL {
  const measure = context.widget.measure;
  const workspaceId = context.workspaceId;
  const now = context.now;
  switch (measure.durationOf ?? 'cycle_time') {
    case 'time_in_state':
      // Closed intervals use their recorded exit; an open interval is measured
      // against the injectable `now` so it is not silently dropped.
      return sql`AVG((COALESCE(h.exited_at, ${now}) - h.entered_at) / 1000.0)`;
    case 'time_to_state': {
      const target =
        context.widget.dataSource.agingStates?.[0] ??
        firstFunnelStateIds(context.widget.dataSource)[0];
      if (!target) {
        throw errors.validation('time_to_state requires agingStates or a funnel stage state');
      }
      const reached = sql`(SELECT MIN(${workflowItemStateHistory}.entered_at) FROM ${workflowItemStateHistory} WHERE ${workflowItemStateHistory}.workflow_item_id = ${workflowItems.id} AND ${workflowItemStateHistory}.workspace_id = ${workspaceId} AND ${workflowItemStateHistory}.state_id = ${target})`;
      return sql`AVG((${reached} - ${workflowItems.createdAt}) / 1000.0)`;
    }
    case 'cycle_time': {
      const terminal = sql`(SELECT MIN(hist.entered_at) FROM ${workflowItemStateHistory} hist JOIN ${workflowStates} st ON st.id = hist.state_id AND st.workspace_id = hist.workspace_id WHERE hist.workflow_item_id = ${workflowItems.id} AND hist.workspace_id = ${workspaceId} AND (st.is_terminal = 1 OR st.category IN ('done', 'cancelled')))`;
      return sql`AVG((${terminal} - ${workflowItems.createdAt}) / 1000.0)`;
    }
  }
}

async function runDuration(context: RunContext): Promise<WidgetResult> {
  const measure = context.widget.measure;
  let source = context.source;
  let group = context.group;
  let where = context.where;

  if (measure.durationOf === 'time_in_state') {
    // Dwell time is an interval property: read it from history, not from the
    // current work-item row.
    source = buildSourcePlan('state_history', context.workspaceId);
    const timeExpr =
      source.time[context.range.basis === 'entered_state' ? 'entered_state' : context.range.basis];
    group = await buildGroupPlan(
      context.db,
      context.workspaceId,
      context.widget.grouping,
      source,
      timeExpr
    );
    // The base WHERE names the original source's alias; history always joins
    // `workflow_items`, so re-scope against work items instead of reusing it.
    const parts: SQL[] = [workflowItemScope(context)];
    if (context.range.from !== null) parts.push(sql`${timeExpr} >= ${context.range.from}`);
    if (context.range.to !== null) parts.push(sql`${timeExpr} <= ${context.range.to}`);
    const states = context.widget.dataSource.agingStates ?? [];
    if (states.length > 0) {
      parts.push(
        sql`h.state_id IN (${sql.join(
          states.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
    }
    where = sql.join(parts, sql` AND `);
  } else {
    // Cycle time and time-to-state are per-item: base on work items, ignoring the
    // data source's row unit so an item is never counted twice.
    source = buildSourcePlan('workflow_items', context.workspaceId);
    group = await buildGroupPlan(
      context.db,
      context.workspaceId,
      context.widget.grouping,
      source,
      source.time[context.range.basis]
    );
    const parts: SQL[] = [workflowItemScope(context)];
    const scopedTime = source.time[context.range.basis];
    if (context.range.from !== null) parts.push(sql`${scopedTime} >= ${context.range.from}`);
    if (context.range.to !== null) parts.push(sql`${scopedTime} <= ${context.range.to}`);
    where = sql.join(parts, sql` AND `);
  }

  const durationExpr = durationExpression(context);
  const from = fromWithJoins(source, group);
  const scoped = { ...context, source, group };

  if (!group.key) {
    const rows = await executeRows(
      context.db,
      sql`SELECT ${durationExpr} AS value FROM ${from} WHERE ${where}`
    );
    return {
      kind: context.widget.type,
      value: toNumber(rows[0]?.value),
      grouping: 'none',
      meta: metaFor(scoped)
    };
  }
  const query = sql`SELECT ${group.key} AS g_key, ${group.label ?? group.key} AS g_label, ${durationExpr} AS value FROM ${from} WHERE ${where} GROUP BY g_key, g_label`;
  const rows = await executeRows(context.db, orderAndLimit(scoped, query));
  return finalizeGroupedResult(scoped, shapeRows(rows, group));
}

function firstFunnelStateIds(dataSource: WidgetDataSource): string[] {
  const stage = dataSource.funnelStages?.[0];
  return stage?.stateIds ?? [];
}

async function runConversion(context: RunContext): Promise<WidgetResult> {
  const stages = context.widget.dataSource.funnelStages ?? [];
  if (stages.length < 2) {
    throw errors.validation('conversion requires at least two funnel stages');
  }
  const first = stages[0]!;
  const last = stages[stages.length - 1]!;
  const firstStates = first.stateIds ?? [];
  const lastStates = last.stateIds ?? [];
  if (firstStates.length === 0 || lastStates.length === 0) {
    throw errors.validation('conversion stages must select states');
  }

  const workspaceId = context.workspaceId;
  const windowClause = (alias: string): SQL => {
    const parts: SQL[] = [];
    if (context.range.from !== null)
      parts.push(sql`${sql.raw(`${alias}.entered_at`)} >= ${context.range.from}`);
    if (context.range.to !== null)
      parts.push(sql`${sql.raw(`${alias}.entered_at`)} <= ${context.range.to}`);
    return parts.length > 0 ? sql` AND ${sql.join(parts, sql` AND `)}` : sql``;
  };
  const firstEntry = sql`(SELECT MIN(fh.entered_at) FROM ${workflowItemStateHistory} fh WHERE fh.workflow_item_id = ${workflowItems.id} AND fh.workspace_id = ${workspaceId} AND fh.state_id IN (${sql.join(
    firstStates.map((id) => sql`${id}`),
    sql`, `
  )})${windowClause('fh')})`;
  const lastEntry = sql`(SELECT MIN(lh.entered_at) FROM ${workflowItemStateHistory} lh WHERE lh.workflow_item_id = ${workflowItems.id} AND lh.workspace_id = ${workspaceId} AND lh.state_id IN (${sql.join(
    lastStates.map((id) => sql`${id}`),
    sql`, `
  )}))`;

  const reachedFirst = sql`COUNT(DISTINCT CASE WHEN ${firstEntry} IS NOT NULL THEN ${workflowItems.id} END)`;
  const reachedLast = sql`COUNT(DISTINCT CASE WHEN ${lastEntry} IS NOT NULL THEN ${workflowItems.id} END)`;
  const ratio = sql`(100.0 * ${reachedLast}) / NULLIF(${reachedFirst}, 0)`;

  const where = sql.join([workflowItemScope(context), sql`${firstEntry} IS NOT NULL`], sql` AND `);

  if (!context.group.key) {
    const rows = await executeRows(
      context.db,
      sql`SELECT ${ratio} AS value FROM ${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId} WHERE ${where}`
    );
    return {
      kind: context.widget.type,
      value: toNumber(rows[0]?.value),
      grouping: 'none',
      meta: metaFor(context)
    };
  }

  // Time buckets are anchored on first-stage entry, not item creation, so a
  // week-over-week conversion answers "of items that started this week".
  const keyExpr = context.group.timeUnit
    ? bucketExpression(context.group.timeUnit, firstEntry)
    : context.group.key;
  const labelExpr = context.group.timeUnit ? keyExpr : (context.group.label ?? keyExpr);
  const query = sql`SELECT ${keyExpr} AS g_key, ${labelExpr} AS g_label, ${ratio} AS value FROM ${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId} WHERE ${where} GROUP BY g_key, g_label`;
  const rows = await executeRows(
    context.db,
    orderAndLimit({ ...context, group: { ...context.group, key: keyExpr } }, query)
  );
  return finalizeGroupedResult(
    { ...context, group: { ...context.group, key: keyExpr, label: labelExpr } },
    shapeRows(rows, context.group)
  );
}
