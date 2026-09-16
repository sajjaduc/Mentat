/**
 * OpenAPI import.
 *
 * Turns an OpenAPI 3.x description into the same operation shape the HTTP service
 * editor produces, so an entire API can become agent tools without hand-mapping every
 * path. The module is deliberately transport-free: it parses and *previews*, and the
 * caller decides which operations to create through the existing HTTP services
 * module. That keeps the policy and audit path identical to a hand-authored
 * operation.
 *
 * A note on scope: references are resolved against `#/components/...` only. External
 * `$ref`s are ignored (the property is dropped) rather than fetched, because import
 * must never make a network request on behalf of the operator.
 */
import { errors } from '../core/errors';
import type { HttpBodyMapping, HttpMethod, HttpParameterMapping } from '../db/schema';
import type { JsonSchema } from './types';

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

const MAX_OPERATIONS = 200;

export interface OpenApiOperationDraft {
  /** Namespaced, model-facing key, e.g. `petstore.listpets`. */
  key: string;
  method: HttpMethod;
  path: string;
  name: string;
  description: string;
  parameters: HttpParameterMapping[];
  body: HttpBodyMapping | null;
  outputSchema: JsonSchema | null;
}

export interface OpenApiPreview {
  title: string;
  version: string | null;
  /** First declared server URL, if any; the wizard lets the operator override it. */
  baseUrl: string | null;
  /** Suggested key prefix derived from the title. */
  namespace: string;
  operations: OpenApiOperationDraft[];
}

/** Lowercase, dot/dash-safe token suitable as a leading operation key segment. */
export function slugifyNamespace(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'api';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a document that may be JSON or YAML.
 *
 * JSON is attempted first because it is unambiguous; YAML goes through Bun's native
 * parser when it is present. The fallback keeps the module usable under a plain Node
 * test runner (where only JSON documents are accepted).
 */
export function parseOpenApiText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw errors.validation('The OpenAPI document is empty');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const yaml = (globalThis as { Bun?: { YAML?: { parse(input: string): unknown } } }).Bun?.YAML;
    if (!yaml) {
      throw errors.validation('The document is not valid JSON, and YAML parsing is unavailable');
    }
    try {
      parsed = yaml.parse(trimmed);
    } catch (failure) {
      throw errors.validation('The document could not be parsed as JSON or YAML', {
        cause: failure instanceof Error ? failure.message : String(failure)
      });
    }
  }

  const record = asRecord(parsed);
  if (!record) throw errors.validation('The OpenAPI document must be an object');
  return record;
}

/** Resolve a local JSON pointer (`#/components/schemas/Foo`) inside the document. */
function resolveRef(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = document;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    const record = asRecord(current);
    if (!record || !(key in record)) return undefined;
    current = record[key];
  }
  return current;
}

function deref(document: Record<string, unknown>, value: unknown): unknown {
  let current = value;
  const seen = new Set<string>();
  while (true) {
    const record = asRecord(current);
    const ref = record?.$ref;
    if (typeof ref !== 'string') return current;
    if (seen.has(ref)) return current;
    seen.add(ref);
    current = resolveRef(document, ref);
    if (current === undefined) return undefined;
  }
}

function schemaTypeOf(schema: unknown): HttpParameterMapping['type'] | undefined {
  const record = asRecord(schema);
  if (!record) return undefined;
  const raw = record.type;
  if (typeof raw === 'string') {
    if (raw === 'integer' || raw === 'number') return 'number';
    if (raw === 'string' || raw === 'boolean' || raw === 'object' || raw === 'array') {
      return raw;
    }
  }
  if (record.items) return 'array';
  if (record.properties) return 'object';
  return undefined;
}

function typeSchema(type: string): JsonSchema {
  switch (type) {
    case 'integer':
      return { type: 'integer' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return { type: 'array', items: { type: 'string' } };
    case 'object':
      return { type: 'object' };
    default:
      return { type: 'string' };
  }
}

/** Convert an OpenAPI schema into a compact JSON Schema for the model contract. */
function toJsonSchema(schema: unknown, depth = 0): JsonSchema {
  const record = asRecord(schema);
  if (!record || depth > 4) return { type: 'object' };
  const type = typeof record.type === 'string' ? record.type : undefined;
  if (!type) return { type: 'object' };
  if (type !== 'object') {
    const base = typeSchema(type);
    if (type === 'array' && record.items) {
      return { type: 'array', items: toJsonSchema(record.items, depth + 1) };
    }
    if (Array.isArray(record.enum)) return { ...base, enum: record.enum };
    return base;
  }

  const properties = asRecord(record.properties) ?? {};
  const required = Array.isArray(record.required)
    ? record.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const converted: Record<string, JsonSchema> = {};
  for (const [name, property] of Object.entries(properties)) {
    converted[name] = toJsonSchema(property, depth + 1);
  }
  return {
    type: 'object',
    properties: converted,
    required,
    additionalProperties: record.additionalProperties === true
  };
}

function parameterMapping(
  document: Record<string, unknown>,
  raw: unknown
): HttpParameterMapping | null {
  const parameter = asRecord(deref(document, raw));
  if (!parameter) return null;
  const name = typeof parameter.name === 'string' ? parameter.name : undefined;
  const location = parameter.in;
  if (!name || (location !== 'path' && location !== 'query' && location !== 'header')) return null;
  const mapping: HttpParameterMapping = {
    name,
    location,
    required: location === 'path' ? true : parameter.required === true
  };
  if (typeof parameter.description === 'string' && parameter.description.length > 0) {
    mapping.description = parameter.description;
  }
  const type = schemaTypeOf(deref(document, parameter.schema));
  if (type) mapping.type = type;
  const schema = asRecord(deref(document, parameter.schema));
  if (schema && 'default' in schema) mapping.default = schema.default;
  return mapping;
}

function bodyMapping(document: Record<string, unknown>, raw: unknown): HttpBodyMapping | null {
  const requestBody = asRecord(deref(document, raw));
  const content = asRecord(requestBody?.content);
  if (!content) return null;
  const json = asRecord(content['application/json']);
  const schema = asRecord(deref(document, json?.schema));
  if (!schema) return null;

  const properties = asRecord(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : []
  );

  // An object schema with named properties maps field-by-field; anything else is sent
  // through as-is so an unusual body is not silently flattened into nothing.
  if (!properties) return { mode: 'json', passthrough: true };

  const fields: HttpParameterMapping[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const propertySchema = asRecord(deref(document, property)) ?? {};
    const field: HttpParameterMapping = {
      name,
      location: 'body',
      required: required.has(name)
    };
    if (typeof propertySchema.description === 'string' && propertySchema.description.length > 0) {
      field.description = propertySchema.description;
    }
    const type = schemaTypeOf(propertySchema);
    if (type) field.type = type;
    if ('default' in propertySchema) field.default = propertySchema.default;
    fields.push(field);
  }
  return { mode: 'json', fields };
}

function responseSchema(document: Record<string, unknown>, responses: unknown): JsonSchema | null {
  const map = asRecord(responses);
  if (!map) return null;
  const preferred = ['200', '201', '202', '2XX', 'default'];
  for (const status of preferred) {
    const response = asRecord(deref(document, map[status]));
    const content = asRecord(response?.content);
    const json = asRecord(content?.['application/json']);
    if (json) {
      const schema = deref(document, json.schema);
      if (schema) return toJsonSchema(schema);
    }
  }
  return null;
}

function operationKey(
  namespace: string,
  operationId: unknown,
  method: HttpMethod,
  path: string
): string {
  const suffix =
    typeof operationId === 'string' && operationId.trim().length > 0
      ? operationId.trim()
      : `${method.toLowerCase()}-${path.replace(/[{}]/g, '').replace(/\//g, '-')}`;
  const cleaned = suffix
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const key = `${namespace}.${cleaned}`.slice(0, 128);
  return key.replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, 'a');
}

/** A key unique within this import, suffixed on collision. */
function uniqueOperationKey(
  namespace: string,
  operationId: unknown,
  method: HttpMethod,
  path: string,
  used: Set<string>
): string {
  const base = operationKey(namespace, operationId, method, path);
  let key = base;
  let attempt = 2;
  while (used.has(key)) {
    key = `${base}-${attempt}`.slice(0, 128);
    attempt += 1;
  }
  used.add(key);
  return key;
}

/**
 * Path-level parameters are shared by every method; operation-level ones override a
 * path-level parameter with the same `in` + `name`.
 */
function mergedParameters(
  document: Record<string, unknown>,
  shared: unknown[],
  operation: Record<string, unknown>
): HttpParameterMapping[] {
  const raws = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  const bySlot = new Map<string, HttpParameterMapping>();
  for (const raw of raws) {
    const mapping = parameterMapping(document, raw);
    if (mapping) bySlot.set(`${mapping.location}:${mapping.name}`, mapping);
  }
  return [...bySlot.values()];
}

function buildOperationDraft(input: {
  document: Record<string, unknown>;
  path: string;
  method: HttpMethod;
  operation: Record<string, unknown>;
  sharedParameters: unknown[];
  namespace: string;
  used: Set<string>;
}): OpenApiOperationDraft {
  const { document, path, method, operation, sharedParameters, namespace, used } = input;
  const key = uniqueOperationKey(namespace, operation.operationId, method, path, used);
  const summary =
    typeof operation.summary === 'string' && operation.summary.length > 0 ? operation.summary : key;
  const description =
    typeof operation.description === 'string'
      ? operation.description
      : typeof operation.summary === 'string'
        ? operation.summary
        : '';

  return {
    key,
    method,
    path,
    name: summary,
    description,
    parameters: mergedParameters(document, sharedParameters, operation),
    body: bodyMapping(document, operation.requestBody),
    outputSchema: responseSchema(document, operation.responses)
  };
}

/**
 * Parse a document into a preview. No database access, no network: the wizard shows
 * exactly what an import would create before anything is written.
 */
export function previewOpenApi(text: string, options: { namespace?: string } = {}): OpenApiPreview {
  const document = parseOpenApiText(text);
  const paths = asRecord(document.paths);
  if (!paths || Object.keys(paths).length === 0) {
    throw errors.validation('This document declares no paths, so there is nothing to import');
  }

  const info = asRecord(document.info);
  const title =
    typeof info?.title === 'string' && info.title.length > 0 ? info.title : 'Imported API';
  const version = typeof info?.version === 'string' ? info.version : null;

  const servers = Array.isArray(document.servers) ? document.servers : [];
  const firstServer = asRecord(servers[0]);
  const baseUrl = typeof firstServer?.url === 'string' ? firstServer.url : null;

  const namespace = slugifyNamespace(options.namespace ?? title);
  const used = new Set<string>();
  const operations: OpenApiOperationDraft[] = [];

  for (const [path, rawPath] of Object.entries(paths)) {
    const pathItem = asRecord(deref(document, rawPath));
    if (!pathItem) continue;
    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = asRecord(pathItem[method.toLowerCase()]);
      if (!operation) continue;
      if (operations.length >= MAX_OPERATIONS) break;
      operations.push(
        buildOperationDraft({
          document,
          path,
          method,
          operation,
          sharedParameters,
          namespace,
          used
        })
      );
    }
  }

  if (operations.length === 0) {
    throw errors.validation('No HTTP operations were found in this document');
  }

  return { title, version, baseUrl, namespace, operations };
}
