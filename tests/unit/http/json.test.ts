/**
 * `parseJsonObject` backs the provider-native reasoning override field.
 *
 * The server validates that field as a record, so a client that accepts a bare
 * array or scalar would only discover the mistake as a 422 after a save. These
 * cases pin the stricter contract.
 */
import { describe, expect, test } from 'bun:test';
import { parseJsonObject } from '../../../src/lib/ui/http/json';

describe('parseJsonObject', () => {
  test('accepts an object and preserves its contents', () => {
    const result = parseJsonObject('{"thinking": {"budget_tokens": 4000}}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ thinking: { budget_tokens: 4000 } });
  });

  test('rejects arrays, scalars and malformed text', () => {
    expect(parseJsonObject('[1, 2]').ok).toBe(false);
    expect(parseJsonObject('"text"').ok).toBe(false);
    expect(parseJsonObject('42').ok).toBe(false);
    expect(parseJsonObject('null').ok).toBe(false);
    expect(parseJsonObject('{').ok).toBe(false);
  });

  test('an empty document is not an object either', () => {
    expect(parseJsonObject('   ').ok).toBe(false);
  });
});
