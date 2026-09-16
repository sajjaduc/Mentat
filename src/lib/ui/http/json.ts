/**
 * JSON helpers for the editor surfaces.
 *
 * The HTTP editor has to do three things browsers do not do for us: read a JSON
 * Schema into a readable parameter list, synthesise a plausible sample so the Test
 * Request console starts useful, and validate a hand-typed JSON document without
 * throwing. All three live here so the editor components stay about layout.
 *
 * Schemas arrive from the API as `unknown`, so every reader is total: a malformed
 * or absent schema yields an empty list rather than a crash.
 */

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  [key: string]: unknown;
}

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  defaultValue: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Total reader: anything that is not an object with recognisable fields becomes `null`. */
export function asJsonSchema(value: unknown): JsonSchema | null {
  if (!isRecord(value)) return null;
  const schema = value as JsonSchema;
  const hasShape =
    schema.type !== undefined ||
    schema.properties !== undefined ||
    schema.items !== undefined ||
    schema.required !== undefined;
  return hasShape ? schema : null;
}

export function schemaTypeLabel(schema: JsonSchema | null | undefined): string {
  if (!schema) return 'unknown';
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array' && schema.items) return `array<${schemaTypeLabel(schema.items)}>`;
  if (type === 'object' && schema.properties) return 'object';
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((entry) => JSON.stringify(entry)).join(' | ');
  }
  return type ?? 'unknown';
}

/** Flatten an object schema's top level into the rows a parameter list shows. */
export function schemaFields(schema: unknown): SchemaField[] {
  const parsed = asJsonSchema(schema);
  if (!parsed?.properties) return [];
  const required = new Set(parsed.required ?? []);
  return Object.entries(parsed.properties).map(([name, property]) => ({
    name,
    type: schemaTypeLabel(property),
    required: required.has(name),
    description: typeof property.description === 'string' ? property.description : null,
    defaultValue: property.default
  }));
}

/**
 * A plausible sample value for a schema, used to prefill the Test Request input.
 * It is intentionally boring: a string where a string is expected, zero where a
 * number is expected. A caller still has to replace the values that matter.
 */
export function sampleFromSchema(schema: unknown, depth = 0): unknown {
  const parsed = asJsonSchema(schema);
  if (!parsed || depth > 4) return null;
  if (parsed.default !== undefined) return parsed.default;
  if (parsed.enum && parsed.enum.length > 0) return parsed.enum[0];
  const type = Array.isArray(parsed.type)
    ? parsed.type.find((entry) => entry !== 'null')
    : parsed.type;
  switch (type) {
    case 'string':
      return parsed.format === 'date-time' ? new Date(0).toISOString() : '';
    case 'integer':
      return 0;
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(parsed.properties ?? {})) {
        out[name] = sampleFromSchema(property, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse a JSON document, returning the message a user can act on. */
export function parseJson(text: string): JsonParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' };
  }
}

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Parse a JSON document that must be an object. Fields the server validates as
 * records (provider-native options, for example) use this so an array or scalar
 * is rejected here rather than as a 422 after a save.
 */
export function parseJsonObject(text: string): JsonObjectParseResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) return { ok: false, error: 'Expected a JSON object' };
  return { ok: true, value: parsed.value };
}

export function formatJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return String(value);
  }
}
