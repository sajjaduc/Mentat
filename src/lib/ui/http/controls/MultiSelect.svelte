<script lang="ts">
/**
 * MultiSelect: a searchable, grouped checkbox list.
 *
 * Skills, tools and HTTP operations are all "pick several from a long list", and a
 * native `<select multiple>` hides the descriptions that make the choice meaningful.
 * This keeps the list visible, filterable and keyboard-operable.
 */
interface MultiSelectOption {
  value: string;
  label: string;
  group?: string;
  hint?: string;
  badge?: string;
}

interface Props {
  options: MultiSelectOption[];
  selected?: string[];
  label?: string;
  hint?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  noMatchLabel?: string;
  disabled?: boolean;
  onchange?: (selected: string[]) => void;
}

let {
  options,
  selected = $bindable<string[]>([]),
  label,
  hint,
  searchPlaceholder = 'Search…',
  emptyLabel = 'Nothing available to select.',
  noMatchLabel = 'No matches.',
  disabled = false,
  onchange
}: Props = $props();

let query = $state('');

const filtered = $derived.by(() => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle) ||
      (option.hint ?? '').toLowerCase().includes(needle)
  );
});

const groups = $derived.by(() => {
  const map = new Map<string, MultiSelectOption[]>();
  for (const option of filtered) {
    const key = option.group ?? '';
    const bucket = map.get(key);
    if (bucket) bucket.push(option);
    else map.set(key, [option]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
});

function toggle(value: string) {
  selected = selected.includes(value)
    ? selected.filter((entry) => entry !== value)
    : [...selected, value];
  onchange?.(selected);
}

function clear() {
  selected = [];
  onchange?.(selected);
}
</script>

<div class="space-y-2">
  {#if label || selected.length > 0}
    <div class="flex items-center justify-between gap-2">
      {#if label}<p class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</p>{:else}<span></span>{/if}
      {#if selected.length > 0 && !disabled}
        <button
          type="button"
          class="text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
          onclick={clear}
        >
          Clear {selected.length} selected
        </button>
      {/if}
    </div>
  {/if}
  {#if hint}<p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">{hint}</p>{/if}

  <input
    class="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]"
    bind:value={query}
    placeholder={searchPlaceholder}
    aria-label={label ?? 'Search options'}
  />

  <div class="scrollbar-thin max-h-80 space-y-3 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2.5">
    {#if options.length === 0}
      <p class="px-1 py-2 text-xs text-[var(--color-ink-subtle)]">{emptyLabel}</p>
    {:else if filtered.length === 0}
      <p class="px-1 py-2 text-xs text-[var(--color-ink-subtle)]">{noMatchLabel}</p>
    {:else}
      {#each groups as [groupName, groupOptions] (groupName || 'ungrouped')}
        <div class="space-y-1">
          {#if groupName}
            <p class="px-1 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
              {groupName}
            </p>
          {/if}
          {#each groupOptions as option (option.value)}
            <label
              class="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] px-1.5 py-1.5 transition-colors hover:bg-[var(--color-surface-muted)]"
            >
              <input
                type="checkbox"
                class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                checked={selected.includes(option.value)}
                {disabled}
                onchange={() => toggle(option.value)}
              />
              <span class="min-w-0 flex-1 space-y-0.5">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono text-xs text-[var(--color-ink)]">{option.label}</span>
                  {#if option.badge}
                    <span class="rounded-full border border-[var(--color-border-subtle)] px-1.5 text-[10px] text-[var(--color-ink-subtle)]">
                      {option.badge}
                    </span>
                  {/if}
                </span>
                {#if option.hint}
                  <span class="block text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">{option.hint}</span>
                {/if}
              </span>
            </label>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
