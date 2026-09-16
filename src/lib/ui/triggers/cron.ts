/**
 * Cron authoring without importing the server.
 *
 * The trigger editor has to answer two questions before a schedule is saved: "what
 * does this expression mean" and "when will it next run, in my timezone". The server
 * validates with `cron-parser` at the API boundary, but the browser cannot reach
 * server modules, so this module implements the five-field subset an operator
 * actually authors (`*`, lists, ranges, steps, names) plus a timezone-aware next-run
 * search.
 *
 * Being a second implementation is a real cost, so it is deliberately conservative:
 * it accepts exactly five fields and rejects anything it cannot evaluate, which means
 * an expression the editor accepts is one the server will also accept. The next-run
 * maths uses `Intl` for the timezone offset rather than a bundled tz database, so a
 * DST transition lands on the correct wall-clock time.
 */

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
] as const;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const;

const FALLBACK_TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland'
] as const;

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type ParseCronResult = { ok: true; value: ParsedCron } | { ok: false; error: string };

interface TokenRange {
  start: number;
  end: number;
  step: number;
}

/** Parse a cron token — star, single value, range, step or a combination — into one inclusive range. */
function expandToken(
  token: string,
  min: number,
  max: number,
  names?: readonly string[]
): TokenRange | string {
  const [rangePart, stepPart] = token.split('/');
  if (rangePart === undefined) return `Bad field "${token}"`;
  let step = 1;
  if (stepPart !== undefined) {
    step = Number.parseInt(stepPart, 10);
    if (!Number.isFinite(step) || step < 1) return `Bad step in "${token}"`;
  }
  if (rangePart === '*') return { start: min, end: max, step };

  const [fromPart, toPart] = rangePart.split('-');
  const start = resolveValue(fromPart ?? '', names);
  if (start === null) return `Unknown value "${fromPart ?? ''}"`;
  if (toPart === undefined) {
    return { start, end: stepPart === undefined ? start : max, step };
  }
  const end = resolveValue(toPart, names);
  if (end === null) return `Unknown value "${toPart}"`;
  return { start, end, step };
}

function expandField(
  raw: string,
  min: number,
  max: number,
  names?: readonly string[]
): number[] | string {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token.length === 0) return 'Empty list item';
    const expanded = expandToken(token, min, max, names);
    if (typeof expanded === 'string') return expanded;
    const { start, end, step } = expanded;
    if (start < min || end > max || start > end) return `"${token}" is out of range`;
    for (let value = start; value <= end; value += step) out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

function resolveValue(token: string, names?: readonly string[]): number | null {
  const trimmed = token.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && String(numeric) === trimmed) return numeric;
  if (names) {
    const index = names.indexOf(trimmed);
    if (index >= 0) return index + (names === DAY_NAMES ? 0 : 1);
  }
  return null;
}

export function parseCron(expression: string): ParseCronResult {
  const fields = expression
    .trim()
    .split(/\s+/)
    .filter((field) => field.length > 0);
  if (fields.length !== 5) {
    return {
      ok: false,
      error: 'Use five fields: minute hour day-of-month month day-of-week'
    };
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string
  ];
  const minutes = expandField(minuteRaw, 0, 59);
  if (typeof minutes === 'string') return { ok: false, error: `Minute: ${minutes}` };
  const hours = expandField(hourRaw, 0, 23);
  if (typeof hours === 'string') return { ok: false, error: `Hour: ${hours}` };
  const daysOfMonth = expandField(domRaw, 1, 31);
  if (typeof daysOfMonth === 'string') return { ok: false, error: `Day of month: ${daysOfMonth}` };
  const months = expandField(monthRaw, 1, 12, MONTH_NAMES);
  if (typeof months === 'string') return { ok: false, error: `Month: ${months}` };
  const rawDaysOfWeek = expandField(dowRaw, 0, 7, DAY_NAMES);
  if (typeof rawDaysOfWeek === 'string')
    return { ok: false, error: `Day of week: ${rawDaysOfWeek}` };
  const daysOfWeek = [...new Set(rawDaysOfWeek.map((value) => (value === 7 ? 0 : value)))].sort(
    (a, b) => a - b
  );
  return {
    ok: true,
    value: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      domRestricted: domRaw !== '*',
      dowRestricted: dowRaw !== '*'
    }
  };
}

/** `null` when the expression is valid, otherwise the reason to show inline. */
export function validateCronExpression(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return 'An expression is required';
  const parsed = parseCron(trimmed);
  return parsed.ok ? null : parsed.error;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function stepOf(raw: string): number | null {
  const match = /^\*\/(\d+)$/.exec(raw.trim());
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

/** Plain-language cadence; the exact instants come from {@link nextCronRuns}. */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return `Invalid schedule: ${parsed.error}`;
  const p = parsed.value;
  const allMinutes = p.minutes.length === 60;
  const allHours = p.hours.length === 24;
  const allDom = !p.domRestricted;
  const allMonths = p.months.length === 12;
  const allDow = !p.dowRestricted;
  const fields = expression.trim().split(/s+/);

  if (allMinutes && allHours && allDom && allMonths && allDow) return 'Every minute';
  if (allHours && allDom && allMonths && allDow) {
    const step = stepOf(fields[0] ?? '');
    if (step) return `Every ${step} minutes`;
    return `Hourly at minute ${p.minutes.map(String).join(', ')}`;
  }
  if (allDom && allMonths && allDow) {
    const step = stepOf(fields[1] ?? '');
    if (step && p.minutes.length === 1) return `Every ${step} hours at minute ${p.minutes[0]}`;
    return `Every day at ${renderTimes(p)}`;
  }
  if (allDom && allMonths && !allDow) {
    const days = p.daysOfWeek.map((day) => DAY_LABELS[day] ?? String(day)).join(', ');
    return `Every week on ${days} at ${renderTimes(p)}`;
  }
  if (!allDom && allMonths && allDow) {
    return `Every month on day ${p.daysOfMonth.join(', ')} at ${renderTimes(p)}`;
  }
  return `On the configured dates at ${renderTimes(p)}`;
}

function renderTimes(p: ParsedCron): string {
  const times: string[] = [];
  for (const hour of p.hours) {
    for (const minute of p.minutes) {
      times.push(`${pad(hour)}:${pad(minute)}`);
      if (times.length >= 4) return `${times.join(', ')}…`;
    }
  }
  return times.length > 0 ? times.join(', ') : 'no valid time';
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInTimezone(ms: number, timezone: string): TzParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

/** Offset of `timezone` at a given instant: local wall clock minus UTC. */
function offsetAt(utcMs: number, timezone: string): number {
  const parts = partsInTimezone(utcMs, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - utcMs;
}

function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = offsetAt(guess, timezone);
  const candidate = guess - firstOffset;
  const secondOffset = offsetAt(candidate, timezone);
  return secondOffset === firstOffset ? candidate : guess - secondOffset;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export type NextRunsResult = { ok: true; runs: number[] } | { ok: false; error: string };

/** Standard cron semantics: a restricted dom and dow are ORed, otherwise ANDed. */
function dayMatches(p: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = p.daysOfMonth.includes(dayOfMonth);
  const dowMatch = p.daysOfWeek.includes(dayOfWeek);
  if (!p.domRestricted && !p.dowRestricted) return true;
  if (p.domRestricted && p.dowRestricted) return domMatch || dowMatch;
  return p.domRestricted ? domMatch : dowMatch;
}

/** Instants on one local calendar day that are still in the future. */
function runsForDay(
  p: ParsedCron,
  year: number,
  month: number,
  dayOfMonth: number,
  timezone: string,
  from: number,
  limit: number
): number[] {
  const found: number[] = [];
  for (const hour of p.hours) {
    for (const minute of p.minutes) {
      const instant = zonedTimeToUtc(year, month, dayOfMonth, hour, minute, timezone);
      if (instant <= from) continue;
      found.push(instant);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * The next `count` instants a schedule fires, as epoch milliseconds, correct across
 * DST because each candidate wall-clock time is converted with its own offset.
 */
export function nextCronRuns(
  expression: string,
  timezone: string,
  count = 3,
  from: number = Date.now()
): NextRunsResult {
  const parsed = parseCron(expression);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const tz = timezone.trim().length > 0 ? timezone.trim() : 'UTC';
  if (!isValidTimezone(tz)) return { ok: false, error: `Unknown timezone "${tz}"` };

  const p = parsed.value;
  const start = partsInTimezone(from, tz);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const runs: number[] = [];
  const MAX_DAYS = 1464; // Four years covers every valid five-field schedule.

  for (let offset = 0; offset <= MAX_DAYS && runs.length < count; offset += 1) {
    const day = new Date(startDay + offset * 86_400_000);
    const month = day.getUTCMonth() + 1;
    if (!p.months.includes(month)) continue;
    if (!dayMatches(p, day.getUTCDate(), day.getUTCDay())) continue;
    runs.push(
      ...runsForDay(p, day.getUTCFullYear(), month, day.getUTCDate(), tz, from, count - runs.length)
    );
  }

  if (runs.length === 0) return { ok: false, error: 'This schedule never fires' };
  return { ok: true, runs };
}

export function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const values = intl.supportedValuesOf?.('timeZone');
    if (values && values.length > 0) {
      return ['UTC', ...values.filter((zone) => zone !== 'UTC')];
    }
  } catch {
    // Older engines lack supportedValuesOf; the curated list is a fine substitute.
  }
  return [...FALLBACK_TIMEZONES];
}

export function formatInTimezone(ms: number, timezone: string): string {
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(ms));
}

export { DAY_LABELS };
