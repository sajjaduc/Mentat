/**
 * Parameter, body and response mapping.
 *
 * An HTTP operation has two faces. The *model-facing* face is a JSON Schema plus a
 * stable output shape; the *wire* face is a URL, query string and body that a
 * third-party API understands. Keeping the translation between them in one pure
 * module means the runtime, the editor's Test Request and schema inference all agree
 * about what an operation means.
 *
 * Design notes:
 *  - input inference is best-effort and always *closed* (`additionalProperties: false`),
 *    so a model that invents a parameter is rejected instead of shipping it upstream;
 *  - `applyResponseMapping` projects into a deliberate shape rather than forwarding a
 *    vendor payload verbatim, which is what keeps an agent's context stable when the
 *    vendor changes its response envelope;
 *  - success rules default to 2xx but can be widened (`statusCodes`) or narrowed by
 *    vendor-specific failure conventions (`failWhenPath`, `failWhenBodyContains`).
 */
import { errors } from '../core/errors';
import type {
  HttpBodyMapping,
  HttpParameterMapping,
  HttpResponseMapping,
  HttpSuccessRules
} from '../db/schema';
import type { JsonSchema } from '../tools/types';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]*)\s*\}\}/g;

/** A small structural index, e.g. `{{id}}` in a schema-inferred input. */
interface SchemaProperty {
  type: string;
  description?: string;
}

export { selectBodyPath };

/**
 * Build the JSON Schema a model sees for an operation.
 *
 * `body.fields` describes json/form bodies; `body.template` (raw) describes the
 * placeholders instead. Both are folded into the same closed object schema, and an
 * explicit authored `inputSchema` is left untouched by the caller.
 */
export function inferInputSchema(
  parameters?: readonly HttpParameterMapping[] | null,
  body?: HttpBodyMapping | null
): JsonSchema {
  const properties: Record<string, SchemaProperty> = {};
  const required = new Set<string>();

  const add = (mapping: HttpParameterMapping): void => {
    properties[mapping.name] = mapping.description
      ? { type: mapping.type ?? 'string', description: mapping.description }
      : { type: mapping.type ?? 'string' };
    if (isRequired(mapping)) required.add(mapping.name);
  };

  for (const parameter of parameters ?? []) {
    // For raw bodies the template declares the contract; a stale field list must not
    // leak parameters the wire request never uses.
    if (body?.mode === 'raw' && parameter.location === 'body') continue;
    add(parameter);
  }

  if (body?.mode === 'raw') {
    for (const name of templatePlaceholders(body.template ?? '')) {
      if (!properties[name]) {
        properties[name] = { type: 'string' };
        required.add(name);
      }
    }
  } else if (body?.passthrough) {
    properties.body = { type: 'object' };
    required.add('body');
  } else {
    for (const field of body?.fields ?? []) add(field);
  }

  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false
  };
}

/**
 * Validate model-supplied input and normalise it with declared defaults/constants.
 *
 * Throws `errors.validation` carrying a structured `errors` array so the editor and
 * the agent runner can render precise feedback without parsing a message string.
 */
export function validateInput(
  inputSchema: unknown,
  parameters: readonly HttpParameterMapping[] | null | undefined,
  input: unknown
): Record<string, unknown> {
  if (
    input !== undefined &&
    input !== null &&
    (typeof input !== 'object' || Array.isArray(input))
  ) {
    throw errors.validation('Operation input must be an object');
  }

  const provided = (input ?? {}) as Record<string, unknown>;
  const value: Record<string, unknown> = { ...provided };
  const declarations = parameters ?? [];

  for (const mapping of declarations) {
    if (value[mapping.name] === undefined) {
      if (mapping.constant !== undefined) value[mapping.name] = mapping.constant;
      else if (mapping.default !== undefined) value[mapping.name] = mapping.default;
    }
  }

  const schema = asSchemaObject(inputSchema) ?? inferInputSchema(declarations, null);
  const properties = asProperties(schema.properties);
  const required = requiredNames(schema, declarations);
  const strict = schema.additionalProperties === false;
  const issues: Array<{ path: string; message: string }> = [];

  for (const name of required) {
    const current = value[name];
    if (current === undefined || current === null || current === '') {
      issues.push({ path: name, message: 'Required parameter is missing' });
    }
  }

  for (const [name, current] of Object.entries(value)) {
    if (current === undefined || current === null) continue;
    const property = properties[name];
    if (!property) {
      if (strict) issues.push({ path: name, message: `Unknown parameter "${name}"` });
      continue;
    }
    if (typeof property.type === 'string') {
      if (!matchesType(current, property.type)) {
        issues.push({ path: name, message: `Parameter "${name}" must be a ${property.type}` });
      }
    } else if (Array.isArray(property.type)) {
      if (!property.type.some((type) => matchesType(current, type))) {
        issues.push({
          path: name,
          message: `Parameter "${name}" must be one of: ${property.type.join(', ')}`
        });
      }
    }
  }

  if (issues.length > 0) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw errors.validation(`Invalid operation input: ${summary}`, { errors: issues });
  }
  return value;
}

/** Turn a mapped body into the bytes and content type that go on the wire. */
export function applyBodyMapping(
  body: HttpBodyMapping | null | undefined,
  input: Record<string, unknown>
): { body?: string; contentType?: string } {
  if (!body || body.mode === 'none') return {};

  switch (body.mode) {
    case 'json': {
      if (body.passthrough) {
        const payload = input.body ?? input;
        return {
          body: JSON.stringify(payload),
          contentType: body.contentType ?? 'application/json'
        };
      }
      const payload = collectFields(body.fields ?? [], input);
      return { body: JSON.stringify(payload), contentType: body.contentType ?? 'application/json' };
    }
    case 'form': {
      const params = new URLSearchParams();
      for (const [key, entry] of Object.entries(collectFields(body.fields ?? [], input))) {
        params.append(key, scalarToString(entry));
      }
      return {
        body: params.toString(),
        contentType: body.contentType ?? 'application/x-www-form-urlencoded'
      };
    }
    case 'raw': {
      const template = body.template ?? '';
      const rendered = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
        const entry = name.length === 0 ? input : resolvePath(input, name);
        return entry === undefined || entry === null ? '' : scalarToString(entry);
      });
      return { body: rendered, contentType: body.contentType ?? 'text/plain' };
    }
    default: {
      const exhaustive: never = body.mode;
      throw errors.unsupported(`Unsupported HTTP body mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * Select and project a response into the shape the model sees.
 *
 * Without a mapping the body is returned as-is; with one, `bodyPath` selects a
 * subtree and `outputTemplate` renames/derives fields. A template that is a single
 * placeholder preserves the value's native type rather than stringifying it.
 */
export function applyResponseMapping(
  responseBody: unknown,
  mapping?: HttpResponseMapping | null
): unknown {
  const parsed = parseMaybeJson(responseBody);
  const selected = mapping?.bodyPath ? selectBodyPath(parsed, mapping.bodyPath) : parsed;
  if (!mapping?.outputTemplate) return selected;

  const context = buildTemplateContext(selected);
  const output: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(mapping.outputTemplate)) {
    output[key] = typeof template === 'string' ? renderTemplate(template, context) : template;
  }
  return output;
}

export function evaluateSuccessRules(
  rules: HttpSuccessRules | null | undefined,
  status: number,
  body: unknown
): { ok: boolean; reason?: string } {
  const explicit = rules?.statusCodes;
  let ok = explicit ? explicit.includes(status) : status >= 200 && status < 300;
  let reason: string | undefined;

  if (ok && rules?.failWhenPath) {
    if (isTruthy(selectBodyPath(parseMaybeJson(body), rules.failWhenPath))) {
      ok = false;
      reason = `Response flag "${rules.failWhenPath}" indicated failure`;
    }
  }

  if (ok && rules?.failWhenBodyContains) {
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    if (text.toLowerCase().includes(rules.failWhenBodyContains.toLowerCase())) {
      ok = false;
      reason = `Response body contained "${rules.failWhenBodyContains}"`;
    }
  }

  if (!ok && !reason) reason = `HTTP ${status}`;
  return reason ? { ok, reason } : { ok };
}

/** JSONPath-ish lookup with dot access and `[n]` indexing. */
function selectBodyPath(value: unknown, path: string): unknown {
  if (!path) return value;
  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((token) => token.length > 0);
  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[Number(token)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Render one output-template value against a projection context. */
function renderTemplate(template: string, context: Record<string, unknown>): unknown {
  const matches = [...template.matchAll(PLACEHOLDER_RE)];
  const single = matches.length === 1 && matches[0]?.[0] === template;
  if (single) {
    const name = matches[0]?.[1] ?? '';
    const resolved = name.length === 0 ? context.$value : resolvePath(context, name);
    return resolved === undefined || resolved === null ? '' : resolved;
  }
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const resolved = name.length === 0 ? context.$value : resolvePath(context, name);
    return resolved === undefined || resolved === null ? '' : scalarToString(resolved);
  });
}

function buildTemplateContext(selected: unknown): Record<string, unknown> {
  if (selected !== null && typeof selected === 'object' && !Array.isArray(selected)) {
    return { ...(selected as Record<string, unknown>), $value: selected, value: selected };
  }
  return { $value: selected, value: selected, data: selected, result: selected };
}

function resolvePath(value: unknown, path: string): unknown {
  return selectBodyPath(value, path);
}

function collectFields(
  fields: readonly HttpParameterMapping[],
  input: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = resolveFieldValue(field, input);
    if (value === undefined) continue;
    out[field.wireName ?? field.name] = value;
  }
  return out;
}

function resolveFieldValue(mapping: HttpParameterMapping, input: Record<string, unknown>): unknown {
  if (mapping.constant !== undefined) return mapping.constant;
  const supplied = input[mapping.name];
  if (supplied !== undefined && supplied !== null) return supplied;
  return mapping.default;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function asSchemaObject(schema: unknown): Record<string, unknown> | null {
  return schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : null;
}

function asProperties(value: unknown): Record<string, { type?: string | string[] }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, { type?: string | string[] }>;
}

function requiredNames(
  schema: Record<string, unknown>,
  declarations: readonly HttpParameterMapping[]
): string[] {
  if (Array.isArray(schema.required)) {
    return schema.required.filter((entry): entry is string => typeof entry === 'string');
  }
  return declarations.filter(isRequired).map((mapping) => mapping.name);
}

function isRequired(mapping: HttpParameterMapping): boolean {
  return mapping.required ?? mapping.location === 'path';
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function templatePlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

function scalarToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}
