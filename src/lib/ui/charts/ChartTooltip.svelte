<script lang="ts">
/**
 * ChartTooltip: the exact-value readout for a hovered chart mark.
 *
 * Positioned as a fraction of the chart box rather than by pointer coordinates, so
 * it lands next to the mark the user is actually inspecting and never depends on
 * mouse-tracking accuracy. `role="status"` means the value is announced as well as
 * shown.
 */
interface Row {
  series: string;
  label: string;
  value: string;
}

interface Props {
  x: number;
  y: number;
  title: string;
  rows: Row[];
}

let { x, y, title, rows }: Props = $props();

// Keep the tooltip inside the box: past ~70% it flips to the left of the mark.
const side = $derived(x > 0.7 ? 'left' : 'right');
</script>

<div
  class="pointer-events-none absolute z-10 max-w-56 animate-fade-in rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 shadow-[var(--shadow-raised)]"
  style={side === 'left'
    ? `right: ${Math.round((1 - x) * 100)}%; top: ${Math.round(y * 100)}%;`
    : `left: ${Math.round(x * 100)}%; top: ${Math.round(y * 100)}%;`}
  role="status"
>
  <p class="text-[11px] font-semibold text-[var(--color-ink)]">{title}</p>
  <ul class="mt-0.5 space-y-0.5">
    {#each rows as row, index (index)}
      <li class="flex items-center justify-between gap-3 text-[11px]">
        <span class="truncate text-[var(--color-ink-muted)]">{row.series || row.label}</span>
        <span class="font-mono text-[var(--color-ink)]">{row.value}</span>
      </li>
    {/each}
  </ul>
</div>
