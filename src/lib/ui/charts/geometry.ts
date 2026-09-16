/**
 * Chart geometry and formatting.
 *
 * The brief forbids a charting dependency, so every chart in Mentat is inline SVG
 * built from these primitives. Keeping the scale/ticks/label maths here means the
 * bar, line, area, pie, donut, funnel and aging charts share one definition of
 * "a nice axis" and one definition of "how a value reads" — a KPI and a bar tooltip
 * never disagree about the number.
 *
 * The ticks are the classic 1/2/5×10ⁿ ladder: readable at every magnitude and
 * cheap to compute, with no dependency on d3.
 */

import { formatCurrency, formatNumber } from '$shared/format';
import type { WidgetVisualization } from '$ui/types';

export interface Scale {
  min: number;
  max: number;
  /** Map a value into pixel space. */
  map: (value: number) => number;
}

/** A linear scale from a data range into `[start, end]` pixels (already flipped). */
export function linearScale(
  domainMin: number,
  domainMax: number,
  rangeStart: number,
  rangeEnd: number
): Scale {
  const min = Math.min(domainMin, domainMax);
  const max = Math.max(domainMin, domainMax);
  const span = max - min;
  return {
    min,
    max,
    map: (value: number) => {
      if (span === 0) return (rangeStart + rangeEnd) / 2;
      const fraction = (value - min) / span;
      return rangeStart + fraction * (rangeEnd - rangeStart);
    }
  };
}

/**
 * The 1/2/5 tick ladder. `count` is a target, not a promise: the returned step is
 * always a round number so 0, 25, 50, 75, 100 appears instead of 0, 23.7, 47.4.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) return [min];
  const rawStep = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const normalized = rawStep / magnitude;
  const niceStep = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceStep * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Guard against pathological ranges producing an unbounded loop.
  for (
    let value = start, guard = 0;
    value <= end + step / 2 && guard < 200;
    value += step, guard++
  ) {
    ticks.push(roundToStep(value, step));
  }
  return ticks.length > 0 ? ticks : [min, max];
}

function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number.parseFloat(value.toFixed(Math.min(decimals, 10)));
}

/** Axis domain for a value series, always including zero for bar-like marks. */
export function valueDomain(values: number[], includeZero = true): { min: number; max: number } {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    if (min === 0) return { min: 0, max: 1 };
    return min > 0 ? { min: 0, max: min * 1.1 } : { min: min * 1.1, max: 0 };
  }
  return { min, max };
}

// ------------------------------------------------------------------ formatting

/**
 * Format a value the way the widget's `valueFormat` asks. `duration` and
 * `currency` are the two cases where a raw number is actively misleading.
 */
export function formatWidgetValue(
  value: number | null | undefined,
  visualization: WidgetVisualization | null | undefined,
  fallback: 'number' | 'duration' = 'number'
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const format = visualization?.valueFormat ?? fallback;
  switch (format) {
    case 'currency':
      return formatCurrency(value, visualization?.currency ?? 'USD');
    case 'percent':
      return `${formatNumber(value)}%`;
    case 'duration':
      return formatDurationSeconds(value);
    default:
      return formatNumber(value);
  }
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Compact axis label: 1.2k rather than 1200, so a tick never overlaps. */
export function formatAxisValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

/** A truncating label for a category axis; the full value lives in the tooltip. */
export function truncateLabel(label: string, max = 14): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(1, max - 1))}…`;
}

// ------------------------------------------------------------------- geometry

export interface Point {
  x: number;
  y: number;
}

/** Build an SVG path for a polyline through points. */
export function linePath(points: Point[]): string {
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
}

/** Build a closed SVG path for an area under a line, down to `baselineY`. */
export function areaPath(points: Point[], baselineY: number): string {
  if (points.length === 0) return '';
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  const outline = points.map((point) => `L${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  return `M${first.x.toFixed(2)},${baselineY.toFixed(2)} ${outline} L${last.x.toFixed(2)},${baselineY.toFixed(2)} Z`;
}

/** Arc path for a pie/donut slice, from `startAngle` to `endAngle` in radians. */
export function arcPath(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  innerRadius = 0
): string {
  const startOuter = polar(centerX, centerY, radius, endAngle);
  const endOuter = polar(centerX, centerY, radius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  if (innerRadius <= 0) {
    return [
      `M${centerX.toFixed(2)},${centerY.toFixed(2)}`,
      `L${startOuter.x.toFixed(2)},${startOuter.y.toFixed(2)}`,
      `A${radius},${radius} 0 ${largeArc} 0 ${endOuter.x.toFixed(2)},${endOuter.y.toFixed(2)}`,
      'Z'
    ].join(' ');
  }
  const startInner = polar(centerX, centerY, innerRadius, endAngle);
  const endInner = polar(centerX, centerY, innerRadius, startAngle);
  return [
    `M${startOuter.x.toFixed(2)},${startOuter.y.toFixed(2)}`,
    `A${radius},${radius} 0 ${largeArc} 0 ${endOuter.x.toFixed(2)},${endOuter.y.toFixed(2)}`,
    `L${endInner.x.toFixed(2)},${endInner.y.toFixed(2)}`,
    `A${innerRadius},${innerRadius} 0 ${largeArc} 1 ${startInner.x.toFixed(2)},${startInner.y.toFixed(2)}`,
    'Z'
  ].join(' ');
}

function polar(centerX: number, centerY: number, radius: number, angle: number): Point {
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle)
  };
}

/** Total of a numeric series, used for pie/donut percentages. */
export function totalOf(values: number[]): number {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}
