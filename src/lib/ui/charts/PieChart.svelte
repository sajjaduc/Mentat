<script lang="ts">
/**
 * PieChart: proportional slices in inline SVG (`donut` is the same geometry with
 * an inner radius).
 *
 * A pie answers "what share" and hides the absolute number, so each slice's title
 * and the tooltip both carry count *and* percentage, and the frame's data table is
 * one click away. Slices are keyed by index so hovering one dims the others without
 * reordering the arcs.
 */
import ChartTooltip from './ChartTooltip.svelte';
import { arcPath, totalOf } from './geometry';
import { colorAt } from './series-colors';
import type { ChartSeries } from './types';

interface Props {
  series: ChartSeries[];
  height?: number;
  donut?: boolean;
  formatValue?: (value: number) => string;
}

let {
  series,
  height = 240,
  donut = false,
  formatValue = (value: number) => value.toLocaleString()
}: Props = $props();

const SIZE = 240;
const CENTER = SIZE / 2;
const RADIUS = 96;

const data = $derived(series[0]?.data ?? []);
/** Read once: the prop selects the geometry and does not change mid-render. */
const isDonut = donut;
const INNER = isDonut ? 58 : 0;
const total = $derived(totalOf(data.map((datum) => datum.value)));
const totalLabel = $derived(formatValue(total));

let hover = $state<number | null>(null);

const slices = $derived.by(() => {
  let angle = -Math.PI / 2;
  return data.map((datum, index) => {
    const fraction = total > 0 ? datum.value / total : 0;
    const start = angle;
    const end = angle + fraction * Math.PI * 2;
    angle = end;
    return {
      datum,
      index,
      start,
      end,
      fraction,
      path: arcPath(CENTER, CENTER, RADIUS, start, end, INNER)
    };
  });
});

function percentLabel(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
</script>

<div class="relative flex justify-center">
  <svg
    viewBox="0 0 {SIZE} {SIZE}"
    class="h-auto w-full max-w-xs"
    role="img"
    aria-label={isDonut ? 'Donut chart' : 'Pie chart'}
  >
    <title>{isDonut ? 'Donut chart' : 'Pie chart'}</title>
    <desc>
      Total {totalLabel} across {data.length} categories.
      {#each data as datum (datum.label)}{datum.rawLabel ?? datum.label}: {formatValue(datum.value)} ({percentLabel(total > 0 ? datum.value / total : 0)}). {/each}
    </desc>

    {#if total <= 0}
      <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="var(--color-surface-muted)" />
      <text x={CENTER} y={CENTER + 4} text-anchor="middle" font-size="12" fill="var(--color-ink-subtle)">
        No data
      </text>
    {:else}
      {#each slices as slice (slice.index)}
        <path
          d={slice.path}
          fill={colorAt(slice.index)}
          opacity={hover === null || hover === slice.index ? 1 : 0.5}
          stroke="var(--color-surface)"
          stroke-width="1.5"
          role="presentation"
          onpointerenter={() => (hover = slice.index)}
          onpointerleave={() => (hover = null)}
        >
          <title>
            {slice.datum.rawLabel ?? slice.datum.label}: {formatValue(slice.datum.value)}
            ({percentLabel(slice.fraction)})
          </title>
        </path>
      {/each}
      {#if isDonut}
        <text
          x={CENTER}
          y={CENTER - 2}
          text-anchor="middle"
          font-size="12"
          fill="var(--color-ink-subtle)">Total</text
        >
        <text
          x={CENTER}
          y={CENTER + 16}
          text-anchor="middle"
          font-size="16"
          font-weight="600"
          fill="var(--color-ink)">{totalLabel}</text
        >
      {/if}
    {/if}
  </svg>

  {#if hover !== null && slices[hover]}
    <ChartTooltip
      x={0.5}
      y={0.05}
      title={slices[hover]!.datum.rawLabel ?? slices[hover]!.datum.label}
      rows={[
        {
          series: 'Value',
          label: 'Value',
          value: formatValue(slices[hover]!.datum.value)
        },
        { series: 'Share', label: 'Share', value: percentLabel(slices[hover]!.fraction) }
      ]}
    />
  {/if}
</div>
