/**
 * OpenAPI import parsing.
 *
 * The importer is the only place a spec is interpreted, so these tests pin the
 * mapping decisions: key namespacing, parameter/body extraction, local `$ref`
 * resolution, and the errors an operator sees for an unusable document.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseOpenApiText,
  previewOpenApi,
  slugifyNamespace
} from '../../../src/lib/server/tools/openapi';

const document = {
  openapi: '3.0.0',
  info: { title: 'Pet Store', version: '1.2.0' },
  servers: [{ url: 'https://api.pets.example' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Max items',
            schema: { type: 'integer' }
          }
        ],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'object', properties: { id: { type: 'string' } } }
                }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createPet',
        summary: 'Create pet',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewPet' } }
          }
        },
        responses: { '201': { description: 'created' } }
      }
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getPet', summary: 'Get pet', responses: {} }
    }
  },
  components: {
    schemas: {
      NewPet: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Pet name' },
          tag: { type: 'string' }
        },
        required: ['name']
      }
    }
  }
};

describe('slugifyNamespace', () => {
  test('produces a key-safe token', () => {
    expect(slugifyNamespace('Pet Store')).toBe('pet-store');
    expect(slugifyNamespace('  ***  ')).toBe('api');
  });
});

describe('parseOpenApiText', () => {
  test('parses JSON', () => {
    expect(parseOpenApiText(JSON.stringify(document)).openapi).toBe('3.0.0');
  });

  test('parses YAML through the runtime parser', () => {
    const yaml = [
      'openapi: 3.0.0',
      'info:',
      '  title: YAML API',
      '  version: "1.0.0"',
      'paths:',
      '  /ping:',
      '    get:',
      '      operationId: ping',
      '      responses: {}'
    ].join('\n');
    const parsed = parseOpenApiText(yaml);
    expect((parsed.info as { title: string }).title).toBe('YAML API');
  });

  test('rejects an empty document', () => {
    expect(() => parseOpenApiText('   ')).toThrow();
  });

  test('rejects a document that is not an object', () => {
    expect(() => parseOpenApiText('[1,2,3]')).toThrow();
  });
});

describe('previewOpenApi', () => {
  test('summarises the document and namespaces its keys', () => {
    const preview = previewOpenApi(JSON.stringify(document));
    expect(preview.title).toBe('Pet Store');
    expect(preview.version).toBe('1.2.0');
    expect(preview.baseUrl).toBe('https://api.pets.example');
    expect(preview.namespace).toBe('pet-store');
    expect(preview.operations.map((operation) => operation.key)).toEqual([
      'pet-store.listpets',
      'pet-store.createpet',
      'pet-store.getpet'
    ]);
  });

  test('honours a caller-supplied namespace', () => {
    const preview = previewOpenApi(JSON.stringify(document), { namespace: 'pets' });
    expect(preview.operations[0]?.key).toBe('pets.listpets');
  });

  test('maps query and path parameters with their types', () => {
    const preview = previewOpenApi(JSON.stringify(document));
    const list = preview.operations.find((operation) => operation.key === 'pet-store.listpets');
    expect(list?.parameters).toHaveLength(1);
    expect(list?.parameters[0]).toMatchObject({ name: 'limit', location: 'query', type: 'number' });

    const get = preview.operations.find((operation) => operation.key === 'pet-store.getpet');
    expect(get?.parameters[0]).toMatchObject({ name: 'petId', location: 'path', required: true });
  });

  test('resolves a request-body $ref into field mappings', () => {
    const preview = previewOpenApi(JSON.stringify(document));
    const create = preview.operations.find((operation) => operation.key === 'pet-store.createpet');
    expect(create?.body).toMatchObject({
      mode: 'json',
      fields: [
        { name: 'name', location: 'body', required: true, description: 'Pet name' },
        { name: 'tag', location: 'body', required: false }
      ]
    });
  });

  test('derives an output schema from the success response', () => {
    const preview = previewOpenApi(JSON.stringify(document));
    const list = preview.operations.find((operation) => operation.key === 'pet-store.listpets');
    expect(list?.outputSchema).toMatchObject({ type: 'array' });
  });

  test('fails clearly when there are no paths', () => {
    expect(() =>
      previewOpenApi(JSON.stringify({ openapi: '3.0.0', info: { title: 'Empty' } }))
    ).toThrow();
  });
});
