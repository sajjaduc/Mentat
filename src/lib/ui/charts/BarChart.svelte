<script lang="ts">
/**
 * BarChart: grouped (and optionally stacked) vertical bars in inline SVG.
 *
 * Values are labelled directly when there is room, because a bar chart's shape is
 * only half the answer — the reader usually needs the number. Hovering a bar shows
 * the exact value; the surrounding `ChartFrame` supplies the data-table fallback.
 */
import ChartTooltip from './ChartTooltip.svelte';
import { formatAxisValue, linearScale, niceTicks, truncateLabel, valueDomain } from './geometry';
import { colorAt } from './series-colors';
import type { ChartSeries } from './types';

interface Props {
  series: ChartSeries[];
  height?: number;
  stacked?: boolean;
  color?: string;
  /** Formats a value for the axis, tooltip and direct labels. */
  formatValue?: (value: number) => string;
}

let {
  series,
  height = 240,
  stacked = false,
  color,
  formatValue = (value: number) => formatAxisValue(value)
}: Props = $props();

const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 42;
const WIDTH = 640;

const labels = $derived(series[0]?.data.map((datum) => datum.rawLabel ?? datum.label) ?? []);
const categories = $derived(labels.length);

const domain = $derived.by(() => {
  if (stacked) {
    const totals = labels.map((_, index) =>
      series.reduce((sum, entry) => sum + (entry.data[index]?.value ?? 0), 0)
    );
    return valueDomain(totals, true);
  }
  return valueDomain(
    series.flatMap((entry) => entry.data.map((datum) => datum.value)),
    true
  );
});

const ticks = $derived(niceTicks(domain.min, domain.max, 5));
const yScale = $derived(
  linearScale(
    ticks[0] ?? domain.min,
    ticks[ticks.length - 1] ?? domain.max,
    height - PAD_BOTTOM,
    PAD_TOP
  )
);

const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
const categoryWidth = $derived(categories > 0 ? plotWidth / categories : plotWidth);
const groupWidth = $derived(categoryWidth * 0.66);
const barWidth = $derived(
  stacked ? groupWidth : Math.max(1, groupWidth / Math.max(1, series.length))
);

let hover = $state<{ index: number; x: number } | null>(null);

function barsFor(
  index: number
): Array<{ seriesName: string; value: number; x: number; y: number; h: number }> {
  const bars: Array<{ seriesName: string; value: number; x: number; y: number; h: number }> = [];
  const groupLeft = PAD_LEFT + index * categoryWidth + (categoryWidth - groupWidth) / 2;
  let stackTop = yScale.map(0);
  series.forEach((entry, seriesIndex) => {
    const datum = entry.data[index];
    if (!datum) return;
    const top = yScale.map(datum.value);
    if (stacked) {
      const barHeight = Math.max(0, stackTop - top);
      bars.push({
        seriesName: entry.name,
        value: datum.value,
        x: groupLeft,
        y: top,
        h: barHeight
      });
      stackTop = top;
    } else {
      bars.push({
        seriesName: entry.name,
        value: datum.value,
        x: groupLeft + seriesIndex * barWidth,
        y: Math.min(top, yScale.map(0)),
        h: Math.abs(yScale.map(0) - top)
      });
    }
  });
  return bars;
}

const plotBottom = $derived(yScale.map(0));
</script>

<div class="relative">
  <svg
    viewBox="0 0 {WIDTH} {height}"
    class="h-auto w-full"
    preserveAspectRatio="none"
    role="img"
    aria-label="Bar chart"
  >
    <title>Bar chart</title>
    <desc>
      {categories} categories across {series.length} series.
      {#each series as entry (entry.name)}{entry.name}: {entry.data.map((datum) => `${datum.rawLabel ?? datum.label} ${formatValue(datum.value)}`).join(', ')}. {/each}
    </desc>

    {#each ticks as tick (tick)}
      <line
        x1={PAD_LEFT}
        x2={WIDTH - PAD_RIGHT}
        y1={yScale.map(tick)}
        y2={yScale.map(tick)}
        stroke="var(--color-border-subtle)"
        stroke-width="1"
      />
      <text
        x={PAD_LEFT - 6}
        y={yScale.map(tick) + 3}
        text-anchor="end"
        font-size="10"
        fill="var(--color-ink-subtle)">{formatValue(tick)}</text
      >
    {/each}

    {#each labels as label, index (index)}
      <rect
        x={PAD_LEFT + index * categoryWidth}
        y={PAD_TOP}
        width={categoryWidth}
        height={height - PAD_TOP - PAD_BOTTOM}
        fill="transparent"
        role="presentation"
        onpointerenter={() => (hover = { index, x: PAD_LEFT + (index + 0.5) * categoryWidth })}
        onpointerleave={() => (hover = null)}
      />
      {#each barsFor(index) as bar, barIndex (barIndex)}
        <rect
          x={bar.x}
          y={bar.y}
          width={barWidth}
          height={Math.max(0, bar.h)}
          rx="2"
          fill={color ?? (series.length === 1 ? colorAt(0) : colorAt(barIndex))}
          opacity={hover && hover.index !== index ? 0.55 : 1}
        >
          <title>{bar.seriesName}: {formatValue(bar.value)}</title>
        </rect>
      {/each}
      {#if categories <= 12}
        <text
          x={PAD_LEFT + (index + 0.5) * categoryWidth}
          y={height - PAD_BOTTOM + 14}
          text-anchor="middle"
          font-size="10"
          fill="var(--color-ink-subtle)">{truncateLabel(label)}</text
        >
      {/if}
    {/each}

    <line
      x1={PAD_LEFT}
      x2={WIDTH - PAD_RIGHT}
      y1={plotBottom}
      y2={plotBottom}
      stroke="var(--color-border-strong)"
      stroke-width="1"
    />
  </svg>

  {#if hover && series.length > 0}
    <ChartTooltip
      x={hover.x / WIDTH}
      y={0.1}
      title={labels[hover.index] ?? ''}
      rows={series.map((entry) => ({
        series: entry.name,
        label: entry.name,
        value: formatValue(entry.data[hover!.index]?.value ?? 0)
      }))}
    />
  {/if}
</div>
