<script lang="ts">
/**
 * Dense workItem list.
 *
 * The same data as the board, with sortable columns and a column picker driven by
 * the workflow's `showInList` fields. Sorting happens client-side over the fetched
 * page because the workItem endpoint cannot be asked to sort reliably; the visible
 * column set is controlled by the parent so a saved view can restore it.
 */
import { api, describeApiError } from '$ui/api';
import FilterBar from '$ui/board/FilterBar.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { type FilterState, filterStateToQuery } from '$ui/work/filters';
import {
  buildListColumns,
  normalizeWorkItemRow,
  type RawWorkItemRow,
  sortRows
} from '$ui/work/rows';
import type {
  AppliedSavedView,
  Label,
  MemberOption,
  SortSpec,
  TeamOption,
  Workflow,
  WorkflowFieldView,
  WorkflowState,
  WorkItemColumn,
  WorkItemListRow
} from '$ui/work/types';
import WorkItemTable from '$ui/work/WorkItemTable.svelte';

interface Props {
  workflow: Workflow;
  states: WorkflowState[];
  fieldConfig: WorkflowFieldView[];
  filter: FilterState;
  members: MemberOption[];
  teams: TeamOption[];
  labels: Label[];
  sort: SortSpec;
  columns: string[];
  /** Bumped by the parent to force a re-read after an external change (a transfer). */
  refreshKey?: number;
  onFilterChange: (filter: FilterState) => void;
  onApplyView: (view: AppliedSavedView) => void;
  onOpenWorkItem: (workflowItemId: string) => void;
  onSortChange: (sort: SortSpec) => void;
  onColumnsChange: (columns: string[]) => void;
}

let {
  workflow,
  states,
  fieldConfig,
  filter,
  members,
  teams,
  labels,
  sort,
  columns,
  refreshKey = 0,
  onFilterChange,
  onApplyView,
  onOpenWorkItem,
  onSortChange,
  onColumnsChange
}: Props = $props();

let columnPickerOpen = $state(false);
let rows = $state<WorkItemListRow[] | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

const nounPlural = $derived((workflow.objectTypePluralName ?? 'work item').toLowerCase());
const allColumns = $derived(buildListColumns(fieldConfig.filter((view) => view.showInList)));
const activeColumns = $derived<WorkItemColumn[]>(
  columns.length === 0 ? allColumns : allColumns.filter((column) => columns.includes(column.key))
);
const sorted = $derived(rows ? sortRows(rows, sort.field, sort.direction) : []);

const filterQuery = $derived(filterStateToQuery(filter));

async function load(query: string | null) {
  loading = true;
  error = null;
  try {
    const response = await api.get<{
      items?: RawWorkItemRow[];
      rows?: RawWorkItemRow[];
    }>('/api/workflow-items', {
      workflowId: workflow.id,
      filter: query,
      search: filter.search.trim() === '' ? undefined : filter.search.trim(),
      limit: 200
    });
    rows = (response.items ?? response.rows ?? []).map(normalizeWorkItemRow);
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

const listRequest = $derived({ query: filterQuery, refreshKey });

$effect(() => {
  void load(listRequest.query);
});

function toggleColumn(key: string) {
  const next = activeColumns.some((column) => column.key === key)
    ? activeColumns.map((column) => column.key).filter((entry) => entry !== key)
    : [...activeColumns.map((column) => column.key), key];
  onColumnsChange(next);
}
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="border-b border-[var(--color-border-subtle)] px-4 py-3">
    <FilterBar
      {filter}
      {states}
      {members}
      {labels}
      workflowId={workflow.id}
      sort={[sort]}
      columns={columns}
      onchange={onFilterChange}
      onApplyView={onApplyView}
    />
  </div>

  <div class="flex items-center justify-between gap-2 px-4 py-2">
    <p class="text-xs text-[var(--color-ink-subtle)]">
      {rows ? `${rows.length} ${nounPlural}` : '—'}
      {#if rows && rows.length >= 200} (first 200){/if}
    </p>
    <!-- A real button rather than a <details> disclosure: the column picker is a
         menu of toggles, and a <summary> is not exposed as a button. -->
    <div class="relative">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]"
        aria-haspopup="menu"
        aria-expanded={columnPickerOpen}
        onclick={() => (columnPickerOpen = !columnPickerOpen)}
      >
        Columns <span aria-hidden="true" class="text-[10px]">▾</span>
      </button>
      {#if columnPickerOpen}
        <div
          role="menu"
          aria-label="Choose columns"
          class="animate-pop-in absolute right-0 z-30 mt-1 max-h-72 w-60 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-overlay)]"
        >
          {#each allColumns as column (column.key)}
            <label
              class="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs hover:bg-[var(--color-surface-muted)]"
            >
              <input
                type="checkbox"
                checked={columns.length === 0 || columns.includes(column.key)}
                onchange={() => toggleColumn(column.key)}
              />
              <span class="truncate">{column.label}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-2 pb-4">
    {#if loading && rows === null}
      <div class="space-y-2 p-2">
        <Skeleton lines={6} height="1.5rem" />
      </div>
    {:else if error}
      <div class="p-4"><ErrorState message={error} onRetry={() => load(filterQuery)} /></div>
    {:else}
      <WorkItemTable
        rows={sorted}
        columns={activeColumns.length > 0 ? activeColumns : allColumns}
        {sort}
        onsorts={(key) =>
          onSortChange({
            field: key,
            direction: sort.field === key && sort.direction === 'asc' ? 'desc' : 'asc'
          })}
        onRowClick={onOpenWorkItem}
        {members}
        {teams}
        emptyTitle={`No ${nounPlural} match this view`}
        emptyDescription={`Adjust the filters or create one from the board.`}
      />
    {/if}
  </div>
</div>
