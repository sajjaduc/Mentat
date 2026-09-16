<script lang="ts">
/** Select: native select styled to match Input, with grouped options support. */
import type { HTMLSelectAttributes } from 'svelte/elements';
import { nextControlId } from './ids';

interface Props extends HTMLSelectAttributes {
  label?: string;
  hint?: string;
  error?: string | null;
  options: Option[];
  placeholder?: string;
}
let {
  label,
  hint,
  error = null,
  options,
  placeholder,
  class: className = '',
  id,
  // `value` must be declared bindable, otherwise `bind:value` is one-way.
  value = $bindable(),
  ...rest
}: Props = $props();
const inputId = $derived(id ?? `select-${nextControlId()}`);
</script>

<div class="flex flex-col gap-1.5">
  {#if label}
    <label for={inputId} class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</label>
  {/if}
  <select
    {...rest}
    bind:value
    id={inputId}
    class="h-9 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-2 text-sm
      {error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]'}
      focus:border-[var(--color-accent)] {className}"
  >
    {#if placeholder}<option value="">{placeholder}</option>{/if}
    {#each options as option (option.value)}
      <option value={option.value} disabled={option.disabled}>{option.label}</option>
    {/each}
  </select>
  {#if error}<p class="text-xs text-[var(--color-danger)]">{error}</p>
  {:else if hint}<p class="text-xs text-[var(--color-ink-subtle)]">{hint}</p>{/if}
</div>
