import { describe, expect, test } from 'bun:test';
import type { HttpParameterMapping } from '../../../src/lib/server/db/schema';
import { buildUrl, isHostAllowed } from '../../../src/lib/server/http/url';

const service = { baseUrl: 'https://api.example.com/v3', allowedHosts: ['api.example.com'] };

function param(overrides: Partial<HttpParameterMapping> & { name: string }): HttpParameterMapping {
  return { location: 'query', ...overrides };
}

describe('buildUrl: path substitution', () => {
  test('joins the base path with the operation path and substitutes placeholders', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/contacts/{{contactId}}/notes/{{noteId}}',
        parameters: [
          { name: 'contactId', location: 'path', required: true },
          { name: 'noteId', location: 'path', required: true }
        ]
      },
      params: { contactId: '42', noteId: 'note-7' }
    });
    expect(built.url).toBe('https://api.example.com/v3/contacts/42/notes/note-7');
    expect(built.pathname).toBe('/v3/contacts/42/notes/note-7');
    expect(built.consumed.sort()).toEqual(['contactId', 'noteId']);
  });

  test('handles a trailing slash on the base URL without doubling it', () => {
    const built = buildUrl({
      service: { baseUrl: 'https://api.example.com/v3/' },
      operation: { path: '/contacts' },
      params: {}
    });
    expect(built.url).toBe('https://api.example.com/v3/contacts');
  });

  test('uses the parameter default when the value is absent', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/search',
        parameters: [param({ name: 'version', default: '2024-01' })]
      },
      params: {}
    });
    expect(built.url).toBe('https://api.example.com/v3/search?version=2024-01');
  });

  test('uses the parameter constant and ignores a supplied value', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/search',
        parameters: [param({ name: 'v', constant: '2' })]
      },
      params: { v: 'attacker' }
    });
    expect(built.query.v).toBe('2');
  });

  test('percent-encodes path parameter values', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/users/{{email}}',
        parameters: [{ name: 'email', location: 'path', required: true }]
      },
      params: { email: 'a b/c?d@example.com' }
    });
    expect(built.url).toBe('https://api.example.com/v3/users/a%20b%2Fc%3Fd%40example.com');
  });

  test('encodes placeholders that appear more than once', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/a/{{id}}/b/{{id}}',
        parameters: [{ name: 'id', location: 'path', required: true }]
      },
      params: { id: 'x' }
    });
    expect(built.url).toBe('https://api.example.com/v3/a/x/b/x');
  });
});

describe('buildUrl: query parameters', () => {
  test('appends query parameters and skips undefined values', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/contacts',
        parameters: [
          param({ name: 'limit', type: 'number' }),
          param({ name: 'cursor', wireName: 'after' }),
          param({ name: 'missing' })
        ]
      },
      params: { limit: 25, cursor: 'abc' }
    });
    expect(built.url).toContain('limit=25');
    expect(built.url).toContain('after=abc');
    expect(built.url).not.toContain('missing=');
  });

  test('serialises arrays as repeated keys and booleans as literals', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/search',
        parameters: [
          param({ name: 'tag', type: 'array' }),
          param({ name: 'archived', type: 'boolean' })
        ]
      },
      params: { tag: ['a', 'b'], archived: false }
    });
    expect(built.query.tag).toEqual(['a', 'b']);
    expect(built.query.archived).toBe('false');
    expect(built.url).toBe('https://api.example.com/v3/search?tag=a&tag=b&archived=false');
  });

  test('merges extra static query parameters last', () => {
    const built = buildUrl({
      service,
      operation: { path: '/x', parameters: [param({ name: 'a' })] },
      params: { a: '1' },
      extraQuery: { a: 'override', b: '2' }
    });
    expect(built.query.a).toBe('override');
    expect(built.query.b).toBe('2');
  });
});

describe('buildUrl: validation', () => {
  test('rejects a missing required path parameter', () => {
    expect(() =>
      buildUrl({
        service,
        operation: {
          path: '/contacts/{{id}}',
          parameters: [{ name: 'id', location: 'path', required: true }]
        },
        params: {}
      })
    ).toThrow(/Missing required parameter/);
  });

  test('rejects an unknown parameter', () => {
    expect(() =>
      buildUrl({
        service,
        operation: { path: '/x', parameters: [param({ name: 'a' })] },
        params: { a: '1', surprise: 'x' }
      })
    ).toThrow(/Unknown parameter/);
  });

  test('allows a free-form body object for passthrough operations', () => {
    const built = buildUrl({
      service,
      operation: { path: '/x', parameters: [param({ name: 'a' })] },
      params: { a: '1', body: { anything: true } }
    });
    expect(built.url).toBe('https://api.example.com/v3/x?a=1');
  });

  test('allows body-field parameters declared on the body mapping', () => {
    const built = buildUrl({
      service,
      operation: {
        path: '/contacts',
        parameters: [],
        body: { mode: 'json', fields: [{ name: 'email', location: 'body' }] }
      },
      params: { email: 'a@b.c' }
    });
    expect(built.url).toBe('https://api.example.com/v3/contacts');
  });
});

describe('buildUrl: SSRF safety', () => {
  test('rejects an absolute URL used as the operation path', () => {
    expect(() =>
      buildUrl({
        service,
        operation: { path: 'https://evil.example.com/steal' },
        params: {}
      })
    ).toThrow(/absolute URL/i);
  });

  test('rejects a protocol-relative operation path', () => {
    expect(() =>
      buildUrl({ service, operation: { path: '//evil.example.com/steal' }, params: {} })
    ).toThrow(/protocol-relative/i);
  });

  test('rejects dot-segment traversal that escapes the service base', () => {
    expect(() => buildUrl({ service, operation: { path: '/../../admin' }, params: {} })).toThrow(
      /traversal|escape/i
    );
  });

  test('rejects a path placeholder whose value is a dot segment', () => {
    expect(() =>
      buildUrl({
        service,
        operation: {
          path: '/contacts/{{id}}',
          parameters: [{ name: 'id', location: 'path', required: true }]
        },
        params: { id: '..' }
      })
    ).toThrow(/traversal|escape/i);
  });

  test('rejects a non-http service base URL', () => {
    expect(() =>
      buildUrl({
        service: { baseUrl: 'file:///etc/passwd' },
        operation: { path: '/x' },
        params: {}
      })
    ).toThrow(/http/i);
  });

  test('rejects a base URL that is not a URL at all', () => {
    expect(() =>
      buildUrl({ service: { baseUrl: 'not a url' }, operation: { path: '/x' }, params: {} })
    ).toThrow();
  });

  test('rejects a host outside the allowedHosts list', () => {
    expect(() =>
      buildUrl({
        service: { baseUrl: 'https://api.example.com', allowedHosts: ['other.example.com'] },
        operation: { path: '/x' },
        params: {}
      })
    ).toThrow(/allowedHosts/);
  });

  test('enforces allowedHosts with a wildcard suffix', () => {
    expect(isHostAllowed('api.example.com', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('evil-example.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
  });
});
