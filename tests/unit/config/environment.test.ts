/**
 * Environment key validation.
 *
 * Keys become process environment names at execution time, so the format is
 * enforced at the boundary rather than silently mangled later.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeEnvironmentKey } from '../../../src/lib/server/config/environment';
import { isAppError } from '../../../src/lib/server/core/errors';

function expectValidation(key: string): void {
  try {
    normalizeEnvironmentKey(key);
    throw new Error(`expected "${key}" to be rejected`);
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) expect(error.code).toBe('validation_failed');
  }
}

describe('config/environment key validation', () => {
  test('accepts canonical upper-snake keys', () => {
    expect(normalizeEnvironmentKey('STRIPE_API_KEY')).toBe('STRIPE_API_KEY');
    expect(normalizeEnvironmentKey('_PRIVATE')).toBe('_PRIVATE');
    expect(normalizeEnvironmentKey('A1')).toBe('A1');
  });

  test('normalizes lowercase and separators', () => {
    expect(normalizeEnvironmentKey('stripe api key')).toBe('STRIPE_API_KEY');
    expect(normalizeEnvironmentKey('  log-level  ')).toBe('LOG_LEVEL');
    expect(normalizeEnvironmentKey('a--b')).toBe('A_B');
  });

  test('rejects empty, leading-digit and oversized keys', () => {
    expectValidation('');
    expectValidation('   ');
    expectValidation('1FOO');
    expectValidation('x'.repeat(65));
  });
});
