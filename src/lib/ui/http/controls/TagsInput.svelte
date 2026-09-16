<script lang="ts">
/**
 * TagsInput: a list of short strings (labels, allowed hosts, vary-on keys, status
 * codes). Values commit on Enter or comma, and only non-empty trimmed values are kept,
 * so a trailing comma never becomes an empty entry.
 */
interface Props {
  values?: string[];
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
}

let {
  values = $bindable<string[]>([]),
  label,
  hint,
  placeholder = 'Add value…',
  disabled = false,
  emptyLabel = 'None.'
}: Props = $props();

let draft = $state('');

function commit() {
  const parts = draft
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    draft = '';
    return;
  }
  values = [...new Set([...values, ...parts])];
  draft = '';
}

function remove(index: number) {
  values = values.filter((_, position) => position !== index);
}
</script>

<div class="space-y-1.5">
  {#if label}
    <p class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</p>
  {/if}
  <div class="flex flex-wrap gap-1.5">
    {#if values.length === 0}
      <span class="text-xs text-[var(--color-ink-subtle)]">{emptyLabel}</span>
    {:else}
      {#each values as value, index (value)}
        <span class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink)]">
          {value}
          {#if !disabled}
            <button
              type="button"
              class="text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-danger)]"
              aria-label={`Remove ${value}`}
              onclick={() => remove(index)}
            >
              <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
              </svg>
            </button>
          {/if}
        </span>
      {/each}
    {/if}
  </div>
  <input
    class="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]"
    bind:value={draft}
    {placeholder}
    {disabled}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        commit();
      }
    }}
    onblur={commit}
    aria-label={label ?? 'Add value'}
  />
  {#if hint}
    <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">{hint}</p>
  {/if}
</div>
