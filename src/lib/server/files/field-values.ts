/**
 * Field-value normalisation.
 *
 * `field_definitions.type` is the contract between the UI, extraction and
 * filtering, but values arrive from humans (strings), agents (JSON) and models
 * (often strings-for-numbers). Exactly one function turns any of those into the
 * typed columns plus a lowercase `search_text` projection, so `file_field_values`
 * is never a bag of loosely-typed JSON (ADR-0005). Validation failures are
 * `errors.validation`, which keeps extraction and correction on the same rails.
 */

import { errors } from '../core/errors';
import type { FieldDefinition } from '../db/schema';

export interface NormalizedFieldValue {
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: number | null;
  valueJson: unknown | null;
  /** Lowercase projection used by portable text filters. */
  searchText: string | null;
  /** Canonical, JSON-safe representation used in history rows and API output. */
  display: unknown;
  isEmpty: boolean;
}

export interface TypedFieldValueColumns {
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: number | null;
  valueJson: unknown | null;
}

const EMPTY: NormalizedFieldValue = {
  valueText: null,
  valueNumber: null,
  valueBool: null,
  valueDate: null,
  valueJson: null,
  searchText: null,
  display: null,
  isEmpty: true
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeFieldValue(
  definition: Pick<FieldDefinition, 'type' | 'options' | 'validation' | 'key'>,
  raw: unknown
): NormalizedFieldValue {
  if (isEmptyInput(raw)) return { ...EMPTY };

  switch (definition.type) {
    case 'short_text':
    case 'long_text':
      return fromText(definition, requireString(raw, definition));
    case 'url':
      return fromText(definition, requireUrl(raw, definition));
    case 'email':
      return fromText(definition, requireEmail(raw, definition));
    case 'phone':
      return fromText(definition, requirePhone(raw, definition));
    case 'number':
      return fromNumber(definition, requireNumber(raw, definition));
    case 'currency':
      return fromNumber(definition, parseCurrency(raw, definition));
    case 'boolean':
      return fromBoolean(requireBoolean(raw, definition));
    case 'date': {
      const parsed = requireDate(raw, definition);
      return fromDate(parsed.ms, parsed.display, 'date');
    }
    case 'datetime': {
      const parsed = requireDate(raw, definition);
      return fromDate(parsed.ms, parsed.display, 'datetime');
    }
    case 'select':
      return fromText(definition, requireChoice(definition, raw));
    case 'multi_select':
      return fromMultiChoice(definition, raw);
    case 'user':
    case 'team':
      return fromText(definition, requireIdentifier(raw, definition));
    case 'json':
      return fromJson(requireJson(raw, definition));
    default:
      throw errors.validation(`Unsupported field type: ${String(definition.type)}`, {
        field: definition.key
      });
  }
}

/** Reconstruct the canonical value from stored typed columns. */
export function readFieldValue(
  row: TypedFieldValueColumns,
  definition: Pick<FieldDefinition, 'type'>
): unknown {
  switch (definition.type) {
    case 'number':
    case 'currency':
      return row.valueNumber;
    case 'boolean':
      return row.valueBool;
    case 'date':
      return row.valueDate === null || row.valueDate === undefined
        ? null
        : new Date(row.valueDate).toISOString().slice(0, 10);
    case 'datetime':
      return row.valueDate === null || row.valueDate === undefined
        ? null
        : new Date(row.valueDate).toISOString();
    case 'json':
    case 'multi_select':
      return row.valueJson ?? null;
    default:
      return row.valueText;
  }
}

function isEmptyInput(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

function base(display: unknown, searchText: string | null): NormalizedFieldValue {
  return { ...EMPTY, display, searchText, isEmpty: false };
}

function fromText(
  definition: Pick<FieldDefinition, 'validation' | 'key'>,
  value: string
): NormalizedFieldValue {
  applyValidation(definition, value);
  return { ...base(value, value.toLowerCase()), valueText: value };
}

function fromNumber(
  definition: Pick<FieldDefinition, 'validation' | 'key'>,
  value: number
): NormalizedFieldValue {
  validateBounds(definition, value);
  return { ...base(value, String(value)), valueNumber: value };
}

function fromBoolean(value: boolean): NormalizedFieldValue {
  return { ...base(value, value ? 'true' : 'false'), valueBool: value };
}

function fromDate(ms: number, display: string, kind: 'date' | 'datetime'): NormalizedFieldValue {
  const canonical = kind === 'date' ? new Date(ms).toISOString().slice(0, 10) : display;
  return { ...base(canonical, canonical.toLowerCase()), valueDate: ms };
}

function fromMultiChoice(
  definition: Pick<FieldDefinition, 'options' | 'key'>,
  raw: unknown
): NormalizedFieldValue {
  if (!Array.isArray(raw)) {
    throw errors.validation(`Field "${definition.key}" expects a list of choices`, {
      field: definition.key
    });
  }
  const choices = definition.options?.choices ?? [];
  const values = raw.map((entry) => resolveChoice(choices, entry, definition.key));
  return { ...base(values, values.join(' ').toLowerCase()), valueJson: values };
}

function fromJson(value: unknown): NormalizedFieldValue {
  const search = JSON.stringify(value).toLowerCase();
  return { ...base(value, search), valueJson: value };
}

function requireString(raw: unknown, definition: Pick<FieldDefinition, 'key'>): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  throw errors.validation(`Field "${definition.key}" expects text`, { field: definition.key });
}

function requireUrl(raw: unknown, definition: Pick<FieldDefinition, 'key'>): string {
  const value = requireString(raw, definition);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw errors.validation(`Field "${definition.key}" expects a valid URL`, {
      field: definition.key
    });
  }
  if (!URL_PROTOCOLS.has(parsed.protocol)) {
    throw errors.validation(`Field "${definition.key}" expects an http(s) URL`, {
      field: definition.key
    });
  }
  return value;
}

function requireEmail(raw: unknown, definition: Pick<FieldDefinition, 'key'>): string {
  const value = requireString(raw, definition);
  if (!EMAIL_RE.test(value)) {
    throw errors.validation(`Field "${definition.key}" expects a valid email address`, {
      field: definition.key
    });
  }
  return value;
}

function requirePhone(raw: unknown, definition: Pick<FieldDefinition, 'key'>): string {
  const value = requireString(raw, definition);
  if (value.replace(/[^0-9]/g, '').length < 3) {
    throw errors.validation(`Field "${definition.key}" expects a phone number`, {
      field: definition.key
    });
  }
  return value;
}

function requireNumber(raw: unknown, definition: Pick<FieldDefinition, 'key'>): number {
  const value = toFiniteNumber(raw);
  if (value === null) {
    throw errors.validation(`Field "${definition.key}" expects a number`, {
      field: definition.key
    });
  }
  return value;
}

function parseCurrency(raw: unknown, definition: Pick<FieldDefinition, 'key'>): number {
  if (typeof raw === 'number') {
    return requireNumber(raw, definition);
  }
  if (typeof raw !== 'string') {
    throw errors.validation(`Field "${definition.key}" expects an amount`, {
      field: definition.key
    });
  }
  // Tolerate thousands separators and currency symbols from humans and models.
  const cleaned = raw.replace(/[^0-9.eE+-]/g, '');
  const value = toFiniteNumber(cleaned);
  if (value === null) {
    throw errors.validation(`Field "${definition.key}" expects an amount`, {
      field: definition.key
    });
  }
  return value;
}

function requireBoolean(raw: unknown, definition: Pick<FieldDefinition, 'key'>): boolean {
  const value = toBoolean(raw);
  if (value === null) {
    throw errors.validation(`Field "${definition.key}" expects a boolean`, {
      field: definition.key
    });
  }
  return value;
}

function requireDate(
  raw: unknown,
  definition: Pick<FieldDefinition, 'key'>
): { ms: number; display: string } {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    return { ms: raw.getTime(), display: raw.toISOString() };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { ms: raw, display: new Date(raw).toISOString() };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
      const ms = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
      return { ms, display: new Date(ms).toISOString() };
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return { ms: parsed, display: new Date(parsed).toISOString() };
  }
  throw errors.validation(`Field "${definition.key}" expects a date`, { field: definition.key });
}

function requireChoice(definition: Pick<FieldDefinition, 'options' | 'key'>, raw: unknown): string {
  const choices = definition.options?.choices ?? [];
  const candidate = typeof raw === 'string' ? raw.trim() : raw;
  return resolveChoice(choices, candidate, definition.key);
}

function resolveChoice(
  choices: NonNullable<FieldDefinition['options']>['choices'],
  raw: unknown,
  key: string
): string {
  if (typeof raw !== 'string') {
    throw errors.validation(`Field "${key}" expects a choice value`, { field: key });
  }
  const candidate = raw.trim();
  if (!choices || choices.length === 0) return candidate;
  const match = choices.find(
    (choice) =>
      choice.value.toLowerCase() === candidate.toLowerCase() ||
      choice.label.toLowerCase() === candidate.toLowerCase()
  );
  if (!match) {
    throw errors.validation(`Field "${key}" does not allow the value "${candidate}"`, {
      field: key,
      allowed: choices.map((choice) => choice.value)
    });
  }
  return match.value;
}

function requireIdentifier(raw: unknown, definition: Pick<FieldDefinition, 'key'>): string {
  const value = requireString(raw, definition);
  if (value.length === 0) {
    throw errors.validation(`Field "${definition.key}" expects an identifier`, {
      field: definition.key
    });
  }
  return value;
}

function requireJson(raw: unknown, definition: Pick<FieldDefinition, 'key'>): unknown {
  try {
    return JSON.parse(JSON.stringify(raw)) as unknown;
  } catch {
    throw errors.validation(`Field "${definition.key}" expects JSON-serialisable data`, {
      field: definition.key
    });
  }
}

function applyValidation(
  definition: Pick<FieldDefinition, 'validation' | 'key'>,
  value: string
): void {
  const validation = definition.validation;
  if (!validation) return;
  if (validation.minLength !== undefined && value.length < validation.minLength) {
    throw errors.validation(
      `Field "${definition.key}" must be at least ${validation.minLength} characters`,
      { field: definition.key }
    );
  }
  if (validation.maxLength !== undefined && value.length > validation.maxLength) {
    throw errors.validation(
      `Field "${definition.key}" must be at most ${validation.maxLength} characters`,
      { field: definition.key }
    );
  }
  if (validation.pattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(validation.pattern);
    } catch {
      return; // A malformed pattern is a configuration bug, not a value failure.
    }
    if (!pattern.test(value)) {
      throw errors.validation(
        validation.patternMessage ?? `Field "${definition.key}" has an invalid format`,
        { field: definition.key }
      );
    }
  }
}

function validateBounds(
  definition: Pick<FieldDefinition, 'validation' | 'key'>,
  value: number
): void {
  const validation = definition.validation;
  if (!validation) return;
  if (validation.min !== undefined && value < validation.min) {
    throw errors.validation(`Field "${definition.key}" must be at least ${validation.min}`, {
      field: definition.key
    });
  }
  if (validation.max !== undefined && value > validation.max) {
    throw errors.validation(`Field "${definition.key}" must be at most ${validation.max}`, {
      field: definition.key
    });
  }
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function toBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(value)) return false;
  }
  return null;
}
