<script lang="ts">
/**
 * WidgetCard: render one widget result by type.
 *
 * The card is the boundary between the run endpoint's `WidgetResult` and the
 * hand-built chart components. It owns the type switch, the value formatter implied
 * by the widget's `visualization.valueFormat`, and the honest metadata line: which
 * filter was applied, which time basis, and any unresolved filter keys the compiler
 * reported.
 */

import DataTable from '$ui/common/DataTable.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Card from '$ui/primitives/Card.svelte';
import type { DashboardWidget, WidgetResult } from '$ui/types';
import AgingChart from './AgingChart.svelte';
import AreaChart from './AreaChart.svelte';
import BarChart from './BarChart.svelte';
import ChartFrame from './ChartFrame.svelte';
import FunnelChart from './FunnelChart.svelte';
import { formatWidgetValue } from './geometry';
import LineChart from './LineChart.svelte';
import PieChart from './PieChart.svelte';
import type { ChartDatum } from './types';
import {
  type AgingEntryView,
  agingChartData,
  toAgingEntries,
  toChartData,
  toFunnelView,
  toSeries
} from './view-models';

interface Props {
  widget: DashboardWidget;
  result: WidgetResult | null;
  error?: string | null;
  onexpand?: (widget: DashboardWidget) => void;
}

let { widget, result, error = null, onexpand }: Props = $props();

const visualization = $derived(widget.visualization);
const format = $derived((value: number) => formatWidgetValue(value, visualization, 'number'));
const formatDuration = $derived((value: number) =>
  formatWidgetValue(value, { ...visualization, valueFormat: 'duration' }, 'duration')
);

const data = $derived(result ? toChartData(result) : []);
const series = $derived(result ? toSeries(result, widget.title) : []);
const funnel = $derived(result ? toFunnelView(result) : null);
const aging = $derived(result ? toAgingEntries(result) : []);

/** Duration widgets report seconds, so their axis and tooltips must say so. */
const axisFormatter = $derived.by(() => {
  if (widget.measure.aggregation === 'duration') return formatDuration;
  return format;
});

const metaLine = $derived.by(() => {
  if (!result) return '';
  const parts: string[] = [];
  if (result.meta.filter && result.meta.filter !== 'All items') parts.push(result.meta.filter);
  parts.push(`basis: ${result.meta.basis.replace('_', ' ')}`);
  if (result.meta.timeRange.kind === 'relative' && result.meta.timeRange.lastDays) {
    parts.push(`last ${result.meta.timeRange.lastDays} day(s)`);
  } else if (result.meta.timeRange.kind === 'all') {
    parts.push('all time');
  }
  return parts.join(' · ');
});
</script>

<Card class="h-full space-y-3">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <p class="truncate text-sm font-semibold text-[var(--color-ink)]">{widget.title}</p>
      <p class="text-[11px] text-[var(--color-ink-subtle)]">
        {widget.measure.aggregation}
        {#if widget.measure.fieldKey}· {widget.measure.fieldKey}{/if}
        {#if widget.grouping && widget.grouping.by !== 'none'}· by {widget.grouping.by}{/if}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-1.5">
      {#if result?.meta.unresolved && result.meta.unresolved.length > 0}
        <Badge tone="caution">{result.meta.unresolved.length} unresolved</Badge>
      {/if}
      {#if onexpand}
        <button
          type="button"
          class="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-subtle)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
          onclick={() => onexpand?.(widget)}
        >
          Edit
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
  {:else if !result}
    <p class="py-6 text-center text-xs text-[var(--color-ink-subtle)]">Run the dashboard to load this widget.</p>
  {:else if widget.type === 'kpi' || widget.type === 'number'}
    <div class="space-y-1 py-2">
      <p class="font-mono text-3xl font-semibold tracking-tight text-[var(--color-ink)]">
        {format(result.value ?? 0)}
      </p>
      <p class="text-[11px] text-[var(--color-ink-subtle)]">
        {widget.measure.aggregation}
        {#if widget.measure.fieldKey} of {widget.measure.fieldKey}{/if}
      </p>
    </div>
  {:else if widget.type === 'bar'}
    <ChartFrame title={widget.title} description={widget.description ?? undefined} series={series} formatValue={axisFormatter} height={widget.size === 'full' ? 320 : 240}>
      {#snippet children()}
        <BarChart {series} formatValue={axisFormatter} color={visualization?.color} stacked={visualization?.stacked} height={widget.size === 'full' ? 320 : 240} />
      {/snippet}
    </ChartFrame>
  {:else if widget.type === 'line'}
    <ChartFrame title={widget.title} description={widget.description ?? undefined} series={series} formatValue={axisFormatter} height={widget.size === 'full' ? 320 : 240}>
      {#snippet children()}
        <LineChart {series} formatValue={axisFormatter} height={widget.size === 'full' ? 320 : 240} />
      {/snippet}
    </ChartFrame>
  {:else if widget.type === 'area'}
    <ChartFrame title={widget.title} description={widget.description ?? undefined} series={series} formatValue={axisFormatter} height={widget.size === 'full' ? 320 : 240}>
      {#snippet children()}
        <AreaChart {series} formatValue={axisFormatter} height={widget.size === 'full' ? 320 : 240} />
      {/snippet}
    </ChartFrame>
  {:else if widget.type === 'pie' || widget.type === 'donut'}
    <ChartFrame title={widget.title} description={widget.description ?? undefined} series={series} formatValue={format} height={widget.size === 'full' ? 320 : 240}>
      {#snippet children()}
        <PieChart {series} formatValue={format} donut={widget.type === 'donut'} height={widget.size === 'full' ? 320 : 240} />
      {/snippet}
    </ChartFrame>
  {:else if widget.type === 'funnel' && funnel}
    <FunnelChart {funnel} formatValue={format} />
  {:else if widget.type === 'aging'}
    <AgingChart entries={aging as AgingEntryView[]} />
  {:else if widget.type === 'table'}
    <DataTable
      columns={[
        { key: 'label', label: 'Label' },
        { key: 'value', label: 'Value', align: 'right' }
      ]}
      rows={data as ChartDatum[]}
      rowKey={(item) => String((item as ChartDatum).rawLabel ?? (item as ChartDatum).label)}
    >
      {#snippet row(item)}
        {@const datum = item as ChartDatum}
        <td class="px-3 py-1.5 text-xs">{datum.rawLabel ?? datum.label}</td>
        <td class="px-3 py-1.5 text-right font-mono text-xs">{format(datum.value)}</td>
      {/snippet}
    </DataTable>
  {:else}
    <p class="py-6 text-center text-xs text-[var(--color-ink-subtle)]">
      Unsupported widget type: {widget.type}
    </p>
  {/if}

  {#if result && metaLine}
    <p class="border-t border-[var(--color-border-subtle)] pt-2 text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      {metaLine}
      {#if result.meta.note}· {result.meta.note}{/if}
    </p>
  {/if}
</Card>
