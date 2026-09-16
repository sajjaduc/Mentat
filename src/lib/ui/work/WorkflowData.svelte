<script lang="ts">
/**
 * Workflow data.
 *
 * Two read-only windows for operators: the workflow's structured collections and
 * the agent state scoped to this workflow. Both are inspection surfaces — nothing
 * here mutates data — so an unexpected value can be understood without opening a
 * terminal.
 */
import { formatDateTime, formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import JsonBlock from '$ui/work/JsonBlock.svelte';
import type { CollectionRecordView, CollectionView, StateEntryView } from '$ui/work/types';

interface Props {
  workflowId: string;
}

let { workflowId }: Props = $props();

let collections = $state<CollectionView[] | null>(null);
let collectionsError = $state<string | null>(null);
let selectedId = $state<string | null>(null);
let records = $state<CollectionRecordView[] | null>(null);
let recordsError = $state<string | null>(null);
let truncated = $state(false);
let entries = $state<StateEntryView[] | null>(null);
let stateError = $state<string | null>(null);

async function loadCollections() {
  collectionsError = null;
  try {
    const response = await api.get<{ collections: CollectionView[] }>('/api/collections', {
      workflowId
    });
    collections = response.collections;
    if (selectedId === null && response.collections[0]) {
      selectedId = response.collections[0].id;
    }
  } catch (failure) {
    collectionsError = describeApiError(failure);
  }
}

async function loadRecords(collectionId: string) {
  records = null;
  recordsError = null;
  try {
    const response = await api.get<{
      records: CollectionRecordView[];
      nextCursor: string | null;
      truncated: boolean;
    }>(`/collections/${collectionId}/records`, { limit: 50 });
    records = response.records;
    truncated = response.truncated;
  } catch (failure) {
    recordsError = describeApiError(failure);
  }
}

async function loadState() {
  stateError = null;
  try {
    const response = await api.get<{ entries: StateEntryView[] }>('/api/state', {
      scope: 'workflow',
      workflowId
    });
    entries = response.entries;
  } catch (failure) {
    stateError = describeApiError(failure);
  }
}

$effect(() => {
  const id = workflowId;
  void id;
  void loadCollections();
  void loadState();
});

$effect(() => {
  const id = selectedId;
  if (id === null) return;
  void loadRecords(id);
});

function recordColumns(list: CollectionRecordView[]): string[] {
  const keys = new Set<string>();
  for (const record of list) {
    for (const key of Object.keys(record.data)) keys.add(key);
  }
  return [...keys].slice(0, 6);
}
</script>

<div class="space-y-6 p-4" data-testid="workflow-data">
  <section class="space-y-2">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Collections
    </h3>
    {#if collectionsError}
      <ErrorState message={collectionsError} onRetry={loadCollections} />
    {:else if collections === null}
      <Skeleton lines={3} height="1.5rem" />
    {:else if collections.length === 0}
      <EmptyState
        title="No collections for this workflow"
        description="Collections hold structured records agents can read and write through the data tools."
      />
    {:else}
      <div class="flex flex-wrap gap-1.5">
        {#each collections as collection (collection.id)}
          <button
            type="button"
            aria-pressed={selectedId === collection.id}
            class="rounded-full border px-2.5 py-1 text-[11px] transition-colors
              {selectedId === collection.id
              ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
              : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'}"
            onclick={() => (selectedId = collection.id)}
          >
            {collection.name}
            <span class="text-[var(--color-ink-subtle)]">{collection.key}</span>
          </button>
        {/each}
      </div>

      {#if recordsError}
        <ErrorState message={recordsError} onRetry={() => selectedId && loadRecords(selectedId)} />
      {:else if records === null}
        <Skeleton lines={4} height="1.5rem" />
      {:else if records.length === 0}
        <p class="text-xs text-[var(--color-ink-subtle)]">This collection has no records yet.</p>
      {:else}
        <div class="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]">
          <table class="w-full border-collapse text-left text-xs">
            <thead>
              <tr class="border-b border-[var(--color-border-subtle)]">
                {#each recordColumns(records) as column (column)}
                  <th
                    class="px-2 py-1.5 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
                  >
                    {column}
                  </th>
                {/each}
                <th
                  class="px-2 py-1.5 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
                >
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {#each records as record (record.id)}
                <tr class="border-b border-[var(--color-border-subtle)] last:border-b-0">
                  {#each recordColumns(records) as column (column)}
                    <td class="max-w-[14rem] truncate px-2 py-1.5">
                      {typeof record.data[column] === 'object'
                        ? JSON.stringify(record.data[column])
                        : String(record.data[column] ?? '—')}
                    </td>
                  {/each}
                  <td class="px-2 py-1.5 text-[var(--color-ink-subtle)]">
                    {formatRelative(record.updatedAt)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if truncated}
          <p class="text-[11px] text-[var(--color-caution)]">
            Showing the first matching records; the scan is bounded.
          </p>
        {/if}
      {/if}
    {/if}
  </section>

  <section class="space-y-2">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Agent state
    </h3>
    {#if stateError}
      <ErrorState message={stateError} onRetry={loadState} />
    {:else if entries === null}
      <Skeleton lines={3} height="1.5rem" />
    {:else if entries.length === 0}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        No workflow-scoped state has been written yet.
      </p>
    {:else}
      <ul class="space-y-2">
        {#each entries as entry (entry.id)}
          <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2.5">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-mono">{entry.key}</span>
              <Badge tone="muted">{entry.namespace}</Badge>
              <span class="text-[var(--color-ink-subtle)]">v{entry.version}</span>
              <span class="ml-auto text-[10px] text-[var(--color-ink-subtle)]">
                {formatDateTime(entry.updatedAt)}
                {#if entry.expiresAt}· expires {formatRelative(entry.expiresAt)}{/if}
              </span>
            </div>
            <div class="mt-1"><JsonBlock value={entry.value} label="Value" /></div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
