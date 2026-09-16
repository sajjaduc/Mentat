/**
 * Typed field value normalization.
 *
 * One function decides what a value of each `FieldType` means, both for ticket
 * fields and for file fields (ADR-0005). Every write path — human UI, agent tool,
 * trigger mapping, extraction pipeline — funnels through here, so validation,
 * the typed storage columns and the searchable projection can never disagree.
 *
 * The returned shape maps directly onto the typed columns in
 * `ticket_field_values` / `file_field_values`.
 */

import { errors } from '../core/errors';
import { isUuid } from '../core/ids';
import type { FieldDefinition, FieldType } from '../db/schema';

export interface NormalizedFieldValue {
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: number | null;
  valueJson: unknown;
  /** Lowercase projection used for portable text filters. */
  searchText: string | null;
  /** Original (normalized) value, for display and history. */
  display: unknown;
}

export const EMPTY_FIELD_VALUE: NormalizedFieldValue = {
  valueText: null,
  valueNumber: null,
  valueBool: null,
  valueDate: null,
  valueJson: null,
  searchText: null,
  display: null
};

export function isFieldEmpty(value: NormalizedFieldValue): boolean {
  return (
    value.valueText === null &&
    value.valueNumber === null &&
    value.valueBool === null &&
    value.valueDate === null &&
    (value.valueJson === null ||
      value.valueJson === undefined ||
      (Array.isArray(value.valueJson) && value.valueJson.length === 0))
  );
}

/** True when the field type stores its canonical value in `value_json`. */
export function usesJsonColumn(type: FieldType): boolean {
  return type === 'multi_select' || type === 'json';
}

export function normalizeFieldValue(field: FieldDefinition, raw: unknown): NormalizedFieldValue {
  if (raw === null || raw === undefined || raw === '') return EMPTY_FIELD_VALUE;

  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone': {
      const text = String(raw).trim();
      if (text.length === 0) return EMPTY_FIELD_VALUE;
      if (field.type === 'url' && !/^https?:\/\/[^\s]+$/i.test(text)) {
        throw invalid(field, 'must be a URL starting with http:// or https://');
      }
      if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
        throw invalid(field, 'must be a valid email address');
      }
      applyTextConstraints(field, text);
      return {
        ...EMPTY_FIELD_VALUE,
        valueText: text,
        searchText: text.toLowerCase(),
        display: text
      };
    }

    case 'number':
    case 'currency': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/,/g, ''));
      if (!Number.isFinite(value)) throw invalid(field, 'must be a number');
      applyNumericConstraints(field, value);
      return {
        ...EMPTY_FIELD_VALUE,
        valueNumber: value,
        searchText: String(value),
        display: value
      };
    }

    case 'boolean': {
      const value = coerceBoolean(raw);
      if (value === null) throw invalid(field, 'must be true or false');
      return { ...EMPTY_FIELD_VALUE, valueBool: value, searchText: String(value), display: value };
    }

    case 'date': {
      const ms = parseDateInput(raw, 'date');
      return { ...EMPTY_FIELD_VALUE, valueDate: ms, searchText: null, display: ms };
    }

    case 'datetime': {
      const ms = parseDateInput(raw, 'datetime');
      return { ...EMPTY_FIELD_VALUE, valueDate: ms, searchText: null, display: ms };
    }

    case 'select': {
      const value = String(raw).trim();
      if (value.length === 0) return EMPTY_FIELD_VALUE;
      const choices = field.options?.choices ?? [];
      if (choices.length > 0 && !choices.some((choice) => choice.value === value)) {
        throw invalid(field, `must be one of: ${choices.map((choice) => choice.value).join(', ')}`);
      }
      const label = choices.find((choice) => choice.value === value)?.label ?? value;
      return {
        ...EMPTY_FIELD_VALUE,
        valueText: value,
        valueJson: value,
        searchText: `${value} ${label}`.toLowerCase(),
        display: value
      };
    }

    case 'multi_select': {
      const list = Array.isArray(raw) ? raw : [raw];
      const values = list.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
      if (values.length === 0) return EMPTY_FIELD_VALUE;
      const choices = field.options?.choices ?? [];
      if (choices.length > 0) {
        const unknownValues = values.filter(
          (value) => !choices.some((choice) => choice.value === value)
        );
        if (unknownValues.length > 0) {
          throw invalid(field, `contains unknown option(s): ${unknownValues.join(', ')}`);
        }
      }
      const labels = values.map(
        (value) => choices.find((choice) => choice.value === value)?.label ?? value
      );
      return {
        ...EMPTY_FIELD_VALUE,
        valueJson: values,
        searchText: `${values.join(' ')} ${labels.join(' ')}`.toLowerCase(),
        display: values
      };
    }

    case 'user':
    case 'team': {
      const value = String(raw).trim();
      if (value.length === 0) return EMPTY_FIELD_VALUE;
      if (!isUuid(value)) {
        throw invalid(field, `must be a ${field.type} id`);
      }
      return { ...EMPTY_FIELD_VALUE, valueText: value, searchText: value, display: value };
    }

    case 'json': {
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.length === 0) return EMPTY_FIELD_VALUE;
        try {
          const parsed = JSON.parse(trimmed);
          return {
            ...EMPTY_FIELD_VALUE,
            valueJson: parsed,
            searchText: JSON.stringify(parsed).toLowerCase().slice(0, 2000),
            display: parsed
          };
        } catch {
          throw invalid(field, 'must be valid JSON');
        }
      }
      return {
        ...EMPTY_FIELD_VALUE,
        valueJson: raw,
        searchText: JSON.stringify(raw).toLowerCase().slice(0, 2000),
        display: raw
      };
    }

    default: {
      const exhaustive: never = field.type;
      throw errors.validation(`Unsupported field type: ${String(exhaustive)}`);
    }
  }
}

export function coerceBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on'].includes(value)) return true;
    if (['false', 'no', 'n', '0', 'off'].includes(value)) return false;
  }
  return null;
}

/**
 * Dates accept epoch milliseconds, `YYYY-MM-DD`, or an ISO 8601 string. `date`
 * normalizes to UTC midnight so equality and range filters are stable regardless
 * of the server's local timezone; `datetime` keeps the exact instant.
 */
export function parseDateInput(raw: unknown, mode: 'date' | 'datetime'): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return mode === 'date' ? utcMidnight(raw) : Math.trunc(raw);
  }
  const text = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(ms)) throw errors.validation(`Invalid date: ${text}`);
    return ms;
  }
  if (/^\d+$/.test(text)) {
    const ms = Number.parseInt(text, 10);
    return mode === 'date' ? utcMidnight(ms) : ms;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw errors.validation(`Invalid ${mode}: ${text}`);
  return mode === 'date' ? utcMidnight(ms) : ms;
}

export function utcMidnight(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function applyTextConstraints(field: FieldDefinition, text: string): void {
  const validation = field.validation;
  if (!validation) return;
  if (validation.minLength !== undefined && text.length < validation.minLength) {
    throw invalid(field, `must be at least ${validation.minLength} characters`);
  }
  if (validation.maxLength !== undefined && text.length > validation.maxLength) {
    throw invalid(field, `must be at most ${validation.maxLength} characters`);
  }
  if (validation.pattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(validation.pattern);
    } catch {
      throw errors.internal(`Field ${field.key} has an invalid validation pattern`);
    }
    if (!pattern.test(text)) {
      throw invalid(field, validation.patternMessage ?? `does not match ${validation.pattern}`);
    }
  }
}

function applyNumericConstraints(field: FieldDefinition, value: number): void {
  const validation = field.validation;
  if (!validation) return;
  if (validation.min !== undefined && value < validation.min) {
    throw invalid(field, `must be at least ${validation.min}`);
  }
  if (validation.max !== undefined && value > validation.max) {
    throw invalid(field, `must be at most ${validation.max}`);
  }
}

function invalid(field: FieldDefinition, message: string): Error {
  return errors.validation(`Field "${field.name}" ${message}`, { fieldKey: field.key });
}

/** Human-readable rendering of a stored value, used by lists, cards and drawers. */
export function displayFieldValue(field: FieldDefinition, value: NormalizedFieldValue): string {
  if (isFieldEmpty(value)) return '';
  switch (field.type) {
    case 'boolean':
      return value.valueBool ? 'Yes' : 'No';
    case 'currency': {
      const currency = field.options?.currency ?? 'USD';
      return `${value.valueNumber ?? 0} ${currency}`;
    }
    case 'date':
      return value.valueDate ? new Date(value.valueDate).toISOString().slice(0, 10) : '';
    case 'datetime':
      return value.valueDate ? new Date(value.valueDate).toISOString() : '';
    case 'multi_select': {
      const list = Array.isArray(value.valueJson) ? (value.valueJson as unknown[]) : [];
      const choices = field.options?.choices ?? [];
      return list
        .map((entry) => choices.find((choice) => choice.value === entry)?.label ?? String(entry))
        .join(', ');
    }
    case 'select': {
      const choices = field.options?.choices ?? [];
      return (
        choices.find((choice) => choice.value === value.valueText)?.label ?? value.valueText ?? ''
      );
    }
    case 'json':
      return value.valueJson === null ? '' : JSON.stringify(value.valueJson);
    default:
      return value.valueText ?? (value.valueNumber === null ? '' : String(value.valueNumber));
  }
}

/** Reconstruct the normalized value from a stored row (used when reading history). */
export function normalizedFromColumns(row: {
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: number | null;
  valueJson: unknown;
}): NormalizedFieldValue {
  const json = row.valueJson ?? null;
  return {
    valueText: row.valueText,
    valueNumber: row.valueNumber,
    valueBool: row.valueBool,
    valueDate: row.valueDate,
    valueJson: json,
    searchText: row.valueText?.toLowerCase() ?? null,
    display: row.valueText ?? row.valueNumber ?? row.valueBool ?? row.valueDate ?? json
  };
}
