/**
 * Authoring Zod schemas as source (ADR-0023 revision).
 *
 * Object Types, Workflow overlays and Workflow States can be defined by pasting a
 * Zod schema directly instead of assembling fields one by one. The source is the
 * authoritative contract: it is stored verbatim and re-compiled whenever a record
 * is validated, so the same schema can be tested while authoring and *run later*
 * by the engine.
 *
 * The schema is also projected onto the typed-field engine (`field_definitions` /
 * `object_type_fields` / `workflow_fields`) so record lists, filters, history and
 * analytics keep working. Projection is best-effort: constructs the field engine
 * cannot type (records, tuples, unions, transforms) become `json` fields, while the
 * stored Zod source still validates them exactly.
 *
 * Security note: the source is JavaScript, so compiling it means executing it. That
 * is confined to a `new Function` factory whose only lexical binding is `z`; every
 * dangerous global is shadowed with `undefined`. This is admin-authored workspace
 * configuration in a self-hosted product — the same trust boundary as a workflow
 * template — but it is documented rather than implied.
 */
import { z } from 'zod';
import type { FieldOptions, FieldType, FieldValidation } from '../db/schema';

/** Longer than any hand-authored contract should be; a guard, not a target. */
export const MAX_ZOD_SOURCE_LENGTH = 20_000;

/**
 * Compiling source means building a function. Building it once per distinct source
 * keeps contract validation off the hot path while work items are submitted.
 */
const COMPILE_CACHE = new Map<string, ZodCompileResult>();
const COMPILE_CACHE_LIMIT = 200;

/**
 * Globals shadowed with `undefined` inside the compiled factory. This is
 * defence-in-depth, not a sandbox: a determined author can still escape via
 * constructors. See the module note.
 */
const GUARDED_BINDINGS = [
  'require',
  'module',
  'exports',
  'process',
  'global',
  'globalThis',
  'fetch',
  'Bun',
  'Deno',
  'WebSocket',
  'XMLHttpRequest',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'Worker',
  'SharedWorker',
  'navigator',
  'document',
  'window',
  'self',
  'top',
  'parent',
  'frames',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'crypto',
  'Reflect',
  'Proxy',
  'importScripts'
] as const;

export interface ZodSchemaIssue {
  path: string;
  message: string;
}

/** One field derived from a Zod object schema, before it is persisted. */
export interface ProjectedZodField {
  /** Normalized field key (the object key run through the field-key rules). */
  key: string;
  /** Human display name derived from the key unless the schema describes it. */
  name: string;
  type: FieldType;
  required: boolean;
  description: string | null;
  options: FieldOptions | null;
  validation: FieldValidation | null;
  defaultValue: unknown;
  /**
   * Binding flags, read from `.meta({...})` on the field schema. They let a schema
   * author keep identity/display behaviour without a per-field form.
   */
  isIdentity: boolean;
  isPrimaryDisplay: boolean;
  showInList: boolean;
  showOnCard: boolean;
  filterable: boolean;
  /** The raw `.meta()` values, so a save can tell "unset" from "explicitly false". */
  meta: {
    identity?: boolean;
    primary?: boolean;
    list?: boolean;
    card?: boolean;
    filterable?: boolean;
  };
}

export interface ZodCompileSuccess {
  ok: true;
  /** The stored, trimmed source that produced this schema. */
  source: string;
  schema: z.ZodTypeAny;
  /** Present only when the top-level value is a Zod object. */
  object: z.ZodObject<z.ZodRawShape> | null;
  fields: ProjectedZodField[];
  /** Object keys that cannot become field keys, reported rather than dropped silently. */
  invalidKeys: string[];
}

export interface ZodCompileFailure {
  ok: false;
  message: string;
  /** Compiler output when evaluation failed with a SyntaxError. */
  detail?: string;
}

export type ZodCompileResult = ZodCompileSuccess | ZodCompileFailure;

export interface ZodSchemaTestResult {
  /** True when the schema compiled *and* the sample parsed. */
  ok: boolean;
  compiled: boolean;
  message: string | null;
  issues: ZodSchemaIssue[];
  /** Parsed (and possibly coerced/transformed) data on success. */
  data: unknown;
  fields: ProjectedZodField[];
  invalidKeys: string[];
}

/** Compile stored/pasted Zod source into a schema and its field projection. */
export function compileZodSource(source: string): ZodCompileResult {
  const trimmed = source.trim();
  const cached = COMPILE_CACHE.get(trimmed);
  if (cached) return cached;
  const result = evaluateZodSource(trimmed);
  if (COMPILE_CACHE.size >= COMPILE_CACHE_LIMIT) {
    const oldest = COMPILE_CACHE.keys().next().value;
    if (oldest !== undefined) COMPILE_CACHE.delete(oldest);
  }
  COMPILE_CACHE.set(trimmed, result);
  return result;
}

function evaluateZodSource(trimmed: string): ZodCompileResult {
  if (trimmed.length === 0) {
    return {
      ok: false,
      message: 'The schema is empty. Provide a Zod expression such as z.object({}).'
    };
  }
  if (trimmed.length > MAX_ZOD_SOURCE_LENGTH) {
    return {
      ok: false,
      message: `The schema is too long (${trimmed.length} characters; the limit is ${MAX_ZOD_SOURCE_LENGTH}).`
    };
  }

  let produced: unknown;
  try {
    const factory = new Function(
      'z',
      ...GUARDED_BINDINGS,
      `"use strict"; return (\n${trimmed}\n);`
    ) as (...args: unknown[]) => unknown;
    produced = factory(z, ...GUARDED_BINDINGS.map(() => undefined));
  } catch (failure) {
    return {
      ok: false,
      message: `The schema could not be evaluated: ${errorMessage(failure)}`,
      detail: failure instanceof Error ? failure.stack : undefined
    };
  }

  if (!isZodSchema(produced)) {
    return {
      ok: false,
      message:
        'The expression must evaluate to a Zod schema, for example z.object({ name: z.string() }).'
    };
  }

  const object = isZodObject(produced) ? produced : null;
  const projected = object ? projectZodFields(object) : { fields: [], invalidKeys: [] };
  return {
    ok: true,
    source: trimmed,
    schema: produced,
    object,
    fields: projected.fields,
    invalidKeys: projected.invalidKeys
  };
}

function errorMessage(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  return String(failure);
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  if (value instanceof z.ZodType) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function' &&
    typeof (value as { parse?: unknown }).parse === 'function'
  );
}

function isZodObject(value: z.ZodTypeAny): value is z.ZodObject<z.ZodRawShape> {
  return schemaType(value) === 'object' && isRecord(schemaShape(value));
}

/**
 * Compile the source and parse a JSON sample against it, returning both the parse
 * result and the field projection so the author can see what saving will create.
 */
export function testZodSource(source: string, sample: unknown): ZodSchemaTestResult {
  const compiled = compileZodSource(source);
  if (!compiled.ok) {
    return {
      ok: false,
      compiled: false,
      message: compiled.message,
      issues: [],
      data: null,
      fields: [],
      invalidKeys: []
    };
  }
  const parsed = compiled.schema.safeParse(sample);
  if (parsed.success) {
    return {
      ok: true,
      compiled: true,
      message: null,
      issues: [],
      data: parsed.data,
      fields: compiled.fields,
      invalidKeys: compiled.invalidKeys
    };
  }
  return {
    ok: false,
    compiled: true,
    message: 'The sample does not satisfy this schema.',
    issues: zodIssues(parsed.error.issues),
    data: null,
    fields: compiled.fields,
    invalidKeys: compiled.invalidKeys
  };
}

/**
 * Validate raw data against stored Zod source at runtime. A schema that no longer
 * compiles is a validation failure, not a crash: the contract is explicit about
 * what the data must be.
 */
export function validateAgainstZodSource(
  source: string,
  raw: unknown
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: ZodSchemaIssue[] } {
  const compiled = compileZodSource(source);
  if (!compiled.ok) {
    return { ok: false, issues: [{ path: '', message: compiled.message }] };
  }
  const parsed = compiled.schema.safeParse(raw ?? {});
  if (parsed.success) {
    return { ok: true, data: (parsed.data ?? {}) as Record<string, unknown> };
  }
  return { ok: false, issues: zodIssues(parsed.error.issues) };
}

/** Derive the typed-field projection of a Zod object schema. */
export function projectZodFields(schema: z.ZodObject<z.ZodRawShape>): {
  fields: ProjectedZodField[];
  invalidKeys: string[];
} {
  const shape = schemaShape(schema) ?? {};
  const fields: ProjectedZodField[] = [];
  const invalidKeys: string[] = [];
  for (const [rawKey, node] of Object.entries(shape)) {
    const key = toFieldKey(rawKey);
    if (key === null) {
      invalidKeys.push(rawKey);
      continue;
    }
    const described = describeNode(node);
    const meta = collectMeta(node);
    fields.push({
      key,
      name: humanizeKey(rawKey),
      type: described.type,
      required: described.required,
      description: metaDescription(meta),
      options: described.options,
      validation: described.validation,
      defaultValue: described.defaultValue,
      isIdentity: meta.identity === true,
      isPrimaryDisplay: meta.primary === true,
      // Display flags default to today's behaviour; `.meta()` opts out.
      showInList: meta.list !== false,
      showOnCard: meta.card === true,
      filterable: meta.filterable !== false,
      meta: {
        identity: typeof meta.identity === 'boolean' ? meta.identity : undefined,
        primary: typeof meta.primary === 'boolean' ? meta.primary : undefined,
        list: typeof meta.list === 'boolean' ? meta.list : undefined,
        card: typeof meta.card === 'boolean' ? meta.card : undefined,
        filterable: typeof meta.filterable === 'boolean' ? meta.filterable : undefined
      }
    });
  }
  return { fields, invalidKeys };
}

interface DescribedNode {
  type: FieldType;
  required: boolean;
  options: FieldOptions | null;
  validation: FieldValidation | null;
  defaultValue: unknown;
}

/** Unwrap optional/nullable/default/etc. and map the base type to a field type. */
function describeNode(node: z.ZodTypeAny): DescribedNode {
  let current: z.ZodTypeAny = node;
  let required = true;
  let defaultValue: unknown;
  let hasDefault = false;

  for (let depth = 0; depth < 12; depth += 1) {
    const type = schemaType(current);
    if (type === 'optional' || type === 'nonoptional') {
      required = false;
      current = innerType(current) ?? current;
      continue;
    }
    if (type === 'default' || type === 'prefault') {
      // A default makes the key omittable and supplies a value when it is.
      required = false;
      hasDefault = true;
      const declared = schemaDef(current).defaultValue as unknown;
      // A default function cannot be persisted as a field default; the schema
      // still applies it at validation time.
      defaultValue = typeof declared === 'function' ? undefined : declared;
      current = innerType(current) ?? current;
      continue;
    }
    if (type === 'nullable' || type === 'readonly' || type === 'catch') {
      current = innerType(current) ?? current;
      continue;
    }
    break;
  }

  const base = mapBaseType(current);
  if (
    base.type === 'json' &&
    (schemaType(current) === 'unknown' || schemaType(current) === 'any')
  ) {
    // An unconstrained field is effectively optional; requiring `unknown` would
    // force every submission to carry a key with no meaning.
    required = false;
  }
  return {
    ...base,
    required,
    defaultValue: hasDefault ? defaultValue : undefined
  };
}

function mapBaseType(node: z.ZodTypeAny): Omit<DescribedNode, 'required' | 'defaultValue'> {
  const type = schemaType(node);
  switch (type) {
    case 'string':
      return stringMapping(node);
    case 'number':
    case 'bigint':
      return { type: 'number', options: null, validation: numberValidation(node) };
    case 'boolean':
      return { type: 'boolean', options: null, validation: null };
    case 'date':
      return { type: 'datetime', options: null, validation: null };
    case 'enum': {
      const choices = enumChoices(node);
      return choices && choices.length > 0
        ? { type: 'select', options: { choices }, validation: null }
        : { type: 'json', options: null, validation: null };
    }
    case 'literal': {
      const choices = literalChoices(node);
      return choices && choices.length > 0
        ? { type: 'select', options: { choices }, validation: null }
        : { type: 'json', options: null, validation: null };
    }
    case 'array':
      return arrayMapping(node);
    default:
      return { type: 'json', options: null, validation: null };
  }
}

function stringMapping(node: z.ZodTypeAny): Omit<DescribedNode, 'required' | 'defaultValue'> {
  const format = stringFormat(node);
  const validation = stringValidation(node);
  switch (format) {
    case 'email':
      return { type: 'email', options: null, validation };
    case 'url':
      return { type: 'url', options: null, validation };
    case 'e164':
      return { type: 'phone', options: null, validation };
    case 'datetime':
    case 'iso-datetime':
      return { type: 'datetime', options: null, validation };
    case 'date':
      return { type: 'date', options: null, validation };
    default:
      return { type: 'short_text', options: null, validation };
  }
}

function arrayMapping(node: z.ZodTypeAny): Omit<DescribedNode, 'required' | 'defaultValue'> {
  const element = schemaDef(node).element as z.ZodTypeAny | undefined;
  if (element) {
    const unwrapped = unwrapWrappers(element);
    const innerType = schemaType(unwrapped);
    if (innerType === 'enum') {
      const choices = enumChoices(unwrapped);
      if (choices && choices.length > 0) {
        return { type: 'multi_select', options: { choices }, validation: null };
      }
    }
    if (innerType === 'literal') {
      const choices = literalChoices(unwrapped);
      if (choices && choices.length > 0) {
        return { type: 'multi_select', options: { choices }, validation: null };
      }
    }
  }
  // A choice-less string array is not a select; the field engine has no typed
  // column for it, so it becomes JSON while the Zod source keeps validating it.
  return { type: 'json', options: null, validation: null };
}

function unwrapWrappers(node: z.ZodTypeAny): z.ZodTypeAny {
  let current = node;
  for (let depth = 0; depth < 12; depth += 1) {
    const type = schemaType(current);
    if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'prefault') {
      const inner = innerType(current);
      if (!inner) break;
      current = inner;
      continue;
    }
    break;
  }
  return current;
}

function enumChoices(node: z.ZodTypeAny): FieldOptions['choices'] {
  const entries = schemaDef(node).entries as Record<string, string> | undefined;
  if (entries && typeof entries === 'object') {
    return Object.keys(entries).map((value) => ({
      value,
      label: humanizeKey(value)
    }));
  }
  const options = schemaDef(node).options as unknown[] | undefined;
  if (Array.isArray(options)) {
    return options
      .filter((value): value is string => typeof value === 'string')
      .map((value) => ({ value, label: humanizeKey(value) }));
  }
  return undefined;
}

function literalChoices(node: z.ZodTypeAny): FieldOptions['choices'] {
  const values = schemaDef(node).values as unknown[] | undefined;
  const source = Array.isArray(values) ? values : [schemaDef(node).value];
  return source
    .filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number'
    )
    .map((value) => ({ value: String(value), label: humanizeKey(String(value)) }));
}

function stringFormat(node: z.ZodTypeAny): string | null {
  const def = schemaDef(node);
  if (typeof def.format === 'string') return def.format;
  const checks = def.checks as unknown[] | undefined;
  if (!Array.isArray(checks)) return null;
  for (const check of checks) {
    const checkDef = (check as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (checkDef && typeof checkDef.format === 'string' && checkDef.check === 'string_format') {
      return checkDef.format;
    }
  }
  return null;
}

function stringValidation(node: z.ZodTypeAny): FieldValidation | null {
  const validation: FieldValidation = {};
  const checks = schemaDef(node).checks as unknown[] | undefined;
  if (Array.isArray(checks)) {
    for (const check of checks) {
      const checkDef = (check as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
      if (!checkDef) continue;
      if (checkDef.check === 'min_length' && typeof checkDef.minimum === 'number') {
        validation.minLength = checkDef.minimum;
      }
      if (checkDef.check === 'max_length' && typeof checkDef.maximum === 'number') {
        validation.maxLength = checkDef.maximum;
      }
      if (checkDef.check === 'string_format' && checkDef.format === 'regex') {
        const pattern = checkDef.pattern;
        if (pattern instanceof RegExp) validation.pattern = pattern.source;
      }
    }
  }
  // `z.email()` / `z.url()` carry their format regex on the definition; that is a
  // Zod implementation detail, not a rule the field editor should echo back.
  const directPattern = schemaDef(node).pattern;
  if (
    validation.pattern === undefined &&
    directPattern instanceof RegExp &&
    stringFormat(node) === null
  ) {
    validation.pattern = directPattern.source;
  }
  return Object.keys(validation).length > 0 ? validation : null;
}

function numberValidation(node: z.ZodTypeAny): FieldValidation | null {
  const validation: FieldValidation = {};
  const checks = schemaDef(node).checks as unknown[] | undefined;
  if (Array.isArray(checks)) {
    for (const check of checks) {
      const checkDef = (check as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
      if (!checkDef) continue;
      if (
        checkDef.check === 'greater_than' &&
        typeof checkDef.value === 'number' &&
        checkDef.inclusive
      ) {
        validation.min = checkDef.value;
      }
      if (
        checkDef.check === 'less_than' &&
        typeof checkDef.value === 'number' &&
        checkDef.inclusive
      ) {
        validation.max = checkDef.value;
      }
    }
  }
  return Object.keys(validation).length > 0 ? validation : null;
}

function zodIssues(
  issues: Array<{ path: PropertyKey[]; message: string; code?: string; keys?: string[] }>
): ZodSchemaIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      return issue.keys.map((key) => ({ path: key, message: `Unrecognized field: ${key}` }));
    }
    return [{ path: issue.path.map(String).join('.'), message: issue.message }];
  });
}

// --- zod v4 def access -----------------------------------------------------

interface ZodDefShape {
  type?: string;
  shape?: Record<string, z.ZodTypeAny>;
  innerType?: z.ZodTypeAny;
  element?: z.ZodTypeAny;
  defaultValue?: unknown;
  default?: unknown;
  entries?: Record<string, string>;
  options?: unknown;
  values?: unknown[];
  value?: unknown;
  format?: string;
  checks?: unknown[];
  pattern?: unknown;
  [key: string]: unknown;
}

function schemaDef(node: z.ZodTypeAny): ZodDefShape {
  const candidate = (node as unknown as { def?: ZodDefShape }).def;
  return candidate && typeof candidate === 'object' ? candidate : {};
}

function schemaType(node: z.ZodTypeAny): string {
  return schemaDef(node).type ?? '';
}

function innerType(node: z.ZodTypeAny): z.ZodTypeAny | null {
  const inner = schemaDef(node).innerType;
  return inner && typeof inner === 'object' ? inner : null;
}

function schemaShape(node: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const shape = schemaDef(node).shape;
  return isRecord(shape) ? (shape as Record<string, z.ZodTypeAny>) : null;
}

interface FieldMeta {
  description?: unknown;
  identity?: unknown;
  primary?: unknown;
  list?: unknown;
  card?: unknown;
  filterable?: unknown;
}

/**
 * Merge `.meta()` (and `.describe()`) across the wrapper chain so metadata written
 * on either the inner schema or the outer optional/default still applies. Outer
 * values win.
 */
function collectMeta(node: z.ZodTypeAny): FieldMeta {
  const chain: FieldMeta[] = [];
  let current: z.ZodTypeAny | null = node;
  for (let depth = 0; depth < 12 && current; depth += 1) {
    chain.push(readMeta(current));
    current = innerType(current);
  }
  const merged: FieldMeta = {};
  for (const meta of chain.reverse()) Object.assign(merged, meta);
  return merged;
}

function readMeta(node: z.ZodTypeAny): FieldMeta {
  const meta = (node as unknown as { meta?: () => unknown }).meta;
  if (typeof meta === 'function') {
    try {
      const value = meta.call(node);
      if (isRecord(value)) return value as FieldMeta;
    } catch {
      return {};
    }
  }
  const description = (node as unknown as { description?: unknown }).description;
  return typeof description === 'string' ? { description } : {};
}

function metaDescription(meta: FieldMeta): string | null {
  return typeof meta.description === 'string' && meta.description.trim().length > 0
    ? meta.description.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize an object key into a field key. Returns null when the key cannot be
 * represented (`FIELD_KEY_PATTERN`: lowercase letter start, 2-48 chars).
 */
function toFieldKey(rawKey: string): string | null {
  const key = rawKey
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!/^[a-z][a-z0-9_]{1,47}$/.test(key)) return null;
  return key;
}

/** `policy_number` → `Policy number`; camelCase is humanized the same way. */
export function humanizeKey(rawKey: string): string {
  const spaced = rawKey
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (spaced.length === 0) return rawKey;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
