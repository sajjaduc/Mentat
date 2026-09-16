import { describe, expect, test } from 'bun:test';
import type { HttpBodyMapping, HttpParameterMapping } from '../../../src/lib/server/db/schema';
import {
  inferOperationInputSchema,
  inferOutputSchemaFromSample
} from '../../../src/lib/server/http/service';

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  additionalProperties?: boolean;
}

describe('inferOperationInputSchema', () => {
  const parameters: HttpParameterMapping[] = [
    { name: 'id', location: 'path', required: true, type: 'string' },
    { name: 'limit', location: 'query', type: 'number' }
  ];

  test('infers a schema from parameters and body when none is authored', () => {
    const body: HttpBodyMapping = {
      mode: 'json',
      fields: [{ name: 'name', location: 'body', type: 'string', required: true }]
    };
    const schema = inferOperationInputSchema({ parameters, body, inputSchema: null }) as SchemaNode;
    expect(schema.type).toBe('object');
    expect(schema.properties?.id?.type).toBe('string');
    expect(schema.properties?.limit?.type).toBe('number');
    expect(schema.properties?.name?.type).toBe('string');
    expect(schema.required).toContain('id');
    expect(schema.required).toContain('name');
  });

  test('returns the authored schema unchanged when present', () => {
    const authored = { type: 'object', properties: { custom: { type: 'string' } } };
    const schema = inferOperationInputSchema({ parameters, body: null, inputSchema: authored });
    expect(schema).toEqual(authored);
  });
});

describe('inferOutputSchemaFromSample', () => {
  test('infers primitives', () => {
    expect(inferOutputSchemaFromSample('text')).toEqual({ type: 'string' });
    expect(inferOutputSchemaFromSample(42)).toEqual({ type: 'integer' });
    expect(inferOutputSchemaFromSample(4.5)).toEqual({ type: 'number' });
    expect(inferOutputSchemaFromSample(true)).toEqual({ type: 'boolean' });
    expect(inferOutputSchemaFromSample(null)).toEqual({ type: ['null'] });
  });

  test('infers nested objects with required keys', () => {
    const schema = inferOutputSchemaFromSample({
      id: 'c1',
      count: 3,
      nested: { flag: true }
    }) as SchemaNode;
    expect(schema.type).toBe('object');
    expect(schema.properties?.id?.type).toBe('string');
    expect(schema.properties?.count?.type).toBe('integer');
    expect(schema.properties?.nested?.properties?.flag?.type).toBe('boolean');
    expect(schema.required?.sort()).toEqual(['count', 'id', 'nested']);
  });

  test('infers array item schemas from the first element', () => {
    const schema = inferOutputSchemaFromSample([{ id: 'a' }, { id: 'b' }]) as SchemaNode;
    expect(schema.type).toBe('array');
    expect(schema.items?.properties?.id?.type).toBe('string');
  });

  test('returns an empty object schema for an empty array', () => {
    const schema = inferOutputSchemaFromSample([]) as SchemaNode;
    expect(schema.type).toBe('array');
    expect(schema.items).toBeUndefined();
  });
});
