<script lang="ts">
/**
 * NumberField: a two-way numeric input where an empty box means "not set" (`null`)
 * rather than zero, because an absent timeout and a timeout of 0 are different
 * policies. This wrapper exists for the same reason as {@link TextField}: the frozen
 * primitives cannot be bound two-way.
 */
interface Props {
  value?: number | null;
  label?: string;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  onchange?: (value: number | null) => void;
}

let {
  value = $bindable<number | null>(null),
  label,
  hint,
  error = null,
  placeholder,
  min,
  max,
  step,
  disabled = false,
  required = false,
  id,
  onchange
}: Props = $props();

const generatedId = `number-${Math.random().toString(36).slice(2, 9)}`;
const inputId = $derived(id ?? generatedId);
</script>

<div class="flex flex-col gap-1.5">
  {#if label}
    <label for={inputId} class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</label>
  {/if}
  <input
    id={inputId}
    type="number"
    {min}
    {max}
    {step}
    {disabled}
    {required}
    {placeholder}
    value={value ?? ''}
    aria-invalid={error ? 'true' : undefined}
    class="h-9 w-full rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]
      {error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]'}"
    oninput={(event) => {
      const raw = event.currentTarget.value;
      value = raw === '' ? null : Number(raw);
      onchange?.(value);
    }}
  />
  {#if error}
    <p class="text-xs text-[var(--color-danger)]">{error}</p>
  {:else if hint}
    <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">{hint}</p>
  {/if}
</div>
