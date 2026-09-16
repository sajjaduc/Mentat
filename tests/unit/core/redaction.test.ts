import { describe, expect, test } from 'bun:test';
import {
  containsSecret,
  createRedactor,
  isSensitiveKey,
  maskInlineCredentials,
  REDACTED,
  secretHint
} from '../../../src/lib/server/core/redaction';

describe('redaction', () => {
  test('masks nested sensitive keys without touching structural ids', () => {
    const input = {
      apiKey: 'super-secret-value',
      authorization: 'Bearer abcdefghijklmnop',
      secretId: 'f1e2d3c4-0000-7000-8000-000000000000',
      cacheKey: 'user:42',
      nested: { password: 'hunter2hunter2', ok: 'visible' },
      list: [{ token: 'zzzzzzzzzzzzzzzz' }]
    };
    const out = createRedactor().value(input);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.nested.password).toBe(REDACTED);
    expect(out.list[0]?.token).toBe(REDACTED);
    // Non-secret identifiers survive so diagnostics stay useful.
    expect(out.secretId).toBe(input.secretId);
    expect(out.cacheKey).toBe('user:42');
    expect(out.nested.ok).toBe('visible');
  });

  test('masks registered plaintext wherever it appears, including inside strings', () => {
    const redactor = createRedactor(['sk-live-abcdef123456']);
    const out = redactor.value({
      url: 'https://api.example.com/v1?key=sk-live-abcdef123456',
      header: 'Bearer sk-live-abcdef123456',
      note: 'the token is sk-live-abcdef123456 ok'
    });
    expect(out.url).not.toContain('sk-live-abcdef123456');
    expect(out.header).not.toContain('sk-live-abcdef123456');
    expect(out.note).not.toContain('sk-live-abcdef123456');
    expect(out.note).toContain(REDACTED);
  });

  test('ignores short registered values so ordinary text is not corrupted', () => {
    const redactor = createRedactor(['abc']);
    expect(redactor.value({ text: 'abc def' }).text).toBe('abc def');
  });

  test('masks inline credentials in free text', () => {
    expect(maskInlineCredentials('Authorization: Bearer abcdef1234567890')).not.toContain(
      'abcdef1234567890'
    );
    expect(maskInlineCredentials('https://user:hunter2@example.com/x')).not.toContain('hunter2');
    expect(maskInlineCredentials('api_key=ABCDEF1234567890')).not.toContain('ABCDEF1234567890');
  });

  test('serializes errors without leaking secrets', () => {
    const error = Object.assign(new Error('boom'), { code: 'internal' });
    const out = createRedactor(['boom']).value({ error });
    expect(out.error.message).toBe(REDACTED);
    expect(out.error.code).toBe('internal');
  });

  test('classifies sensitive key names', () => {
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('client_secret')).toBe(true);
    expect(isSensitiveKey('webhookSecret')).toBe(true);
    // Structural/identifier keys must stay readable.
    expect(isSensitiveKey('secretId')).toBe(false);
    expect(isSensitiveKey('storageKey')).toBe(false);
    expect(isSensitiveKey('idempotencyKey')).toBe(false);
  });

  test('detects leaked secrets for defence-in-depth assertions', () => {
    const hit = containsSecret({ a: { b: 'value with sk-live-abcdef123456 inside' } }, [
      'sk-live-abcdef123456'
    ]);
    expect(hit).toBe('sk-live-abcdef123456');
    expect(containsSecret({ a: 'nothing here' }, ['sk-live-abcdef123456'])).toBeNull();
  });

  test('provides a non-sensitive hint for stored secrets', () => {
    expect(secretHint('sk-live-abcdef123456')).toEqual({ lastFour: '3456', length: 20 });
  });
});
