<script lang="ts">
/** ErrorState: always offers a retry, and shows the stable code for support. */
interface Props {
  message: string;
  code?: string | null;
  requestId?: string | null;
  onRetry?: () => void;
}
let { message, code = null, requestId = null, onRetry }: Props = $props();
</script>

<div class="flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_6%,var(--color-surface))] p-4">
  <div class="flex items-start gap-2">
    <svg viewBox="0 0 24 24" class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" stroke-linecap="round" />
    </svg>
    <div class="space-y-1">
      <p class="text-sm text-[var(--color-ink)]">{message}</p>
      {#if code}<p class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{code}{requestId ? ` · ${requestId.slice(0, 8)}` : ''}</p>{/if}
    </div>
  </div>
  {#if onRetry}
    <button class="rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-muted)]" onclick={onRetry}>
      Try again
    </button>
  {/if}
</div>
