/**
 * Ticket filter compiler.
 *
 * This is the single place where the serializable filter AST becomes SQL. Ticket
 * lists, saved views and dashboard widgets all call it, so a saved view and a
 * widget can never disagree about what a filter means (ADR-0012). The module
 * deliberately owns *all* dialect knowledge for filtering — including the few
 * JSON and correlated-subquery expressions — behind portable Drizzle `SQL`
 * chunks.
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
 * ticket's `provenance` JSON; the SQLite form is
 * `json_extract(provenance, '$.sourceType')` and the PostgreSQL equivalent is
 * `provenance ->> 'sourceType'`.
 *
 * ## Text matching
 *
 * `contains` / `starts_with` / `ends_with` are case-insensitive (`lower(...)`
 * plus a lowercased pattern); `eq` / `neq` are exact. Custom-field pattern
 * matching reads the lowercase `search_text` projection, which is indexed.
 * `LIKE` metacharacters in a user value are escaped and the pattern uses an
 * explicit `ESCAPE '\'`, so a search for `%` matches a literal percent sign.
 */
import { getTableColumns, type SQL, sql } from 'drizzle-orm';
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
  fileSources,
  files,
  labels,
  type SavedViewSort,
  type Ticket,
  ticketFieldValues,
  ticketFiles,
  ticketLabels,
  tickets,
  workflowFiles,
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
  TicketSystemFields
} from './ast';

/** A condition that matches nothing. */
const FALSE: SQL = sql`0 = 1`;
/** A condition that matches everything. */
const TRUE: SQL = sql`1 = 1`;

type ValueType = 'text' | 'number' | 'date' | 'bool' | 'enum';

interface FieldRef {
  id: string;
  key: string;
  type: FieldType;
  scope: 'ticket' | 'file';
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

function systemFieldExpression(
  key: string,
  workspaceId: string,
  now: number
): { expr: SQL; type: ValueType } | null {
  switch (key) {
    case TicketSystemFields.key:
      return { expr: sql`${tickets.key}`, type: 'text' };
    case TicketSystemFields.number:
      return { expr: sql`${tickets.number}`, type: 'number' };
    case TicketSystemFields.title:
      return { expr: sql`${tickets.title}`, type: 'text' };
    case TicketSystemFields.description:
      return { expr: sql`${tickets.description}`, type: 'text' };
    case TicketSystemFields.priority:
      return { expr: sql`${tickets.priority}`, type: 'enum' };
    case TicketSystemFields.stateId:
      return { expr: sql`${tickets.stateId}`, type: 'enum' };
    case TicketSystemFields.workflowId:
      return { expr: sql`${tickets.workflowId}`, type: 'enum' };
    case TicketSystemFields.ownerUserId:
      return { expr: sql`${tickets.ownerUserId}`, type: 'enum' };
    case TicketSystemFields.ownerTeamId:
      return { expr: sql`${tickets.ownerTeamId}`, type: 'enum' };
    case TicketSystemFields.createdAt:
      return { expr: sql`${tickets.createdAt}`, type: 'date' };
    case TicketSystemFields.updatedAt:
      return { expr: sql`${tickets.updatedAt}`, type: 'date' };
    case TicketSystemFields.enteredStateAt:
      return { expr: sql`${tickets.enteredStateAt}`, type: 'date' };
    case TicketSystemFields.lastActivityAt:
      return { expr: sql`${tickets.lastActivityAt}`, type: 'date' };
    case TicketSystemFields.dueAt:
      return { expr: sql`${tickets.dueAt}`, type: 'date' };
    case TicketSystemFields.closedAt:
      return { expr: sql`${tickets.closedAt}`, type: 'date' };
    case TicketSystemFields.waitingOn:
      return { expr: sql`${tickets.waitingOn}`, type: 'enum' };
    case TicketSystemFields.originTicketId:
      return { expr: sql`${tickets.originTicketId}`, type: 'enum' };
    case TicketSystemFields.stateRunCount:
      return { expr: sql`${tickets.stateRunCount}`, type: 'number' };
    case TicketSystemFields.stateName:
      return {
        expr: sql`(SELECT ${workflowStates.name} FROM ${workflowStates} WHERE ${workflowStates.id} = ${tickets.stateId} AND ${workflowStates.workspaceId} = ${workspaceId})`,
        type: 'text'
      };
    case TicketSystemFields.stateKind:
      return {
        expr: sql`(SELECT ${workflowStates.kind} FROM ${workflowStates} WHERE ${workflowStates.id} = ${tickets.stateId} AND ${workflowStates.workspaceId} = ${workspaceId})`,
        type: 'enum'
      };
    case TicketSystemFields.stateCategory:
      return {
        expr: sql`(SELECT ${workflowStates.category} FROM ${workflowStates} WHERE ${workflowStates.id} = ${tickets.stateId} AND ${workflowStates.workspaceId} = ${workspaceId})`,
        type: 'enum'
      };
    case TicketSystemFields.isUnassigned:
      return {
        expr: sql`(CASE WHEN ${tickets.ownerUserId} IS NULL AND ${tickets.ownerTeamId} IS NULL THEN 1 ELSE 0 END)`,
        type: 'bool'
      };
    case TicketSystemFields.timeInStateSeconds:
      return {
        expr: sql`CAST((${now} - ${tickets.enteredStateAt}) / 1000 AS INTEGER)`,
        type: 'number'
      };
    case TicketSystemFields.runStatus:
      return {
        expr: sql`(SELECT ${agentRuns.status} FROM ${agentRuns} WHERE ${agentRuns.ticketId} = ${tickets.id} AND ${agentRuns.workspaceId} = ${workspaceId} ORDER BY ${agentRuns.createdAt} DESC, ${agentRuns.id} DESC LIMIT 1)`,
        type: 'enum'
      };
    case TicketSystemFields.approvalStatus:
      return {
        expr: sql`(SELECT ${approvalRequests.status} FROM ${approvalRequests} WHERE ${approvalRequests.ticketId} = ${tickets.id} AND ${approvalRequests.workspaceId} = ${workspaceId} ORDER BY ${approvalRequests.createdAt} DESC, ${approvalRequests.id} DESC LIMIT 1)`,
        type: 'enum'
      };
    case TicketSystemFields.sourceType:
      return { expr: sql`json_extract(${tickets.provenance}, '$.sourceType')`, type: 'enum' };
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

/** Typed column name inside a `ticket_field_values`/`file_field_values` alias. */
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

function columnRef(alias: 'tfv' | 'ffv', column: string): SQL {
  // The alias and column are chosen from fixed sets in this module, never from
  // user input, so `raw` here cannot become an injection vector.
  return sql.raw(`${alias}.${column}`);
}

function emptinessForColumn(alias: 'tfv' | 'ffv', type: FieldType): SQL {
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

function findField(
  ctx: CompileContext,
  scope: 'ticket' | 'file',
  key: string
): FieldRef | undefined {
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
  const expr = kind === 'owner' ? sql`${tickets.ownerUserId}` : sql`${tickets.ownerTeamId}`;
  return compileMembership(condition, expr);
}

function compileLabel(condition: FilterCondition, ctx: CompileContext): SQL {
  const labelExists = (inner: SQL): SQL =>
    sql`EXISTS (SELECT 1 FROM ${ticketLabels} WHERE ${ticketLabels.ticketId} = ${tickets.id} AND ${ticketLabels.workspaceId} = ${ctx.workspaceId} AND ${inner})`;
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
  const matching = labelExists(sql`${ticketLabels.labelId} IN ${inList(ids)}`);
  const negative = condition.operator === 'not_in' || condition.operator === 'neq';
  return existsClause(matching, negative);
}

function compileMultiSelect(
  alias: 'tfv' | 'ffv',
  condition: FilterCondition,
  negative: boolean
): SQL {
  const values = asStringList(condition.value);
  if (values.length === 0) return negative ? TRUE : FALSE;
  const column = columnRef(alias, 'value_json');
  const matching = sql`EXISTS (SELECT 1 FROM json_each(${column}) AS je WHERE je.value IN ${inList(values)})`;
  return negative ? sql`NOT (${matching})` : matching;
}

function compileField(
  condition: FilterCondition,
  ctx: CompileContext,
  scope: 'ticket' | 'file'
): SQL {
  const ref = findField(ctx, scope, condition.key);
  if (!ref) {
    ctx.unresolved.add(condition.key);
    return FALSE;
  }
  const alias = scope === 'ticket' ? 'tfv' : 'ffv';

  const wrap = (inner: SQL, negative: boolean): SQL => {
    if (scope === 'ticket') {
      const query = sql`EXISTS (SELECT 1 FROM ${ticketFieldValues} tfv WHERE tfv.ticket_id = ${tickets.id} AND tfv.workspace_id = ${ctx.workspaceId} AND tfv.field_definition_id = ${ref.id} AND ${inner})`;
      return existsClause(query, negative);
    }
    const query = sql`EXISTS (SELECT 1 FROM ${ticketFiles} tfl JOIN ${files} f ON f.id = tfl.file_id AND f.workspace_id = tfl.workspace_id JOIN ${fileFieldValues} ffv ON ffv.file_id = f.id AND ffv.workspace_id = f.workspace_id WHERE tfl.ticket_id = ${tickets.id} AND tfl.workspace_id = ${ctx.workspaceId} AND tfl.removed_at IS NULL AND f.deleted_at IS NULL AND ffv.field_definition_id = ${ref.id} AND ${inner})`;
    return existsClause(query, negative);
  };

  if (condition.operator === 'is_empty' || condition.operator === 'is_not_empty') {
    const positive = wrap(emptinessForColumn(alias, ref.type), false);
    return condition.operator === 'is_empty' ? sql`NOT (${positive})` : positive;
  }

  const negative = isNegativeOperator(condition.operator);
  const operator = positiveOperator(condition.operator);

  if (ref.type === 'multi_select') {
    return wrap(compileMultiSelect(alias, { ...condition, operator }, false), negative);
  }

  const columnName = typedColumnName(ref.type, operator);
  const column = columnRef(alias, columnName);
  const type: ValueType = columnName === 'search_text' ? 'text' : valueTypeForField(ref.type);
  const value =
    columnName === 'search_text'
      ? (asString(condition.value)?.toLowerCase() ?? condition.value)
      : condition.value;
  const inner = applyOperator(column, type, operator, value, ctx.now);
  return wrap(inner, negative);
}

/* ------------------------------------------------------------------ *
 * File-kind filters: files linked to the ticket through `ticket_files`.
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
    case 'ticketId':
      return { expr: sql`tfl.ticket_id`, type: 'enum', extraJoin: NO_JOIN };
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

function compileFile(condition: FilterCondition, ctx: CompileContext): SQL {
  const filesExist = sql`EXISTS (SELECT 1 FROM ${ticketFiles} tfl JOIN ${files} f ON f.id = tfl.file_id AND f.workspace_id = tfl.workspace_id WHERE tfl.ticket_id = ${tickets.id} AND tfl.workspace_id = ${ctx.workspaceId} AND tfl.removed_at IS NULL AND f.deleted_at IS NULL)`;
  if (condition.operator === 'is_empty') return sql`NOT (${filesExist})`;
  if (condition.operator === 'is_not_empty') return filesExist;

  const access = fileProperty(condition.key);
  if (!access) {
    ctx.unresolved.add(condition.key);
    return FALSE;
  }
  const negative = isNegativeOperator(condition.operator);
  const operator = positiveOperator(condition.operator);
  const inner = applyOperator(access.expr, access.type, operator, condition.value, ctx.now);
  const query = sql`EXISTS (SELECT 1 FROM ${ticketFiles} tfl JOIN ${files} f ON f.id = tfl.file_id AND f.workspace_id = tfl.workspace_id ${access.extraJoin} WHERE tfl.ticket_id = ${tickets.id} AND tfl.workspace_id = ${ctx.workspaceId} AND tfl.removed_at IS NULL AND f.deleted_at IS NULL AND ${inner})`;
  return existsClause(query, negative);
}

function compileRelated(
  condition: FilterCondition,
  ctx: CompileContext,
  kind: 'run' | 'approval'
): SQL {
  if (kind === 'run') {
    const any = sql`EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${agentRuns.ticketId} = ${tickets.id} AND ${agentRuns.workspaceId} = ${ctx.workspaceId})`;
    if (condition.operator === 'is_empty') return sql`NOT (${any})`;
    if (condition.operator === 'is_not_empty') return any;
    const values = valuesOf(condition);
    if (values.length === 0) return condition.operator === 'not_in' ? TRUE : FALSE;
    const negative = condition.operator === 'not_in' || condition.operator === 'neq';
    const query = sql`EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${agentRuns.ticketId} = ${tickets.id} AND ${agentRuns.workspaceId} = ${ctx.workspaceId} AND ${agentRuns.status} IN ${inList(values)})`;
    return existsClause(query, negative);
  }
  const any = sql`EXISTS (SELECT 1 FROM ${approvalRequests} WHERE ${approvalRequests.ticketId} = ${tickets.id} AND ${approvalRequests.workspaceId} = ${ctx.workspaceId})`;
  if (condition.operator === 'is_empty') return sql`NOT (${any})`;
  if (condition.operator === 'is_not_empty') return any;
  const values = valuesOf(condition);
  if (values.length === 0) return condition.operator === 'not_in' ? TRUE : FALSE;
  const negative = condition.operator === 'not_in' || condition.operator === 'neq';
  const query = sql`EXISTS (SELECT 1 FROM ${approvalRequests} WHERE ${approvalRequests.ticketId} = ${tickets.id} AND ${approvalRequests.workspaceId} = ${ctx.workspaceId} AND ${approvalRequests.status} IN ${inList(values)})`;
  return existsClause(query, negative);
}

function compileCondition(condition: FilterCondition, ctx: CompileContext): SQL {
  switch (condition.kind) {
    case 'system':
      return compileSystem(condition, ctx);
    case 'field':
      return compileField(condition, ctx, 'ticket');
    case 'file_field':
      return compileField(condition, ctx, 'file');
    case 'label':
      return compileLabel(condition, ctx);
    case 'owner':
      return compileOwnership(condition, 'owner');
    case 'team':
      return compileOwnership(condition, 'team');
    case 'workflow':
      return compileMembership(condition, sql`${tickets.workflowId}`);
    case 'state':
      return compileMembership(condition, sql`${tickets.stateId}`);
    case 'run':
      return compileRelated(condition, ctx, 'run');
    case 'approval':
      return compileRelated(condition, ctx, 'approval');
    case 'file':
      return compileFile(condition, ctx);
    default:
      // `collection` has no ticket-side representation in this milestone.
      ctx.unresolved.add(condition.key);
      return FALSE;
  }
}

function compileNode(node: FilterNode, ctx: CompileContext): SQL {
  if (isGroup(node)) {
    if (node.children.length === 0) return node.op === 'and' ? TRUE : FALSE;
    const parts = node.children.map((child) => compileNode(child, ctx));
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
  options: CompileTicketFilterOptions
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
      const ref: FieldRef = { id: row.id, key: row.key, type: row.type, scope: row.scope };
      // Key wins over id when a definition happens to be addressed by both.
      if (!ctx.fields.has(`${ref.scope}:${ref.key}`))
        ctx.fields.set(`${ref.scope}:${ref.key}`, ref);
      ctx.fields.set(`${ref.scope}:${ref.id}`, ref);
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

export interface CompileTicketFilterOptions {
  workspaceId: string;
  filter: FilterAst | null;
  /** Injectable clock for `timeInStateSeconds` and relative date operators. */
  now?: number;
}

export interface CompiledTicketFilter {
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
 * show a warning; use `compileTicketFilter` when only the condition is needed.
 */
export async function compileTicketFilterDetailed(
  db: Executor,
  options: CompileTicketFilterOptions
): Promise<CompiledTicketFilter> {
  const ctx = await createContext(db, options);
  const condition = options.filter ? compileNode(options.filter, ctx) : TRUE;
  return { sql: condition, unresolved: [...ctx.unresolved].sort() };
}

/** Compile a ticket filter into a Drizzle condition usable in `.where(...)`. */
export async function compileTicketFilter(
  db: Executor,
  options: CompileTicketFilterOptions
): Promise<SQL> {
  const compiled = await compileTicketFilterDetailed(db, options);
  return compiled.sql;
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

async function resolveSortPlan(
  db: Executor,
  workspaceId: string,
  sort: SavedViewSort[] | null | undefined,
  now: number
): Promise<ResolvedSortPlan> {
  const requested: SavedViewSort[] =
    sort && sort.length > 0 ? sort : [{ field: TicketSystemFields.updatedAt, direction: 'desc' }];

  // `updatedAt` is always the pagination identity, so a caller-supplied
  // `updatedAt` sort only chooses the tail direction; it is not duplicated.
  let tailDirection: 'asc' | 'desc' = 'desc';
  const remaining: SavedViewSort[] = [];
  for (const entry of requested) {
    if (entry.field === TicketSystemFields.updatedAt) {
      tailDirection = entry.direction === 'asc' ? 'asc' : 'desc';
      continue;
    }
    remaining.push(entry);
  }

  const customKeys = remaining
    .filter((entry) => !(entry.field in TicketSystemFields))
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
            sql`${fieldDefinitions.workspaceId} = ${workspaceId} AND ${fieldDefinitions.scope} = 'ticket' AND (${fieldDefinitions.key} IN ${inList(customKeys)} OR ${fieldDefinitions.id} IN ${inList(customKeys)})`
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
    if (entry.field in TicketSystemFields) {
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
    const column = columnRef('tfv', typedColumnName(definition.type, 'eq'));
    const expr = sql`(SELECT ${column} FROM ${ticketFieldValues} tfv WHERE tfv.ticket_id = ${tickets.id} AND tfv.workspace_id = ${workspaceId} AND tfv.field_definition_id = ${definition.id} LIMIT 1)`;
    sorts.push({
      field: entry.field,
      expr: sortCoalesce(expr, type),
      type,
      direction: entry.direction
    });
  }

  return { sorts, tailDirection };
}

export interface TicketCursor {
  /** Sort-key values for the custom part of the ordering tuple. */
  keys: Array<string | number | null>;
  updatedAt: number;
  id: string;
}

export function encodeTicketCursor(cursor: TicketCursor): string {
  return Buffer.from(
    JSON.stringify({ k: cursor.keys, u: cursor.updatedAt, i: cursor.id })
  ).toString('base64url');
}

export function decodeTicketCursor(value: string): TicketCursor {
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
 * is what the index on `tickets(workspace_id, updated_at)` wants.
 */
function keysetPredicate(plan: ResolvedSortPlan, cursor: TicketCursor): SQL {
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
      ? sql`${tickets.id} > ${cursor.id}`
      : sql`${tickets.id} < ${cursor.id}`;
  const updatedComparison =
    plan.tailDirection === 'asc'
      ? sql`${tickets.updatedAt} > ${cursor.updatedAt}`
      : sql`${tickets.updatedAt} < ${cursor.updatedAt}`;
  const tail = sql`(${updatedComparison} OR (${tickets.updatedAt} = ${cursor.updatedAt} AND ${idComparison}))`;
  alternatives.push(sql`(${sql.join([...prefix, tail], sql` AND `)})`);
  return sql`(${sql.join(alternatives, sql` OR `)})`;
}

export interface FilterTicketsOptions {
  workspaceId: string;
  filter: FilterAst | null;
  sort?: SavedViewSort[] | null;
  limit?: number;
  cursor?: string | null;
  now?: number;
}

export interface TicketListPage {
  rows: Ticket[];
  /** `null` when the last page was reached. */
  nextCursor: string | null;
  unresolved: string[];
}

/**
 * List tickets for a workspace with the shared filter language, validated
 * sorting and keyset pagination by `(updatedAt, id)` (with custom sort keys
 * folded into the cursor so a non-default sort is still exact).
 */
export async function filterTickets(
  db: Executor,
  options: FilterTicketsOptions
): Promise<TicketListPage> {
  const now = options.now ?? Date.now();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const compiled = await compileTicketFilterDetailed(db, {
    workspaceId: options.workspaceId,
    filter: options.filter,
    now
  });
  const plan = await resolveSortPlan(db, options.workspaceId, options.sort, now);

  const conditions: SQL[] = [sql`${tickets.workspaceId} = ${options.workspaceId}`, compiled.sql];
  if (options.cursor) {
    conditions.push(keysetPredicate(plan, decodeTicketCursor(options.cursor)));
  }
  const where = sql.join(conditions, sql` AND `);

  const orderParts: SQL[] = plan.sorts.map((sort) =>
    sort.direction === 'asc' ? sql`${sort.expr} ASC` : sql`${sort.expr} DESC`
  );
  orderParts.push(
    plan.tailDirection === 'asc' ? sql`${tickets.updatedAt} ASC` : sql`${tickets.updatedAt} DESC`
  );
  orderParts.push(plan.tailDirection === 'asc' ? sql`${tickets.id} ASC` : sql`${tickets.id} DESC`);

  const keysExpression =
    plan.sorts.length === 0
      ? sql<string>`json_array()`
      : sql<string>`json_array(${sql.join(
          plan.sorts.map((sort) => sort.expr),
          sql`, `
        )})`;

  const selected = await db
    .select({ ...getTableColumns(tickets), sortKeys: keysExpression })
    .from(tickets)
    .where(where)
    .orderBy(...orderParts)
    // One extra row detects "there is another page" without a second query.
    .limit(limit + 1)
    .all();

  const hasMore = selected.length > limit;
  const page = hasMore ? selected.slice(0, limit) : selected;
  const rows: Ticket[] = [];
  let nextCursor: string | null = null;
  for (const selectedRow of page) {
    const { sortKeys, ...ticket } = selectedRow;
    rows.push(ticket as Ticket);
    const keys = normalizeSortKeys(sortKeys);
    nextCursor = encodeTicketCursor({ keys, updatedAt: ticket.updatedAt, id: ticket.id });
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
