/**
 * Typed field-value normalisation.
 *
 * Every `FieldType` from the frozen schema must round-trip through one shared
 * normaliser before it reaches `file_field_values`. Testing the whole matrix here
 * keeps validation out of the service and makes the typed columns trustworthy for
 * filtering.
 */
import { describe, expect, test } from 'bun:test';
import type { FieldDefinition, FieldType } from '../../../src/lib/server/db/schema';
import { normalizeFieldValue, readFieldValue } from '../../../src/lib/server/files/field-values';

function def(type: FieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: 'fd-1',
    workspaceId: 'ws-1',
    key: 'k',
    name: 'Field',
    description: null,
    type,
    scope: 'file',
    options: null,
    defaultValue: null,
    validation: null,
    display: null,
    isSystem: false,
    createdByUserId: null,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...extra
  };
}

describe('normalizeFieldValue: text-like types', () => {
  test('short_text and long_text store trimmed text and lowercase search text', () => {
    for (const type of ['short_text', 'long_text'] as const) {
      const value = normalizeFieldValue(def(type), '  Policy Schedule ');
      expect(value.valueText).toBe('Policy Schedule');
      expect(value.searchText).toBe('policy schedule');
      expect(value.valueNumber).toBeNull();
      expect(value.isEmpty).toBe(false);
    }
  });

  test('url, email and phone validate their shape', () => {
    expect(normalizeFieldValue(def('url'), 'https://example.test/a').valueText).toBe(
      'https://example.test/a'
    );
    expect(() => normalizeFieldValue(def('url'), 'not a url')).toThrow();
    expect(normalizeFieldValue(def('email'), 'a@b.test').valueText).toBe('a@b.test');
    expect(() => normalizeFieldValue(def('email'), 'nope')).toThrow();
    expect(normalizeFieldValue(def('phone'), '+1 555 0100').valueText).toBe('+1 555 0100');
  });
});

describe('normalizeFieldValue: numeric types', () => {
  test('number accepts numbers and numeric strings', () => {
    expect(normalizeFieldValue(def('number'), 42).valueNumber).toBe(42);
    expect(normalizeFieldValue(def('number'), '42.5').valueNumber).toBe(42.5);
    expect(normalizeFieldValue(def('number'), '42.5').searchText).toBe('42.5');
    expect(() => normalizeFieldValue(def('number'), 'many')).toThrow();
  });

  test('number honours min/max and length validation', () => {
    const bounded = def('number', { validation: { min: 1, max: 10 } });
    expect(normalizeFieldValue(bounded, 10).valueNumber).toBe(10);
    expect(() => normalizeFieldValue(bounded, 11)).toThrow();
    expect(() => normalizeFieldValue(bounded, 0)).toThrow();

    const short = def('short_text', { validation: { maxLength: 3 } });
    expect(() => normalizeFieldValue(short, 'abcd')).toThrow();
    const pattered = def('short_text', { validation: { pattern: '^[A-Z]+$' } });
    expect(normalizeFieldValue(pattered, 'ABC').valueText).toBe('ABC');
    expect(() => normalizeFieldValue(pattered, 'abc')).toThrow();
  });

  test('currency uses the numeric column and formats search text', () => {
    const value = normalizeFieldValue(
      def('currency', { options: { currency: 'USD' } }),
      '1,234.50'
    );
    expect(value.valueNumber).toBe(1234.5);
    expect(value.searchText).toBe('1234.5');
  });
});

describe('normalizeFieldValue: boolean, date and datetime', () => {
  test('boolean accepts booleans and common string forms', () => {
    expect(normalizeFieldValue(def('boolean'), true).valueBool).toBe(true);
    expect(normalizeFieldValue(def('boolean'), 'yes').valueBool).toBe(true);
    expect(normalizeFieldValue(def('boolean'), 'false').valueBool).toBe(false);
    expect(normalizeFieldValue(def('boolean'), 0).valueBool).toBe(false);
    expect(() => normalizeFieldValue(def('boolean'), 'maybe')).toThrow();
  });

  test('date stores UTC midnight in the date column', () => {
    const value = normalizeFieldValue(def('date'), '2026-01-15');
    expect(value.valueDate).toBe(Date.UTC(2026, 0, 15));
    expect(value.display).toBe('2026-01-15');
    expect(value.searchText).toBe('2026-01-15');
  });

  test('datetime accepts ISO strings and epoch milliseconds', () => {
    const iso = normalizeFieldValue(def('datetime'), '2026-01-15T10:30:00.000Z');
    expect(iso.valueDate).toBe(Date.parse('2026-01-15T10:30:00.000Z'));
    const epoch = normalizeFieldValue(def('datetime'), 1_700_000_000_000);
    expect(epoch.valueDate).toBe(1_700_000_000_000);
    expect(() => normalizeFieldValue(def('date'), 'last tuesday')).toThrow();
  });
});

describe('normalizeFieldValue: choice and relation types', () => {
  const choices = {
    choices: [
      { value: 'invoice', label: 'Invoice' },
      { value: 'evidence', label: 'Evidence' }
    ]
  };
  const select = def('select', { options: choices });
  const multiSelect = def('multi_select', { options: choices });

  test('select accepts a configured choice by value or label and rejects others', () => {
    expect(normalizeFieldValue(select, 'invoice').valueText).toBe('invoice');
    expect(normalizeFieldValue(select, 'Invoice').valueText).toBe('invoice');
    expect(normalizeFieldValue(select, 'invoice').searchText).toBe('invoice');
    expect(() => normalizeFieldValue(select, 'unknown')).toThrow();
  });

  test('select without configured choices accepts the raw value', () => {
    expect(normalizeFieldValue(def('select'), 'anything').valueText).toBe('anything');
  });

  test('multi_select stores an array in the JSON column', () => {
    const value = normalizeFieldValue(multiSelect, ['invoice', 'evidence']);
    expect(value.valueJson).toEqual(['invoice', 'evidence']);
    expect(value.searchText).toBe('invoice evidence');
    expect(() => normalizeFieldValue(multiSelect, 'invoice')).toThrow();
    expect(() => normalizeFieldValue(multiSelect, ['invoice', 'nope'])).toThrow();
  });

  test('user and team store the id in the text column and clear on empty', () => {
    expect(normalizeFieldValue(def('user'), 'user-1').valueText).toBe('user-1');
    expect(normalizeFieldValue(def('team'), 'team-1').valueText).toBe('team-1');
    expect(normalizeFieldValue(def('user'), '').isEmpty).toBe(true);
  });
});

describe('normalizeFieldValue: json and emptiness', () => {
  test('json stores any JSON-serialisable value', () => {
    const value = normalizeFieldValue(def('json'), { a: 1, b: [true] });
    expect(value.valueJson).toEqual({ a: 1, b: [true] });
    expect(value.searchText).toContain('"a":1');
  });

  test('rejects values that cannot be represented as JSON', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => normalizeFieldValue(def('json'), circular)).toThrow();
  });

  test('empty input normalizes to an explicit empty value', () => {
    for (const type of ['short_text', 'number', 'date', 'datetime', 'select', 'json'] as const) {
      const value = normalizeFieldValue(def(type), null);
      expect(value.isEmpty).toBe(true);
      expect(value.searchText).toBeNull();
    }
  });
});

describe('readFieldValue', () => {
  test('reconstructs the canonical value from typed columns', () => {
    const dateValue = normalizeFieldValue(def('date'), '2026-01-15');
    expect(
      readFieldValue(
        {
          valueText: dateValue.valueText,
          valueNumber: dateValue.valueNumber,
          valueBool: dateValue.valueBool,
          valueDate: dateValue.valueDate,
          valueJson: dateValue.valueJson
        },
        def('date')
      )
    ).toBe('2026-01-15');

    const jsonValue = normalizeFieldValue(def('json'), { a: 1 });
    expect(
      readFieldValue(
        {
          valueText: jsonValue.valueText,
          valueNumber: jsonValue.valueNumber,
          valueBool: jsonValue.valueBool,
          valueDate: jsonValue.valueDate,
          valueJson: jsonValue.valueJson
        },
        def('json')
      )
    ).toEqual({ a: 1 });
  });
});
