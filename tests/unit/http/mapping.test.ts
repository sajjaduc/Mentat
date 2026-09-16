import { describe, expect, test } from 'bun:test';
import type {
  HttpBodyMapping,
  HttpParameterMapping,
  HttpResponseMapping,
  HttpSuccessRules
} from '../../../src/lib/server/db/schema';
import {
  applyBodyMapping,
  applyResponseMapping,
  evaluateSuccessRules,
  inferInputSchema,
  selectBodyPath,
  validateInput
} from '../../../src/lib/server/http/mapping';

function param(overrides: Partial<HttpParameterMapping> & { name: string }): HttpParameterMapping {
  return { location: 'body', ...overrides };
}

describe('inferInputSchema', () => {
  test('builds an object schema from parameter mappings with required fields', () => {
    const schema = inferInputSchema(
      [
        { name: 'id', location: 'path', required: true, type: 'string', description: 'Contact id' },
        { name: 'limit', location: 'query', type: 'number' },
        { name: 'verbose', location: 'query', type: 'boolean', default: false }
      ],
      null
    ) as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['id']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.id?.type).toBe('string');
    expect(schema.properties.id?.description).toBe('Contact id');
    expect(schema.properties.limit?.type).toBe('number');
    expect(schema.properties.verbose?.type).toBe('boolean');
  });

  test('marks path parameters required even when the flag is absent', () => {
    const schema = inferInputSchema(
      [
        { name: 'id', location: 'path' },
        { name: 'optional', location: 'query', required: false }
      ],
      null
    ) as { required: string[] };
    expect(schema.required).toContain('id');
    expect(schema.required).not.toContain('optional');
  });

  test('adds body fields and discovers raw template placeholders', () => {
    const body: HttpBodyMapping = {
      mode: 'raw',
      template: '{"name": "{{name}}", "age": {{age}}}',
      fields: [{ name: 'ignoredField', location: 'body' }]
    };
    const schema = inferInputSchema([], body) as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['age', 'name']);
    expect(schema.required.sort()).toEqual(['age', 'name']);
  });

  test('exposes a passthrough body as a single object property', () => {
    const schema = inferInputSchema([], { mode: 'json', passthrough: true }) as {
      required: string[];
      properties: Record<string, { type?: string }>;
    };
    expect(schema.properties.body?.type).toBe('object');
    expect(schema.required).toContain('body');
  });
});

describe('validateInput', () => {
  const parameters: HttpParameterMapping[] = [
    { name: 'id', location: 'path', required: true, type: 'string' },
    { name: 'limit', location: 'query', type: 'number' },
    { name: 'archived', location: 'query', type: 'boolean' },
    { name: 'tags', location: 'body', type: 'array' },
    { name: 'meta', location: 'body', type: 'object' }
  ];
  const schema = inferInputSchema(parameters, null);

  test('accepts a valid input and applies declared defaults', () => {
    const withDefault: HttpParameterMapping[] = [
      { name: 'id', location: 'path', required: true, type: 'string' },
      param({ name: 'limit', type: 'number', default: 10 })
    ];
    const value = validateInput(inferInputSchema(withDefault, null), withDefault, { id: 'c1' });
    expect(value.id).toBe('c1');
    expect(value.limit).toBe(10);
  });

  test('rejects a missing required parameter', () => {
    expect(() => validateInput(schema, parameters, {})).toThrow(/id/);
  });

  test('rejects a value of the wrong type', () => {
    expect(() => validateInput(schema, parameters, { id: 'c1', limit: 'many' })).toThrow(/number/i);
    expect(() => validateInput(schema, parameters, { id: 'c1', archived: 'yes' })).toThrow(
      /boolean/i
    );
  });

  test('rejects unknown properties when the schema is closed', () => {
    expect(() => validateInput(schema, parameters, { id: 'c1', nope: true })).toThrow(/nope/);
  });

  test('throws an AppError with a validation code and structured details', () => {
    try {
      validateInput(schema, parameters, { limit: 'many' });
      throw new Error('expected validateInput to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('validation_failed');
      const details = (error as { details?: { errors?: unknown[] } }).details;
      expect(Array.isArray(details?.errors)).toBe(true);
      expect(details?.errors?.length).toBeGreaterThan(0);
    }
  });
});

describe('applyBodyMapping', () => {
  test('mode none produces no body', () => {
    expect(applyBodyMapping({ mode: 'none' }, { a: 1 })).toEqual({});
  });

  test('json mode maps declared fields to wire names', () => {
    const result = applyBodyMapping(
      {
        mode: 'json',
        fields: [
          { name: 'firstName', location: 'body', wireName: 'first_name' },
          { name: 'age', location: 'body', type: 'number' }
        ]
      },
      { firstName: 'Ada', age: 36, ignored: true }
    );
    expect(result.contentType).toBe('application/json');
    expect(JSON.parse(result.body ?? '{}')).toEqual({ first_name: 'Ada', age: 36 });
  });

  test('json passthrough sends the whole body object', () => {
    const result = applyBodyMapping(
      { mode: 'json', passthrough: true },
      { body: { x: 1, y: [2] } }
    );
    expect(JSON.parse(result.body ?? '{}')).toEqual({ x: 1, y: [2] });
  });

  test('form mode serialises fields as url-encoded form data', () => {
    const result = applyBodyMapping(
      {
        mode: 'form',
        fields: [
          { name: 'q', location: 'body' },
          { name: 'page', location: 'body' }
        ]
      },
      { q: 'hello world', page: 2 }
    );
    expect(result.contentType).toBe('application/x-www-form-urlencoded');
    expect(result.body).toBe('q=hello+world&page=2');
  });

  test('raw mode substitutes placeholders', () => {
    const result = applyBodyMapping(
      { mode: 'raw', contentType: 'application/xml', template: '<name>{{name}}</name>' },
      { name: 'Ada' }
    );
    expect(result.body).toBe('<name>Ada</name>');
    expect(result.contentType).toBe('application/xml');
  });

  test('raw mode renders an empty string for absent optional placeholders', () => {
    const result = applyBodyMapping({ mode: 'raw', template: 'a={{a}}' }, {});
    expect(result.body).toBe('a=');
  });
});

describe('applyResponseMapping', () => {
  const body = { data: { contact: { id: 'c1', email: 'a@b.c' } }, meta: { page: 1 } };

  test('selects a nested bodyPath', () => {
    expect(selectBodyPath(body, 'data.contact')).toEqual({ id: 'c1', email: 'a@b.c' });
    expect(selectBodyPath(body, 'data.contact.email')).toBe('a@b.c');
    expect(selectBodyPath(body, 'data.missing.deep')).toBeUndefined();
  });

  test('supports array indexing in a bodyPath', () => {
    expect(selectBodyPath({ items: [{ id: 'a' }, { id: 'b' }] }, 'items[1].id')).toBe('b');
  });

  test('returns the parsed body unchanged without a mapping', () => {
    expect(applyResponseMapping(body, null)).toEqual(body);
  });

  test('projects a stable output shape from an outputTemplate', () => {
    const mapping: HttpResponseMapping = {
      bodyPath: 'data.contact',
      outputTemplate: {
        contactId: '{{id}}',
        email: '{{email}}',
        source: 'hubspot'
      }
    };
    expect(applyResponseMapping(body, mapping)).toEqual({
      contactId: 'c1',
      email: 'a@b.c',
      source: 'hubspot'
    });
  });

  test('preserves the raw type when the template is exactly one placeholder', () => {
    const mapping: HttpResponseMapping = {
      bodyPath: 'data.contact',
      outputTemplate: { literal: 'fixed', contact: '{{}}', tags: '{{meta.missing}}' }
    };
    const output = applyResponseMapping(body, mapping) as Record<string, unknown>;
    expect(output.contact).toEqual({ id: 'c1', email: 'a@b.c' });
    expect(output.literal).toBe('fixed');
    expect(output.tags).toBe('');
  });

  test('parses a JSON string response for bodyPath selection', () => {
    expect(applyResponseMapping('{"ok":true}', { bodyPath: 'ok' })).toBe(true);
  });
});

describe('evaluateSuccessRules', () => {
  test('treats 2xx as success by default and non-2xx as failure', () => {
    expect(evaluateSuccessRules(null, 200, {}).ok).toBe(true);
    expect(evaluateSuccessRules(null, 204, {}).ok).toBe(true);
    expect(evaluateSuccessRules(null, 302, {}).ok).toBe(false);
    expect(evaluateSuccessRules(null, 500, {}).ok).toBe(false);
  });

  test('honours an explicit statusCodes allow-list', () => {
    expect(evaluateSuccessRules({ statusCodes: [200, 202] }, 202, {}).ok).toBe(true);
    expect(evaluateSuccessRules({ statusCodes: [200, 202] }, 201, {}).ok).toBe(false);
  });

  test('fails when failWhenPath is truthy', () => {
    const rules: HttpSuccessRules = { failWhenPath: 'error' };
    expect(evaluateSuccessRules(rules, 200, { error: 'boom' }).ok).toBe(false);
    expect(evaluateSuccessRules(rules, 200, { error: null }).ok).toBe(true);
    expect(evaluateSuccessRules(rules, 200, { error: false }).ok).toBe(true);
    expect(evaluateSuccessRules(rules, 200, { data: {} }).ok).toBe(true);
  });

  test('fails when the body contains a forbidden substring', () => {
    const rules: HttpSuccessRules = { failWhenBodyContains: 'rate limit exceeded' };
    expect(evaluateSuccessRules(rules, 200, { message: 'RATE LIMIT EXCEEDED' }).ok).toBe(false);
    expect(evaluateSuccessRules(rules, 200, { message: 'ok' }).ok).toBe(true);
  });

  test('reports a human-readable reason on failure', () => {
    expect(evaluateSuccessRules(null, 404, {}).reason).toMatch(/404/);
    expect(evaluateSuccessRules({ failWhenPath: 'error' }, 200, { error: true }).reason).toMatch(
      /error/
    );
  });
});
