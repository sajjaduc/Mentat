<script lang="ts">
/**
 * Toggle: a labelled checkbox. Used wherever a setting is a boolean — permissions,
 * cache participation, retry behaviour — so the "off" state is always explicit rather
 * than an empty field.
 */
interface Props {
  checked?: boolean;
  label: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
  onchange?: (checked: boolean) => void;
}

let { checked = $bindable(false), label, hint, disabled = false, id, onchange }: Props = $props();
const generatedId = `toggle-${Math.random().toString(36).slice(2, 9)}`;
const inputId = $derived(id ?? generatedId);
</script>

<label
  for={inputId}
  class="flex items-start gap-2.5 {disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}"
>
  <input
    id={inputId}
    type="checkbox"
    bind:checked
    {disabled}
    class="mt-0.5 h-4 w-4 shrink-0 rounded-[var(--radius-xs)] border-[var(--color-border-strong)] accent-[var(--color-accent)]"
    onchange={(event) => onchange?.(event.currentTarget.checked)}
  />
  <span class="space-y-0.5">
    <span class="block text-sm text-[var(--color-ink)]">{label}</span>
    {#if hint}
      <span class="block text-xs leading-relaxed text-[var(--color-ink-subtle)]">{hint}</span>
    {/if}
  </span>
</label>
