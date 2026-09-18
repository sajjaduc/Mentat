/**
 * Short human-readable summaries of a projected field's options, validation and
 * default value.
 *
 * The same projection is shown in the schema box's test preview and in the Object
 * Type fields list, so the formatting lives here rather than in either component.
 */
import type { FieldOptions, FieldValidation } from '$ui/work/types';

/** e.g. `min 3 · max 120` or `pattern ^[A-Z]{2}-\d+$`; null when unconstrained. */
export function describeFieldValidation(
  validation: FieldValidation | Record<string, unknown> | null | undefined
): string | null {
  if (!validation) return null;
  const parts: string[] = [];
  const minLength = validation.minLength;
  const maxLength = validation.maxLength;
  const min = validation.min;
  const max = validation.max;
  const pattern = validation.pattern;
  if (typeof minLength === 'number' && typeof maxLength === 'number') {
    parts.push(`${minLength}–${maxLength} chars`);
  } else if (typeof minLength === 'number') {
    parts.push(`min ${minLength} chars`);
  } else if (typeof maxLength === 'number') {
    parts.push(`max ${maxLength} chars`);
  }
  if (typeof min === 'number' && typeof max === 'number') {
    parts.push(`${formatValue(min)}–${formatValue(max)}`);
  } else if (typeof min === 'number') {
    parts.push(`min ${formatValue(min)}`);
  } else if (typeof max === 'number') {
    parts.push(`max ${formatValue(max)}`);
  }
  if (typeof pattern === 'string' && pattern.length > 0) {
    parts.push(`pattern ${pattern}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** e.g. `active, lapsed`; null when the field has no choices. */
export function describeFieldChoices(options: FieldOptions | null | undefined): string | null {
  const choices = options?.choices ?? [];
  if (choices.length === 0) return null;
  return choices.map((choice) => choice.label || choice.value).join(', ');
}

/** A compact JSON rendering of a field default; null when there is none. */
export function describeDefaultValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const rendered = JSON.stringify(value);
    if (rendered === undefined) return null;
    return rendered.length > 80 ? `${rendered.slice(0, 77)}…` : rendered;
  } catch {
    return String(value);
  }
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}
