<script lang="ts">
/**
 * Switch: a labelled checkbox for an instant, optimistic setting.
 *
 * The shared `Toggle` binds its checked state directly, which is the right shape for
 * form drafts; provider and model rows instead need the *event* so they can apply an
 * optimistic update and roll back on failure. This keeps that contract explicit
 * without duplicating the styling in every row.
 */
interface Props {
  checked: boolean;
  label: string;
  hint?: string;
  disabled?: boolean;
  onchange: (next: boolean) => void;
}

let { checked, label, hint, disabled = false, onchange }: Props = $props();

const inputId = `switch-${Math.random().toString(36).slice(2, 9)}`;
</script>

<label
  for={inputId}
  class="flex items-start gap-2 {disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}"
>
  <input
    id={inputId}
    type="checkbox"
    {checked}
    {disabled}
    class="mt-0.5 h-4 w-4 shrink-0 rounded-[var(--radius-xs)] border-[var(--color-border-strong)] accent-[var(--color-accent)]"
    onchange={(event) => onchange(event.currentTarget.checked)}
  />
  <span class="space-y-0.5">
    <span class="block text-xs text-[var(--color-ink)]">{label}</span>
    {#if hint}
      <span class="block text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">{hint}</span>
    {/if}
  </span>
</label>
