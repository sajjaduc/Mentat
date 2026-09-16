/**
 * Record filter predicate compiler for structured collections.
 *
 * ## Why this is not the ticket filter AST (ADR-0012)
 *
 * The ticket/file/saved-view filter AST compiles to SQL against typed `field_values`
 * rows and system columns: it has nested AND/OR groups, joins and 20+ temporal
 * operators. Collection records are portable JSON documents whose fields have no
 * column of their own, so a faithful port would need dialect-specific JSON
 * operators (`json_extract` on SQLite vs `#>>`/GIN on PostgreSQL) and a per-field
 * index strategy that does not exist in V1.
 *
 * Instead this is deliberately narrow: a flat list of conditions combined with AND,
 * compiled to an *in-process* predicate. `collections/service` narrows the row set
 * with an indexed `search_text` LIKE prefilter for text predicates before running
 * the predicate, so the common case stays cheap while the semantics stay exactly
 * portable. When the collection filter needs groups or joins, the right answer is to
 * add a typed field or route through the ticket filter — not to grow this compiler.
 */
import { z } from 'zod';
import { errors } from '../core/errors';
import { stableStringify } from '../core/hash';

export const recordFilterOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'ends_with',
  'in',
  'is_empty',
  'is_not_empty'
]);
export type RecordFilterOperator = z.infer<typeof recordFilterOperatorSchema>;

export const recordFilterConditionSchema = z.object({
  field: z.string().min(1),
  op: recordFilterOperatorSchema,
  value: z.unknown().optional()
});
export type RecordFilterCondition = z.infer<typeof recordFilterConditionSchema>;

export const recordFilterSchema = z.array(recordFilterConditionSchema).max(50);
export type RecordFilter = z.infer<typeof recordFilterSchema>;

export const recordSortSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']).default('asc')
});
export type RecordSort = z.infer<typeof recordSortSchema>;

/** The minimal shape a predicate needs; keeps the compiler independent of the service. */
export interface FilterableRecord {
  id: string;
  externalKey: string | null;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** System fields addressable without touching the JSON document. */
export const RECORD_SYSTEM_FIELDS = {
  id: 'id',
  externalKey: 'externalKey',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
} as const;

/** Parse and validate an untrusted filter payload at the service/tool boundary. */
export function parseRecordFilter(value: unknown): RecordFilter | undefined {
  if (value === undefined || value === null) return undefined;
  const result = recordFilterSchema.safeParse(value);
  if (!result.success) {
    throw errors.validation('Invalid record filter', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    });
  }
  return result.data;
}

/**
 * Resolve a field from a record. System fields win; otherwise the field is a dotted
 * path into `data` so `address.city` works without flattening storage.
 */
export function readRecordField(record: FilterableRecord, field: string): unknown {
  switch (field) {
    case RECORD_SYSTEM_FIELDS.id:
      return record.id;
    case RECORD_SYSTEM_FIELDS.externalKey:
      return record.externalKey;
    case RECORD_SYSTEM_FIELDS.createdAt:
      return record.createdAt;
    case RECORD_SYSTEM_FIELDS.updatedAt:
      return record.updatedAt;
    default:
      return readPath(record.data, field);
  }
}

function readPath(data: Record<string, unknown>, field: string): unknown {
  if (field in data) return data[field];
  if (!field.includes('.')) return undefined;
  let current: unknown = data;
  for (const segment of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Compile a filter into a pure predicate; an empty filter matches everything. */
export function compileRecordPredicate(
  filter?: RecordFilter
): (record: FilterableRecord) => boolean {
  if (!filter || filter.length === 0) return () => true;
  return (record) => filter.every((condition) => matches(record, condition));
}

function matches(record: FilterableRecord, condition: RecordFilterCondition): boolean {
  return evaluate(condition.op, readRecordField(record, condition.field), condition.value);
}

function evaluate(op: RecordFilterOperator, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return equals(actual, expected);
    case 'neq':
      return !equals(actual, expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return orderedCompare(op, compare(actual, expected));
    case 'contains':
      return contains(actual, expected);
    case 'starts_with':
      return textMatch(actual, expected, 'starts');
    case 'ends_with':
      return textMatch(actual, expected, 'ends');
    case 'in':
      return Array.isArray(expected) && expected.some((candidate) => equals(actual, candidate));
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    default:
      return false;
  }
}

function orderedCompare(op: 'gt' | 'gte' | 'lt' | 'lte', order: number): boolean {
  if (Number.isNaN(order)) return false;
  if (op === 'gt') return order > 0;
  if (op === 'gte') return order >= 0;
  if (op === 'lt') return order < 0;
  return order <= 0;
}

function textMatch(actual: unknown, expected: unknown, mode: 'starts' | 'ends'): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const haystack = actual.toLowerCase();
  const needle = expected.toLowerCase();
  return mode === 'starts' ? haystack.startsWith(needle) : haystack.endsWith(needle);
}

function equals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return false;
  }
  if (typeof actual === 'object' || typeof expected === 'object') {
    return stableStringify(actual) === stableStringify(expected);
  }
  return false;
}

function compare(actual: unknown, expected: unknown): number {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return numericOrder(actual, expected);
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return stringOrder(actual, expected);
  }
  return Number.NaN;
}

function numericOrder(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function stringOrder(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  // ISO-8601-ish strings compare as dates; anything else compares lexically.
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return numericOrder(leftTime, rightTime);
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((candidate) => equals(candidate, expected));
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase().includes(expected.toLowerCase());
  }
  return false;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}
