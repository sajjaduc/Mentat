/**
 * Formatting helpers shared by server rendering and the browser.
 *
 * Kept dependency-free and locale-tolerant so the same value renders identically
 * in a server-rendered page and after a client-side update.
 */

export function formatDateTime(value: number | null | undefined, locale = 'en-GB'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function formatDate(value: number | null | undefined, locale = 'en-GB'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  }).format(new Date(value));
}

export function formatRelative(value: number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return '—';
  const delta = value - now;
  const abs = Math.abs(delta);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
    ['week', 604_800_000],
    ['month', 2_592_000_000],
    ['year', 31_536_000_000]
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0] as [
    Intl.RelativeTimeFormatUnit,
    number
  ];
  for (const unit of units) {
    if (abs >= unit[1]) chosen = unit;
  }
  return formatter.format(Math.round(delta / chosen[1]), chosen[0]);
}

export function formatDurationShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatNumber(value: number | null | undefined, locale = 'en-GB'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

export function formatCurrency(
  value: number | null | undefined,
  currency = 'USD',
  locale = 'en-GB'
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

/** `CLAIM-42` style record keys are displayed verbatim; this guards malformed input. */
export function formatRecordKey(key: string | null | undefined): string {
  return key && key.length > 0 ? key : '—';
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Deterministic accent colour from any id, so avatars and labels are stable
 * across renders without storing a colour.
 */
export function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `oklch(0.62 0.12 ${hue})`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Convert a `{{path.to.value}}` template against a payload. */
export function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(context, path.trim());
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** Read a dot/bracket path such as `data.customer.email` or `items[0].id`. */
export function readPath(source: unknown, path: string): unknown {
  if (!path) return source;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isFinite(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
