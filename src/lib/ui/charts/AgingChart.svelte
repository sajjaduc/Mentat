<script lang="ts">
/**
 * AgingChart: time-in-state, stated as history rather than current rows.
 *
 * The whole point of this widget is that current state cannot answer "how long do
 * tickets spend in Human Review". Every number here comes from
 * `ticket_state_history` intervals — including an open interval, which is measured
 * against now so in-progress work is counted rather than dropped.
 *
 * `GET /api/dashboards/:id/run` returns the **median** dwell time per state and
 * nothing else, so that is what is plotted. p90, average, max and the currently-in
 * count are produced by `analytics/aging.ts` but are not part of the serialized
 * result; the panel says so instead of showing blank statistics.
 */
import Badge from '$ui/primitives/Badge.svelte';
import ChartTooltip from './ChartTooltip.svelte';
import { formatDurationSeconds } from './geometry';
import { colorAt } from './series-colors';
import type { AgingEntryView } from './view-models';

interface Props {
  entries: AgingEntryView[];
}

let { entries }: Props = $props();

const maxMedian = $derived(
  entries.reduce((max, entry) => Math.max(max, entry.medianSeconds ?? 0), 0)
);
let hover = $state<number | null>(null);
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-center gap-2">
    <Badge tone="neutral">From recorded history</Badge>
    <span class="text-[11px] text-[var(--color-ink-subtle)]">
      Intervals from <code class="font-mono">ticket_state_history</code>, not current ticket rows
    </span>
  </div>

  {#if entries.length === 0}
    <p class="py-6 text-center text-xs text-[var(--color-ink-subtle)]">
      No states selected. Choose the states to measure dwell time in.
    </p>
  {:else}
    <div class="relative space-y-2">
      {#each entries as entry, index (entry.stateId)}
        <div class="space-y-1">
          <div class="flex items-baseline justify-between gap-2 text-xs">
            <span class="font-medium">{entry.label}</span>
            <span class="font-mono text-[11px] text-[var(--color-ink-muted)]">
              median {formatDurationSeconds(entry.medianSeconds)}
            </span>
          </div>
          <div
            class="h-3 overflow-hidden rounded-[var(--radius-xs)] bg-[var(--color-surface-muted)]"
            onmouseenter={() => (hover = index)}
            onmouseleave={() => (hover = null)}
            role="img"
            aria-label="{entry.label}: median {formatDurationSeconds(entry.medianSeconds)}"
          >
            <div
              class="h-full rounded-[var(--radius-xs)] transition-[width] duration-200"
              style="width: {maxMedian > 0
                ? Math.max(1, ((entry.medianSeconds ?? 0) / maxMedian) * 100)
                : 0}%; background-color: {colorAt(index)}"
            ></div>
          </div>
        </div>
      {/each}

      {#if hover !== null && entries[hover]}
        <ChartTooltip
          x={0.4}
          y={0.05}
          title={entries[hover]!.label}
          rows={[
            {
              series: 'Median time in state',
              label: 'Median',
              value: formatDurationSeconds(entries[hover]!.medianSeconds)
            }
          ]}
        />
      {/if}
    </div>

    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      The run endpoint returns the median dwell time per state. p90, average, maximum and the
      currently-in count are computed by the aging report server-side from the same intervals; they
      are not serialized yet, so this chart shows the number it actually has.
    </p>
  {/if}
</div>
