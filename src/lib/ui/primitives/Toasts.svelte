<script lang="ts">
/**
 * Toasts: transient feedback for background failures and confirmations.
 *
 * Deliberately dismissible and never blocking: a toast reports something that
 * already happened, so it must not require a decision.
 */
import { dismissToast, toasts } from '$lib/ui/toast';

const tones = {
  success: 'border-[color-mix(in_oklch,var(--color-positive)_40%,transparent)]',
  error: 'border-[color-mix(in_oklch,var(--color-danger)_40%,transparent)]',
  info: 'border-[var(--color-border-subtle)]'
} as const;
</script>

<div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite" role="status">
  {#each toasts.current as toast (toast.id)}
    <div class="animate-pop-in pointer-events-auto rounded-[var(--radius-md)] border bg-[var(--color-surface)] p-3 shadow-[var(--shadow-overlay)] {tones[toast.tone]}">
      <div class="flex items-start justify-between gap-2">
        <div class="space-y-0.5">
          <p class="text-xs font-medium text-[var(--color-ink)]">{toast.title}</p>
          {#if toast.description}<p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">{toast.description}</p>{/if}
        </div>
        <button class="text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]" aria-label="Dismiss" onclick={() => dismissToast(toast.id)}>
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>
  {/each}
</div>
