<script lang="ts">
/**
 * KeyValueEditor: edits a string→string map (headers, output templates, field
 * mappings). It keeps a local draft row so an empty key is never committed, which is
 * what stops a half-typed header from becoming a saved one.
 */
interface Props {
  value?: Record<string, string>;
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  emptyLabel?: string;
  /** When true a row can be removed; templates keep this on. */
  removable?: boolean;
  onchange?: (value: Record<string, string>) => void;
}

let {
  value = $bindable<Record<string, string>>({}),
  keyLabel = 'Key',
  valueLabel = 'Value',
  keyPlaceholder = 'X-Header',
  valuePlaceholder = '{{param}}',
  addLabel = 'Add row',
  emptyLabel = 'No entries yet.',
  removable = true,
  onchange
}: Props = $props();

let draftKey = $state('');
let draftValue = $state('');
let duplicate = $state(false);

const entries = $derived(Object.entries(value));

function commit(next: Record<string, string>) {
  value = next;
  onchange?.(next);
}

function add() {
  const key = draftKey.trim();
  if (key.length === 0) return;
  if (Object.hasOwn(value, key)) {
    duplicate = true;
    return;
  }
  duplicate = false;
  commit({ ...value, [key]: draftValue });
  draftKey = '';
  draftValue = '';
}

function updateKey(previous: string, next: string) {
  const key = next.trim();
  if (key.length === 0 || key === previous) return;
  const rebuilt: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    rebuilt[entryKey === previous ? key : entryKey] = entryValue;
  }
  commit(rebuilt);
}

function updateValue(key: string, next: string) {
  commit({ ...value, [key]: next });
}

function remove(key: string) {
  const next = { ...value };
  delete next[key];
  commit(next);
}

const cell =
  'h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 font-mono text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]';
</script>

<div class="space-y-2">
  <div class="grid grid-cols-[1fr_1fr_auto] gap-2">
    <p class="text-[11px] font-medium tracking-wide text-[var(--color-ink-subtle)] uppercase">{keyLabel}</p>
    <p class="text-[11px] font-medium tracking-wide text-[var(--color-ink-subtle)] uppercase">{valueLabel}</p>
    <span class="w-8"></span>
  </div>

  {#if entries.length === 0}
    <p class="rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-subtle)] px-2.5 py-2 text-xs text-[var(--color-ink-subtle)]">
      {emptyLabel}
    </p>
  {:else}
    {#each entries as [entryKey, entryValue] (entryKey)}
      <div class="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
        <input
          class={cell}
          value={entryKey}
          aria-label={`${keyLabel} name`}
          onchange={(event) => updateKey(entryKey, event.currentTarget.value)}
        />
        <input
          class={cell}
          value={entryValue}
          aria-label={`${keyLabel} value`}
          oninput={(event) => updateValue(entryKey, event.currentTarget.value)}
        />
        {#if removable}
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-subtle)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-danger)]"
            aria-label={`Remove ${entryKey}`}
            onclick={() => remove(entryKey)}
          >
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        {:else}
          <span class="w-8"></span>
        {/if}
      </div>
    {/each}
  {/if}

  <div class="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
    <input
      class={cell}
      bind:value={draftKey}
      placeholder={keyPlaceholder}
      aria-label={`New ${keyLabel}`}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          add();
        }
      }}
    />
    <input
      class={cell}
      bind:value={draftValue}
      placeholder={valuePlaceholder}
      aria-label={`New ${valueLabel}`}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          add();
        }
      }}
    />
    <button
      type="button"
      class="h-8 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2 text-xs text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]"
      onclick={add}
    >
      {addLabel}
    </button>
  </div>
  {#if duplicate}
    <p class="text-xs text-[var(--color-danger)]">That key already exists.</p>
  {/if}
</div>
