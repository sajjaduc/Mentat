<script lang="ts">
/**
 * DataTable: a real `<table>` with optional row activation.
 *
 * Tables are used when the data is genuinely tabular: files, members, jobs, audit
 * events, collection records. It is keyboard-navigable by construction — a real
 * table, with real buttons/links inside cells — sorts by clicking a header button,
 * and keeps a fixed column set so widths do not jump between pages.
 *
 * `row` is a snippet so each screen owns its cells. A row that navigates does so
 * through a real link/button inside the cell rather than a click handler on the
 * `<tr>`, which keeps middle-click, focus order and screen-reader semantics intact.
 */
interface Column {
  key: string;
  label: string;
  align?: 'left' | 'right';
  width?: string;
  sortable?: boolean;
  /** Hidden on narrow screens; the first column is always shown. */
  hideBelow?: 'sm' | 'md' | 'lg';
}

interface Props {
  columns: Column[];
  rows: unknown[];
  rowKey: (row: unknown, index: number) => string;
  sortKey?: string | null;
  sortDirection?: 'asc' | 'desc';
  onsort?: (key: string) => void;
  class?: string;
  row: import('svelte').Snippet<[unknown, number]>;
  empty?: import('svelte').Snippet;
  caption?: string;
}

let {
  columns,
  rows,
  rowKey,
  sortKey = null,
  sortDirection = 'asc',
  onsort,
  class: className = '',
  row,
  empty,
  caption
}: Props = $props();

const hideBelowClass: Record<string, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell'
};

function onHeaderClick(column: Column) {
  if (!column.sortable || !onsort) return;
  onsort(column.key);
}
</script>

<div class="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] {className}">
  <table class="w-full border-collapse text-sm">
    {#if caption}<caption class="sr-only">{caption}</caption>{/if}
    <thead>
      <tr class="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)]">
        {#each columns as column (column.key)}
          <th
            scope="col"
            style={column.width ? `width:${column.width}` : undefined}
            class="px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-[var(--color-ink-subtle)] uppercase
              {column.align === 'right' ? 'text-right' : ''}
              {column.hideBelow ? hideBelowClass[column.hideBelow] : ''}"
          >
            {#if column.sortable && onsort}
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-[var(--radius-xs)] uppercase hover:text-[var(--color-ink)]"
                onclick={() => onHeaderClick(column)}
              >
                {column.label}
                <span aria-hidden="true" class="text-[9px]">
                  {sortKey === column.key ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}
                </span>
                <span class="sr-only">
                  {sortKey === column.key ? `sorted ${sortDirection}` : 'not sorted'}
                </span>
              </button>
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr>
          <td colspan={columns.length} class="px-0 py-0">
            {#if empty}
              {@render empty()}
            {:else}
              <p class="py-8 text-center text-xs text-[var(--color-ink-subtle)]">Nothing to show</p>
            {/if}
          </td>
        </tr>
      {:else}
        {#each rows as item, index (rowKey(item, index))}
          <tr class="border-b border-[var(--color-border-subtle)] align-top last:border-b-0">
            {@render row(item, index)}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>
