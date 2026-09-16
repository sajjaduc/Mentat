/**
 * File filter compiler.
 *
 * ADR-0012 gives Mentat exactly one filtering language. The analytics workstream
 * owns the ticket compiler, so the file compiler lives here and translates the
 * frozen AST into conditions over `files`, `file_field_values` and the relation
 * tables.
 *
 * Relation fields use scalar subqueries (`EXISTS`/correlated `SELECT`) rather than
 * joins: a file can carry many sources, tickets and workflow contexts, and a join
 * would multiply rows and make `limit` mean the wrong thing. JSON columns are read
 * with `json_extract`, which is the one SQLite-specific construct here and is
 * isolated so a PostgreSQL compiler can replace it.
 */
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { type FieldDefinition, fieldDefinitions } from '../db/schema';
import {
  FileSystemFields,
  type FilterCondition,
  type FilterNode,
  type FilterOperator,
  isGroup
} from '../filters/ast';

type ValueType = 'text' | 'number' | 'date' | 'bool';

export function compileFileFilter(
  db: Executor,
  workspaceId: string,
  node: FilterNode | null
): SQL | undefined {
  if (!node) return undefined;
  if (isGroup(node)) {
    const compiled = node.children
      .map((child) => compileFileFilter(db, workspaceId, child))
      .filter((entry): entry is SQL => entry !== undefined);
    if (compiled.length === 0) return undefined;
    return node.op === 'and' ? and(...compiled) : or(...compiled);
  }
  return compileCondition(db, workspaceId, node);
}

function compileCondition(
  db: Executor,
  workspaceId: string,
  condition: FilterCondition
): SQL | undefined {
  if (condition.kind === 'system' || condition.kind === 'file') {
    const left = systemExpression(condition.key);
    return comparison(left.expression, condition.operator, condition.value, left.valueType);
  }
  if (condition.kind === 'field' || condition.kind === 'file_field') {
    const definition = findFileFieldDefinition(db, workspaceId, condition.key);
    if (!definition) {
      // An unknown key must not silently broaden the result set.
      throw errors.validation(`Unknown file field "${condition.key}"`);
    }
    const left = fieldExpression(definition);
    return comparison(left.expression, condition.operator, condition.value, left.valueType);
  }
  throw errors.unsupported(`Filter kind "${condition.kind}" is not supported for files`);
}

function findFileFieldDefinition(
  db: Executor,
  workspaceId: string,
  key: string
): FieldDefinition | undefined {
  return db
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, 'file'),
        or(eq(fieldDefinitions.key, key), eq(fieldDefinitions.id, key))
      )
    )
    .limit(1)
    .all()[0];
}

function systemExpression(key: string): { expression: SQL; valueType: ValueType } {
  switch (key) {
    case FileSystemFields.filename:
      return { expression: sql`files.original_filename`, valueType: 'text' };
    case FileSystemFields.mimeType:
      return { expression: sql`files.mime_type`, valueType: 'text' };
    case FileSystemFields.size:
      return { expression: sql`files.size`, valueType: 'number' };
    case FileSystemFields.status:
      return { expression: sql`files.status`, valueType: 'text' };
    case FileSystemFields.summary:
      return { expression: sql`files.summary`, valueType: 'text' };
    case FileSystemFields.createdAt:
      return { expression: sql`files.created_at`, valueType: 'date' };
    case FileSystemFields.updatedAt:
      return { expression: sql`files.updated_at`, valueType: 'date' };
    case FileSystemFields.contentHash:
      return {
        expression: sql`(SELECT b.content_hash FROM blobs b WHERE b.id = files.blob_id)`,
        valueType: 'text'
      };
    case FileSystemFields.pageCount:
      return {
        expression: sql`json_extract(files.metadata, '$.pageCount')`,
        valueType: 'number'
      };
    case FileSystemFields.language:
      return {
        expression: sql`json_extract(files.metadata, '$.language')`,
        valueType: 'text'
      };
    case FileSystemFields.sourceType:
      return {
        expression: sql`(SELECT fs.source_type FROM file_sources fs WHERE fs.file_id = files.id ORDER BY fs.occurred_at ASC LIMIT 1)`,
        valueType: 'text'
      };
    case FileSystemFields.workflowId:
      return {
        expression: sql`(SELECT wf.workflow_id FROM workflow_files wf WHERE wf.file_id = files.id AND wf.removed_at IS NULL LIMIT 1)`,
        valueType: 'text'
      };
    case FileSystemFields.ticketId:
      return {
        expression: sql`(SELECT tf.ticket_id FROM ticket_files tf WHERE tf.file_id = files.id AND tf.removed_at IS NULL LIMIT 1)`,
        valueType: 'text'
      };
    case FileSystemFields.contextLabel:
      return {
        expression: sql`(SELECT wf.context_label FROM workflow_files wf WHERE wf.file_id = files.id AND wf.removed_at IS NULL LIMIT 1)`,
        valueType: 'text'
      };
    case FileSystemFields.contentText:
      return {
        expression: sql`(SELECT fec.text FROM file_extracted_content fec WHERE fec.file_id = files.id ORDER BY fec.created_at DESC LIMIT 1)`,
        valueType: 'text'
      };
    default:
      throw errors.validation(`Unknown file system field "${key}"`);
  }
}

function fieldExpression(definition: FieldDefinition): { expression: SQL; valueType: ValueType } {
  const id = definition.id;
  const typed = `(SELECT %s FROM file_field_values ffv WHERE ffv.file_id = files.id AND ffv.field_definition_id = '${id.replace(/'/g, "''")}' LIMIT 1)`;
  switch (definition.type) {
    case 'number':
    case 'currency':
      return { expression: sql.raw(typed.replace('%s', 'ffv.value_number')), valueType: 'number' };
    case 'date':
    case 'datetime':
      return { expression: sql.raw(typed.replace('%s', 'ffv.value_date')), valueType: 'date' };
    case 'boolean':
      return { expression: sql.raw(typed.replace('%s', 'ffv.value_bool')), valueType: 'bool' };
    default:
      // search_text is the lowercase projection shared by text, select, URL,
      // email, user/team and JSON fields, so text operators stay dialect-neutral.
      return { expression: sql.raw(typed.replace('%s', 'ffv.search_text')), valueType: 'text' };
  }
}

function comparison(
  left: SQL,
  operator: FilterOperator,
  value: unknown,
  valueType: ValueType
): SQL {
  const lower = sql`lower(${left})`;
  switch (operator) {
    case 'eq':
      return valueType === 'text'
        ? sql`${lower} = ${textValue(value)}`
        : sql`${left} = ${typedValue(value, valueType)}`;
    case 'neq':
      return valueType === 'text'
        ? sql`${lower} <> ${textValue(value)}`
        : sql`${left} <> ${typedValue(value, valueType)}`;
    case 'in':
      return inList(left, value, valueType, false);
    case 'not_in':
      return inList(left, value, valueType, true);
    case 'contains':
      return sql`${lower} like ${likePattern(value, 'contains')} escape '\\'`;
    case 'not_contains':
      return sql`${lower} not like ${likePattern(value, 'contains')} escape '\\'`;
    case 'starts_with':
      return sql`${lower} like ${likePattern(value, 'starts')} escape '\\'`;
    case 'ends_with':
      return sql`${lower} like ${likePattern(value, 'ends')} escape '\\'`;
    case 'gt':
      return sql`${left} > ${typedValue(value, valueType)}`;
    case 'gte':
      return sql`${left} >= ${typedValue(value, valueType)}`;
    case 'lt':
      return sql`${left} < ${typedValue(value, valueType)}`;
    case 'lte':
      return sql`${left} <= ${typedValue(value, valueType)}`;
    case 'before':
      return sql`${left} < ${typedValue(value, 'date')}`;
    case 'after':
      return sql`${left} > ${typedValue(value, 'date')}`;
    case 'between': {
      const [from, to] = asArray(value, 2);
      return sql`${left} between ${typedValue(from, valueType)} and ${typedValue(to, valueType)}`;
    }
    case 'within_last_days':
      return sql`${left} >= ${Date.now() - numberValue(value) * 86_400_000}`;
    case 'not_within_last_days':
      return sql`${left} < ${Date.now() - numberValue(value) * 86_400_000}`;
    case 'is_empty':
      return valueType === 'text' ? sql`(${left} is null or ${left} = '')` : sql`${left} is null`;
    case 'is_not_empty':
      return valueType === 'text'
        ? sql`(${left} is not null and ${left} <> '')`
        : sql`${left} is not null`;
    case 'is_true':
      return sql`${left} = 1`;
    case 'is_false':
      return sql`(${left} = 0 or ${left} is null)`;
    default:
      throw errors.unsupported(`Filter operator "${operator}" is not supported`);
  }
}

function inList(left: SQL, value: unknown, valueType: ValueType, negate: boolean): SQL {
  const lower = sql`lower(${left})`;
  const entries = asArray(value, 0);
  if (entries.length === 0) {
    // `in ()` is invalid SQL; an empty list matches nothing (or everything).
    return negate ? sql`1 = 1` : sql`1 = 0`;
  }
  const placeholders = entries.map((entry) =>
    valueType === 'text' ? sql`${textValue(entry)}` : sql`${typedValue(entry, valueType)}`
  );
  const list = sql.join(placeholders, sql`, `);
  const subject = valueType === 'text' ? lower : left;
  return negate ? sql`${subject} not in (${list})` : sql`${subject} in (${list})`;
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase();
}

function typedValue(value: unknown, valueType: ValueType): string | number {
  if (valueType === 'number') return numberValue(value);
  if (valueType === 'bool') return booleanValue(value) ? 1 : 0;
  if (valueType === 'date') return dateValue(value);
  return String(value ?? '');
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed))
    throw errors.validation(`Expected a number, received ${String(value)}`);
  return parsed;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === 1;
}

function dateValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed))
    throw errors.validation(`Expected a date, received ${String(value)}`);
  return parsed;
}

function asArray(value: unknown, expected: number): unknown[] {
  if (!Array.isArray(value)) {
    if (expected === 0) return [];
    throw errors.validation('Filter value must be a list');
  }
  return value;
}

function likePattern(value: unknown, position: 'contains' | 'starts' | 'ends'): string {
  const escaped = String(value ?? '')
    .toLowerCase()
    .replace(/[\\%_]/g, (character) => `\\${character}`);
  if (position === 'contains') return `%${escaped}%`;
  if (position === 'starts') return `${escaped}%`;
  return `%${escaped}`;
}
