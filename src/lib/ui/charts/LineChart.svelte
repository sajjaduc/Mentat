<script lang="ts">
/**
 * LineChart: one or more series as inline SVG polylines.
 *
 * A vertical hit zone per index (rather than a hit area on the 2px line) is what
 * makes hovering practical: the reader aims at a point in time, not at a stroke.
 * Hovering shows every series at that index with its exact value.
 */
import ChartTooltip from './ChartTooltip.svelte';
import {
  areaPath,
  formatAxisValue,
  linearScale,
  linePath,
  niceTicks,
  type Point,
  truncateLabel,
  valueDomain
} from './geometry';
import { colorAt } from './series-colors';
import type { ChartSeries } from './types';

interface Props {
  series: ChartSeries[];
  height?: number;
  filled?: boolean;
  stacked?: boolean;
  formatValue?: (value: number) => string;
}

let {
  series,
  height = 240,
  filled = false,
  formatValue = (value: number) => formatAxisValue(value)
}: Props = $props();

const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 42;
const WIDTH = 640;

const labels = $derived(series[0]?.data.map((datum) => datum.rawLabel ?? datum.label) ?? []);
const count = $derived(labels.length);
const domain = $derived(
  valueDomain(
    series.flatMap((entry) => entry.data.map((datum) => datum.value)),
    false
  )
);
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
const step = $derived(count > 1 ? plotWidth / (count - 1) : plotWidth);

const baselineY = $derived(yScale.map(ticks[0] ?? domain.min));

function pointsFor(entry: ChartSeries): Point[] {
  return entry.data.map((datum, index) => ({
    x: PAD_LEFT + index * step,
    y: yScale.map(datum.value)
  }));
}

let hover = $state<number | null>(null);
</script>

<div class="relative">
  <svg
    viewBox="0 0 {WIDTH} {height}"
    class="h-auto w-full"
    preserveAspectRatio="none"
    role="img"
    aria-label={filled ? 'Area chart' : 'Line chart'}
  >
    <title>{filled ? 'Area chart' : 'Line chart'}</title>
    <desc>
      {count} points across {series.length} series.
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

    {#each series as entry, seriesIndex (entry.name)}
      {@const points = pointsFor(entry)}
      {#if filled && seriesIndex === 0}
        <path d={areaPath(points, baselineY)} fill={colorAt(seriesIndex)} opacity="0.15" />
      {/if}
      <path
        d={linePath(points)}
        fill="none"
        stroke={colorAt(seriesIndex)}
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      {#if count <= 40}
        {#each points as point, index (index)}
          <circle
            cx={point.x}
            cy={point.y}
            r={hover === index ? 4 : 2.5}
            fill="var(--color-surface)"
            stroke={colorAt(seriesIndex)}
            stroke-width="2"
          >
            <title>{entry.name}: {formatValue(entry.data[index]?.value ?? 0)}</title>
          </circle>
        {/each}
      {/if}
    {/each}

    {#each labels as label, index (index)}
      {#if count <= 12 || index % Math.ceil(count / 10) === 0}
        <text
          x={PAD_LEFT + index * step}
          y={height - PAD_BOTTOM + 14}
          text-anchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}
          font-size="10"
          fill="var(--color-ink-subtle)">{truncateLabel(label)}</text
        >
      {/if}
    {/each}

    {#each labels as _label, index (index)}
      <rect
        x={PAD_LEFT + index * step - step / 2}
        y={PAD_TOP}
        width={step}
        height={height - PAD_TOP - PAD_BOTTOM}
        fill="transparent"
        role="presentation"
        onpointerenter={() => (hover = index)}
        onpointerleave={() => (hover = null)}
      />
    {/each}
  </svg>

  {#if hover !== null}
    <ChartTooltip
      x={(PAD_LEFT + hover * step) / WIDTH}
      y={0.08}
      title={labels[hover] ?? ''}
      rows={series.map((entry) => ({
        series: entry.name,
        label: entry.name,
        value: formatValue(entry.data[hover as number]?.value ?? 0)
      }))}
    />
  {/if}
</div>
