<script lang="ts">
/**
 * Collapsible JSON viewer.
 *
 * Tool arguments, results and context snapshots are essential but noisy, so they
 * are collapsed by default and rendered as monospace text that can be read without
 * a JSON tree widget.
 */
interface Props {
  value: unknown;
  label?: string;
  open?: boolean;
}

let { value, label = 'Details', open = false }: Props = $props();

const text = $derived(
  typeof value === 'string' ? value : (JSON.stringify(value ?? null, null, 2) ?? 'null')
);
</script>

<details class="group" open={open}>
  <summary
    class="cursor-pointer list-none text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink-muted)]"
  >
    <span class="inline-flex items-center gap-1">
      <span class="transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
      {label}
    </span>
  </summary>
  <pre
    class="scrollbar-thin mt-1 max-h-64 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2 font-mono text-[11px] whitespace-pre-wrap">{text}</pre>
</details>
