import { describe, expect, test } from 'bun:test';
import {
  assertRecordData,
  parseRecordSchema,
  validateRecordData
} from '../../../src/lib/server/collections/schema-validation';
import { AppError } from '../../../src/lib/server/core/errors';

const schema = {
  required: ['name'],
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    status: { type: 'string', enum: ['open', 'closed'] },
    tags: { type: 'array' },
    note: { type: ['string', 'null'] }
  }
};

describe('collection schema validation', () => {
  test('parses a pragmatic schema into the internal shape', () => {
    const parsed = parseRecordSchema(schema);
    expect(parsed?.required).toEqual(['name']);
    expect(parsed?.properties?.name?.type).toBe('string');
    expect(parsed?.properties?.note?.type).toEqual(['string', 'null']);
  });

  test('returns null when no schema is declared', () => {
    expect(parseRecordSchema(null)).toBeNull();
    expect(parseRecordSchema(undefined)).toBeNull();
  });

  test('rejects a malformed schema descriptor eagerly', () => {
    expect(() => parseRecordSchema('nope')).toThrow(AppError);
    expect(() => parseRecordSchema({ properties: [] })).toThrow(AppError);
    expect(() => parseRecordSchema({ properties: { a: { type: 'date' } } })).toThrow(AppError);
    expect(() => parseRecordSchema({ required: 'name' })).toThrow(AppError);
    expect(() => parseRecordSchema({ properties: { a: { enum: 'x' } } })).toThrow(AppError);
  });

  test('accepts a document that satisfies required keys, types and enums', () => {
    expect(
      validateRecordData(parseRecordSchema(schema), {
        name: 'Acme',
        age: 3,
        status: 'open',
        tags: ['a'],
        note: null
      })
    ).toEqual([]);
  });

  test('collects every violation with a readable message', () => {
    const violations = validateRecordData(parseRecordSchema(schema), {
      age: 'three',
      status: 'pending',
      tags: 'nope'
    });
    const paths = violations.map((violation) => violation.path).sort();
    expect(paths).toEqual(['age', 'name', 'status', 'tags']);
    expect(violations.find((v) => v.path === 'name')?.message).toContain('Missing required field');
    expect(violations.find((v) => v.path === 'age')?.message).toContain('must be of type integer');
    expect(violations.find((v) => v.path === 'status')?.message).toContain(
      'must be one of: "open", "closed"'
    );
    expect(violations.find((v) => v.path === 'tags')?.message).toContain('must be of type array');
  });

  test('honours per-property required shorthand', () => {
    const shorthand = parseRecordSchema({
      properties: { email: { type: 'string', required: true } }
    });
    const violations = validateRecordData(shorthand, {});
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('email');
  });

  test('assertRecordData throws one validation error carrying all violations', () => {
    try {
      assertRecordData(parseRecordSchema(schema), {});
      throw new Error('expected assertRecordData to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('validation_failed');
      expect(Array.isArray(appError.details.violations)).toBe(true);
    }
  });

  test('skips validation entirely when no schema is declared', () => {
    expect(validateRecordData(null, { anything: true })).toEqual([]);
    expect(() => assertRecordData(null, { anything: true })).not.toThrow();
  });
});
