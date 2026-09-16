<script lang="ts">
/** Input: labelled text field with inline error and hint text. */
import type { HTMLInputAttributes } from 'svelte/elements';
import { nextControlId } from './ids';

// `size` is omitted from the native attributes because the primitive uses it for its
// own visual scale, not for the HTML `size` attribute.
interface Props extends Omit<HTMLInputAttributes, 'size'> {
  label?: string;
  hint?: string;
  error?: string | null;
  size?: 'sm' | 'md';
}
let {
  label,
  hint,
  error = null,
  size = 'md',
  class: className = '',
  id,
  // `value` must be declared bindable, otherwise `bind:value` on this component is
  // one-way: the parent's setter is never called.
  value = $bindable(),
  ...rest
}: Props = $props();
const inputId = $derived(id ?? `input-${nextControlId()}`);
const sizes = { sm: 'h-7 text-xs', md: 'h-9 text-sm' } as const;
</script>

<div class="flex flex-col gap-1.5">
  {#if label}
    <label for={inputId} class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</label>
  {/if}
  <input
    {...rest}
    bind:value
    id={inputId}
    aria-invalid={error ? 'true' : undefined}
    aria-describedby={hint || error ? `${inputId}-help` : undefined}
    class="w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-2.5 text-[var(--color-ink)]
      placeholder:text-[var(--color-ink-subtle)]
      {error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]'}
      focus:border-[var(--color-accent)] {sizes[size]} {className}"
  />
  {#if error}
    <p id="{inputId}-help" class="text-xs text-[var(--color-danger)]">{error}</p>
  {:else if hint}
    <p id="{inputId}-help" class="text-xs text-[var(--color-ink-subtle)]">{hint}</p>
  {/if}
</div>
