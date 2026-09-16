/**
 * Pragmatic record-schema validation.
 *
 * Collections may declare a `schema` describing their documents. Rather than embed a
 * full JSON Schema engine (which would add a dependency and a large compatibility
 * surface), Mentat supports the subset workflow authors actually use: required keys,
 * scalar/container types and enum membership. `additionalProperties` is intentionally
 * ignored — collections are documents, and forbidding unknown keys would make
 * forward-compatible ingestion painful.
 *
 * Every violation is collected before throwing, so a model gets one message listing
 * all the problems instead of discovering them one retry at a time.
 */
import { errors } from '../core/errors';
import { stableStringify } from '../core/hash';

export type RecordSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | 'any';

export interface RecordSchemaProperty {
  type?: RecordSchemaType | RecordSchemaType[];
  enum?: unknown[];
  /** Per-property shorthand for `required: [key]`. */
  required?: boolean;
}

export interface RecordSchema {
  required?: string[];
  properties?: Record<string, RecordSchemaProperty>;
}

export interface SchemaViolation {
  path: string;
  message: string;
}

const TYPES: RecordSchemaType[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
  'any'
];

/** Validate an untrusted schema descriptor; returns null when nothing is declared. */
export function parseRecordSchema(value: unknown): RecordSchema | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    throw errors.validation('Collection schema must be an object');
  }
  const source = value as Record<string, unknown>;
  const schema: RecordSchema = {};
  if (source.required !== undefined) schema.required = parseRequiredList(source.required);
  if (source.properties !== undefined) schema.properties = parsePropertyMap(source.properties);
  return schema;
}

function parseRequiredList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string')) {
    throw errors.validation('Collection schema "required" must be an array of field names');
  }
  return value as string[];
}

function parsePropertyMap(value: unknown): Record<string, RecordSchemaProperty> {
  if (!isPlainObject(value)) {
    throw errors.validation('Collection schema "properties" must be an object');
  }
  const properties: Record<string, RecordSchemaProperty> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    properties[key] = parseProperty(key, raw);
  }
  return properties;
}

function parseProperty(key: string, raw: unknown): RecordSchemaProperty {
  if (!isPlainObject(raw)) {
    throw errors.validation(`Collection schema property "${key}" must be an object`);
  }
  const descriptor = raw as Record<string, unknown>;
  const property: RecordSchemaProperty = {};
  if (descriptor.type !== undefined) property.type = parsePropertyType(key, descriptor.type);
  if (descriptor.enum !== undefined) {
    if (!Array.isArray(descriptor.enum)) {
      throw errors.validation(`Collection schema property "${key}" enum must be an array`);
    }
    property.enum = descriptor.enum;
  }
  if (descriptor.required !== undefined) {
    if (typeof descriptor.required !== 'boolean') {
      throw errors.validation(`Collection schema property "${key}" required must be a boolean`);
    }
    property.required = descriptor.required;
  }
  return property;
}

function parsePropertyType(key: string, value: unknown): RecordSchemaType | RecordSchemaType[] {
  const types = Array.isArray(value) ? value : [value];
  for (const type of types) {
    if (typeof type !== 'string' || !TYPES.includes(type as RecordSchemaType)) {
      throw errors.validation(
        `Collection schema property "${key}" has unsupported type "${String(type)}"`,
        { supported: TYPES }
      );
    }
  }
  return value as RecordSchemaType | RecordSchemaType[];
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collect every way `data` violates `schema`; an empty array means valid. */
export function validateRecordData(
  schema: RecordSchema | null | undefined,
  data: Record<string, unknown>
): SchemaViolation[] {
  if (!schema) return [];
  const properties = schema.properties ?? {};
  const required = collectRequired(schema, properties);
  const violations: SchemaViolation[] = [];

  for (const key of required) {
    if (data[key] === undefined) {
      violations.push({ path: key, message: `Missing required field "${key}"` });
    }
  }

  for (const [key, descriptor] of Object.entries(properties)) {
    const value = data[key];
    if (value === undefined) continue;
    violations.push(...validateProperty(key, descriptor, value));
  }

  return violations;
}

function collectRequired(
  schema: RecordSchema,
  properties: Record<string, RecordSchemaProperty>
): Set<string> {
  const required = new Set(schema.required ?? []);
  for (const [key, descriptor] of Object.entries(properties)) {
    if (descriptor.required) required.add(key);
  }
  return required;
}

function validateProperty(
  key: string,
  descriptor: RecordSchemaProperty,
  value: unknown
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  if (descriptor.type !== undefined && !matchesType(value, descriptor.type)) {
    violations.push({
      path: key,
      message: `Field "${key}" must be of type ${formatTypes(descriptor.type)}`
    });
  }
  if (
    descriptor.enum !== undefined &&
    !descriptor.enum.some((member) => enumEquals(member, value))
  ) {
    violations.push({
      path: key,
      message: `Field "${key}" must be one of: ${descriptor.enum.map(formatValue).join(', ')}`
    });
  }
  return violations;
}

/** Convenience for services: throw a single validation error listing all problems. */
export function assertRecordData(
  schema: RecordSchema | null | undefined,
  data: Record<string, unknown>
): void {
  const violations = validateRecordData(schema, data);
  if (violations.length > 0) {
    throw errors.validation(
      `Record does not match the collection schema (${violations.length} violation${
        violations.length === 1 ? '' : 's'
      })`,
      { violations }
    );
  }
}

function matchesType(value: unknown, type: RecordSchemaType | RecordSchemaType[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesSingleType(value, candidate));
}

function matchesSingleType(value: unknown, type: RecordSchemaType): boolean {
  switch (type) {
    case 'any':
      return true;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function enumEquals(member: unknown, value: unknown): boolean {
  if (member === value) return true;
  if (member === null || value === null) return false;
  if (typeof member === 'object' || typeof value === 'object') {
    return stableStringify(member) === stableStringify(value);
  }
  return false;
}

function formatTypes(type: RecordSchemaType | RecordSchemaType[]): string {
  return (Array.isArray(type) ? type : [type]).join(' | ');
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : stableStringify(value);
}
