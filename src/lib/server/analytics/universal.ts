/**
 * Universal-model widget engine: analytics over Records and WorkflowItems.
 *
 * This is the shared implementation for the canonical tables (ADR-0021):
 *
 *  - `records`         — durable facts: grouping by Object Type, record fields, time
 *  - `workflow_items`  — process facts: grouping by state, workflow, owner, record
 *                        fields (overlay value wins over base), time in state
 *
 * It returns the same `WidgetResult` shape as `runWidget`, so dashboards and the UI
 * need no special case. Funnels read `workflow_item_state_history` intervals, which
 * is the same recorded-history rule the history reports follow (ADR-0017). The
 * legacy `tickets` data-source kind (still present in stored widgets) is normalized
 * to `workflow_items` here so there is one work-item implementation.
 */
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  fieldDefinitions,
  labels,
  objectTypes,
  records,
  savedViews,
  teams,
  users,
  type WidgetDataSource,
  type WidgetMeasure,
  type WidgetTimeRange,
  workflowItemLabels,
  workflowItemStateHistory,
  workflowItems,
  workflowStates,
  workflows
} from '../db/schema';
import {
  combineFilters,
  describeFilter,
  type FilterAst,
  type FilterCondition,
  isGroup,
  parseFilterAst
} from '../filters/ast';
import { compileWorkflowItemFilterDetailed } from '../filters/compile';
import type { WidgetDefinition, WidgetMeta, WidgetResult, WidgetRow } from './query';
import {
  type BucketPoint,
  type BucketUnit,
  bucketExpression,
  fillMissingBuckets,
  resolveTimeWindow
} from './series';

export type UniversalSource = 'records' | 'workflow_items';

/**
 * Map a stored data-source kind to the universal source it is answered by.
 * History sources return null because they are answered by the history reports.
 */
export function normalizeUniversalSource(kind: WidgetDataSource['kind']): UniversalSource | null {
  if (kind === 'records') return 'records';
  if (kind === 'workflow_items') return 'workflow_items';
  return null;
}

export function isUniversalSource(kind: WidgetDataSource['kind']): kind is UniversalSource {
  return kind === 'records' || kind === 'workflow_items';
}

export async function runUniversalWidget(
  db: Executor,
  options: {
    workspaceId: string;
    widget: WidgetDefinition;
    globalFilter?: FilterAst | null;
    now?: number;
  }
): Promise<WidgetResult> {
  const now = options.now ?? Date.now();
  const kind = normalizeUniversalSource(options.widget.dataSource.kind);
  if (!kind) {
    throw errors.validation(
      `Widget data source "${options.widget.dataSource.kind}" is not a universal source`
    );
  }
  // A widget may reference a saved view; its stored AST is ANDed with the
  // widget's own filter and the dashboard/global filter, exactly like the
  // dashboard run path. The view lookup is workspace-scoped so a foreign view id
  // can never broaden (or narrow) another workspace's result.
  const viewFilter = options.widget.savedViewId
    ? savedViewFilter(db, options.workspaceId, options.widget.savedViewId)
    : null;
  const filter = combineFilters(
    combineFilters(viewFilter, safeParse(options.widget.filter)),
    options.globalFilter ?? null
  );
  const range = resolveTimeWindow(options.widget.timeRange, now);
  const timeExpr = timeExpression(kind, range.basis);
  // Work item filters go through the shared `filters/compile` implementation so a
  // dashboard widget, a board and a saved view can never disagree (ADR-0012). The
  // Records source keeps its own compiler, which answers record fields directly.
  const filterCompiled =
    kind === 'workflow_items'
      ? await compileWorkflowItemFilterDetailed(db, {
          workspaceId: options.workspaceId,
          filter,
          now
        })
      : compileUniversalFilter(
          filter,
          kind,
          resolveFilterFieldTypes(db, options.workspaceId, filter)
        );
  const unresolved = filterCompiled.unresolved;
  const conditions: SQL[] = [workspaceCondition(kind, options.workspaceId), filterCompiled.sql];
  applyWorkflowScope(conditions, kind, options.widget.dataSource.workflowIds ?? []);
  if (range.from !== null) conditions.push(sql`${timeExpr} >= ${range.from}`);
  if (range.to !== null) conditions.push(sql`${timeExpr} <= ${range.to}`);
  const where = sql.join(conditions, sql` AND `);

  const definition = options.widget.dataSource;
  const meta = (grouping: WidgetMeta['grouping'], note?: string): WidgetMeta => ({
    dataSource: kind,
    measure: options.widget.measure,
    grouping,
    timeRange: options.widget.timeRange ?? { kind: 'all' },
    basis: range.basis,
    from: range.from,
    to: range.to,
    filter: describeFilter(filter),
    unresolved,
    note
  });

  if (options.widget.type === 'funnel') {
    return runUniversalFunnel(db, {
      workspaceId: options.workspaceId,
      kind,
      definition,
      filterSql: filterCompiled.sql,
      workflowIds: definition.workflowIds ?? [],
      range,
      now,
      meta
    });
  }

  const grouping = options.widget.grouping ?? { by: 'none' as const };
  const groupingField =
    grouping.by === 'field' ? resolveRecordField(db, options.workspaceId, grouping.fieldKey) : null;
  const group = buildUniversalGroup(kind, grouping, groupingField, timeExpr);

  const measure = options.widget.measure;
  if (measure.aggregation === 'conversion') {
    // Conversion over time is anchored on first-stage entry, not creation, so a
    // week-over-week line answers "of items that started this week".
    return runUniversalConversion(db, {
      workspaceId: options.workspaceId,
      kind,
      definition,
      filterSql: filterCompiled.sql,
      workflowIds: definition.workflowIds ?? [],
      range,
      now,
      widgetType: options.widget.type,
      grouping,
      group,
      meta
    });
  }

  if (measure.aggregation === 'duration') {
    // Duration is an interval property and needs no field.
    return runUniversalDuration(db, {
      workspaceId: options.workspaceId,
      kind,
      measure,
      definition,
      filterSql: filterCompiled.sql,
      workflowIds: definition.workflowIds ?? [],
      range,
      now,
      timeExpr,
      widgetType: options.widget.type,
      meta
    });
  }

  const baseId = kind === 'records' ? sql`${records.id}` : sql`${workflowItems.id}`;
  const fieldId =
    measure.fieldKey && measure.aggregation !== 'count'
      ? resolveRecordFieldId(db, options.workspaceId, measure.fieldKey)
      : null;
  if (measure.aggregation !== 'count' && !fieldId) {
    throw errors.validation(`Unknown numeric record field: ${measure.fieldKey ?? '(none)'}`);
  }
  const fieldExpr = fieldId ? fieldMeasureExpression(kind, options.workspaceId, fieldId) : null;
  const from = kind === 'records' ? recordsJoin(group.joins) : workflowItemJoin(group.joins);

  if (measure.aggregation === 'median') {
    if (!fieldExpr) throw errors.validation('median requires a fieldKey to aggregate');
    return runUniversalMedian(db, {
      widgetType: options.widget.type,
      baseId,
      fieldExpr,
      from,
      where,
      group,
      range,
      now,
      meta
    });
  }

  const expression = scalarExpression(measure, baseId, fieldExpr);
  if (!group.key) {
    const rows = await db.all<{ value: unknown }>(
      sql`SELECT ${expression} AS value FROM ${from} WHERE ${where}`
    );
    return {
      kind: options.widget.type,
      value: toNumber(rows[0]?.value) ?? 0,
      grouping: 'none',
      meta: meta('none')
    };
  }

  const query = sql`SELECT ${group.key} AS g_key, ${group.label ?? group.key} AS g_label, ${expression} AS value FROM ${from} WHERE ${where} GROUP BY g_key, g_label`;
  const ordered = group.timeUnit
    ? sql`${query} ORDER BY g_key ASC`
    : sql`${query} ORDER BY value DESC LIMIT ${group.limit ?? 100}`;
  const rows = await db.all<{ g_key: unknown; g_label: unknown; value: unknown }>(ordered);
  const shaped: WidgetRow[] = rows.map((row) => ({
    key: toKey(row.g_key),
    label: toKey(row.g_label) ?? toKey(row.g_key),
    value: toNumber(row.value) ?? 0,
    ...(group.timeUnit ? { bucket: toKey(row.g_key) ?? undefined } : {})
  }));

  if (group.timeUnit) {
    const points: BucketPoint[] = shaped.map((row) => ({
      bucket: row.bucket ?? row.key ?? '',
      value: row.value
    }));
    const filled = fillUniversalBuckets(points, range, now, group.timeUnit);
    const filledRows: WidgetRow[] = filled.map((point) => ({
      key: point.bucket,
      label: point.bucket,
      bucket: point.bucket,
      value: point.value
    }));
    return {
      kind: options.widget.type,
      rows: filledRows,
      series: filledRows.map((row) => ({
        label: row.label ?? '',
        bucket: row.bucket,
        value: row.value
      })),
      grouping: grouping.by,
      meta: meta(grouping.by)
    };
  }

  return {
    kind: options.widget.type,
    rows: shaped,
    series: shaped.map((row) => ({ label: row.label ?? row.key ?? '', value: row.value })),
    grouping: grouping.by,
    meta: meta(grouping.by)
  };
}

function safeParse(filter: unknown): FilterAst | null {
  if (!filter) return null;
  try {
    return parseFilterAst(filter);
  } catch {
    return null;
  }
}

/** Load a saved view's AST, workspace-scoped. Missing/invalid views are ignored. */
function savedViewFilter(db: Executor, workspaceId: string, savedViewId: string): FilterAst | null {
  const rows = db
    .select({ filterAst: savedViews.filterAst })
    .from(savedViews)
    .where(and(eq(savedViews.workspaceId, workspaceId), eq(savedViews.id, savedViewId)))
    .all();
  return rows[0] ? safeParse(rows[0].filterAst) : null;
}

function workspaceCondition(kind: UniversalSource, workspaceId: string): SQL {
  return kind === 'records'
    ? sql`${records.workspaceId} = ${workspaceId} AND ${records.archivedAt} IS NULL`
    : sql`${workflowItems.workspaceId} = ${workspaceId} AND ${workflowItems.archivedAt} IS NULL`;
}

function timeExpression(kind: UniversalSource, basis: WidgetTimeRange['basis']): SQL {
  if (kind === 'records') {
    if (basis === 'updated') return sql`${records.updatedAt}`;
    return sql`${records.createdAt}`;
  }
  if (basis === 'created') return sql`${workflowItems.createdAt}`;
  if (basis === 'updated') return sql`${workflowItems.updatedAt}`;
  return sql`${workflowItems.enteredStateAt}`;
}

function applyWorkflowScope(conditions: SQL[], kind: UniversalSource, workflowIds: string[]): void {
  if (workflowIds.length === 0) return;
  const list = sql.join(
    workflowIds.map((id) => sql`${id}`),
    sql`, `
  );
  if (kind === 'workflow_items') {
    conditions.push(sql`${workflowItems.workflowId} IN (${list})`);
  } else {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM workflow_items wi_scope WHERE wi_scope.record_id = ${records.id} AND wi_scope.workspace_id = ${records.workspaceId} AND wi_scope.workflow_id IN (${list}))`
    );
  }
}

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

interface CompiledFilter {
  sql: SQL;
  unresolved: string[];
}

const RECORD_SYSTEM_COLUMNS: Record<string, string> = {
  displayName: 'display_name',
  key: 'key',
  number: 'number',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  archivedAt: 'archived_at',
  objectTypeId: 'object_type_id'
};

const WORK_ITEM_SYSTEM_COLUMNS: Record<string, string> = {
  stateId: 'state_id',
  workflowId: 'workflow_id',
  ownerUserId: 'owner_user_id',
  ownerTeamId: 'owner_team_id',
  recordId: 'record_id',
  waitingOn: 'waiting_on',
  enteredStateAt: 'entered_state_at',
  lastActivityAt: 'last_activity_at',
  completedAt: 'completed_at',
  dueAt: 'due_at',
  version: 'version',
  recordDisplayName: 'record_id'
};

function compileUniversalFilter(
  filter: FilterAst | null,
  kind: UniversalSource,
  fieldTypes: Map<string, string>
): CompiledFilter {
  const unresolved: string[] = [];
  if (!filter) return { sql: sql`1 = 1`, unresolved };
  return { sql: compileNode(filter, kind, fieldTypes, unresolved), unresolved };
}

function compileNode(
  node: FilterAst,
  kind: UniversalSource,
  fieldTypes: Map<string, string>,
  unresolved: string[]
): SQL {
  if (isGroup(node)) {
    const children = node.children.map((child) => compileNode(child, kind, fieldTypes, unresolved));
    if (children.length === 0) return sql`1 = 1`;
    const joined =
      node.op === 'or' ? sql.join(children, sql` OR `) : sql.join(children, sql` AND `);
    return sql`(${joined})`;
  }
  return compileCondition(node, kind, fieldTypes, unresolved);
}

function compileCondition(
  condition: FilterCondition,
  kind: UniversalSource,
  fieldTypes: Map<string, string>,
  unresolved: string[]
): SQL {
  const conditionKind = condition.kind ?? 'system';
  if (conditionKind === 'system') {
    return compileSystemCondition(condition, kind, unresolved);
  }
  if (conditionKind === 'field' || conditionKind === 'record_field') {
    return compileRecordFieldCondition(condition, fieldTypes, unresolved);
  }
  unresolved.push(`${conditionKind}:${condition.key}`);
  return sql`0 = 1`;
}

function compileSystemCondition(
  condition: FilterCondition,
  kind: UniversalSource,
  unresolved: string[]
): SQL {
  if (
    kind === 'workflow_items' &&
    (condition.key === 'displayName' || condition.key === 'recordDisplayName')
  ) {
    return compareExpression(sql`${records.displayName}`, condition);
  }
  const table = kind === 'records' ? 'records' : 'workflow_items';
  const columns = kind === 'records' ? RECORD_SYSTEM_COLUMNS : WORK_ITEM_SYSTEM_COLUMNS;
  const column = columns[condition.key];
  if (!column) {
    unresolved.push(condition.key);
    return sql`0 = 1`;
  }
  return compareExpression(sql.raw(`${table}.${column}`), condition);
}

function compareExpression(column: SQL, condition: FilterCondition): SQL {
  const { operator, value } = condition;
  switch (operator) {
    case 'eq':
      return sql`${column} = ${value}`;
    case 'neq':
      return sql`${column} <> ${value}`;
    case 'contains':
      return sql`lower(${column}) LIKE ${`%${String(value).toLowerCase()}%`}`;
    case 'starts_with':
      return sql`lower(${column}) LIKE ${`${String(value).toLowerCase()}%`}`;
    case 'ends_with':
      return sql`lower(${column}) LIKE ${`%${String(value).toLowerCase()}`}`;
    case 'gt':
    case 'after':
      return sql`${column} > ${value}`;
    case 'gte':
      return sql`${column} >= ${value}`;
    case 'lt':
    case 'before':
      return sql`${column} < ${value}`;
    case 'lte':
      return sql`${column} <= ${value}`;
    case 'in':
      return sql`${column} IN ${inList(value)}`;
    case 'not_in':
      return sql`${column} NOT IN ${inList(value)}`;
    case 'is_empty':
      return sql`(${column} IS NULL OR ${column} = '')`;
    case 'is_not_empty':
      return sql`(${column} IS NOT NULL AND ${column} <> '')`;
    default:
      return sql`1 = 1`;
  }
}

function compileRecordFieldCondition(
  condition: FilterCondition,
  fieldTypes: Map<string, string>,
  unresolved: string[]
): SQL {
  const type = fieldTypes.get(condition.key);
  if (!type) {
    unresolved.push(condition.key);
    return sql`0 = 1`;
  }
  const inner = compareRecordValue(type, condition);
  return sql`EXISTS (
    SELECT 1 FROM record_field_values rfv
    INNER JOIN field_definitions fd ON fd.id = rfv.field_definition_id
    WHERE rfv.record_id = ${records.id}
      AND fd.scope = 'record'
      AND (fd.key = ${condition.key} OR fd.id = ${condition.key})
      AND ${inner}
  )`;
}

function recordColumn(type: string): string {
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

function compareRecordValue(type: string, condition: FilterCondition): SQL {
  const value = condition.value;
  const text = value === undefined || value === null ? null : String(value);
  const column = sql.raw(`rfv.${recordColumn(type)}`);
  const numeric = type === 'number' || type === 'currency';
  const date = type === 'date' || type === 'datetime';
  const bound = numeric
    ? Number(value)
    : date
      ? typeof value === 'number'
        ? value
        : Number.isFinite(Date.parse(String(value)))
          ? Date.parse(String(value))
          : value
      : value;
  switch (condition.operator) {
    case 'contains':
      return sql`rfv.search_text LIKE ${`%${String(text).toLowerCase()}%`}`;
    case 'starts_with':
      return sql`rfv.search_text LIKE ${`${String(text).toLowerCase()}%`}`;
    case 'ends_with':
      return sql`rfv.search_text LIKE ${`%${String(text).toLowerCase()}`}`;
    case 'is_empty':
      return sql`(rfv.value_text IS NULL AND rfv.value_number IS NULL AND rfv.value_date IS NULL AND rfv.value_bool IS NULL AND rfv.value_json IS NULL)`;
    case 'is_not_empty':
      return sql`(rfv.value_text IS NOT NULL OR rfv.value_number IS NOT NULL OR rfv.value_date IS NOT NULL OR rfv.value_bool IS NOT NULL OR rfv.value_json IS NOT NULL)`;
    case 'gt':
    case 'after':
      return sql`${column} > ${bound}`;
    case 'gte':
      return sql`${column} >= ${bound}`;
    case 'lt':
    case 'before':
      return sql`${column} < ${bound}`;
    case 'lte':
      return sql`${column} <= ${bound}`;
    case 'in':
      return sql`${column} IN ${inList(value)}`;
    case 'not_in':
      return sql`${column} NOT IN ${inList(value)}`;
    case 'neq':
      return sql`${column} <> ${bound}`;
    default:
      return sql`${column} = ${bound}`;
  }
}

/** Resolve every record-field key/id in the filter to its declared type once. */
function resolveFilterFieldTypes(
  db: Executor,
  workspaceId: string,
  filter: FilterAst | null
): Map<string, string> {
  const keys = new Set<string>();
  const walk = (node: FilterAst): void => {
    if (isGroup(node)) {
      for (const child of node.children) walk(child);
      return;
    }
    const kind = node.kind ?? 'system';
    if (kind === 'field' || kind === 'record_field') keys.add(node.key);
  };
  if (filter) walk(filter);
  if (keys.size === 0) return new Map();
  const rows = db
    .select({ id: fieldDefinitions.id, key: fieldDefinitions.key, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, 'record'),
        isNull(fieldDefinitions.archivedAt),
        sql`(${fieldDefinitions.key} IN ${inList([...keys])} OR ${fieldDefinitions.id} IN ${inList([...keys])})`
      )
    )
    .all();
  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.key, row.type);
    result.set(row.id, row.type);
  }
  return result;
}

function inList(value: unknown): SQL {
  const values = Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value)];
  return sql`(${sql.join(values.length > 0 ? values.map((entry) => sql`${entry}`) : [sql`NULL`], sql`, `)})`;
}

// ---------------------------------------------------------------------------
// Grouping and measures
// ---------------------------------------------------------------------------

interface UniversalGroup {
  key: SQL | null;
  label?: SQL;
  joins: SQL | null;
  timeUnit?: BucketUnit;
  limit?: number;
}

function buildUniversalGroup(
  kind: UniversalSource,
  grouping: { by: string; fieldKey?: string; limit?: number },
  groupingField: { id: string; type: string } | null,
  timeExpr: SQL
): UniversalGroup {
  switch (grouping.by) {
    case 'none':
      return { key: null, joins: null };
    case 'objectType':
      if (kind !== 'records') return { key: sql`${records.objectTypeId}`, joins: null };
      return {
        key: sql`${objectTypes.name}`,
        label: sql`${objectTypes.name}`,
        joins: sql`JOIN object_types ON object_types.id = ${records.objectTypeId}`,
        limit: grouping.limit
      };
    case 'state':
      if (kind === 'workflow_items') {
        return {
          key: sql`${workflowStates.name}`,
          label: sql`${workflowStates.name}`,
          joins: sql`JOIN workflow_states ON workflow_states.id = ${workflowItems.stateId}`,
          limit: grouping.limit
        };
      }
      return { key: sql`${records.objectTypeId}`, joins: null, limit: grouping.limit };
    case 'workflow':
      if (kind === 'workflow_items') {
        return {
          key: sql`${workflows.name}`,
          label: sql`${workflows.name}`,
          joins: sql`JOIN workflows ON workflows.id = ${workflowItems.workflowId}`,
          limit: grouping.limit
        };
      }
      return { key: sql`${records.objectTypeId}`, joins: null, limit: grouping.limit };
    case 'owner':
      if (kind === 'workflow_items') {
        return {
          key: sql`COALESCE(${users.name}, 'Unassigned')`,
          label: sql`COALESCE(${users.name}, 'Unassigned')`,
          joins: sql`LEFT JOIN users ON users.id = ${workflowItems.ownerUserId}`,
          limit: grouping.limit
        };
      }
      return { key: sql`${records.createdById}`, joins: null, limit: grouping.limit };
    case 'team':
      if (kind === 'workflow_items') {
        return {
          key: sql`COALESCE(${teams.name}, 'No team')`,
          label: sql`COALESCE(${teams.name}, 'No team')`,
          joins: sql`LEFT JOIN teams ON teams.id = ${workflowItems.ownerTeamId}`,
          limit: grouping.limit
        };
      }
      return { key: sql`${records.objectTypeId}`, joins: null, limit: grouping.limit };
    case 'priority':
      // There is no priority column in the universal model: it is a Record
      // structured value. Items without one read as `none`, the legacy default.
      return {
        key: sql`COALESCE(json_extract(${records.structuredData}, '$.priority'), 'none')`,
        label: sql`COALESCE(json_extract(${records.structuredData}, '$.priority'), 'none')`,
        joins: null,
        limit: grouping.limit
      };
    case 'label':
      if (kind === 'workflow_items') {
        // A labelled item appears once per label; COUNT(DISTINCT item) keeps the
        // fan-out from inflating the value.
        return {
          key: sql`${labels.id}`,
          label: sql`${labels.name}`,
          joins: sql`JOIN ${workflowItemLabels} wil ON wil.workflow_item_id = ${workflowItems.id} AND wil.workspace_id = ${workflowItems.workspaceId} JOIN ${labels} ON ${labels.id} = wil.label_id AND ${labels.workspaceId} = ${workflowItems.workspaceId}`,
          limit: grouping.limit
        };
      }
      return { key: sql`${records.objectTypeId}`, joins: null, limit: grouping.limit };
    case 'field': {
      if (!groupingField) return { key: sql`NULL`, joins: null, limit: grouping.limit };
      const column = recordColumn(groupingField.type);
      const id = groupingField.id;
      if (kind === 'records') {
        return {
          key: sql`(SELECT rfv.${sql.raw(column)} FROM record_field_values rfv WHERE rfv.record_id = ${records.id} AND rfv.field_definition_id = ${id} LIMIT 1)`,
          joins: null,
          limit: grouping.limit
        };
      }
      return {
        key: sql`COALESCE((SELECT wifv.${sql.raw(column)} FROM workflow_item_field_values wifv WHERE wifv.workflow_item_id = ${workflowItems.id} AND wifv.field_definition_id = ${id} LIMIT 1), (SELECT rfv.${sql.raw(column)} FROM record_field_values rfv WHERE rfv.record_id = ${workflowItems.recordId} AND rfv.field_definition_id = ${id} LIMIT 1))`,
        joins: null,
        limit: grouping.limit
      };
    }
    case 'day':
    case 'week':
    case 'month': {
      const unit = grouping.by as BucketUnit;
      return { key: bucketExpression(unit, timeExpr), joins: null, timeUnit: unit };
    }
    default:
      return { key: null, joins: null };
  }
}

function recordsJoin(joins: SQL | null): SQL {
  return joins ? sql`${records} ${joins}` : sql`${records}`;
}

function workflowItemJoin(joins: SQL | null): SQL {
  const base = sql`${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`;
  return joins ? sql`${base} ${joins}` : base;
}

function scalarExpression(measure: WidgetMeasure, baseId: SQL, fieldExpr: SQL | null): SQL {
  const count = sql`COUNT(DISTINCT ${baseId})`;
  if (!fieldExpr) return count;
  switch (measure.aggregation) {
    case 'sum':
      return sql`SUM(${fieldExpr})`;
    case 'avg':
      return sql`AVG(${fieldExpr})`;
    case 'min':
      return sql`MIN(${fieldExpr})`;
    case 'max':
      return sql`MAX(${fieldExpr})`;
    default:
      return count;
  }
}

function fieldMeasureExpression(kind: UniversalSource, workspaceId: string, fieldId: string): SQL {
  const base = sql`(SELECT rfv.value_number FROM record_field_values rfv WHERE rfv.record_id = ${records.id} AND rfv.workspace_id = ${workspaceId} AND rfv.field_definition_id = ${fieldId} LIMIT 1)`;
  if (kind === 'records') return base;
  const overlay = sql`(SELECT wifv.value_number FROM workflow_item_field_values wifv WHERE wifv.workflow_item_id = ${workflowItems.id} AND wifv.workspace_id = ${workspaceId} AND wifv.field_definition_id = ${fieldId} LIMIT 1)`;
  return sql`COALESCE(${overlay}, ${base})`;
}

function resolveRecordField(
  db: Executor,
  workspaceId: string,
  keyOrId: string | null | undefined
): { id: string; type: string } | null {
  if (!keyOrId) return null;
  const row = db
    .select({ id: fieldDefinitions.id, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        sql`${fieldDefinitions.scope} <> 'file'`,
        isNull(fieldDefinitions.archivedAt),
        sql`(${fieldDefinitions.key} = ${keyOrId} OR ${fieldDefinitions.id} = ${keyOrId})`
      )
    )
    .all()[0];
  return row ? { id: row.id, type: row.type } : null;
}

function resolveRecordFieldId(
  db: Executor,
  workspaceId: string,
  keyOrId: string | null | undefined
): string | null {
  return resolveRecordField(db, workspaceId, keyOrId)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Median
// ---------------------------------------------------------------------------

async function runUniversalMedian(
  db: Executor,
  input: {
    widgetType: WidgetDefinition['type'];
    baseId: SQL;
    fieldExpr: SQL;
    from: SQL;
    where: SQL;
    group: UniversalGroup;
    range: ReturnType<typeof resolveTimeWindow>;
    now: number;
    meta: (grouping: WidgetMeta['grouping']) => WidgetMeta;
  }
): Promise<WidgetResult> {
  if (!input.group.key) {
    const query = sql`SELECT AVG(v) AS value FROM (
      SELECT ${input.fieldExpr} AS v,
        ROW_NUMBER() OVER (ORDER BY ${input.fieldExpr}) AS rn,
        COUNT(*) OVER () AS cnt
      FROM ${input.from} WHERE ${input.where} AND ${input.fieldExpr} IS NOT NULL
    ) WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)`;
    const rows = await db.all<{ value: unknown }>(query);
    return {
      kind: input.widgetType,
      value: toNumber(rows[0]?.value),
      grouping: 'none',
      meta: input.meta('none')
    };
  }
  const query = sql`SELECT g_key, g_label, AVG(v) AS value FROM (
      SELECT ${input.group.key} AS g_key, ${input.group.label ?? input.group.key} AS g_label, ${input.fieldExpr} AS v,
        ROW_NUMBER() OVER (PARTITION BY ${input.group.key}, ${input.group.label ?? input.group.key} ORDER BY ${input.fieldExpr}) AS rn,
        COUNT(*) OVER (PARTITION BY ${input.group.key}, ${input.group.label ?? input.group.key}) AS cnt
      FROM ${input.from} WHERE ${input.where} AND ${input.fieldExpr} IS NOT NULL
    ) WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
    GROUP BY g_key, g_label
    ORDER BY value DESC LIMIT ${input.group.limit ?? 100}`;
  const rows = await db.all<{ g_key: unknown; g_label: unknown; value: unknown }>(query);
  const shaped: WidgetRow[] = rows.map((row) => ({
    key: toKey(row.g_key),
    label: toKey(row.g_label) ?? toKey(row.g_key),
    value: toNumber(row.value) ?? 0
  }));
  return {
    kind: input.widgetType,
    rows: shaped,
    series: shaped.map((row) => ({ label: row.label ?? row.key ?? '', value: row.value })),
    grouping: 'field',
    meta: input.meta('field')
  };
}

// ---------------------------------------------------------------------------
// Duration (workflow items read recorded intervals)
// ---------------------------------------------------------------------------

async function runUniversalDuration(
  db: Executor,
  input: {
    workspaceId: string;
    kind: UniversalSource;
    measure: WidgetMeasure;
    definition: WidgetDataSource;
    filterSql: SQL;
    workflowIds: string[];
    range: ReturnType<typeof resolveTimeWindow>;
    now: number;
    timeExpr: SQL;
    widgetType: WidgetDefinition['type'];
    meta: (grouping: WidgetMeta['grouping'], note?: string) => WidgetMeta;
  }
): Promise<WidgetResult> {
  if (input.kind !== 'workflow_items') {
    throw errors.validation('Duration analytics is only available for workflow items');
  }
  const durationOf = input.measure.durationOf ?? 'cycle_time';

  if (durationOf === 'time_in_state') {
    const conditions: SQL[] = [sql`h.workspace_id = ${input.workspaceId}`, input.filterSql];
    if (input.workflowIds.length > 0) {
      conditions.push(
        sql`h.workflow_id IN (${sql.join(
          input.workflowIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
    }
    const states = input.definition.agingStates ?? [];
    if (states.length > 0) {
      conditions.push(
        sql`h.state_id IN (${sql.join(
          states.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
    }
    const from = sql`${workflowItemStateHistory} h JOIN ${workflowItems} ON ${workflowItems.id} = h.workflow_item_id JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`;
    const where = sql.join(conditions, sql` AND `);
    const expression = sql`AVG((COALESCE(h.exited_at, ${input.now}) - h.entered_at) / 1000.0)`;
    const rows = await db.all<{ value: unknown }>(
      sql`SELECT ${expression} AS value FROM ${from} WHERE ${where}`
    );
    return {
      kind: input.widgetType,
      value: toNumber(rows[0]?.value),
      grouping: 'none',
      meta: input.meta('none')
    };
  }

  // Cycle time and time-to-state are per-item measures, so they read the current
  // item (never the interval row unit) and scope the window on the requested
  // timestamp. An item with no terminal/reached entry contributes no sample.
  const workspaceId = input.workspaceId;
  const conditions: SQL[] = [workspaceCondition('workflow_items', workspaceId), input.filterSql];
  applyWorkflowScope(conditions, 'workflow_items', input.workflowIds);
  if (input.range.from !== null) conditions.push(sql`${input.timeExpr} >= ${input.range.from}`);
  if (input.range.to !== null) conditions.push(sql`${input.timeExpr} <= ${input.range.to}`);
  const where = sql.join(conditions, sql` AND `);
  const from = sql`${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`;

  let expression: SQL;
  if (durationOf === 'time_to_state') {
    const target =
      input.definition.agingStates?.[0] ?? input.definition.funnelStages?.[0]?.stateIds?.[0];
    if (!target) {
      throw errors.validation('time_to_state requires agingStates or a funnel stage state');
    }
    const reached = sql`(SELECT MIN(${workflowItemStateHistory}.entered_at) FROM ${workflowItemStateHistory} WHERE ${workflowItemStateHistory}.workflow_item_id = ${workflowItems.id} AND ${workflowItemStateHistory}.workspace_id = ${workspaceId} AND ${workflowItemStateHistory}.state_id = ${target})`;
    expression = sql`AVG((${reached} - ${workflowItems.createdAt}) / 1000.0)`;
  } else {
    const terminal = sql`(SELECT MIN(hist.entered_at) FROM ${workflowItemStateHistory} hist JOIN ${workflowStates} st ON st.id = hist.state_id AND st.workspace_id = hist.workspace_id WHERE hist.workflow_item_id = ${workflowItems.id} AND hist.workspace_id = ${workspaceId} AND (st.is_terminal = 1 OR st.category IN ('done', 'cancelled')))`;
    expression = sql`AVG((${terminal} - ${workflowItems.createdAt}) / 1000.0)`;
  }

  const rows = await db.all<{ value: unknown }>(
    sql`SELECT ${expression} AS value FROM ${from} WHERE ${where}`
  );
  return {
    kind: input.widgetType,
    value: toNumber(rows[0]?.value),
    grouping: 'none',
    meta: input.meta('none')
  };
}

// ---------------------------------------------------------------------------
// Conversion (first → last funnel stage, optionally over time)
// ---------------------------------------------------------------------------

async function runUniversalConversion(
  db: Executor,
  input: {
    workspaceId: string;
    kind: UniversalSource;
    definition: WidgetDataSource;
    filterSql: SQL;
    workflowIds: string[];
    range: ReturnType<typeof resolveTimeWindow>;
    now: number;
    widgetType: WidgetDefinition['type'];
    grouping: { by: WidgetMeta['grouping']; limit?: number };
    group: UniversalGroup;
    meta: (grouping: WidgetMeta['grouping'], note?: string) => WidgetMeta;
  }
): Promise<WidgetResult> {
  if (input.kind !== 'workflow_items') {
    throw errors.validation('Conversion analytics is only available for workflow items');
  }
  const stages = input.definition.funnelStages ?? [];
  const first = stages[0];
  const last = stages[stages.length - 1];
  if (stages.length < 2 || !first || !last) {
    throw errors.validation('conversion requires at least two funnel stages');
  }
  const firstStates = first.stateIds ?? [];
  const lastStates = last.stateIds ?? [];
  if (firstStates.length === 0 || lastStates.length === 0) {
    throw errors.validation('conversion stages must select states');
  }

  const workspaceId = input.workspaceId;
  const ids = (values: string[]): SQL =>
    sql.join(
      values.map((id) => sql`${id}`),
      sql`, `
    );
  const windowClause = (alias: string): SQL => {
    const parts: SQL[] = [];
    if (input.range.from !== null)
      parts.push(sql`${sql.raw(`${alias}.entered_at`)} >= ${input.range.from}`);
    if (input.range.to !== null)
      parts.push(sql`${sql.raw(`${alias}.entered_at`)} <= ${input.range.to}`);
    return parts.length > 0 ? sql` AND ${sql.join(parts, sql` AND `)}` : sql``;
  };
  const firstEntry = sql`(SELECT MIN(fh.entered_at) FROM ${workflowItemStateHistory} fh WHERE fh.workflow_item_id = ${workflowItems.id} AND fh.workspace_id = ${workspaceId} AND fh.state_id IN (${ids(firstStates)})${windowClause('fh')})`;
  const lastEntry = sql`(SELECT MIN(lh.entered_at) FROM ${workflowItemStateHistory} lh WHERE lh.workflow_item_id = ${workflowItems.id} AND lh.workspace_id = ${workspaceId} AND lh.state_id IN (${ids(lastStates)}))`;
  const reachedFirst = sql`COUNT(DISTINCT CASE WHEN ${firstEntry} IS NOT NULL THEN ${workflowItems.id} END)`;
  const reachedLast = sql`COUNT(DISTINCT CASE WHEN ${lastEntry} IS NOT NULL THEN ${workflowItems.id} END)`;
  const ratio = sql`(100.0 * ${reachedLast}) / NULLIF(${reachedFirst}, 0)`;

  const conditions: SQL[] = [
    workspaceCondition('workflow_items', workspaceId),
    input.filterSql,
    sql`${firstEntry} IS NOT NULL`
  ];
  applyWorkflowScope(conditions, 'workflow_items', input.workflowIds);
  const where = sql.join(conditions, sql` AND `);
  const from = workflowItemJoin(input.group.joins);

  if (!input.group.key) {
    const rows = await db.all<{ value: unknown }>(
      sql`SELECT ${ratio} AS value FROM ${from} WHERE ${where}`
    );
    return {
      kind: input.widgetType,
      value: toNumber(rows[0]?.value),
      grouping: 'none',
      meta: input.meta('none')
    };
  }

  const keyExpr = input.group.timeUnit
    ? bucketExpression(input.group.timeUnit, firstEntry)
    : input.group.key;
  const labelExpr = input.group.timeUnit ? keyExpr : (input.group.label ?? keyExpr);
  const query = sql`SELECT ${keyExpr} AS g_key, ${labelExpr} AS g_label, ${ratio} AS value FROM ${from} WHERE ${where} GROUP BY g_key, g_label`;
  const ordered = input.group.timeUnit
    ? sql`${query} ORDER BY g_key ASC`
    : sql`${query} ORDER BY value DESC LIMIT ${input.group.limit ?? 100}`;
  const rows = await db.all<{ g_key: unknown; g_label: unknown; value: unknown }>(ordered);
  const shaped: WidgetRow[] = rows.map((row) => ({
    key: toKey(row.g_key),
    label: toKey(row.g_label) ?? toKey(row.g_key),
    value: toNumber(row.value) ?? 0,
    ...(input.group.timeUnit ? { bucket: toKey(row.g_key) ?? undefined } : {})
  }));

  if (input.group.timeUnit) {
    const points: BucketPoint[] = shaped.map((row) => ({
      bucket: row.bucket ?? row.key ?? '',
      value: row.value
    }));
    const filled = fillUniversalBuckets(points, input.range, input.now, input.group.timeUnit);
    const filledRows: WidgetRow[] = filled.map((point) => ({
      key: point.bucket,
      label: point.bucket,
      bucket: point.bucket,
      value: point.value
    }));
    return {
      kind: input.widgetType,
      rows: filledRows,
      series: filledRows.map((row) => ({
        label: row.label ?? '',
        bucket: row.bucket,
        value: row.value
      })),
      grouping: input.grouping.by,
      meta: input.meta(input.grouping.by)
    };
  }

  return {
    kind: input.widgetType,
    rows: shaped,
    series: shaped.map((row) => ({ label: row.label ?? row.key ?? '', value: row.value })),
    grouping: input.grouping.by,
    meta: input.meta(input.grouping.by)
  };
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

async function runUniversalFunnel(
  db: Executor,
  input: {
    workspaceId: string;
    kind: UniversalSource;
    definition: WidgetDataSource;
    filterSql: SQL;
    workflowIds: string[];
    range: ReturnType<typeof resolveTimeWindow>;
    now: number;
    meta: (grouping: WidgetMeta['grouping'], note?: string) => WidgetMeta;
  }
): Promise<WidgetResult> {
  const stages = input.definition.funnelStages ?? [];
  const counts: Array<{ label: string; count: number }> = [];
  for (const stage of stages) {
    const count = await universalStageCount(db, { ...input, stage });
    counts.push({ label: stage.label, count });
  }
  const first = counts[0]?.count ?? 0;
  const last = counts[counts.length - 1]?.count ?? 0;
  const overall = first > 0 ? last / first : 0;
  return {
    kind: 'funnel',
    rows: counts.map((entry) => ({ key: entry.label, label: entry.label, value: entry.count })),
    series: counts.map((entry) => ({ label: entry.label, value: entry.count })),
    grouping: 'none',
    meta: input.meta('none', `overallConversion=${overall}`)
  };
}

async function universalStageCount(
  db: Executor,
  input: {
    workspaceId: string;
    kind: UniversalSource;
    filterSql: SQL;
    workflowIds: string[];
    range: ReturnType<typeof resolveTimeWindow>;
    stage: NonNullable<WidgetDataSource['funnelStages']>[number];
  }
): Promise<number> {
  const conditions: SQL[] = [input.filterSql];
  if (input.stage.stateIds && input.stage.stateIds.length > 0) {
    const list = sql.join(
      input.stage.stateIds.map((id) => sql`${id}`),
      sql`, `
    );
    const from = sql`${workflowItemStateHistory} h JOIN ${workflowItems} ON ${workflowItems.id} = h.workflow_item_id JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`;
    const inner: SQL[] = [sql`h.workspace_id = ${input.workspaceId}`, sql`h.state_id IN (${list})`];
    if (input.range.from !== null) inner.push(sql`h.entered_at >= ${input.range.from}`);
    if (input.range.to !== null) inner.push(sql`h.entered_at <= ${input.range.to}`);
    const rows = await db.all<{ value: unknown }>(
      sql`SELECT COUNT(DISTINCT ${workflowItems.id}) AS value FROM ${from} WHERE ${sql.join(inner, sql` AND `)}`
    );
    return toNumber(rows[0]?.value) ?? 0;
  }
  if (input.stage.fieldKey) {
    const field = resolveRecordField(db, input.workspaceId, input.stage.fieldKey);
    if (!field) return 0;
    const from =
      input.kind === 'records'
        ? sql`${records}`
        : sql`${workflowItems} JOIN ${records} ON ${records.id} = ${workflowItems.recordId}`;
    // Base value on the Record or overlay value on the participation both count.
    const store = (table: string, joinColumn: string, joinValue: SQL): SQL =>
      sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} fv WHERE fv.${sql.raw(joinColumn)} = ${joinValue} AND fv.field_definition_id = ${field.id} AND ${stageValuePredicate(field.type, input.stage.fieldValue, 'fv')})`;
    const baseExists = store('record_field_values', 'record_id', sql`${records.id}`);
    const exists =
      input.kind === 'records'
        ? baseExists
        : sql`(${store('workflow_item_field_values', 'workflow_item_id', sql`${workflowItems.id}`)} OR ${store('record_field_values', 'record_id', sql`${workflowItems.recordId}`)})`;
    conditions.push(exists);
    conditions.push(workspaceCondition(input.kind, input.workspaceId));
    if (input.range.from !== null)
      conditions.push(sql`${records.createdAt} >= ${input.range.from}`);
    if (input.range.to !== null) conditions.push(sql`${records.createdAt} <= ${input.range.to}`);
    const idExpr = input.kind === 'records' ? sql`${records.id}` : sql`${workflowItems.id}`;
    const rows = await db.all<{ value: unknown }>(
      sql`SELECT COUNT(DISTINCT ${idExpr}) AS value FROM ${from} WHERE ${sql.join(conditions, sql` AND `)}`
    );
    return toNumber(rows[0]?.value) ?? 0;
  }
  return 0;
}

/** Typed match for a funnel stage's expected field value against store alias `fv`. */
function stageValuePredicate(type: string, value: unknown, alias: string): SQL {
  if (Array.isArray(value)) {
    const list = sql.join(
      value.map((entry) => sql`${String(entry)}`),
      sql`, `
    );
    return sql`EXISTS (SELECT 1 FROM json_each(${sql.raw(`${alias}.value_json`)}) je WHERE je.value IN (${list}))`;
  }
  const column = recordColumn(type);
  const ref = sql.raw(`${alias}.${column}`);
  if (type === 'number' || type === 'currency') return sql`${ref} = ${Number(value)}`;
  if (type === 'date' || type === 'datetime') {
    const bound =
      typeof value === 'number'
        ? value
        : Number.isFinite(Date.parse(String(value)))
          ? Date.parse(String(value))
          : value;
    return sql`${ref} = ${bound}`;
  }
  if (type === 'boolean')
    return sql`${ref} = ${value === true || value === 'true' || value === 1 ? 1 : 0}`;
  const text = value === undefined || value === null ? null : String(value);
  return sql`(${ref} = ${text} OR ${sql.raw(`${alias}.search_text`)} = ${text?.toLowerCase() ?? null})`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fillUniversalBuckets(
  points: BucketPoint[],
  range: ReturnType<typeof resolveTimeWindow>,
  now: number,
  unit: BucketUnit
): BucketPoint[] {
  const sorted = [...points].sort((a, b) =>
    a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0
  );
  const from =
    range.from ?? (sorted[0] ? new Date(`${sorted[0].bucket}T00:00:00.000Z`).getTime() : now);
  const to =
    range.to ??
    (sorted.length > 0
      ? new Date(`${sorted[sorted.length - 1]!.bucket}T00:00:00.000Z`).getTime()
      : now);
  return fillMissingBuckets(sorted, from, to, unit);
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
