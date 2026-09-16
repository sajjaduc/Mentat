import { describe, expect, test } from 'bun:test';
import { REDACTED } from '../../../src/lib/server/core/redaction';
import type { HttpAuthConfig, HttpAuthType } from '../../../src/lib/server/db/schema';
import { applyAuth } from '../../../src/lib/server/http/auth';

function service(authType: HttpAuthType, authConfig: HttpAuthConfig | null = null) {
  return { authType, authConfig, defaultHeaders: null };
}

describe('applyAuth: every auth type', () => {
  test('none produces no headers or query', () => {
    const applied = applyAuth({ service: service('none'), resolvedSecrets: {} });
    expect(applied.headers).toEqual({});
    expect(applied.query).toEqual({});
    expect(applied.redactedHeaders).toEqual({});
  });

  test('bearer sets an Authorization header and redacts it', () => {
    const applied = applyAuth({
      service: service('bearer', { secretId: 's1' }),
      resolvedSecrets: { secret: 'super-secret-token' }
    });
    expect(applied.headers.Authorization).toBe('Bearer super-secret-token');
    expect(applied.redactedHeaders.Authorization).toBe(`Bearer ${REDACTED}`);
    expect(JSON.stringify(applied.redactedHeaders)).not.toContain('super-secret-token');
  });

  test('api_key_header uses the configured header name', () => {
    const applied = applyAuth({
      service: service('api_key_header', { secretId: 's1', headerName: 'X-HubSpot-Key' }),
      resolvedSecrets: { secret: 'key-123456' }
    });
    expect(applied.headers['X-HubSpot-Key']).toBe('key-123456');
    expect(applied.redactedHeaders['X-HubSpot-Key']).toBe(REDACTED);
  });

  test('api_key_header defaults to X-API-Key', () => {
    const applied = applyAuth({
      service: service('api_key_header', { secretId: 's1' }),
      resolvedSecrets: { secret: 'key-123456' }
    });
    expect(applied.headers['X-API-Key']).toBe('key-123456');
  });

  test('api_key_query places the secret in the query and redacts it', () => {
    const applied = applyAuth({
      service: service('api_key_query', { secretId: 's1', queryName: 'access_token' }),
      resolvedSecrets: { secret: 'query-secret-value' }
    });
    expect(applied.headers).toEqual({});
    expect(applied.query.access_token).toBe('query-secret-value');
    expect(applied.redactedQuery.access_token).toBe(REDACTED);
    expect(JSON.stringify(applied.redactedQuery)).not.toContain('query-secret-value');
  });

  test('basic auth encodes username and password and redacts the whole credential', () => {
    const applied = applyAuth({
      service: service('basic', { username: 'alice', passwordSecretId: 's2' }),
      resolvedSecrets: { password: 'hunter2-password' }
    });
    const expected = `Basic ${Buffer.from('alice:hunter2-password').toString('base64')}`;
    expect(applied.headers.Authorization).toBe(expected);
    expect(applied.redactedHeaders.Authorization).toBe(`Basic ${REDACTED}`);
    expect(JSON.stringify(applied.redactedHeaders)).not.toContain('hunter2-password');
    expect(JSON.stringify(applied.redactedHeaders)).not.toContain('alice:');
  });

  test('custom_header renders the template with the secret', () => {
    const applied = applyAuth({
      service: service('custom_header', {
        secretId: 's1',
        headerName: 'X-Signature',
        template: 'HMAC {{secret}}'
      }),
      resolvedSecrets: { secret: 'custom-secret-value' }
    });
    expect(applied.headers['X-Signature']).toBe('HMAC custom-secret-value');
    expect(applied.redactedHeaders['X-Signature']).toBe(`HMAC ${REDACTED}`);
  });

  test('custom_header defaults the template to the bare secret', () => {
    const applied = applyAuth({
      service: service('custom_header', { secretId: 's1', headerName: 'X-Auth' }),
      resolvedSecrets: { secret: 'bare-secret-value' }
    });
    expect(applied.headers['X-Auth']).toBe('bare-secret-value');
    expect(applied.redactedHeaders['X-Auth']).toBe(REDACTED);
  });
});

describe('applyAuth: default headers and redaction', () => {
  test('merges service default headers and redacts sensitive keys', () => {
    const applied = applyAuth({
      service: {
        authType: 'none',
        authConfig: null,
        defaultHeaders: { 'X-Tenant': 'acme', 'X-Trace-Token': 'tracetokenvalue' }
      },
      resolvedSecrets: {}
    });
    expect(applied.headers['X-Tenant']).toBe('acme');
    expect(applied.redactedHeaders['X-Tenant']).toBe('acme');
    expect(applied.redactedHeaders['X-Trace-Token']).toBe(REDACTED);
  });

  test('does not leak a resolved secret echoed inside a default header', () => {
    const applied = applyAuth({
      service: {
        authType: 'bearer',
        authConfig: { secretId: 's1' },
        defaultHeaders: { 'X-Debug': 'token=leaked-secret-value' }
      },
      resolvedSecrets: { secret: 'leaked-secret-value' }
    });
    expect(JSON.stringify(applied.redactedHeaders)).not.toContain('leaked-secret-value');
    expect(applied.redactedHeaders['X-Debug']).toContain(REDACTED);
  });
});

describe('applyAuth: misconfiguration fails loudly', () => {
  test('bearer without a resolved secret throws', () => {
    expect(() =>
      applyAuth({ service: service('bearer', { secretId: 's1' }), resolvedSecrets: {} })
    ).toThrow(/secret/i);
  });

  test('basic without a username throws', () => {
    expect(() =>
      applyAuth({
        service: service('basic', { passwordSecretId: 's2' }),
        resolvedSecrets: { password: 'p' }
      })
    ).toThrow(/username/i);
  });

  test('basic without a password secret throws', () => {
    expect(() =>
      applyAuth({ service: service('basic', { username: 'alice' }), resolvedSecrets: {} })
    ).toThrow(/password/i);
  });

  test('api_key_query without a query name falls back to api_key', () => {
    const applied = applyAuth({
      service: service('api_key_query', { secretId: 's1' }),
      resolvedSecrets: { secret: 'some-secret-value' }
    });
    expect(applied.query.api_key).toBe('some-secret-value');
  });
});
