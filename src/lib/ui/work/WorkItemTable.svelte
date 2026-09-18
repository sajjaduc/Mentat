<script lang="ts">
/**
 * Dense workItem table.
 *
 * The List tab and My Work render the same rows through this component so
 * priorities, ownership and field values look identical in both. Sorting is
 * controlled by the parent (the server's workItem endpoint cannot sort reliably, so
 * lists sort client-side over the fetched page) and header clicks are keyboard
 * reachable buttons.
 */
import { formatDate, formatRelative } from '$shared/format';
import Avatar from '$ui/primitives/Avatar.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import FieldValue from '$ui/work/FieldValue.svelte';
import { ageInState, priorityLabel, priorityTone } from '$ui/work/format';
import type {
  MemberOption,
  SortSpec,
  TeamOption,
  WorkItemColumn,
  WorkItemListRow
} from '$ui/work/types';

interface Props {
  rows: WorkItemListRow[];
  columns: WorkItemColumn[];
  sort?: SortSpec | null;
  onsorts?: (key: string) => void;
  onRowClick: (workflowItemId: string) => void;
  members?: MemberOption[];
  teams?: TeamOption[];
  emptyTitle?: string;
  emptyDescription?: string;
}

let {
  rows,
  columns,
  sort = null,
  onsorts,
  onRowClick,
  members = [],
  teams = [],
  emptyTitle = 'No work items here yet',
  emptyDescription = 'Work items appear here as soon as work is created in this view.'
}: Props = $props();

function fieldValue(row: WorkItemListRow, key: string): unknown {
  if (!key.startsWith('field:')) return undefined;
  return row.fields[key.slice('field:'.length)];
}
</script>

{#if rows.length === 0}
  <EmptyState title={emptyTitle} description={emptyDescription} />
{:else}
  <div class="overflow-x-auto">
    <table class="w-full border-collapse text-left">
      <thead>
        <tr class="border-b border-[var(--color-border-subtle)]">
          {#each columns as column (column.key)}
            <th
              class="px-3 py-2 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
              style={column.width ? `width:${column.width}` : undefined}
              aria-sort={sort?.field === column.key
                ? sort.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined}
            >
              {#if column.sortable && onsorts}
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-[var(--radius-xs)] hover:text-[var(--color-ink)]"
                  onclick={() => onsorts?.(column.key)}
                >
                  {column.label}
                  <span aria-hidden="true" class="text-[9px]">
                    {sort?.field === column.key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
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
        {#each rows as row (row.workItem.id)}
          <tr
            class="cursor-pointer border-b border-[var(--color-border-subtle)] transition-colors last:border-b-0 hover:bg-[var(--color-surface-muted)]"
            onclick={() => onRowClick(row.workItem.id)}
          >
            {#each columns as column (column.key)}
              <td class="px-3 py-2 align-middle text-sm">
                {#if column.key === 'key'}
                  <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]"
                    >{row.workItem.record.key}</span
                  >
                {:else if column.key === 'title'}
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate font-medium">{row.workItem.record.displayName}</span>
                    {#if row.labels.length > 0}
                      <span class="flex shrink-0 gap-1">
                        {#each row.labels.slice(0, 3) as label (label.id)}
                          <Badge tone="neutral">{label.name}</Badge>
                        {/each}
                      </span>
                    {/if}
                  </div>
                {:else if column.key === 'state'}
                  <Badge tone="accent">{row.stateName}</Badge>
                {:else if column.key === 'priority'}
                  <Badge tone={priorityTone(row.workItem.priority)}
                    >{priorityLabel(row.workItem.priority)}</Badge
                  >
                {:else if column.key === 'owner'}
                  {#if row.workItem.ownerUserId}
                    <span class="flex items-center gap-1.5">
                      <Avatar
                        id={row.workItem.ownerUserId}
                        name={row.ownerName ?? 'Owner'}
                        size="xs"
                      />
                      <span class="truncate text-xs">{row.ownerName ?? 'Owner'}</span>
                    </span>
                  {:else if row.workItem.ownerTeamId}
                    <span class="text-xs text-[var(--color-ink-muted)]">{teams.find(
                        (team) => team.id === row.workItem.ownerTeamId
                      )?.name ?? 'Team'}</span
                    >
                  {:else}
                    <span class="text-xs text-[var(--color-ink-subtle)]">Unassigned</span>
                  {/if}
                {:else if column.key === 'labels'}
                  <span class="flex flex-wrap gap-1">
                    {#each row.labels as label (label.id)}
                      <Badge tone="neutral">{label.name}</Badge>
                    {/each}
                  </span>
                {:else if column.key === 'updated'}
                  <span class="text-xs text-[var(--color-ink-muted)]"
                    >{formatRelative(row.workItem.updatedAt)}</span
                  >
                {:else if column.key === 'due'}
                  <span class="text-xs text-[var(--color-ink-muted)]"
                    >{formatDate(row.workItem.dueAt)}</span
                  >
                {:else if column.key === 'age'}
                  <span class="text-xs text-[var(--color-ink-muted)]"
                    >{ageInState(row.workItem.enteredStateAt)}</span
                  >
                {:else if column.key.startsWith('field:')}
                  <FieldValue
                    type={column.type ?? 'short_text'}
                    options={column.options ?? null}
                    value={fieldValue(row, column.key)}
                    {members}
                    {teams}
                  />
                {:else}
                  <span class="text-xs text-[var(--color-ink-subtle)]">—</span>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
