/**
 * Zod-source unit tests: compile, project and validate (ADR-0023 revision).
 *
 * The projection is what lets one Zod contract feed the typed-field engine, so these
 * pin the mapping from Zod constructs to field types and requiredness. They are pure
 * functions, so they fail fast without a database.
 */
import { describe, expect, test } from 'bun:test';
import {
  compileZodSource,
  humanizeKey,
  type ProjectedZodField,
  testZodSource,
  validateAgainstZodSource
} from '../../../src/lib/server/schemas/zod-source';

const SOURCE = `z.object({
  policy_number: z.string().min(3).describe('The policy identifier'),
  email: z.string().email(),
  site: z.url().optional(),
  premium: z.number().min(0).max(1000),
  active: z.boolean().default(true),
  status: z.enum(['active', 'lapsed']),
  tags: z.array(z.enum(['a', 'b'])),
  notes: z.array(z.string()).nullable(),
  meta: z.record(z.string(), z.number()),
  anything: z.unknown()
})`;

function fieldsOf(source: string): (key: string) => ProjectedZodField {
  const result = compileZodSource(source);
  if (!result.ok) throw new Error(result.message);
  const byKey = new Map(result.fields.map((field) => [field.key, field]));
  return (key) => {
    const field = byKey.get(key);
    if (!field) throw new Error(`No projected field for "${key}"`);
    return field;
  };
}

describe('zod source: compilation and projection', () => {
  test('maps Zod constructs onto field types and requiredness', () => {
    const field = fieldsOf(SOURCE);

    expect(field('policy_number').type).toBe('short_text');
    expect(field('policy_number').required).toBe(true);
    expect(field('policy_number').validation?.minLength).toBe(3);
    expect(field('policy_number').description).toBe('The policy identifier');
    expect(field('policy_number').name).toBe('Policy number');

    expect(field('email').type).toBe('email');
    expect(field('site').type).toBe('url');
    expect(field('site').required).toBe(false);

    expect(field('premium').type).toBe('number');
    expect(field('premium').validation).toEqual({ min: 0, max: 1000 });

    expect(field('active').type).toBe('boolean');
    expect(field('active').required).toBe(false);
    expect(field('active').defaultValue).toBe(true);

    expect(field('status').type).toBe('select');
    expect(field('status').options?.choices).toEqual([
      { value: 'active', label: 'Active' },
      { value: 'lapsed', label: 'Lapsed' }
    ]);

    expect(field('tags').type).toBe('multi_select');
    expect(field('tags').options?.choices?.map((choice) => choice.value)).toEqual(['a', 'b']);

    // Constructs the field engine cannot type stay JSON; the Zod source still
    // validates them exactly.
    expect(field('notes').type).toBe('json');
    expect(field('meta').type).toBe('json');
    expect(field('anything').type).toBe('json');
    expect(field('anything').required).toBe(false);
  });

  test('reports keys that cannot become field keys instead of dropping them', () => {
    const result = compileZodSource(`z.object({ a: z.string(), '1bad': z.number() })`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invalidKeys).toEqual(['a', '1bad']);
  });

  test('reads binding flags and descriptions from .meta() and .describe()', () => {
    const field = fieldsOf(`z.object({
      code: z.string().meta({ identity: true, primary: true, card: true, list: false, filterable: false }),
      note: z.string().describe('Inner description').optional()
    })`);

    expect(field('code').isIdentity).toBe(true);
    expect(field('code').isPrimaryDisplay).toBe(true);
    expect(field('code').showOnCard).toBe(true);
    expect(field('code').showInList).toBe(false);
    expect(field('code').filterable).toBe(false);
    expect(field('code').meta).toEqual({
      identity: true,
      primary: true,
      list: false,
      card: true,
      filterable: false
    });

    expect(field('note').description).toBe('Inner description');
    expect(field('note').required).toBe(false);
    expect(field('note').showInList).toBe(true);
    expect(field('note').meta.card).toBeUndefined();
  });

  test('distinguishes a non-object schema from a failed compile', () => {
    const scalar = compileZodSource('z.string()');
    expect(scalar.ok).toBe(true);
    if (scalar.ok) {
      expect(scalar.object).toBeNull();
      expect(scalar.fields).toEqual([]);
    }

    const empty = compileZodSource('   ');
    expect(empty.ok).toBe(false);

    const notASchema = compileZodSource('42');
    expect(notASchema.ok).toBe(false);
    if (!notASchema.ok) expect(notASchema.message).toContain('must evaluate to a Zod schema');
  });

  test('does not expose dangerous globals to compiled source', () => {
    const processAccess = compileZodSource('process.exit(1)');
    expect(processAccess.ok).toBe(false);

    const requireAccess = compileZodSource(`require('node:fs')`);
    expect(requireAccess.ok).toBe(false);

    const fetchAccess = compileZodSource('fetch("http://example.com")');
    expect(fetchAccess.ok).toBe(false);
  });

  test('rejects source beyond the length guard', () => {
    const huge = `z.object({ a: z.string().describe('${'x'.repeat(20_100)}') })`;
    const result = compileZodSource(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('too long');
  });
});

describe('zod source: testing against a sample', () => {
  test('returns parsed data and the projection on success', () => {
    const result = testZodSource(SOURCE, {
      policy_number: 'POL-1',
      email: 'a@example.com',
      premium: 10,
      status: 'active',
      tags: ['a'],
      notes: ['n'],
      meta: { x: 1 },
      anything: { free: true }
    });
    expect(result.ok).toBe(true);
    expect(result.compiled).toBe(true);
    expect(result.fields.length).toBeGreaterThan(0);
    expect((result.data as Record<string, unknown>).active).toBe(true);
  });

  test('returns field-path issues when the sample does not satisfy the schema', () => {
    const result = testZodSource(SOURCE, { policy_number: 'x', email: 'nope', premium: 'ten' });
    expect(result.ok).toBe(false);
    expect(result.compiled).toBe(true);
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain('policy_number');
    expect(paths).toContain('email');
    expect(paths).toContain('premium');
  });

  test('reports a compile failure without a parse attempt', () => {
    const result = testZodSource('z.nope()', {});
    expect(result.ok).toBe(false);
    expect(result.compiled).toBe(false);
    expect(result.message).not.toBeNull();
  });
});

describe('zod source: runtime validation', () => {
  test('applies defaults and coercion from the stored source', () => {
    const result = validateAgainstZodSource(SOURCE, {
      policy_number: 'POL-1',
      email: 'a@example.com',
      premium: 0,
      status: 'lapsed',
      tags: ['b'],
      notes: null,
      meta: {},
      anything: 1
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.active).toBe(true);
  });

  test('fails closed when the stored source no longer compiles', () => {
    const result = validateAgainstZodSource('z.object({', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message.length).toBeGreaterThan(0);
  });
});

describe('zod source: key naming', () => {
  test('humanizes snake case and camelCase', () => {
    expect(humanizeKey('policy_number')).toBe('Policy number');
    expect(humanizeKey('policyNumber')).toBe('Policy Number');
    expect(humanizeKey('URL')).toBe('URL');
  });
});
