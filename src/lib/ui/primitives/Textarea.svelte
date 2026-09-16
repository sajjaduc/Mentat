<script lang="ts">
/** Textarea: multi-line field with an optional monospace mode for JSON/templates. */
import type { HTMLTextareaAttributes } from 'svelte/elements';
import { nextControlId } from './ids';

interface Props extends HTMLTextareaAttributes {
  label?: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
}
let {
  label,
  hint,
  error = null,
  mono = false,
  class: className = '',
  id,
  // `value` must be declared bindable, otherwise `bind:value` is one-way.
  value = $bindable(),
  ...rest
}: Props = $props();
const inputId = $derived(id ?? `textarea-${nextControlId()}`);
</script>

<div class="flex flex-col gap-1.5">
  {#if label}
    <label for={inputId} class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</label>
  {/if}
  <textarea
    {...rest}
    bind:value
    id={inputId}
    aria-invalid={error ? 'true' : undefined}
    class="w-full resize-y rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-2.5 py-2 text-sm leading-relaxed
      {error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]'}
      focus:border-[var(--color-accent)] {mono ? 'font-mono text-xs' : ''} {className}"
  ></textarea>
  {#if error}
    <p class="text-xs text-[var(--color-danger)]">{error}</p>
  {:else if hint}
    <p class="text-xs text-[var(--color-ink-subtle)]">{hint}</p>
  {/if}
</div>
