<script lang="ts">
/**
 * AreaChart: a line chart with the first series filled to its baseline.
 *
 * Implemented as a thin configuration of `LineChart` rather than a second
 * implementation, so the axis, hover behaviour and accessibility description can
 * never drift between the two visualisations.
 */
import LineChart from './LineChart.svelte';
import type { ChartSeries } from './types';

interface Props {
  series: ChartSeries[];
  height?: number;
  formatValue?: (value: number) => string;
}

let { series, height = 240, formatValue }: Props = $props();
</script>

<LineChart {series} {height} {formatValue} filled />
