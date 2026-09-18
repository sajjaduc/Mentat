/**
 * Record listing, search and structured filtering.
 *
 * Records reuse the one filter AST (ADR-0012) but compile against the universal
 * tables: system keys map to `records` columns and `record_field` conditions map
 * to `record_field_values` through a correlated EXISTS. The compiler is separate
 * from the ticket compiler on purpose — no ticket special-casing leaks in.
 */
import { and, asc, desc, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { fieldDefinitions, recordFieldValues, records } from '../db/schema';
import { type FilterAst, type FilterCondition, isGroup } from '../filters/ast';

export interface RecordSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface RecordListOptions {
  workspaceId: string;
  objectTypeId?: string | null;
  objectTypeIds?: string[] | null;
  /** Include archived records (defaults to excluding them). */
  includeArchived?: boolean;
  filter?: FilterAst | null;
  search?: string | null;
  sort?: RecordSort[];
  limit?: number;
  cursor?: string | null;
}

export interface RecordListRow {
  id: string;
  objectTypeId: string;
  displayName: string;
  key: string | null;
  number: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  fields: Record<string, unknown>;
}

export interface RecordPage {
  rows: RecordListRow[];
  nextCursor: string | null;
  total: number;
  unresolved: string[];
}

export async function listRecords(db: Executor, options: RecordListOptions): Promise<RecordPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const unresolved: string[] = [];
  const conditions: SQL[] = [eq(records.workspaceId, options.workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(records.archivedAt));
  if (options.objectTypeId) conditions.push(eq(records.objectTypeId, options.objectTypeId));
  if (options.objectTypeIds && options.objectTypeIds.length > 0) {
    conditions.push(sql`${records.objectTypeId} IN ${inList(options.objectTypeIds)}`);
  }
  if (options.filter) {
    conditions.push(compileRecordFilter(options.filter, db, options.workspaceId, unresolved));
  }
  if (options.search && options.search.trim().length > 0) {
    const term = `%${options.search.trim().toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${records.displayName}) LIKE ${term}`,
        sql`lower(coalesce(${records.key}, '')) LIKE ${term}`
      ) as SQL
    );
  }
  if (options.cursor) {
    const decoded = decodeRecordCursor(options.cursor);
    if (decoded) {
      conditions.push(
        sql`(${records.updatedAt} < ${decoded.updatedAt} OR (${records.updatedAt} = ${decoded.updatedAt} AND ${records.id} < ${decoded.id}))`
      );
    }
  }

  const orderBy = buildOrder(options.sort);
  const rows = await db
    .select()
    .from(records)
    .where(and(...conditions))
    .orderBy(...orderBy, desc(records.updatedAt), desc(records.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const total = await countRecords(db, {
    workspaceId: options.workspaceId,
    objectTypeId: options.objectTypeId,
    objectTypeIds: options.objectTypeIds,
    includeArchived: options.includeArchived,
    filter: options.filter,
    search: options.search
  });

  const fieldBags = await loadFieldBags(
    db,
    options.workspaceId,
    pageRows.map((row) => row.id)
  );

  return {
    rows: pageRows.map((row) => ({
      id: row.id,
      objectTypeId: row.objectTypeId,
      displayName: row.displayName,
      key: row.key,
      number: row.number,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      fields: fieldBags.get(row.id) ?? {}
    })),
    nextCursor: hasMore
      ? encodeRecordCursor(pageRows[pageRows.length - 1] as { updatedAt: number; id: string })
      : null,
    total,
    unresolved
  };
}

export async function countRecords(
  db: Executor,
  options: Omit<RecordListOptions, 'sort' | 'limit' | 'cursor'>
): Promise<number> {
  const unresolved: string[] = [];
  const conditions: SQL[] = [eq(records.workspaceId, options.workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(records.archivedAt));
  if (options.objectTypeId) conditions.push(eq(records.objectTypeId, options.objectTypeId));
  if (options.objectTypeIds && options.objectTypeIds.length > 0) {
    conditions.push(sql`${records.objectTypeId} IN ${inList(options.objectTypeIds)}`);
  }
  if (options.filter) {
    conditions.push(compileRecordFilter(options.filter, db, options.workspaceId, unresolved));
  }
  if (options.search && options.search.trim().length > 0) {
    const term = `%${options.search.trim().toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${records.displayName}) LIKE ${term}`,
        sql`lower(coalesce(${records.key}, '')) LIKE ${term}`
      ) as SQL
    );
  }
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(records)
    .where(and(...conditions))
    .all();
  return Number(row[0]?.count ?? 0);
}

const SYSTEM_COLUMNS: Record<string, string> = {
  displayName: 'display_name',
  key: 'key',
  number: 'number',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  archivedAt: 'archived_at',
  objectTypeId: 'object_type_id'
};

function compileRecordFilter(
  node: FilterAst,
  db: Executor,
  workspaceId: string,
  unresolved: string[]
): SQL {
  if (isGroup(node)) {
    const children = node.children.map((child) =>
      compileRecordFilter(child, db, workspaceId, unresolved)
    );
    if (children.length === 0) return sql`1 = 1`;
    const joined =
      node.op === 'or' ? sql.join(children, sql` OR `) : sql.join(children, sql` AND `);
    return sql`(${joined})`;
  }
  return compileCondition(node, db, workspaceId, unresolved);
}

function compileCondition(
  condition: FilterCondition,
  db: Executor,
  workspaceId: string,
  unresolved: string[]
): SQL {
  const kind = condition.kind ?? 'system';
  if (kind === 'system') {
    const column = SYSTEM_COLUMNS[condition.key];
    if (!column) {
      unresolved.push(condition.key);
      return sql`0 = 1`;
    }
    return compareColumn(sql.raw(`records.${column}`), condition);
  }
  if (kind === 'field' || kind === 'record_field') {
    return compileRecordField(condition, db, workspaceId, unresolved);
  }
  if (kind === 'relationship') {
    return compileRelationship(condition, unresolved);
  }
  unresolved.push(`${kind}:${condition.key}`);
  return sql`0 = 1`;
}

function compareColumn(column: SQL, condition: FilterCondition): SQL {
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
      return sql`${column} IN ${inList(toArray(value))}`;
    case 'not_in':
      return sql`${column} NOT IN ${inList(toArray(value))}`;
    case 'is_empty':
      return sql`(${column} IS NULL OR ${column} = '')`;
    case 'is_not_empty':
      return sql`(${column} IS NOT NULL AND ${column} <> '')`;
    default:
      return sql`1 = 1`;
  }
}

function compileRecordField(
  condition: FilterCondition,
  db: Executor,
  workspaceId: string,
  unresolved: string[]
): SQL {
  const definition = db
    .select({ id: fieldDefinitions.id, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, 'record'),
        or(eq(fieldDefinitions.key, condition.key), eq(fieldDefinitions.id, condition.key))
      )
    )
    .all()[0];
  if (!definition) {
    unresolved.push(condition.key);
    return sql`0 = 1`;
  }
  const inner = compareTypedValue(definition.type, condition);
  return sql`EXISTS (
    SELECT 1 FROM record_field_values rfv
    WHERE rfv.record_id = records.id
      AND rfv.workspace_id = ${workspaceId}
      AND rfv.field_definition_id = ${definition.id}
      AND ${inner}
  )`;
}

/** Pick the storage column that matches the definition's declared type. */
function typedColumn(type: string): {
  column: string;
  numeric: boolean;
  date: boolean;
  bool: boolean;
} {
  switch (type) {
    case 'number':
    case 'currency':
      return { column: 'value_number', numeric: true, date: false, bool: false };
    case 'date':
    case 'datetime':
      return { column: 'value_date', numeric: false, date: true, bool: false };
    case 'boolean':
      return { column: 'value_bool', numeric: false, date: false, bool: true };
    case 'multi_select':
    case 'json':
      return { column: 'value_json', numeric: false, date: false, bool: false };
    default:
      return { column: 'value_text', numeric: false, date: false, bool: false };
  }
}

function compareTypedValue(type: string, condition: FilterCondition): SQL {
  const value = condition.value;
  const text = value === undefined || value === null ? null : String(value);
  const column = sql.raw(`rfv.${typedColumn(type).column}`);
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
      return sql`${column} > ${coerceForColumn(type, value)}`;
    case 'gte':
      return sql`${column} >= ${coerceForColumn(type, value)}`;
    case 'lt':
    case 'before':
      return sql`${column} < ${coerceForColumn(type, value)}`;
    case 'lte':
      return sql`${column} <= ${coerceForColumn(type, value)}`;
    case 'in':
      return sql`${column} IN ${inList(toArray(value))}`;
    case 'not_in':
      return sql`${column} NOT IN ${inList(toArray(value))}`;
    case 'neq':
      return sql`${column} <> ${coerceForColumn(type, value)}`;
    default:
      return sql`${column} = ${coerceForColumn(type, value)}`;
  }
}

function coerceForColumn(type: string, value: unknown): unknown {
  const storage = typedColumn(type);
  if (storage.numeric) return typeof value === 'number' ? value : Number(value);
  if (storage.date) {
    if (typeof value === 'number') return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (storage.bool) return value === true || value === 'true' || value === 1;
  return value;
}

function compileRelationship(condition: FilterCondition, unresolved: string[]): SQL {
  // A relationship condition names a definition key and a related record field.
  unresolved.push(`relationship:${condition.key}`);
  return sql`0 = 1`;
}

function buildOrder(sort: RecordSort[] | undefined): SQL[] {
  if (!sort || sort.length === 0) return [];
  return sort
    .map((entry) => {
      const column = SYSTEM_COLUMNS[entry.field];
      if (!column) return null;
      const expression = sql.raw(`records.${column}`);
      return entry.direction === 'asc' ? asc(expression) : desc(expression);
    })
    .filter((value): value is SQL => value !== null);
}

async function loadFieldBags(
  db: Executor,
  workspaceId: string,
  recordIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  if (recordIds.length === 0) return result;
  const rows = await db
    .select({
      recordId: recordFieldValues.recordId,
      key: fieldDefinitions.key,
      valueText: recordFieldValues.valueText,
      valueNumber: recordFieldValues.valueNumber,
      valueBool: recordFieldValues.valueBool,
      valueDate: recordFieldValues.valueDate,
      valueJson: recordFieldValues.valueJson
    })
    .from(recordFieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, recordFieldValues.fieldDefinitionId))
    .where(
      and(
        eq(recordFieldValues.workspaceId, workspaceId),
        sql`${recordFieldValues.recordId} IN ${inList(recordIds)}`
      )
    )
    .all();
  for (const row of rows) {
    const bag = result.get(row.recordId) ?? {};
    bag[row.key] =
      row.valueText ?? row.valueNumber ?? row.valueBool ?? row.valueDate ?? row.valueJson ?? null;
    result.set(row.recordId, bag);
  }
  return result;
}

export function encodeRecordCursor(row: { updatedAt: number; id: string }): string {
  return `${row.updatedAt}:${row.id}`;
}

export function decodeRecordCursor(cursor: string): { updatedAt: number; id: string } | null {
  const index = cursor.indexOf(':');
  if (index <= 0) return null;
  const updatedAt = Number(cursor.slice(0, index));
  const id = cursor.slice(index + 1);
  if (!Number.isFinite(updatedAt) || id.length === 0) return null;
  return { updatedAt, id };
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function inList(values: string[]): SQL {
  return sql`(${sql.join(values.length > 0 ? values.map((value) => sql`${value}`) : [sql`NULL`], sql`, `)})`;
}

export function parseRecordFilterInput(input: unknown): FilterAst | null {
  if (!input || typeof input !== 'object') return null;
  try {
    return input as FilterAst;
  } catch {
    throw errors.validation('Invalid record filter');
  }
}
