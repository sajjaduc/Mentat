<script lang="ts">
/**
 * FunnelChart: explicitly ordered milestones with counts and conversion.
 *
 * The stages come from the widget definition, in the order the author selected
 * them. Kanban column order is never used to infer stage order, because workflows
 * branch and a board's left-to-right layout is a presentation choice, not a process
 * order (ADR-0017).
 *
 * Counts are cumulative by construction: each stage independently asks "did this
 * ticket ever reach here", so a ticket that skipped a stage still counts in the
 * later one and is never double-counted. Conversion between stages and overall
 * conversion are ratios of those counts.
 *
 * Inter-stage *timing* (median/average seconds to reach a stage) is computed by
 * `analytics/funnel.ts` but is not part of the run endpoint's serialized result, so
 * this chart does not display a timing column it cannot fill. The note under the
 * chart says where that number lives.
 */

import { formatPercent } from '$ui/format';
import Badge from '$ui/primitives/Badge.svelte';
import type { FunnelView } from './view-models';

interface Props {
  funnel: FunnelView;
  formatValue?: (value: number) => string;
}

let { funnel, formatValue = (value: number) => value.toLocaleString() }: Props = $props();

const maxCount = $derived(funnel.stages.reduce((max, stage) => Math.max(max, stage.count), 0));
</script>

{#if funnel.empty || funnel.stages.length === 0}
  <p class="py-6 text-center text-xs text-[var(--color-ink-subtle)]">
    This funnel has no milestones yet. A funnel is authored by explicitly selecting ordered
    states and/or field values — it is never inferred from board order.
  </p>
{:else}
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <Badge tone="accent">Overall conversion {formatPercent(funnel.overallConversion)}</Badge>
      <span class="text-[11px] text-[var(--color-ink-subtle)]">
        {funnel.stages.length} explicit milestones, evaluated from recorded history
      </span>
    </div>

    <ol class="space-y-2">
      {#each funnel.stages as stage, index (stage.label)}
        <li class="space-y-1">
          <div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span class="flex items-center gap-1.5 font-medium">
              <span class="text-[10px] text-[var(--color-ink-subtle)]">{index + 1}.</span>
              {stage.label}
            </span>
            <span class="flex items-center gap-3 text-[11px] text-[var(--color-ink-muted)]">
              <span class="font-mono">{formatValue(stage.count)}</span>
              {#if stage.conversionFromPrevious !== null}
                <span title="Conversion from the previous stage">
                  {formatPercent(stage.conversionFromPrevious)} from previous
                </span>
              {/if}
              {#if stage.conversionFromFirst !== null && index > 0}
                <span title="Conversion from the first stage">
                  {formatPercent(stage.conversionFromFirst)} overall
                </span>
              {/if}
            </span>
          </div>
          <div class="h-3 overflow-hidden rounded-[var(--radius-xs)] bg-[var(--color-surface-muted)]">
            <div
              class="h-full rounded-[var(--radius-xs)] bg-[var(--color-accent)] transition-[width] duration-200"
              style="width: {maxCount > 0 ? Math.max(1, (stage.count / maxCount) * 100) : 0}%"
              role="img"
              aria-label="{stage.label}: {formatValue(stage.count)}"
            ></div>
          </div>
        </li>
      {/each}
    </ol>

    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      Counts ask “did this ticket ever reach this milestone inside the window”, so a ticket that
      skipped a stage still counts in the later one. Median and average time between stages are
      computed server-side from recorded entry timestamps; the run endpoint does not serialize them
      yet, so they are not shown here rather than approximated.
    </p>
  </div>
{/if}
