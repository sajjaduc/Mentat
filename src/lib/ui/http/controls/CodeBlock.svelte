<script lang="ts">
/** CodeBlock: monospace output with a copy action, used for schemas, payloads and commands. */
import CopyButton from './CopyButton.svelte';

interface Props {
  value: string;
  label?: string;
  maxHeight?: string;
  emptyLabel?: string;
}

let { value, label, maxHeight = '22rem', emptyLabel = 'Nothing to show yet.' }: Props = $props();
</script>

<div class="space-y-1.5">
  <div class="flex items-center justify-between gap-2">
    {#if label}
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</p>
    {:else}
      <span></span>
    {/if}
    <CopyButton text={value} />
  </div>
  {#if value.length === 0}
    <p class="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-subtle)] px-3 py-2 text-xs text-[var(--color-ink-subtle)]">
      {emptyLabel}
    </p>
  {:else}
    <pre
      class="scrollbar-thin overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
      style="max-height: {maxHeight}">{value}</pre>
  {/if}
</div>
