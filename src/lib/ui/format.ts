/**
 * Presentation helpers shared by the Files, Dashboards, Settings and Data
 * surfaces.
 *
 * These exist so the same status, byte count or duration reads identically on
 * every screen, and so a tone mapping is stated once rather than re-derived in
 * each component. They are pure functions: no state, no imports from Svelte.
 */

import { formatBytes, formatDateTime, formatDurationShort, formatNumber } from '$shared/format';
import type { Tone } from '$ui/primitives/types';
import type { CacheEntry, FileFieldValueRow, FileStatus } from '$ui/types';

export { formatBytes, formatDateTime, formatDurationShort, formatNumber };

/** File processing status → badge tone. Unknown statuses stay visually neutral. */
export function fileStatusTone(status: string): Tone {
  switch (status) {
    case 'ready':
      return 'positive';
    case 'processing':
      return 'accent';
    case 'failed':
      return 'danger';
    case 'quarantined':
      return 'caution';
    default:
      return 'neutral';
  }
}

export function fileStatusLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'processing':
      return 'Processing';
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Failed';
    case 'quarantined':
      return 'Quarantined';
    default:
      return status;
  }
}

export function sourceTypeLabel(sourceType: string): string {
  return sourceType
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function jobStatusTone(status: string): Tone {
  switch (status) {
    case 'completed':
      return 'positive';
    case 'leased':
      return 'accent';
    case 'failed':
    case 'dead':
      return 'danger';
    case 'cancelled':
      return 'muted';
    default:
      return 'neutral';
  }
}

export function jobStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function provenanceTone(state: string): Tone {
  switch (state) {
    case 'inherited':
      return 'accent';
    case 'overridden':
      return 'caution';
    case 'local':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function bindingModeLabel(mode: string): string {
  switch (mode) {
    case 'use_asis':
      return 'Use as-is';
    case 'override':
      return 'Override';
    case 'fork':
      return 'Fork';
    default:
      return mode;
  }
}

/** Long-form duration used by analytics, which reports seconds. */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  return formatDurationShort(seconds * 1000);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Compact display value for one raw `file_field_values` join row. */
export function readFieldValue(row: FileFieldValueRow): unknown {
  if (row.value_bool !== null && row.value_bool !== undefined) return row.value_bool;
  if (row.value_number !== null && row.value_number !== undefined) return row.value_number;
  if (row.value_date !== null && row.value_date !== undefined) return row.value_date;
  if (row.value_text !== null && row.value_text !== undefined) return row.value_text;
  if (row.value_json !== null && row.value_json !== undefined) return row.value_json;
  return null;
}

/** Normalize a boolean stored as `0`/`1` or `true`/`false`. */
export function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Render any field value for a readonly cell, never throwing on objects. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => displayValue(entry)).join(', ');
  return JSON.stringify(value);
}

/** Best-effort human label for a cache entry, which has no title of its own. */
export function cacheEntryLabel(entry: CacheEntry): string {
  return `${entry.namespace}/${entry.key}`;
}

export function statusCounts(items: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return counts;
}

/** True when a status is one of the terminal set, used to stop optimistic polling. */
export function isTerminalFileStatus(status: FileStatus | string): boolean {
  return status === 'ready' || status === 'failed' || status === 'quarantined';
}

/**
 * A short, stable color for a raw label such as a state name. Charts need a
 * deterministic palette without storing a color; this hashes the label into a
 * fixed set of token-derived hues.
 */
export function chartColor(index: number): string {
  const palette = [
    'var(--color-accent)',
    'var(--color-positive)',
    'var(--color-caution)',
    'var(--color-danger)',
    'color-mix(in oklch, var(--color-accent) 60%, var(--color-positive))',
    'color-mix(in oklch, var(--color-accent) 55%, var(--color-danger))',
    'color-mix(in oklch, var(--color-positive) 55%, var(--color-caution))',
    'color-mix(in oklch, var(--color-ink-muted) 70%, var(--color-accent))'
  ];
  return palette[index % palette.length] as string;
}
