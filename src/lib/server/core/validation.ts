/**
 * Validation boundary.
 *
 * All external input (HTTP bodies, query strings, tool arguments, provider
 * payloads) crosses a Zod schema before it reaches domain code. This module
 * centralizes the conversion from Zod issues to `AppError`s so every boundary
 * reports validation failures the same way.
 */
import { z } from 'zod';
import { type AppError, errors } from './errors';

export { z };

export interface ParseOptions {
  /** Label used in the error message, e.g. "ticket" or "http operation". */
  label?: string;
}

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  options: ParseOptions = {}
): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const label = options.label ? `${options.label}: ` : '';
  throw errors.validation(`${label}${formatIssues(result.error)}`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code
    }))
  });
}

export function safeParse<T extends z.ZodType>(
  schema: T,
  input: unknown
): { ok: true; data: z.infer<T> } | { ok: false; error: AppError } {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: errors.validation(formatIssues(result.error), {}) };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** JSON helpers used by repositories that persist document-shaped payloads. */
export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}
