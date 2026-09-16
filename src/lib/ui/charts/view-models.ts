/**
 * Widget result → chart view models.
 *
 * The dashboard run endpoint returns a compact `WidgetResult` per widget: a scalar
 * `value`, `rows`/`series` of `{label, value}` pairs, a `kind`, and metadata. Two
 * widget families need more than that, and this module states exactly what can and
 * cannot be derived on the client rather than inventing numbers:
 *
 *  - **Funnel.** Stage counts are present, so conversion between stages and overall
 *    conversion are derived arithmetically. Inter-stage *timing* (median/average
 *    seconds to reach a stage) is computed inside `analytics/funnel.ts` and is
 *    collapsed into `meta.note` by the run endpoint, so it is not shown here. The
 *    funnel component says so in the UI.
 *  - **Aging.** The result's `value` is the median dwell time per state; p90, avg,
 *    max and the currently-in count are produced by `analytics/aging.ts` and are
 *    not part of the serialized result. The aging component renders the median
 *    faithfully and states that the full report is server-side only.
 *
 * Everything else (kpi, number, bar, line, area, pie, donut, table) maps directly.
 */

import type { WidgetResult } from '$ui/types';
import { formatDurationSeconds } from './geometry';
import type { ChartDatum, ChartSeries } from './types';

export interface FunnelStageView {
  label: string;
  count: number;
  /** Percent of the previous stage; `null` for the first stage. */
  conversionFromPrevious: number | null;
  /** Percent of the first stage; `100` for the first when non-empty. */
  conversionFromFirst: number | null;
}

export interface FunnelView {
  stages: FunnelStageView[];
  overallConversion: number | null;
  /** True when the widget definition had no milestones to evaluate. */
  empty: boolean;
}

export interface AgingEntryView {
  stateId: string;
  label: string;
  /** Median dwell time in seconds, as returned by the run endpoint. */
  medianSeconds: number | null;
}

export function toChartData(result: WidgetResult): ChartDatum[] {
  const rows = result.rows ?? [];
  if (rows.length > 0) {
    return rows.map((row) => ({
      label: row.label ?? row.key ?? '',
      rawLabel: row.label ?? row.key ?? '',
      value: row.value
    }));
  }
  return (result.series ?? []).map((point) => ({
    label: point.label,
    rawLabel: point.label,
    value: point.value
  }));
}

/** One series for a single-series widget; the frame hides the legend for those. */
export function toSeries(result: WidgetResult, name: string): ChartSeries[] {
  const data = toChartData(result);
  if (data.length === 0) {
    // A scalar result (kpi/number/conversion/duration) has no rows: expose the
    // value as a one-point series so the data-table fallback still shows it.
    return [{ name, data: [{ label: name, rawLabel: name, value: result.value ?? 0 }] }];
  }
  return [{ name, data }];
}

/**
 * Funnel stages from a funnel widget result. Stage order is exactly the order the
 * widget definition selected — never Kanban column order (ADR-0017).
 */
export function toFunnelView(result: WidgetResult): FunnelView {
  const stages = toChartData(result);
  if (stages.length === 0) {
    return { stages: [], overallConversion: null, empty: true };
  }
  const first = stages[0]?.value ?? 0;
  const last = stages[stages.length - 1]?.value ?? 0;
  return {
    stages: stages.map((stage, index) => ({
      label: stage.rawLabel ?? stage.label,
      count: stage.value,
      conversionFromPrevious:
        index === 0 ? null : percent(stage.value, stages[index - 1]?.value ?? 0),
      conversionFromFirst: index === 0 ? (first > 0 ? 100 : null) : percent(stage.value, first)
    })),
    overallConversion: percent(last, first),
    empty: false
  };
}

/** Aging rows from an aging widget result (the run endpoint exposes the median). */
export function toAgingEntries(result: WidgetResult): AgingEntryView[] {
  return (result.rows ?? []).map((row) => ({
    stateId: row.key ?? row.label ?? '',
    label: row.label ?? row.key ?? '',
    medianSeconds: Number.isFinite(row.value) ? row.value : null
  }));
}

/** `count` per bucket, used by the throughput/aging data-table fallback. */
export function agingChartData(entries: AgingEntryView[]): ChartDatum[] {
  return entries.map((entry) => ({
    label: entry.label,
    rawLabel: entry.label,
    value: entry.medianSeconds ?? 0
  }));
}

export function formatAgingValue(seconds: number): string {
  return formatDurationSeconds(seconds);
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}
