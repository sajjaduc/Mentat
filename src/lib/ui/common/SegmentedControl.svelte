<script lang="ts">
/**
 * SegmentedControl: pick one of a small set of mutually exclusive modes.
 *
 * Used for genuinely modal choices — metadata vs content search, table vs grid —
 * where a `<select>` would hide the alternatives and a row of buttons would not
 * communicate that only one can be active. Rendered as a radiogroup so arrow keys
 * work and the current choice is announced.
 */
interface Option {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  options: Option[];
  value: string;
  onchange: (value: string) => void;
  label: string;
  class?: string;
  size?: 'sm' | 'md';
}

let { options, value, onchange, label, class: className = '', size = 'sm' }: Props = $props();

function onKeydown(event: KeyboardEvent, index: number) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const next = options[(index + delta + options.length) % options.length];
  if (next) onchange(next.value);
}
</script>

<div
  role="radiogroup"
  aria-label={label}
  class="inline-flex items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-0.5 {className}"
>
  {#each options as option, index (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === option.value}
      tabindex={value === option.value ? 0 : -1}
      title={option.hint}
      class="rounded-[var(--radius-sm)] font-medium transition-colors
        {size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'}
        {value === option.value
          ? 'bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-card)]'
          : 'text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]'}"
      onclick={() => onchange(option.value)}
      onkeydown={(event) => onKeydown(event, index)}
    >
      {option.label}
    </button>
  {/each}
</div>
