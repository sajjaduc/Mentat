/**
 * Order-statistic helpers shared by widget, funnel and aging reports.
 *
 * SQL can compute an average over a group in one pass, but medians and
 * percentiles are order statistics: correctness depends on the *whole* ordered
 * sample, not on a streaming accumulator. These helpers are applied to values
 * that were read in a deterministic order (or to interval rows already scoped by
 * SQL), which keeps the percentile definition in one place instead of drifting
 * between an SQL window expression and a JavaScript fallback.
 *
 * Percentiles use linear interpolation between the two nearest ranks
 * (the "R-7" / NumPy default): `index = (n - 1) * p`. That definition reduces to
 * the ordinary median for p = 0.5 and is stable for both odd and even counts.
 */

/** Validate a percentile before ranking; throws a RangeError outside [0, 1]. */
function assertPercentile(p: number): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`percentile must be within [0, 1], received ${String(p)}`);
  }
}

function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Linear-interpolated percentile of a sample. `null` when the sample is empty. */
export function percentileOf(values: readonly number[], p: number): number | null {
  assertPercentile(p);
  if (values.length === 0) return null;
  const sorted = sortedCopy(values);
  if (sorted.length === 1) return sorted[0] ?? null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower] as number;
  if (lower === upper) return low;
  const high = sorted[upper] as number;
  return low + (high - low) * (index - lower);
}

/** Median. Exact for odd counts; the mean of the two middle samples for even. */
export function medianOf(values: readonly number[]): number | null {
  return percentileOf(values, 0.5);
}

/** 90th percentile, used by time-in-state and cycle-time reports. */
export function p90Of(values: readonly number[]): number | null {
  return percentileOf(values, 0.9);
}

export function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return sumOf(values) / values.length;
}

export function sumOf(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function minOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let min = values[0] as number;
  for (const value of values) if (value < min) min = value;
  return min;
}

export function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let max = values[0] as number;
  for (const value of values) if (value > max) max = value;
  return max;
}
