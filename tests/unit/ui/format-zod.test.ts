/**
 * Zod formatter tests.
 *
 * The box reformats on blur. These prove the formatter is idempotent and that it
 * copies strings, regular expressions and comments verbatim, so reformatting can
 * never change a schema's meaning.
 */
import { describe, expect, test } from 'bun:test';
import { formatZodSource } from '../../../src/lib/ui/schema/format-zod';

describe('formatZodSource', () => {
  test('breaks a one-liner into indented lines', () => {
    const formatted = formatZodSource(
      `z.object({policy_number:z.string().min(3),email:z.string().email()})`
    );
    expect(formatted).toBe(
      [
        'z.object({',
        '  policy_number: z.string().min(3),',
        '  email: z.string().email()',
        '})',
        ''
      ].join('\n')
    );
  });

  test('is idempotent', () => {
    const inputs = [
      `z.object({ a: z.string().regex(/^[A-Z]{2,4}$/), nested: z.object({ b: z.array(z.enum(['x','y'])).optional() }) })`,
      `z.object({ note: z.string().describe('A note: with colon'), f: z.number().default(1) }).strict()`,
      `z.object({}).strict()`,
      `z.object({ url: z.url(), when: z.iso.datetime(), tag: z.literal('a') })`
    ];
    for (const input of inputs) {
      const once = formatZodSource(input);
      expect(formatZodSource(once)).toBe(once);
    }
  });

  test('copies strings, regexes and comments verbatim', () => {
    const formatted = formatZodSource(
      `z.object({ a: z.string().regex(/^[A-Z]{2,4}$/), b: z.string().describe('keep  double spaces'), c: z.number() /* keep me */ })`
    );
    expect(formatted).toContain('/^[A-Z]{2,4}$/');
    expect(formatted).toContain("'keep  double spaces'");
    expect(formatted).toContain('/* keep me */');
  });

  test('returns empty input unchanged', () => {
    expect(formatZodSource('')).toBe('');
    expect(formatZodSource('   \n  ')).toBe('');
  });
});
