<script lang="ts">
/**
 * ChartFrame: the shell every hand-built chart renders inside.
 *
 * Owning the frame here gives every chart the same accessibility contract:
 *
 *  - an accessible `<title>`/`<desc>` is supplied by each chart's `<svg>`;
 *  - a legend that can be hidden;
 *  - a **data-table fallback toggle** that renders the exact numbers, which is what
 *    makes a chart usable with a screen reader or when the shape is not enough.
 */
import SegmentedControl from '$ui/common/SegmentedControl.svelte';
import { colorFor } from './series-colors';
import type { ChartSeries } from './types';

interface Props {
  title: string;
  description?: string;
  /** Series rendered in the legend and the fallback data table. */
  series: ChartSeries[];
  formatValue?: (value: number) => string;
  height?: number;
  children?: import('svelte').Snippet;
}

let {
  title,
  description,
  series,
  formatValue = (value: number) => String(value),
  height = 240,
  children
}: Props = $props();

let view = $state<'chart' | 'table'>('chart');
let legendOpen = $state(true);

const hasLegend = $derived(series.length > 1);
const allRows = $derived(
  series.flatMap((entry) => entry.data.map((datum) => ({ series: entry.name, ...datum })))
);
const summaryLabel = $derived(
  series.length === 1 && series[0]
    ? formatValue(series[0].data.reduce((sum, datum) => sum + datum.value, 0))
    : `${allRows.length} points`
);
</script>

<figure class="space-y-2">
  <figcaption class="flex flex-wrap items-start justify-between gap-2">
    <div class="min-w-0">
      <p class="text-xs font-semibold text-[var(--color-ink)]">{title}</p>
      {#if description}
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">{description}</p>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1.5">
      <span class="text-[11px] text-[var(--color-ink-subtle)]">{summaryLabel}</span>
      <SegmentedControl
        label="Chart or data table"
        value={view}
        onchange={(next) => (view = next as 'chart' | 'table')}
        options={[
          { value: 'chart', label: 'Chart' },
          { value: 'table', label: 'Data' }
        ]}
      />
    </div>
  </figcaption>

  {#if view === 'table'}
    <table class="w-full border-collapse text-xs">
      <caption class="sr-only">{title} data</caption>
      <thead>
        <tr class="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)]">
          {#if series.length > 1}
            <th scope="col" class="px-2 py-1.5 text-left font-semibold text-[var(--color-ink-subtle)]">Series</th>
          {/if}
          <th scope="col" class="px-2 py-1.5 text-left font-semibold text-[var(--color-ink-subtle)]">Label</th>
          <th scope="col" class="px-2 py-1.5 text-right font-semibold text-[var(--color-ink-subtle)]">Value</th>
        </tr>
      </thead>
      <tbody>
        {#each allRows as row, index (index)}
          <tr class="border-b border-[var(--color-border-subtle)] last:border-b-0">
            {#if series.length > 1}
              <td class="px-2 py-1.5">{row.series}</td>
            {/if}
            <td class="px-2 py-1.5">{row.rawLabel ?? row.label}</td>
            <td class="px-2 py-1.5 text-right font-mono">{formatValue(row.value)}</td>
          </tr>
        {/each}
        {#if allRows.length === 0}
          <tr>
            <td
              colspan={series.length > 1 ? 3 : 2}
              class="px-2 py-4 text-center text-[var(--color-ink-subtle)]"
            >
              No data
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  {:else}
    {#if hasLegend && legendOpen}
      <ul class="flex flex-wrap gap-2">
        {#each series as entry (entry.name)}
          <li class="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
            <span
              class="h-2 w-2 rounded-full"
              style="background-color: {colorFor(entry.name)}"
              aria-hidden="true"
            ></span>
            {entry.name}
          </li>
        {/each}
        <li class="ml-auto">
          <button
            type="button"
            class="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
            onclick={() => (legendOpen = false)}
          >
            Hide legend
          </button>
        </li>
      </ul>
    {:else if hasLegend}
      <div class="flex justify-end">
        <button
          type="button"
          class="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
          onclick={() => (legendOpen = true)}
        >
          Show legend
        </button>
      </div>
    {/if}
    <div class="relative w-full" style="min-height: {height}px">
      {@render children?.()}
    </div>
  {/if}
</figure>
