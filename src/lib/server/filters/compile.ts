/**
 * WorkflowItem filter compiler.
 *
 * This is the single place where the serializable filter AST becomes SQL.
 * Workflow-item lists, boards, saved views and dashboard widgets all call it, so
 * a saved view and a widget can never disagree about what a filter means
 * (ADR-0012). The module deliberately owns *all* dialect knowledge for filtering
 * — including the few JSON and correlated-subquery expressions — behind portable
 * Drizzle `SQL` chunks.
 *
 * ## The universal work model (ADR-0021)
 *
 * Filters compile against `workflow_items` joined to `records`; there is no
 * `tickets` table any more. A condition therefore draws on three sources:
 *
 *  - **Record facts** — `key`, `number`, `displayName`, object type, record
 *    timestamps, and base field values in `record_field_values`.
 *  - **WorkflowItem process facts** — state, workflow, owner, entered/closed
 *    timestamps, run/approval status, and workflow-overlay field values in
 *    `workflow_item_field_values`.
 *  - **Files** — linked either to the participation (`file_workflow_items`) or to
 *    the durable Record (`file_records`); both are visible from the item.
 *
 * Work-overlay values win over Record base values when they exist, matching the
 * merged read model in `workflow-items/fields.ts`.
 *
 * ## Failure mode for unknown keys
 *
 * A stored view or widget can outlive the field definition it referenced. An
 * unknown key is not a server error: the condition compiles to "matches nothing"
 * and the key is reported in `unresolved` so the UI can explain the gap instead
 * of silently widening the result. Inside an OR the other branches still run.
 *
 * ## Derived system fields
 *
 * `timeInStateSeconds` is `(now - entered_state_at) / 1000`, i.e. whole seconds
 * spent in the *current* state; `now` is injectable so tests never read the wall
 * clock. `runStatus` and `approvalStatus` read the most recent related row
 * (`ORDER BY created_at DESC, id DESC LIMIT 1`). `sourceType` comes from the
 * workflow item's `provenance` JSON; the SQLite form is
 * `json_extract(provenance, '$.sourceType')`.
 *
 * ## Text matching
 *
 * `contains` / `starts_with` / `ends_with` are case-insensitive (`lower(...)`
 * plus a lowercased pattern); `eq` / `neq` are exact. Custom-field pattern
 * matching reads the lowercase `search_text` projection, which is indexed.
 * `LIKE` metacharacters in a user value are escaped and the pattern uses an
 * explicit `ESCAPE '\'`, so a search for `%` matches a literal percent sign.
 */
import { eq, getTableColumns, type SQL, sql } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  agentRuns,
  approvalRequests,
  blobs,
  type FieldType,
  fieldDefinitions,
  fileExtractedContent,
  fileFieldValues,
  fileRecords,
  fileSources,
  files,
  fileWorkflowItems,
  labels,
  recordFieldValues,
  records,
  type SavedViewSort,
  type WorkflowItem,
  workflowFiles,
  workflowItemFieldValues,
  workflowItemLabels,
  workflowItems,
  workflowStates
} from '../db/schema';
import {
  collectFieldKeys,
  type FilterAst,
  type FilterCondition,
  type FilterNode,
  type FilterOperator,
  isCondition,
  isGroup,
  WorkflowItemSystemFields
} from './ast';

/** A condition that matches nothing. */
const FALSE: SQL = sql`0 = 1`;
/** A condition that matches everything. */
const TRUE: SQL = sql`1 = 1`;

type ValueType = 'text' | 'number' | 'date' | 'bool' | 'enum';

/**
 * Where a custom field's value lives.
 *  - `record`       — durable base value on the Record (`record_field_values`);
 *  - `workflowItem` — the merged work view: overlay value wins, base is the
 *                     fallback (`workflow_item_field_values` ∪ `record_field_values`);
 *  - `file`         — a file field on a file linked to the item or its record.
 */
type FieldSource = 'record' | 'workflowItem' | 'file';

interface FieldRef {
  id: string;
  key: string;
  type: FieldType;
  scope: 'record' | 'file';
}

interface CompileContext {
  workspaceId: string;
  now: number;
  fields: Map<string, FieldRef>;
  labels: Map<string, string>;
  unresolved: Set<string>;
}

/* ------------------------------------------------------------------ *
 * Small value coercions. Filters arrive from JSON, so every value is
 * untrusted and may be the wrong shape.
 * ------------------------------------------------------------------ */

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function asStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: string[] = [];
  for (const entry of raw) {
    const text = asString(entry);
    if (text !== null) out.push(text);
  }
  return out;
}

function asValueList(value: unknown, type: ValueType): Array<string | number> {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: Array<string | number> = [];
  for (const entry of raw) {
    if (type === 'number' || type === 'date') {
      const numeric = asNumber(entry);
      if (numeric !== null) out.push(numeric);
    } else {
      const text = asString(entry);
      if (text !== null) out.push(text);
    }
  }
  return out;
}

function asRange(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const from = asNumber(value[0]);
    const to = asNumber(value[1]);
    if (from !== null && to !== null) return [from, to];
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const from = asNumber(record.from ?? record.min);
    const to = asNumber(record.to ?? record.max);
    if (from !== null && to !== null) return [from, to];
  }
  return null;
}

/** Parameterized `(a, b, c)` tuple for `IN`. Never empty (callers guard). */
function inList(values: ReadonlyArray<string | number>): SQL {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  )})`;
}

/* ------------------------------------------------------------------ *
 * Operators.
 * ------------------------------------------------------------------ */

const NEGATIVE_OPERATORS: Partial<Record<FilterOperator, FilterOperator>> = {
  neq: 'eq',
  not_in: 'in',
  not_contains: 'contains',
  not_within_last_days: 'within_last_days'
};

function isNegativeOperator(operator: FilterOperator): boolean {
  return NEGATIVE_OPERATORS[operator] !== undefined;
}

function positiveOperator(operator: FilterOperator): FilterOperator {
  return NEGATIVE_OPERATORS[operator] ?? operator;
}

const COMPARISON_SYMBOLS: Partial<Record<FilterOperator, SQL>> = {
  eq: sql`=`,
  neq: sql`<>`,
  gt: sql`>`,
  gte: sql`>=`,
  lt: sql`<`,
  lte: sql`<=`,
  before: sql`<`,
  after: sql`>`
};

function emptyPredicate(expr: SQL, type: ValueType): SQL {
  return type === 'text' || type === 'enum'
    ? sql`(${expr} IS NULL OR ${expr} = '')`
    : sql`${expr} IS NULL`;
}

function notEmptyPredicate(expr: SQL, type: ValueType): SQL {
  return type === 'text' || type === 'enum'
    ? sql`(${expr} IS NOT NULL AND ${expr} <> '')`
    : sql`${expr} IS NOT NULL`;
}

function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function textPattern(expr: SQL, operator: FilterOperator, value: string): SQL {
  const escaped = escapeLike(value.toLowerCase());
  switch (operator) {
    case 'contains':
      return sql`lower(${expr}) LIKE ${`%${escaped}%`} ESCAPE '\\'`;
    case 'not_contains':
      return sql`COALESCE(lower(${expr}), '') NOT LIKE ${`%${escaped}%`} ESCAPE '\\'`;
    case 'starts_with':
      return sql`lower(${expr}) LIKE ${`${escaped}%`} ESCAPE '\\'`;
    case 'ends_with':
      return sql`lower(${expr}) LIKE ${`%${escaped}`} ESCAPE '\\'`;
    default:
      return FALSE;
  }
}

/**
 * Build one comparison for a scalar expression. Negative operators
 * (`neq`, `not_in`, `not_contains`, `not_within_last_days`) are handled here for
 * plain columns; relation and field compilers translate them into `NOT EXISTS`
 * so that rows with no related row match the negation.
 */
function applyOperator(
  expr: SQL,
  type: ValueType,
  operator: FilterOperator,
  value: unknown,
  now: number
): SQL {
  switch (operator) {
    case 'is_empty':
      return emptyPredicate(expr, type);
    case 'is_not_empty':
      return notEmptyPredicate(expr, type);
    case 'is_true':
      return sql`${expr} IS TRUE`;
    case 'is_false':
      return sql`${expr} IS FALSE`;
    case 'contains':
    case 'not_contains':
    case 'starts_with':
    case 'ends_with': {
      const text = asString(value);
      if (text === null) return operator === 'not_contains' ? TRUE : FALSE;
      return textPattern(expr, operator, text);
    }
    case 'within_last_days':
    case 'not_within_last_days': {
      const days = asNumber(value);
      if (days === null) return operator === 'not_within_last_days' ? TRUE : FALSE;
      const threshold = now - days * 86_400_000;
      return operator === 'within_last_days'
        ? sql`(${expr} IS NOT NULL AND ${expr} >= ${threshold} AND ${expr} <= ${now})`
        : sql`(${expr} IS NULL OR ${expr} < ${threshold})`;
    }
    case 'between': {
      const range = asRange(value);
      if (!range) return FALSE;
      return sql`${expr} BETWEEN ${range[0]} AND ${range[1]}`;
    }
    case 'in':
    case 'not_in': {
      const values = asValueList(value, type);
      if (values.length === 0) return operator === 'in' ? FALSE : TRUE;
      return operator === 'in'
        ? sql`${expr} IN ${inList(values)}`
        : sql`${expr} NOT IN ${inList(values)}`;
    }
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'before':
    case 'after': {
      if (type === 'bool') {
        const bool = asBoolean(value);
        if (bool === null) return FALSE;
        if (operator === 'eq') return bool ? sql`${expr} IS TRUE` : sql`${expr} IS FALSE`;
        if (operator === 'neq') return bool ? sql`${expr} IS NOT TRUE` : sql`${expr} IS NOT FALSE`;
        return FALSE;
      }
      const symbol = COMPARISON_SYMBOLS[operator] ?? sql`=`;
      if (type === 'number' || type === 'date') {
        const numeric = asNumber(value);
        if (numeric === null) return FALSE;
        return sql`${expr} ${symbol} ${numeric}`;
      }
      const text = asString(value);
      if (text === null) return FALSE;
      return sql`${expr} ${symbol} ${text}`;
    }
    default:
      return FALSE;
  }
}

/* ------------------------------------------------------------------ *
 * System fields.
 * ------------------------------------------------------------------ */

/** `records.structured_data` holds values without a field definition. */
function structuredExpr(column: 'description' | 'priority'): SQL {
  return sql`json_extract(${records.structuredData}, ${`$.${column}`})`;
}

function systemFieldExpression(
  key: string,
  workspaceId: string,
  now: number
): { expr: SQL; type: ValueType } | null {
  switch (key) {
    // --- Record facts -------------------------------------------------
    case WorkflowItemSystemFields.key:
      return { expr: sql`${records.key}`, type: 'text' };
    case WorkflowItemSystemFields.number:
      return { expr: sql`${records.number}`, type: 'number' };
    case WorkflowItemSystemFields.title:
    case WorkflowItemSystemFields.displayName:
      return { expr: sql`${records.displayName}`, type: 'text' };
    case WorkflowItemSystemFields.description:
      return { expr: structuredExpr('description'), type: 'text' };
    case WorkflowItemSystemFields.priority:
      // There is no priority column in the universal model: it is a Record field
      // (or a structured value). Reading the structured projection keeps stored
      // views working without inventing a process column.
      return { expr: structuredExpr('priority'), type: 'enum' };
    case WorkflowItemSystemFields.objectTypeId:
      return { expr: sql`${records.objectTypeId}`, type: 'enum' };
    case WorkflowItemSystemFields.recordId:
      return { expr: sql`${workflowItems.recordId}`, type: 'enum' };
    case WorkflowItemSystemFields.recordCreatedAt:
      return { expr: sql`${records.createdAt}`, type: 'date' };
    case WorkflowItemSystemFields.recordUpdatedAt:
      return { expr: sql`${records.updatedAt}`, type: 'date' };
    // --- WorkflowItem process facts -----------------------------------
    case WorkflowItemSystemFields.stateId:
      return { expr: sql`${workflowItems.stateId}`, type: 'enum' };
    case WorkflowItemSystemFields.workflowId:
      return { expr: sql`${workflowItems.workflowId}`, type: 'enum' };
    case WorkflowItemSystemFields.ownerUserId:
      return { expr: sql`${workflowItems.ownerUserId}`, type: 'enum' };
    case WorkflowItemSystemFields.ownerTeamId:
      return { expr: sql`${workflowItems.ownerTeamId}`, type: 'enum' };
    case WorkflowItemSystemFields.createdAt:
      return { expr: sql`${workflowItems.createdAt}`, type: 'date' };
    case WorkflowItemSystemFields.updatedAt:
      return { expr: sql`${workflowItems.updatedAt}`, type: 'date' };
    case WorkflowItemSystemFields.enteredStateAt:
      return { expr: sql`${workflowItems.enteredStateAt}`, type: 'date' };
    case WorkflowItemSystemFields.lastActivityAt:
      return { expr: sql`${workflowItems.lastActivityAt}`, type: 'date' };
    case WorkflowItemSystemFields.dueAt:
      return { expr: sql`${workflowItems.dueAt}`, type: 'date' };
    case WorkflowItemSystemFields.closedAt:
      return { expr: sql`${workflowItems.closedAt}`, type: 'date' };
    case WorkflowItemSystemFields.completedAt:
      return { expr: sql`${workflowItems.completedAt}`, type: 'date' };
    case WorkflowItemSystemFields.waitingOn:
      return { expr: sql`${workflowItems.waitingOn}`, type: 'enum' };
    case WorkflowItemSystemFields.originWorkflowItemId:
      return { expr: sql`${workflowItems.originWorkflowItemId}`, type: 'enum' };
    case WorkflowItemSystemFields.participation:
      return { expr: sql`${workflowItems.participation}`, type: 'enum' };
    case WorkflowItemSystemFields.stateRunCount:
      return { expr: sql`${workflowItems.stateRunCount}`, type: 'number' };
    case WorkflowItemSystemFields.stateName:
      return {
        expr: sql`(SELECT ${workflowStates.name} FROM ${workflowStates} WHERE ${workflowStates.id} = ${workflowItems.stateId} AND ${workflowStates.workspaceId} = ${workspaceId})`,
        type: 'text'
      };
    case WorkflowItemSystemFields.stateKind:
      return {
        expr: sql`(SELECT ${workflowStates.kind} FROM ${workflowStates} WHERE ${workflowStates.id} = ${workflowItems.stateId} AND ${workflowStates.workspaceId} = ${workspaceId})`,
        type: 'enum'
      };
    case WorkflowItemSystemFields.stateCategory:
      return {
        expr: sql`(SELECT ${workflowStates.category} FROM ${workflowStates} WHERE ${workflowStates.id} = ${workflowItems.stateId} AND ${workflowStates.workspaceId} = ${workspaceId})`,
        type: 'enum'
      };
    case WorkflowItemSystemFields.isUnassigned:
      return {
        expr: sql`(CASE WHEN ${workflowItems.ownerUserId} IS NULL AND ${workflowItems.ownerTeamId} IS NULL THEN 1 ELSE 0 END)`,
        type: 'bool'
      };
    case WorkflowItemSystemFields.timeInStateSeconds:
      return {
        expr: sql`CAST((${now} - ${workflowItems.enteredStateAt}) / 1000 AS INTEGER)`,
        type: 'number'
      };
    case WorkflowItemSystemFields.runStatus:
      return {
        expr: sql`(SELECT ${agentRuns.status} FROM ${agentRuns} WHERE ${agentRuns.workflowItemId} = ${workflowItems.id} AND ${agentRuns.workspaceId} = ${workspaceId} ORDER BY ${agentRuns.createdAt} DESC, ${agentRuns.id} DESC LIMIT 1)`,
        type: 'enum'
      };
    case WorkflowItemSystemFields.approvalStatus:
      return {
        expr: sql`(SELECT ${approvalRequests.status} FROM ${approvalRequests} WHERE ${approvalRequests.workflowItemId} = ${workflowItems.id} AND ${approvalRequests.workspaceId} = ${workspaceId} ORDER BY ${approvalRequests.createdAt} DESC, ${approvalRequests.id} DESC LIMIT 1)`,
        type: 'enum'
      };
    case WorkflowItemSystemFields.sourceType:
      return { expr: sql`json_extract(${workflowItems.provenance}, '$.sourceType')`, type: 'enum' };
    default:
      return null;
  }
}

function valueTypeForField(type: FieldType): ValueType {
  switch (type) {
    case 'number':
    case 'currency':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'boolean':
      return 'bool';
    default:
      return 'text';
  }
}

/** Typed column name inside a field-value store alias. */
function typedColumnName(type: FieldType, operator: FilterOperator): string {
  if (
    operator === 'contains' ||
    operator === 'not_contains' ||
    operator === 'starts_with' ||
    operator === 'ends_with'
  ) {
    return 'search_text';
  }
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

/** Store aliases: `wifv` = overlay, `rfv` = record base, `ffv` = file. */
type FieldAlias = 'wifv' | 'rfv' | 'ffv';

function columnRef(alias: FieldAlias, column: string): SQL {
  // The alias and column are chosen from fixed sets in this module, never from
  // user input, so `raw` here cannot become an injection vector.
  return sql.raw(`${alias}.${column}`);
}

function emptinessForColumn(alias: FieldAlias, type: FieldType): SQL {
  if (type === 'multi_select') {
    const column = columnRef(alias, 'value_json');
    return sql`(${column} IS NOT NULL AND json_array_length(${column}) > 0)`;
  }
  if (
    type === 'number' ||
    type === 'currency' ||
    type === 'date' ||
    type === 'datetime' ||
    type === 'boolean'
  ) {
    return sql`${columnRef(alias, typedColumnName(type, 'eq'))} IS NOT NULL`;
  }
  const column = columnRef(alias, 'value_text');
  return sql`(${column} IS NOT NULL AND ${column} <> '')`;
}

/* ------------------------------------------------------------------ *
 * Compilation.
 * ------------------------------------------------------------------ */

function findField(ctx: CompileContext, source: FieldSource, key: string): FieldRef | undefined {
  const scope = source === 'file' ? 'file' : source;
  return ctx.fields.get(`${scope}:${key}`);
}

function valuesOf(condition: FilterCondition): string[] {
  if (condition.value === undefined || condition.value === null) return [condition.key];
  return asStringList(condition.value);
}

function existsClause(query: SQL, negative: boolean): SQL {
  return negative ? sql`NOT (${query})` : query;
}

function compileSystem(condition: FilterCondition, ctx: CompileContext): SQL {
  const field = systemFieldExpression(condition.key, ctx.workspaceId, ctx.now);
  if (!field) {
    ctx.unresolved.add(condition.key);
    return FALSE;
  }
  return applyOperator(field.expr, field.type, condition.operator, condition.value, ctx.now);
}

function compileMembership(condition: FilterCondition, expr: SQL): SQL {
  if (condition.operator === 'is_empty') return sql`${expr} IS NULL`;
  if (condition.operator === 'is_not_empty') return sql`${expr} IS NOT NULL`;
  const values = valuesOf(condition);
  if (values.length === 0) return condition.operator === 'not_in' ? TRUE : FALSE;
  const negative = condition.operator === 'not_in' || condition.operator === 'neq';
  return negative
    ? sql`(${expr} IS NULL OR ${expr} NOT IN ${inList(values)})`
    : sql`${expr} IN ${inList(values)}`;
}

function compileOwnership(condition: FilterCondition, kind: 'owner' | 'team'): SQL {
  const expr =
    kind === 'owner' ? sql`${workflowItems.ownerUserId}` : sql`${workflowItems.ownerTeamId}`;
  return compileMembership(condition, expr);
}

function compileLabel(condition: FilterCondition, ctx: CompileContext): SQL {
  const labelExists = (inner: SQL): SQL =>
    sql`EXISTS (SELECT 1 FROM ${workflowItemLabels} WHERE ${workflowItemLabels.workflowItemId} = ${workflowItems.id} AND ${workflowItemLabels.workspaceId} = ${ctx.workspaceId} AND ${inner})`;
  const anyLabel = labelExists(sql`1 = 1`);

  if (condition.operator === 'is_empty') return sql`NOT (${anyLabel})`;
  if (condition.operator === 'is_not_empty') return anyLabel;

  const identifiers = valuesOf(condition);
  const ids: string[] = [];
  for (const identifier of identifiers) {
    const resolved = ctx.labels.get(identifier);
    if (resolved) ids.push(resolved);
    else ctx.unresolved.add(identifier);
  }
  if (ids.length === 0) {
    return condition.operator === 'not_in' || condition.operator === 'neq' ? TRUE : FALSE;
  }
  const matching = labelExists(sql`${workflowItemLabels.labelId} IN ${inList(ids)}`);
  const negative = condition.operator === 'not_in' || condition.operator === 'neq';
  return existsClause(matching, negative);
}

/** EXISTS against one field-value store for the current workflow item. */
function storeExists(alias: 'wifv' | 'rfv', ctx: CompileContext, refId: string, inner: SQL): SQL {
  if (alias === 'wifv') {
    return sql`EXISTS (SELECT 1 FROM ${workflowItemFieldValues} wifv WHERE wifv.workflow_item_id = ${workflowItems.id} AND wifv.workspace_id = ${ctx.workspaceId} AND wifv.field_definition_id = ${refId} AND ${inner})`;
  }
  return sql`EXISTS (SELECT 1 FROM ${recordFieldValues} rfv WHERE rfv.record_id = ${workflowItems.recordId} AND rfv.workspace_id = ${ctx.workspaceId} AND rfv.field_definition_id = ${refId} AND ${inner})`;
}

/**
 * EXISTS against the files linked to the item *or* to its Record, restricted to
 * one field definition so a file field filter can see both attachment levels.
 */
function fileFieldExists(ctx: CompileContext, refId: string, inner: SQL): SQL {
  const workBranch = sql`EXISTS (SELECT 1 FROM ${files} f JOIN ${fileFieldValues} ffv ON ffv.file_id = f.id AND ffv.workspace_id = f.workspace_id JOIN ${fileWorkflowItems} fwi ON fwi.file_id = f.id AND fwi.workspace_id = f.workspace_id WHERE fwi.workflow_item_id = ${workflowItems.id} AND fwi.workspace_id = ${ctx.workspaceId} AND fwi.removed_at IS NULL AND f.deleted_at IS NULL AND ffv.field_definition_id = ${refId} AND ${inner})`;
  const recordBranch = sql`EXISTS (SELECT 1 FROM ${files} f JOIN ${fileFieldValues} ffv ON ffv.file_id = f.id AND ffv.workspace_id = f.workspace_id JOIN ${fileRecords} fr ON fr.file_id = f.id AND fr.workspace_id = f.workspace_id WHERE fr.record_id = ${workflowItems.recordId} AND fr.workspace_id = ${ctx.workspaceId} AND fr.removed_at IS NULL AND f.deleted_at IS NULL AND ffv.field_definition_id = ${refId} AND ${inner})`;
  return sql`(${workBranch} OR ${recordBranch})`;
}

/** Scalar read of one typed column from one field-value store. */
function storeValueSubquery(
  alias: 'wifv' | 'rfv',
  column: string,
  refId: string,
  ctx: CompileContext
): SQL {
  if (alias === 'wifv') {
    return sql`(SELECT wifv.${sql.raw(column)} FROM ${workflowItemFieldValues} wifv WHERE wifv.workflow_item_id = ${workflowItems.id} AND wifv.workspace_id = ${ctx.workspaceId} AND wifv.field_definition_id = ${refId} LIMIT 1)`;
  }
  return sql`(SELECT rfv.${sql.raw(column)} FROM ${recordFieldValues} rfv WHERE rfv.record_id = ${workflowItems.recordId} AND rfv.workspace_id = ${ctx.workspaceId} AND rfv.field_definition_id = ${refId} LIMIT 1)`;
}

function compileMultiSelectInner(alias: FieldAlias, condition: FilterCondition): SQL {
  const values = asStringList(condition.value);
  if (values.length === 0) return FALSE;
  const column = columnRef(alias, 'value_json');
  return sql`EXISTS (SELECT 1 FROM json_each(${column}) AS je WHERE je.value IN ${inList(values)})`;
}

/**
 * Compile a custom-field condition. `workflowItem` merges the overlay and the
 * Record base store (overlay value wins when present); `record` reads only the
 * base store; `file` reads file field values at both link levels.
 */
function compileField(condition: FilterCondition, ctx: CompileContext, source: FieldSource): SQL {
  const ref = findField(ctx, source, condition.key);
  if (!ref) {
    ctx.unresolved.add(condition.key);
    return FALSE;
  }

  const stores: FieldAlias[] =
    source === 'workflowItem' ? ['wifv', 'rfv'] : source === 'record' ? ['rfv'] : ['ffv'];

  const build = (alias: FieldAlias, inner: SQL): SQL => {
    if (alias === 'ffv') return fileFieldExists(ctx, ref.id, inner);
    return storeExists(alias, ctx, ref.id, inner);
  };

  if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty') {
    const positive = sql`(${sql.join(
      stores.map((alias) => build(alias, emptinessForColumn(alias, ref.type))),
      sql` OR `
    )})`;
    return condition.operator === 'is_empty' ? sql`NOT (${positive})` : positive;
  }

  const negative = isNegativeOperator(condition.operator);
  const operator = positiveOperator(condition.operator);

  if (ref.type === 'multi_select') {
    // A multi-value array cannot be merged column-wise, so membership is the
    // union of the overlay and base arrays.
    const matching = sql`(${sql.join(
      stores.map((alias) =>
        build(alias, compileMultiSelectInner(alias, { ...condition, operator }))
      ),
      sql` OR `
    )})`;
    return existsClause(matching, negative);
  }

  if (source === 'file') {
    const columnName = typedColumnName(ref.type, operator);
    const type: ValueType = columnName === 'search_text' ? 'text' : valueTypeForField(ref.type);
    const value =
      columnName === 'search_text'
        ? (asString(condition.value)?.toLowerCase() ?? condition.value)
        : condition.value;
    const matching = sql`(${sql.join(
      stores.map((alias) => {
        const inner = applyOperator(columnRef(alias, columnName), type, operator, value, ctx.now);
        return build(alias, inner);
      }),
      sql` OR `
    )})`;
    return existsClause(matching, negative);
  }

  // Scalar fields compare the *merged* value: the workflow overlay shadows the
  // Record base, which is the same rule the read model uses. An item with no
  // value at all still satisfies a negative operator (legacy behaviour).
  const columnName = typedColumnName(ref.type, operator);
  const type: ValueType = columnName === 'search_text' ? 'text' : valueTypeForField(ref.type);
  const value =
    columnName === 'search_text'
      ? (asString(condition.value)?.toLowerCase() ?? condition.value)
      : condition.value;
  const merged =
    source === 'workflowItem'
      ? sql`COALESCE(${storeValueSubquery('wifv', columnName, ref.id, ctx)}, ${storeValueSubquery('rfv', columnName, ref.id, ctx)})`
      : storeValueSubquery('rfv', columnName, ref.id, ctx);
  const hasValue = notEmptyPredicate(merged, type);
  const matched = sql`(${hasValue} AND ${applyOperator(merged, type, operator, value, ctx.now)})`;
  return negative ? sql`NOT (${matched})` : matched;
}

/* ------------------------------------------------------------------ *
 * File-kind filters: files linked to the item or its Record.
 * ------------------------------------------------------------------ */

interface FileAccess {
  expr: SQL;
  type: ValueType;
  extraJoin: SQL;
}

const NO_JOIN: SQL = sql``;

function fileProperty(key: string): FileAccess | null {
  switch (key) {
    case 'filename':
      return { expr: sql`f.original_filename`, type: 'text', extraJoin: NO_JOIN };
    case 'mimeType':
      return { expr: sql`f.mime_type`, type: 'text', extraJoin: NO_JOIN };
    case 'status':
      return { expr: sql`f.status`, type: 'enum', extraJoin: NO_JOIN };
    case 'size':
      return { expr: sql`f.size`, type: 'number', extraJoin: NO_JOIN };
    case 'summary':
      return { expr: sql`f.summary`, type: 'text', extraJoin: NO_JOIN };
    case 'createdAt':
      return { expr: sql`f.created_at`, type: 'date', extraJoin: NO_JOIN };
    case 'updatedAt':
      return { expr: sql`f.updated_at`, type: 'date', extraJoin: NO_JOIN };
    case 'workflowId':
      return { expr: sql`f.primary_workflow_id`, type: 'enum', extraJoin: NO_JOIN };
    case 'workflowItemId':
      return {
        expr: sql`(SELECT fwi.workflow_item_id FROM ${fileWorkflowItems} fwi WHERE fwi.file_id = f.id AND fwi.removed_at IS NULL LIMIT 1)`,
        type: 'enum',
        extraJoin: NO_JOIN
      };
    case 'recordId':
      return {
        expr: sql`(SELECT fr.record_id FROM ${fileRecords} fr WHERE fr.file_id = f.id AND fr.removed_at IS NULL LIMIT 1)`,
        type: 'enum',
        extraJoin: NO_JOIN
      };
    case 'pageCount':
      return {
        expr: sql`json_extract(f.metadata, '$.pageCount')`,
        type: 'number',
        extraJoin: NO_JOIN
      };
    case 'language':
      return {
        expr: sql`json_extract(f.metadata, '$.language')`,
        type: 'text',
        extraJoin: NO_JOIN
      };
    case 'sourceType':
      return {
        expr: sql`fs.source_type`,
        type: 'enum',
        extraJoin: sql`JOIN ${fileSources} fs ON fs.file_id = f.id AND fs.workspace_id = f.workspace_id`
      };
    case 'contentHash':
      return {
        expr: sql`bl.content_hash`,
        type: 'text',
        extraJoin: sql`JOIN ${blobs} bl ON bl.id = f.blob_id AND bl.workspace_id = f.workspace_id`
      };
    case 'contentText':
      return {
        expr: sql`fec.text`,
        type: 'text',
        extraJoin: sql`JOIN ${fileExtractedContent} fec ON fec.file_id = f.id AND fec.workspace_id = f.workspace_id`
      };
    case 'contextLabel':
      return {
        expr: sql`wf.context_label`,
        type: 'text',
        extraJoin: sql`JOIN ${workflowFiles} wf ON wf.file_id = f.id AND wf.workspace_id = f.workspace_id AND wf.workflow_id = f.primary_workflow_id`
      };
    default:
      return null;
  }
}

/**
 * UNION of the two attachment levels: a participation link or a Record link.
 */
function fileLinkUnion(extraJoin: SQL, inner: SQL, ctx: CompileContext, negative: boolean): SQL {
  const work = sql`EXISTS (SELECT 1 FROM ${fileWorkflowItems} fwi JOIN ${files} f ON f.id = fwi.file_id AND f.workspace_id = fwi.workspace_id ${extraJoin} WHERE fwi.workflow_item_id = ${workflowItems.id} AND fwi.workspace_id = ${ctx.workspaceId} AND fwi.removed_at IS NULL AND f.deleted_at IS NULL AND ${inner})`;
  const record = sql`EXISTS (SELECT 1 FROM ${fileRecords} fr JOIN ${files} f ON f.id = fr.file_id AND f.workspace_id = fr.workspace_id ${extraJoin} WHERE fr.record_id = ${workflowItems.recordId} AND fr.workspace_id = ${ctx.workspaceId} AND fr.removed_at IS NULL AND f.deleted_at IS NULL AND ${inner})`;
  return existsClause(sql`(${work} OR ${record})`, negative);
}

function compileFile(condition: FilterCondition, ctx: CompileContext): SQL {
  const any = sql`((SELECT 1 FROM ${files} f JOIN ${fileWorkflowItems} fwi ON fwi.file_id = f.id AND fwi.workspace_id = f.workspace_id WHERE fwi.workflow_item_id = ${workflowItems.id} AND fwi.workspace_id = ${ctx.workspaceId} AND fwi.removed_at IS NULL AND f.deleted_at IS NULL LIMIT 1) IS NOT NULL OR (SELECT 1 FROM ${files} f JOIN ${fileRecords} fr ON fr.file_id = f.id AND fr.workspace_id = f.workspace_id WHERE fr.record_id = ${workflowItems.recordId} AND fr.workspace_id = ${ctx.workspaceId} AND fr.removed_at IS NULL AND f.deleted_at IS NULL LIMIT 1) IS NOT NULL)`;
  if (condition.operator === 'is_empty') return sql`NOT (${any})`;
  if (condition.operator === 'is_not_empty') return any;

  const access = fileProperty(condition.key);
  if (!access) {
    ctx.unresolved.add(condition.key);
    return FALSE;
  }
  const negative = isNegativeOperator(condition.operator);
  const operator = positiveOperator(condition.operator);
  const inner = applyOperator(access.expr, access.type, operator, condition.value, ctx.now);
  return fileLinkUnion(access.extraJoin, inner, ctx, negative);
}

function compileRelated(
  condition: FilterCondition,
  ctx: CompileContext,
  kind: 'run' | 'approval'
): SQL {
  if (kind === 'run') {
    const any = sql`EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${agentRuns.workflowItemId} = ${workflowItems.id} AND ${agentRuns.workspaceId} = ${ctx.workspaceId})`;
    if (condition.operator === 'is_empty') return sql`NOT (${any})`;
    if (condition.operator === 'is_not_empty') return any;
    const values = valuesOf(condition);
    if (values.length === 0) return condition.operator === 'not_in' ? TRUE : FALSE;
    const negative = condition.operator === 'not_in' || condition.operator === 'neq';
    const query = sql`EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${agentRuns.workflowItemId} = ${workflowItems.id} AND ${agentRuns.workspaceId} = ${ctx.workspaceId} AND ${agentRuns.status} IN ${inList(values)})`;
    return existsClause(query, negative);
  }
  const any = sql`EXISTS (SELECT 1 FROM ${approvalRequests} WHERE ${approvalRequests.workflowItemId} = ${workflowItems.id} AND ${approvalRequests.workspaceId} = ${ctx.workspaceId})`;
  if (condition.operator === 'is_empty') return sql`NOT (${any})`;
  if (condition.operator === 'is_not_empty') return any;
  const values = valuesOf(condition);
  if (values.length === 0) return condition.operator === 'not_in' ? TRUE : FALSE;
  const negative = condition.operator === 'not_in' || condition.operator === 'neq';
  const query = sql`EXISTS (SELECT 1 FROM ${approvalRequests} WHERE ${approvalRequests.workflowItemId} = ${workflowItems.id} AND ${approvalRequests.workspaceId} = ${ctx.workspaceId} AND ${approvalRequests.status} IN ${inList(values)})`;
  return existsClause(query, negative);
}

function compileCondition(condition: FilterCondition, ctx: CompileContext): SQL {
  switch (condition.kind) {
    case 'system':
      return compileSystem(condition, ctx);
    case 'field':
      return compileField(condition, ctx, 'workflowItem');
    case 'record_field':
      return compileField(condition, ctx, 'record');
    case 'file_field':
      return compileField(condition, ctx, 'file');
    case 'label':
      return compileLabel(condition, ctx);
    case 'owner':
      return compileOwnership(condition, 'owner');
    case 'team':
      return compileOwnership(condition, 'team');
    case 'workflow':
      return compileMembership(condition, sql`${workflowItems.workflowId}`);
    case 'state':
      return compileMembership(condition, sql`${workflowItems.stateId}`);
    case 'run':
      return compileRelated(condition, ctx, 'run');
    case 'approval':
      return compileRelated(condition, ctx, 'approval');
    case 'file':
      return compileFile(condition, ctx);
    default:
      // `relationship`/`collection` have no filter representation in this milestone.
      ctx.unresolved.add(condition.key);
      return FALSE;
  }
}

/**
 * Is this a row the user is still filling in?
 *
 * The filter builder keeps an incomplete row visible while it is being edited, and a
 * hand-edited link can contain one too. Such a row has no field chosen yet, so it must
 * be dropped from the query rather than compiled to `0 = 1` — otherwise opening a
 * half-written filter silently shows an empty list, which reads as data loss.
 */
function isIncomplete(condition: FilterCondition): boolean {
  return typeof condition.key !== 'string' || condition.key.trim().length === 0;
}

function compileNode(node: FilterNode, ctx: CompileContext): SQL {
  if (isGroup(node)) {
    const children = node.children.filter((child) => isGroup(child) || !isIncomplete(child));
    if (children.length === 0) return node.op === 'and' ? TRUE : FALSE;
    const parts = children.map((child) => compileNode(child, ctx));
    const joiner = node.op === 'and' ? sql` AND ` : sql` OR `;
    return sql`(${sql.join(parts, joiner)})`;
  }
  return compileCondition(node, ctx);
}

function collectLabelIdentifiers(node: FilterNode | null, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if (isGroup(node)) {
    for (const child of node.children) collectLabelIdentifiers(child, out);
    return out;
  }
  if (isCondition(node) && node.kind === 'label') {
    for (const value of valuesOf(node)) out.add(value);
  }
  return out;
}

async function createContext(
  db: Executor,
  options: CompileWorkflowItemFilterOptions
): Promise<CompileContext> {
  const ctx: CompileContext = {
    workspaceId: options.workspaceId,
    now: options.now ?? Date.now(),
    fields: new Map(),
    labels: new Map(),
    unresolved: new Set()
  };

  const fieldKeys = options.filter ? [...collectFieldKeys(options.filter)] : [];
  if (fieldKeys.length > 0) {
    const rows = await db
      .select({
        id: fieldDefinitions.id,
        key: fieldDefinitions.key,
        type: fieldDefinitions.type,
        scope: fieldDefinitions.scope
      })
      .from(fieldDefinitions)
      .where(
        sql`${fieldDefinitions.workspaceId} = ${options.workspaceId} AND (${fieldDefinitions.key} IN ${inList(fieldKeys)} OR ${fieldDefinitions.id} IN ${inList(fieldKeys)})`
      )
      .all();
    for (const row of rows) {
      // Non-file definitions are Record fields. They are registered under both
      // `record` (base store) and `workflowItem` (merged overlay/base view) so a
      // `field` condition sees the work overlay while `record_field` sees base.
      if (row.scope === 'file') {
        const ref: FieldRef = { id: row.id, key: row.key, type: row.type, scope: 'file' };
        if (!ctx.fields.has(`file:${ref.key}`)) ctx.fields.set(`file:${ref.key}`, ref);
        ctx.fields.set(`file:${ref.id}`, ref);
        continue;
      }
      const ref: FieldRef = { id: row.id, key: row.key, type: row.type, scope: 'record' };
      for (const source of ['record', 'workflowItem'] as const) {
        if (!ctx.fields.has(`${source}:${ref.key}`)) ctx.fields.set(`${source}:${ref.key}`, ref);
        ctx.fields.set(`${source}:${ref.id}`, ref);
      }
    }
  }

  const labelIdentifiers = options.filter ? [...collectLabelIdentifiers(options.filter)] : [];
  if (labelIdentifiers.length > 0) {
    const rows = await db
      .select({ id: labels.id, name: labels.name })
      .from(labels)
      .where(
        sql`${labels.workspaceId} = ${options.workspaceId} AND (${labels.id} IN ${inList(labelIdentifiers)} OR ${labels.name} IN ${inList(labelIdentifiers)})`
      )
      .all();
    for (const row of rows) {
      ctx.labels.set(row.id, row.id);
      ctx.labels.set(row.name, row.id);
    }
  }

  return ctx;
}

export interface CompileWorkflowItemFilterOptions {
  workspaceId: string;
  filter: FilterAst | null;
  /** Injectable clock for `timeInStateSeconds` and relative date operators. */
  now?: number;
}

export interface CompiledWorkflowItemFilter {
  sql: SQL;
  /**
   * Keys that could not be resolved (unknown field keys, unknown system keys,
   * unknown label names). Their conditions match nothing; callers surface this
   * so the UI can explain why a list is empty.
   */
  unresolved: string[];
}

/**
 * Compile a filter and report unresolvable keys. Use this at boundaries that can
 * show a warning; use `compileWorkflowItemFilter` when only the condition is needed.
 */
export async function compileWorkflowItemFilterDetailed(
  db: Executor,
  options: CompileWorkflowItemFilterOptions
): Promise<CompiledWorkflowItemFilter> {
  const ctx = await createContext(db, options);
  const condition = options.filter ? compileNode(options.filter, ctx) : TRUE;
  return { sql: condition, unresolved: [...ctx.unresolved].sort() };
}

/** Compile a workflow-item filter into a Drizzle condition usable in `.where(...)`. */
export async function compileWorkflowItemFilter(
  db: Executor,
  options: CompileWorkflowItemFilterOptions
): Promise<SQL> {
  const compiled = await compileWorkflowItemFilterDetailed(db, options);
  return compiled.sql;
}

/* ------------------------------------------------------------------ *
 * Injectable seam.
 *
 * The board/list surface depends on the filter language but must not import
 * analytics directly, so it resolves the active compiler through this registry.
 * Bootstrap installs the canonical implementation; tests may swap it.
 * ------------------------------------------------------------------ */

export interface WorkflowItemFilterCompiler {
  /**
   * Compile a filter AST into a Drizzle condition. May be asynchronous: the
   * canonical implementation resolves field definitions before building conditions.
   */
  compile(
    db: Executor,
    options: { workspaceId: string; filter: FilterAst | null }
  ): CompiledWorkflowItemFilter | Promise<CompiledWorkflowItemFilter>;
}

/** The default compiler; replaceable through {@link setWorkflowItemFilterCompiler}. */
export const defaultWorkflowItemFilterCompiler: WorkflowItemFilterCompiler = {
  compile(db, options) {
    return compileWorkflowItemFilterDetailed(db, options);
  }
};

let activeCompiler: WorkflowItemFilterCompiler = defaultWorkflowItemFilterCompiler;

export function setWorkflowItemFilterCompiler(compiler: WorkflowItemFilterCompiler | null): void {
  activeCompiler = compiler ?? defaultWorkflowItemFilterCompiler;
}

export function getWorkflowItemFilterCompiler(): WorkflowItemFilterCompiler {
  return activeCompiler;
}

/* ------------------------------------------------------------------ *
 * Listing: validated sorting and keyset pagination.
 * ------------------------------------------------------------------ */

interface ResolvedSort {
  field: string;
  expr: SQL;
  type: ValueType;
  direction: 'asc' | 'desc';
}

interface ResolvedSortPlan {
  sorts: ResolvedSort[];
  tailDirection: 'asc' | 'desc';
}

function sortCoalesce(expr: SQL, type: ValueType): SQL {
  return type === 'text' || type === 'enum'
    ? sql`COALESCE(${expr}, '')`
    : sql`COALESCE(${expr}, 0)`;
}

/** Merged overlay/base scalar read for one field definition (overlay wins). */
function fieldValueSubquery(
  alias: 'wifv' | 'rfv',
  column: string,
  workspaceId: string,
  fieldId: string
): SQL {
  if (alias === 'wifv') {
    return sql`(SELECT wifv.${sql.raw(column)} FROM ${workflowItemFieldValues} wifv WHERE wifv.workflow_item_id = ${workflowItems.id} AND wifv.workspace_id = ${workspaceId} AND wifv.field_definition_id = ${fieldId} LIMIT 1)`;
  }
  return sql`(SELECT rfv.${sql.raw(column)} FROM ${recordFieldValues} rfv WHERE rfv.record_id = ${workflowItems.recordId} AND rfv.workspace_id = ${workspaceId} AND rfv.field_definition_id = ${fieldId} LIMIT 1)`;
}

async function resolveSortPlan(
  db: Executor,
  workspaceId: string,
  sort: SavedViewSort[] | null | undefined,
  now: number
): Promise<ResolvedSortPlan> {
  const requested: SavedViewSort[] =
    sort && sort.length > 0
      ? sort
      : [{ field: WorkflowItemSystemFields.updatedAt, direction: 'desc' }];

  // `updatedAt` is always the pagination identity, so a caller-supplied
  // `updatedAt` sort only chooses the tail direction; it is not duplicated.
  let tailDirection: 'asc' | 'desc' = 'desc';
  const remaining: SavedViewSort[] = [];
  for (const entry of requested) {
    if (entry.field === WorkflowItemSystemFields.updatedAt) {
      tailDirection = entry.direction === 'asc' ? 'asc' : 'desc';
      continue;
    }
    remaining.push(entry);
  }

  const customKeys = remaining
    .filter((entry) => !(entry.field in WorkflowItemSystemFields))
    .map((entry) => entry.field);
  const fieldRows =
    customKeys.length > 0
      ? await db
          .select({
            id: fieldDefinitions.id,
            key: fieldDefinitions.key,
            type: fieldDefinitions.type
          })
          .from(fieldDefinitions)
          .where(
            sql`${fieldDefinitions.workspaceId} = ${workspaceId} AND ${fieldDefinitions.scope} <> 'file' AND (${fieldDefinitions.key} IN ${inList(customKeys)} OR ${fieldDefinitions.id} IN ${inList(customKeys)})`
          )
          .all()
      : [];
  const byKey = new Map<string, { id: string; key: string; type: FieldType }>();
  for (const row of fieldRows) {
    byKey.set(row.key, row);
    byKey.set(row.id, row);
  }

  const sorts: ResolvedSort[] = [];
  for (const entry of remaining) {
    if (entry.field in WorkflowItemSystemFields) {
      const field = systemFieldExpression(entry.field, workspaceId, now);
      if (!field) {
        throw errors.validation(`Unknown sort field: ${entry.field}`, { field: entry.field });
      }
      sorts.push({
        field: entry.field,
        expr: sortCoalesce(field.expr, field.type),
        type: field.type,
        direction: entry.direction
      });
      continue;
    }
    const definition = byKey.get(entry.field);
    if (!definition) {
      throw errors.validation(`Unknown sort field: ${entry.field}`, { field: entry.field });
    }
    const type = valueTypeForField(definition.type);
    const column = typedColumnName(definition.type, 'eq');
    const expr = sql`COALESCE(${fieldValueSubquery('wifv', column, workspaceId, definition.id)}, ${fieldValueSubquery('rfv', column, workspaceId, definition.id)})`;
    sorts.push({
      field: entry.field,
      expr: sortCoalesce(expr, type),
      type,
      direction: entry.direction
    });
  }

  return { sorts, tailDirection };
}

export interface WorkflowItemCursor {
  /** Sort-key values for the custom part of the ordering tuple. */
  keys: Array<string | number | null>;
  updatedAt: number;
  id: string;
}

export function encodeWorkflowItemCursor(cursor: WorkflowItemCursor): string {
  return Buffer.from(
    JSON.stringify({ k: cursor.keys, u: cursor.updatedAt, i: cursor.id })
  ).toString('base64url');
}

export function decodeWorkflowItemCursor(value: string): WorkflowItemCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (cause) {
    throw errors.validation('Invalid pagination cursor', { cursor: value, cause: String(cause) });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw errors.validation('Invalid pagination cursor', { cursor: value });
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.u !== 'number' || typeof record.i !== 'string') {
    throw errors.validation('Invalid pagination cursor', { cursor: value });
  }
  const keys = Array.isArray(record.k)
    ? record.k.filter(
        (entry): entry is string | number | null =>
          entry === null || typeof entry === 'string' || typeof entry === 'number'
      )
    : [];
  return { keys, updatedAt: record.u, id: record.i };
}

/**
 * Lexicographic keyset predicate over `[...sorts, updatedAt, id]`, honouring a
 * per-field direction. The default ordering is exactly `(updatedAt, id)`, which
 * is what the index on `workflow_items(workspace_id, updated_at)` wants.
 */
function keysetPredicate(plan: ResolvedSortPlan, cursor: WorkflowItemCursor): SQL {
  const alternatives: SQL[] = [];
  const prefix: SQL[] = [];
  for (let index = 0; index < plan.sorts.length; index++) {
    const sort = plan.sorts[index] as ResolvedSort;
    const value = cursor.keys[index] ?? null;
    const comparison =
      sort.direction === 'asc' ? sql`${sort.expr} > ${value}` : sql`${sort.expr} < ${value}`;
    alternatives.push(sql`(${sql.join([...prefix, comparison], sql` AND `)})`);
    prefix.push(sql`${sort.expr} = ${value}`);
  }
  const idComparison =
    plan.tailDirection === 'asc'
      ? sql`${workflowItems.id} > ${cursor.id}`
      : sql`${workflowItems.id} < ${cursor.id}`;
  const updatedComparison =
    plan.tailDirection === 'asc'
      ? sql`${workflowItems.updatedAt} > ${cursor.updatedAt}`
      : sql`${workflowItems.updatedAt} < ${cursor.updatedAt}`;
  const tail = sql`(${updatedComparison} OR (${workflowItems.updatedAt} = ${cursor.updatedAt} AND ${idComparison}))`;
  alternatives.push(sql`(${sql.join([...prefix, tail], sql` AND `)})`);
  return sql`(${sql.join(alternatives, sql` OR `)})`;
}

export interface FilterWorkflowItemsOptions {
  workspaceId: string;
  filter: FilterAst | null;
  sort?: SavedViewSort[] | null;
  limit?: number;
  cursor?: string | null;
  now?: number;
}

export interface WorkflowItemListPage {
  rows: WorkflowItem[];
  /** `null` when the last page was reached. */
  nextCursor: string | null;
  unresolved: string[];
}

/**
 * List workflow items for a workspace with the shared filter language, validated
 * sorting and keyset pagination by `(updatedAt, id)` (with custom sort keys
 * folded into the cursor so a non-default sort is still exact).
 */
export async function filterWorkflowItems(
  db: Executor,
  options: FilterWorkflowItemsOptions
): Promise<WorkflowItemListPage> {
  const now = options.now ?? Date.now();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const compiled = await compileWorkflowItemFilterDetailed(db, {
    workspaceId: options.workspaceId,
    filter: options.filter,
    now
  });
  const plan = await resolveSortPlan(db, options.workspaceId, options.sort, now);

  const conditions: SQL[] = [
    sql`${workflowItems.workspaceId} = ${options.workspaceId}`,
    compiled.sql
  ];
  if (options.cursor) {
    conditions.push(keysetPredicate(plan, decodeWorkflowItemCursor(options.cursor)));
  }
  const where = sql.join(conditions, sql` AND `);

  const orderParts: SQL[] = plan.sorts.map((sort) =>
    sort.direction === 'asc' ? sql`${sort.expr} ASC` : sql`${sort.expr} DESC`
  );
  orderParts.push(
    plan.tailDirection === 'asc'
      ? sql`${workflowItems.updatedAt} ASC`
      : sql`${workflowItems.updatedAt} DESC`
  );
  orderParts.push(
    plan.tailDirection === 'asc' ? sql`${workflowItems.id} ASC` : sql`${workflowItems.id} DESC`
  );

  const keysExpression =
    plan.sorts.length === 0
      ? sql<string>`json_array()`
      : sql<string>`json_array(${sql.join(
          plan.sorts.map((sort) => sort.expr),
          sql`, `
        )})`;

  // The Record join is required because the compiled filter may reference
  // record-level columns or base field values.
  const selected = await db
    .select({ ...getTableColumns(workflowItems), sortKeys: keysExpression })
    .from(workflowItems)
    .innerJoin(records, eq(records.id, workflowItems.recordId))
    .where(where)
    .orderBy(...orderParts)
    // One extra row detects "there is another page" without a second query.
    .limit(limit + 1)
    .all();

  const hasMore = selected.length > limit;
  const page = hasMore ? selected.slice(0, limit) : selected;
  const rows: WorkflowItem[] = [];
  let nextCursor: string | null = null;
  for (const selectedRow of page) {
    const { sortKeys, ...item } = selectedRow;
    rows.push(item as WorkflowItem);
    const keys = normalizeSortKeys(sortKeys);
    nextCursor = encodeWorkflowItemCursor({ keys, updatedAt: item.updatedAt, id: item.id });
  }
  if (!hasMore) nextCursor = null;

  return { rows, nextCursor, unresolved: compiled.unresolved };
}

function normalizeSortKeys(value: unknown): Array<string | number | null> {
  const parsed = Array.isArray(value) ? value : typeof value === 'string' ? safeParse(value) : [];
  return parsed.map((entry) =>
    entry === null || typeof entry === 'string' || typeof entry === 'number' ? entry : String(entry)
  );
}

function safeParse(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
