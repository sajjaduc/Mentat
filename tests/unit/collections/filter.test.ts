import { describe, expect, test } from 'bun:test';
import {
  compileRecordPredicate,
  type FilterableRecord,
  parseRecordFilter,
  type RecordFilter,
  readRecordField
} from '../../../src/lib/server/collections/filter';

function record(
  data: Record<string, unknown>,
  overrides: Partial<FilterableRecord> = {}
): FilterableRecord {
  return {
    id: 'rec-1',
    externalKey: null,
    data,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides
  };
}

function run(filter: RecordFilter, subject: FilterableRecord): boolean {
  return compileRecordPredicate(filter)(subject);
}

describe('record predicate compiler', () => {
  test('an empty filter matches everything', () => {
    expect(compileRecordPredicate(undefined)(record({}))).toBe(true);
    expect(compileRecordPredicate([])(record({}))).toBe(true);
  });

  test('equality and inequality on strings, numbers and booleans', () => {
    const subject = record({ status: 'open', score: 12, active: true });
    expect(run([{ field: 'status', op: 'eq', value: 'open' }], subject)).toBe(true);
    expect(run([{ field: 'status', op: 'eq', value: 'closed' }], subject)).toBe(false);
    expect(run([{ field: 'score', op: 'eq', value: 12 }], subject)).toBe(true);
    expect(run([{ field: 'active', op: 'eq', value: true }], subject)).toBe(true);
    expect(run([{ field: 'status', op: 'neq', value: 'closed' }], subject)).toBe(true);
  });

  test('structural equality for objects', () => {
    const subject = record({ address: { city: 'Berlin', zip: '10115' } });
    expect(
      run([{ field: 'address', op: 'eq', value: { zip: '10115', city: 'Berlin' } }], subject)
    ).toBe(true);
    expect(run([{ field: 'address', op: 'eq', value: { city: 'Paris' } }], subject)).toBe(false);
  });

  test('numeric and date comparisons', () => {
    const subject = record({ amount: 100, due: '2025-03-01T00:00:00.000Z' });
    expect(run([{ field: 'amount', op: 'gt', value: 99 }], subject)).toBe(true);
    expect(run([{ field: 'amount', op: 'gte', value: 100 }], subject)).toBe(true);
    expect(run([{ field: 'amount', op: 'lt', value: 100 }], subject)).toBe(false);
    expect(run([{ field: 'amount', op: 'lte', value: 100 }], subject)).toBe(true);
    expect(run([{ field: 'due', op: 'gt', value: '2025-01-01T00:00:00.000Z' }], subject)).toBe(
      true
    );
  });

  test('comparisons across incompatible types are false rather than throwing', () => {
    const subject = record({ amount: 'one hundred' });
    expect(run([{ field: 'amount', op: 'gt', value: 5 }], subject)).toBe(false);
  });

  test('contains matches substrings case-insensitively and arrays by membership', () => {
    const subject = record({ title: 'Acme Corp Renewal', tags: ['urgent', 'vip'] });
    expect(run([{ field: 'title', op: 'contains', value: 'acme' }], subject)).toBe(true);
    expect(run([{ field: 'title', op: 'contains', value: 'missing' }], subject)).toBe(false);
    expect(run([{ field: 'tags', op: 'contains', value: 'vip' }], subject)).toBe(true);
    expect(run([{ field: 'tags', op: 'contains', value: 'none' }], subject)).toBe(false);
  });

  test('starts_with and ends_with are case-insensitive', () => {
    const subject = record({ email: 'Person@Example.com' });
    expect(run([{ field: 'email', op: 'starts_with', value: 'person@' }], subject)).toBe(true);
    expect(run([{ field: 'email', op: 'ends_with', value: '.COM' }], subject)).toBe(true);
    expect(run([{ field: 'email', op: 'ends_with', value: '.org' }], subject)).toBe(false);
  });

  test('in checks membership, is_empty and is_not_empty handle absent values', () => {
    const subject = record({ status: 'open', note: '   ' });
    expect(run([{ field: 'status', op: 'in', value: ['open', 'closed'] }], subject)).toBe(true);
    expect(run([{ field: 'status', op: 'in', value: ['closed'] }], subject)).toBe(false);
    expect(run([{ field: 'status', op: 'in', value: 'open' }], subject)).toBe(false);
    expect(run([{ field: 'missing', op: 'is_empty' }], subject)).toBe(true);
    expect(run([{ field: 'status', op: 'is_not_empty' }], subject)).toBe(true);
    expect(run([{ field: 'missing', op: 'is_not_empty' }], subject)).toBe(false);
  });

  test('conditions are ANDed together', () => {
    const subject = record({ status: 'open', amount: 50 });
    expect(
      run(
        [
          { field: 'status', op: 'eq', value: 'open' },
          { field: 'amount', op: 'gte', value: 10 }
        ],
        subject
      )
    ).toBe(true);
    expect(
      run(
        [
          { field: 'status', op: 'eq', value: 'open' },
          { field: 'amount', op: 'gte', value: 100 }
        ],
        subject
      )
    ).toBe(false);
  });

  test('reads dotted paths and system fields', () => {
    const subject = record({ address: { city: 'Berlin' } }, { externalKey: 'ext-9' });
    expect(readRecordField(subject, 'address.city')).toBe('Berlin');
    expect(readRecordField(subject, 'externalKey')).toBe('ext-9');
    expect(readRecordField(subject, 'createdAt')).toBe(1_000);
    expect(readRecordField(subject, 'address.missing')).toBeUndefined();
    expect(run([{ field: 'address.city', op: 'eq', value: 'Berlin' }], subject)).toBe(true);
    expect(run([{ field: 'externalKey', op: 'eq', value: 'ext-9' }], subject)).toBe(true);
  });

  test('parseRecordFilter rejects malformed filters with validation details', () => {
    expect(parseRecordFilter(undefined)).toBeUndefined();
    expect(() => parseRecordFilter([{ field: '', op: 'eq' }])).toThrow();
    expect(() => parseRecordFilter([{ field: 'x', op: 'unknown' }])).toThrow();
    expect(() => parseRecordFilter('nope')).toThrow();
  });
});
