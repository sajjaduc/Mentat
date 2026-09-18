/**
 * Field-summary formatting tests.
 *
 * The same summaries render in the schema box preview and the Object Type fields
 * list, so their shape is pinned here rather than in either component.
 */
import { describe, expect, test } from 'bun:test';
import {
  describeDefaultValue,
  describeFieldChoices,
  describeFieldValidation
} from '../../../src/lib/ui/schema/field-summary';

describe('describeFieldValidation', () => {
  test('renders length, numeric and pattern rules', () => {
    expect(describeFieldValidation(null)).toBeNull();
    expect(describeFieldValidation({})).toBeNull();
    expect(describeFieldValidation({ minLength: 3, maxLength: 120 })).toBe('3–120 chars');
    expect(describeFieldValidation({ minLength: 3 })).toBe('min 3 chars');
    expect(describeFieldValidation({ maxLength: 12 })).toBe('max 12 chars');
    expect(describeFieldValidation({ min: 0, max: 1000 })).toBe('0–1000');
    expect(describeFieldValidation({ min: 0 })).toBe('min 0');
    expect(describeFieldValidation({ max: 10 })).toBe('max 10');
    expect(describeFieldValidation({ pattern: '^[A-Z]{2}$' })).toBe('pattern ^[A-Z]{2}$');
    expect(describeFieldValidation({ minLength: 1, min: 0, pattern: 'a' })).toBe(
      'min 1 chars · min 0 · pattern a'
    );
  });
});

describe('describeFieldChoices', () => {
  test('prefers labels and falls back to values', () => {
    expect(describeFieldChoices(null)).toBeNull();
    expect(describeFieldChoices({ choices: [] })).toBeNull();
    expect(
      describeFieldChoices({
        choices: [
          { value: 'active', label: 'Active' },
          { value: 'lapsed', label: 'Lapsed' }
        ]
      })
    ).toBe('Active, Lapsed');
    expect(describeFieldChoices({ choices: [{ value: 'x', label: '' }] })).toBe('x');
  });
});

describe('describeDefaultValue', () => {
  test('renders JSON and truncates long values', () => {
    expect(describeDefaultValue(undefined)).toBeNull();
    expect(describeDefaultValue(null)).toBeNull();
    expect(describeDefaultValue(true)).toBe('true');
    expect(describeDefaultValue(0)).toBe('0');
    expect(describeDefaultValue('x')).toBe('"x"');
    expect(describeDefaultValue({ a: 1 })).toBe('{"a":1}');
    const long = describeDefaultValue('y'.repeat(120));
    expect(long?.endsWith('…')).toBe(true);
    expect(long?.length).toBe(78);
  });
});
