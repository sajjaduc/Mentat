<script lang="ts">
/**
 * DataWorkspace: `/data` — collections, agent state and cache.
 *
 * Three distinct read surfaces share one screen because they answer the same
 * question from different angles: "what structured data does this workspace hold,
 * and what does the agent see?".
 *
 *  - **Collections** are workflow-authored document stores. Records are edited with
 *    optimistic writes and versioned, so a stale edit is rejected rather than
 *    silently winning.
 *  - **Agent state** is shown read-only. It is scratch space written by tools during
 *    runs; editing it from an inspector would bypass the audit trail that the tool
 *    call provides.
 *  - **Cache** is internal, so values are hidden until explicitly requested, and the
 *    screen says so.
 */
import { untrack } from 'svelte';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import { formatBytes, formatDateTime, formatRelative } from '$shared/format';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import Pagination from '$ui/common/Pagination.svelte';
import { displayValue } from '$ui/format';
import type {
  CacheEntry,
  CacheStatsView,
  CollectionDocument,
  CollectionRecord,
  RecordPage,
  StateEntry,
  WorkflowSummary
} from '$ui/types';

type Section = 'collections' | 'state' | 'cache';

let section = $state<Section>('collections');

// ------------------------------------------------------------- collections

let collections = $state<CollectionRecord[]>([]);
let collectionsLoading = $state(true);
let collectionsError = $state<string | null>(null);
let activeCollection = $state<CollectionRecord | null>(null);
let records = $state<CollectionDocument[]>([]);
let recordsCursor = $state<string | null>(null);
let recordsNext = $state<string | null>(null);
let recordsLoading = $state(false);
let recordsError = $state<string | null>(null);
let recordsTruncated = $state(false);
let createCollectionOpen = $state(false);
let collectionKey = $state('');
let collectionName = $state('');
let collectionWorkflowId = $state('');
let collectionDescription = $state('');
let collectionSchema = $state('{\n  "type": "object",\n  "properties": {}\n}');
let collectionFormError = $state<string | null>(null);
let busy = $state(false);

let recordOpen = $state(false);
let editingRecord = $state<CollectionDocument | null>(null);
let recordData = $state('{}');
let recordExternalKey = $state('');
let recordFormError = $state<string | null>(null);

let workflows = $state<WorkflowSummary[]>([]);

// -------------------------------------------------------------- agent state

let stateEntries = $state<StateEntry[]>([]);
let stateLoading = $state(false);
let stateError = $state<string | null>(null);
let stateNamespace = $state('');
let statePrefix = $state('');
let revealedStateKeys = $state<Set<string>>(new Set());

// ------------------------------------------------------------------- cache

let cacheEntries = $state<CacheEntry[]>([]);
let cacheStats = $state<CacheStatsView | null>(null);
let cacheLoading = $state(false);
let cacheError = $state<string | null>(null);
let cacheNamespace = $state('');
let cachePrefix = $state('');
let includeCacheValues = $state(false);
let revealingCacheKeys = $state<Set<string>>(new Set());

async function loadCollections() {
  collectionsLoading = true;
  collectionsError = null;
  try {
    const [response, workflowResponse] = await Promise.all([
      api.get<{ collections: CollectionRecord[] }>('/collections'),
      api
        .get<{ workflows: WorkflowSummary[] }>('/workflows')
        .catch(() => ({ workflows: [] as WorkflowSummary[] }))
    ]);
    collections = response.collections;
    workflows = workflowResponse.workflows;
    const first = response.collections[0];
    if (!activeCollection && first) await selectCollection(first);
  } catch (failure) {
    collectionsError = describeApiError(failure);
  } finally {
    collectionsLoading = false;
  }
}

async function selectCollection(collection: CollectionRecord) {
  activeCollection = collection;
  recordsCursor = null;
  await loadRecords(null);
}

async function loadRecords(cursor: string | null) {
  if (!activeCollection) return;
  recordsLoading = true;
  recordsError = null;
  try {
    const response = await api.get<RecordPage>(`/collections/${activeCollection.id}/records`, {
      limit: 50,
      cursor: cursor ?? undefined
    });
    records = response.records;
    recordsNext = response.nextCursor;
    recordsTruncated = response.truncated;
    recordsCursor = cursor;
  } catch (failure) {
    recordsError = describeApiError(failure);
  } finally {
    recordsLoading = false;
  }
}

async function createCollection() {
  collectionFormError = null;
  if (!collectionKey.trim() || !collectionName.trim()) {
    collectionFormError = 'A key and a name are required.';
    return;
  }
  let schema: unknown = null;
  try {
    schema = collectionSchema.trim().length > 0 ? JSON.parse(collectionSchema) : null;
  } catch {
    collectionFormError = 'The schema is not valid JSON.';
    return;
  }
  busy = true;
  try {
    const response = await api.post<{ collection: CollectionRecord }>('/collections', {
      key: collectionKey.trim(),
      name: collectionName.trim(),
      description: collectionDescription.trim() || null,
      workflowId: collectionWorkflowId || null,
      schema
    });
    collections = [...collections, response.collection];
    createCollectionOpen = false;
    collectionKey = '';
    collectionName = '';
    collectionDescription = '';
    await selectCollection(response.collection);
    pushToast({ tone: 'success', title: `Created collection "${response.collection.name}"` });
  } catch (failure) {
    collectionFormError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

function openRecord(record: CollectionDocument | null) {
  editingRecord = record;
  recordData = JSON.stringify(record?.data ?? {}, null, 2);
  recordExternalKey = record?.externalKey ?? '';
  recordFormError = null;
  recordOpen = true;
}

async function saveRecord() {
  if (!activeCollection) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(recordData) as Record<string, unknown>;
  } catch {
    recordFormError = 'The record is not valid JSON.';
    return;
  }
  busy = true;
  recordFormError = null;
  try {
    if (editingRecord) {
      const response = await api.patch<{ record: CollectionDocument }>(
        `/collections/${activeCollection.id}/records/${editingRecord.id}`,
        { data: parsed, expectedVersion: editingRecord.version }
      );
      records = records.map((record) =>
        record.id === response.record.id ? response.record : record
      );
      pushToast({ tone: 'success', title: 'Record updated' });
    } else {
      const response = await api.post<{ record: CollectionDocument }>(
        `/collections/${activeCollection.id}/records`,
        { data: parsed, externalKey: recordExternalKey.trim() || null }
      );
      records = [response.record, ...records];
      pushToast({ tone: 'success', title: 'Record created' });
    }
    recordOpen = false;
  } catch (failure) {
    // A version conflict means someone else wrote first; reload rather than guess.
    const message = describeApiError(failure);
    recordFormError = message;
  } finally {
    busy = false;
  }
}

async function deleteRecord(record: CollectionDocument) {
  const previous = records;
  records = records.filter((entry) => entry.id !== record.id);
  try {
    await api.delete(`/collections/${activeCollection?.id}/records/${record.id}`);
    pushToast({ tone: 'success', title: 'Record deleted', description: 'Deleted softly; history keeps pointing at the row.' });
  } catch (failure) {
    records = previous;
    pushToast({ tone: 'error', title: 'Could not delete record', description: describeApiError(failure) });
  }
}

// -------------------------------------------------------------- state/cache

async function loadState() {
  stateLoading = true;
  stateError = null;
  revealedStateKeys = new Set();
  try {
    const response = await api.get<{ entries: StateEntry[] }>('/state', {
      scope: 'workspace',
      namespace: stateNamespace || undefined,
      prefix: statePrefix || undefined,
      limit: 200
    });
    stateEntries = response.entries;
  } catch (failure) {
    stateError = describeApiError(failure);
  } finally {
    stateLoading = false;
  }
}

async function loadCache() {
  cacheLoading = true;
  cacheError = null;
  revealingCacheKeys = new Set();
  try {
    const response = await api.get<{ entries: CacheEntry[]; stats: CacheStatsView }>('/cache', {
      namespace: cacheNamespace || undefined,
      prefix: cachePrefix || undefined,
      includeValues: includeCacheValues ? 'true' : undefined,
      limit: 200
    });
    cacheEntries = response.entries;
    cacheStats = response.stats;
  } catch (failure) {
    cacheError = describeApiError(failure);
  } finally {
    cacheLoading = false;
  }
}

async function clearCacheByNamespace() {
  if (!cacheNamespace) return;
  busy = true;
  try {
    const response = await api.delete<{ removed: number }>('/cache', { namespace: cacheNamespace });
    pushToast({ tone: 'success', title: `Cleared ${response.removed} entries`, description: `Namespace ${cacheNamespace}` });
    await loadCache();
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not clear cache', description: describeApiError(failure) });
  } finally {
    busy = false;
  }
}

async function clearCacheByTag(tag: string) {
  busy = true;
  try {
    const response = await api.delete<{ removed: number }>('/cache', { tag });
    pushToast({ tone: 'success', title: `Cleared ${response.removed} entries`, description: `Tag ${tag}` });
    await loadCache();
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not clear cache', description: describeApiError(failure) });
  } finally {
    busy = false;
  }
}

function revealState(key: string) {
  revealedStateKeys = new Set([...revealedStateKeys, key]);
}

function revealCache(key: string) {
  revealingCacheKeys = new Set([...revealingCacheKeys, key]);
}

// `$derived` so the count tracks the list rather than capturing its first value.
const tabs = $derived([
  { id: 'collections', label: 'Collections', count: collections.length },
  { id: 'state', label: 'Agent state' },
  { id: 'cache', label: 'Cache' }
]);

$effect(() => {
  untrack(() => void loadCollections());
});

function onSectionChange(id: string) {
  section = id as Section;
  if (section === 'state' && stateEntries.length === 0) void loadState();
  if (section === 'cache' && cacheStats === null) void loadCache();
}
</script>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Workflow data"
    eyebrow="Resources"
    description="Workspace-level structured data: collections of JSON documents, the agent state those documents are read alongside, and the internal cache."
  />

  <Tabs {tabs} active={section} onselect={onSectionChange} />

  {#if section === 'collections'}
    <div class="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card class="space-y-3">
        <div class="flex items-center gap-2">
          <h2 class="text-sm font-semibold">Collections</h2>
          <Button size="sm" variant="ghost" class="ml-auto" onclick={() => (createCollectionOpen = true)}>
            + New
          </Button>
        </div>
        {#if collectionsLoading}
          <Skeleton lines={4} />
        {:else if collectionsError}
          <ErrorState message={collectionsError} onRetry={() => void loadCollections()} />
        {:else if collections.length === 0}
          <EmptyState
            title="No collections"
            description="A collection is a structured document store such as customers or research_results, with an optional JSON schema that every record is validated against."
          >
            <div class="mt-2">
              <Button size="sm" variant="primary" onclick={() => (createCollectionOpen = true)}>Create a collection</Button>
            </div>
          </EmptyState>
        {:else}
          <ul class="space-y-1">
            {#each collections as collection (collection.id)}
              <li>
                <button
                  type="button"
                  class="w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs transition-colors
                    {activeCollection?.id === collection.id
                      ? 'bg-[var(--color-surface-muted)] font-medium'
                      : 'hover:bg-[var(--color-surface-muted)]'}"
                  onclick={() => selectCollection(collection)}
                >
                  <span class="block truncate">{collection.name}</span>
                  <span class="block font-mono text-[10px] text-[var(--color-ink-subtle)]">{collection.key}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>

      <div class="space-y-3">
        {#if !activeCollection}
          <Card>
            <EmptyState title="Choose a collection" description="Records are listed and edited per collection." />
          </Card>
        {:else}
          {@const collection = activeCollection}
          <Card class="space-y-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-sm font-semibold">{activeCollection.name}</h2>
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  <span class="font-mono">{collection.key}</span>
                  {#if collection.workflowId}
                    · workflow {workflows.find((entry) => entry.id === collection.workflowId)?.name ??
                      collection.workflowId}
                  {:else}
                    · workspace-level
                  {/if}
                </p>
                {#if activeCollection.description}
                  <p class="mt-1 text-xs text-[var(--color-ink-muted)]">{activeCollection.description}</p>
                {/if}
              </div>
              <Button size="sm" variant="primary" onclick={() => openRecord(null)}>New record</Button>
            </div>

            {#if activeCollection.schema}
              <details class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2">
                <summary class="cursor-pointer text-xs font-medium">Schema</summary>
                <pre class="scrollbar-thin mt-2 max-h-64 overflow-auto font-mono text-[11px]">{JSON.stringify(activeCollection.schema, null, 2)}</pre>
              </details>
            {/if}
          </Card>

          {#if recordsError}
            <ErrorState message={recordsError} onRetry={() => void loadRecords(recordsCursor)} />
          {:else if recordsLoading}
            <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
          {:else if records.length === 0}
            <Card>
              <EmptyState
                title="No records"
                description="Records are JSON documents validated against the collection schema. Create one here, or let a tool or workflow write one."
              />
            </Card>
          {:else}
            <DataTable
              columns={[
                { key: 'externalKey', label: 'External key' },
                { key: 'data', label: 'Data' },
                { key: 'version', label: 'Version', align: 'right' },
                { key: 'updated', label: 'Updated', align: 'right', hideBelow: 'md' },
                { key: 'actions', label: 'Actions', align: 'right' }
              ]}
              rows={records}
              rowKey={(item) => (item as CollectionDocument).id}
            >
              {#snippet row(item)}
                {@const record = item as CollectionDocument}
                <td class="px-3 py-2 font-mono text-[11px]">{record.externalKey ?? '—'}</td>
                <td class="max-w-md px-3 py-2">
                  <code class="block truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
                    {JSON.stringify(record.data)}
                  </code>
                </td>
                <td class="px-3 py-2 text-right text-xs">v{record.version}</td>
                <td class="hidden px-3 py-2 text-right text-xs md:table-cell" title={formatDateTime(record.updatedAt)}>
                  {formatRelative(record.updatedAt)}
                </td>
                <td class="px-3 py-2">
                  <div class="flex justify-end gap-1.5">
                    <Button size="sm" variant="secondary" onclick={() => openRecord(record)}>Edit</Button>
                    <Button size="sm" variant="ghost" onclick={() => deleteRecord(record)}>Delete</Button>
                  </div>
                </td>
              {/snippet}
            </DataTable>
            {#if recordsTruncated}
              <p class="text-[11px] text-[var(--color-caution)]">
                The scan hit its cap; more records may match than this page shows.
              </p>
            {/if}
            <Pagination
              nextCursor={recordsNext}
              loading={recordsLoading}
              cursor={recordsCursor}
              count={records.length}
              noun="records"
              oncursor={(next) => void loadRecords(next)}
            />
          {/if}
        {/if}
      </div>
    </div>
  {:else if section === 'state'}
    <Card class="space-y-3">
      <div class="grid gap-3 sm:grid-cols-3">
        <Input label="Namespace" bind:value={stateNamespace} placeholder="default" />
        <Input label="Key prefix" bind:value={statePrefix} placeholder="Optional" />
        <div class="flex items-end">
          <Button variant="secondary" loading={stateLoading} onclick={loadState}>Load workspace state</Button>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        Workspace-scoped agent state, shown read-only. State is written by tools during runs, where the
        tool-call audit row is the record of the change; editing it here would bypass that trail.
      </p>
    </Card>

    {#if stateError}
      <ErrorState message={stateError} onRetry={() => void loadState()} />
    {:else if stateLoading}
      <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
    {:else if stateEntries.length === 0}
      <Card>
        <EmptyState
          title="No workspace state"
          description="Load the inspector to list workspace-scoped keys. Work item-, workflow-, agent- and run-scoped state is available through the API but not shown on this workspace view."
        />
      </Card>
    {:else}
      <DataTable
        columns={[
          { key: 'key', label: 'Key' },
          { key: 'namespace', label: 'Namespace', hideBelow: 'sm' },
          { key: 'value', label: 'Value' },
          { key: 'expires', label: 'Expires', align: 'right', hideBelow: 'md' },
          { key: 'updated', label: 'Updated', align: 'right', hideBelow: 'lg' },
          { key: 'actions', label: '', align: 'right' }
        ]}
        rows={stateEntries}
        rowKey={(item) => (item as StateEntry).id}
      >
        {#snippet row(item)}
          {@const entry = item as StateEntry}
          <td class="px-3 py-2 font-mono text-[11px]">{entry.key}</td>
          <td class="hidden px-3 py-2 font-mono text-[11px] sm:table-cell">{entry.namespace}</td>
          <td class="max-w-md px-3 py-2">
            {#if revealedStateKeys.has(entry.key)}
              <code class="block font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(entry.value)}</code>
            {:else}
              <span class="text-[11px] text-[var(--color-ink-subtle)]">
                Hidden — {displayValue(entry.value).length} characters
              </span>
            {/if}
          </td>
          <td class="hidden px-3 py-2 text-right text-xs md:table-cell">
            {entry.expiresAt ? formatRelative(entry.expiresAt) : 'never'}
          </td>
          <td class="hidden px-3 py-2 text-right text-xs lg:table-cell" title={formatDateTime(entry.updatedAt)}>
            v{entry.version} · {formatRelative(entry.updatedAt)}
          </td>
          <td class="px-3 py-2">
            <div class="flex justify-end">
              {#if !revealedStateKeys.has(entry.key)}
                <Button size="sm" variant="ghost" onclick={() => revealState(entry.key)}>Reveal</Button>
              {/if}
            </div>
          </td>
        {/snippet}
      </DataTable>
    {/if}
  {:else}
    {#if cacheStats}
      <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {#each [
          ['Entries', String(cacheStats.entries)],
          ['Bytes', formatBytes(cacheStats.bytes)],
          ['Hits', String(cacheStats.hits)],
          ['Misses', String(cacheStats.misses)],
          ['Expiring soon', String(cacheStats.expiringSoon)],
          ['Expired', String(cacheStats.expired)]
        ] as [label, value] (label)}
          <Card class="space-y-1">
            <p class="text-[10px] tracking-wide text-[var(--color-ink-subtle)] uppercase">{label}</p>
            <p class="font-mono text-lg font-semibold">{value}</p>
          </Card>
        {/each}
      </div>
    {/if}

    <Card class="space-y-3">
      <div class="grid gap-3 sm:grid-cols-4">
        <Input label="Namespace" bind:value={cacheNamespace} placeholder="default" />
        <Input label="Key prefix" bind:value={cachePrefix} placeholder="Optional" />
        <label class="flex items-end gap-2 pb-2 text-xs">
          <input type="checkbox" bind:checked={includeCacheValues} />
          Request values
        </label>
        <div class="flex items-end gap-1.5">
          <Button variant="secondary" loading={cacheLoading} onclick={loadCache}>Load</Button>
          <Button variant="ghost" disabled={!cacheNamespace || busy} onclick={clearCacheByNamespace}>
            Clear namespace
          </Button>
        </div>
      </div>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        Cache is an internal primitive: values are only shown when you explicitly request them, and
        even then only for entries the current workspace owns. Clearing by namespace or tag is a
        deliberate action and is audited.
      </p>
    </Card>

    {#if cacheError}
      <ErrorState message={cacheError} onRetry={() => void loadCache()} />
    {:else if cacheLoading}
      <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
    {:else if cacheEntries.length === 0}
      <Card>
        <EmptyState
          title="No cache entries"
          description="Load the inspector to list entries for this workspace. Entries appear as HTTP operations, tools and connectors cache their results."
        />
      </Card>
    {:else}
      <DataTable
        columns={[
          { key: 'key', label: 'Key' },
          { key: 'namespace', label: 'Namespace', hideBelow: 'sm' },
          { key: 'size', label: 'Size', align: 'right' },
          { key: 'hits', label: 'Hits', align: 'right' },
          { key: 'tags', label: 'Tags', hideBelow: 'md' },
          { key: 'expires', label: 'Expires', align: 'right', hideBelow: 'md' },
          { key: 'value', label: 'Value' },
          { key: 'actions', label: '', align: 'right' }
        ]}
        rows={cacheEntries}
        rowKey={(item) => (item as CacheEntry).id}
      >
        {#snippet row(item)}
          {@const entry = item as CacheEntry}
          <td class="px-3 py-2 font-mono text-[11px]">{entry.key}</td>
          <td class="hidden px-3 py-2 font-mono text-[11px] sm:table-cell">{entry.namespace}</td>
          <td class="px-3 py-2 text-right text-xs">{formatBytes(entry.sizeBytes)}</td>
          <td class="px-3 py-2 text-right text-xs">{entry.hits}</td>
          <td class="hidden px-3 py-2 md:table-cell">
            <span class="flex flex-wrap gap-1">
              {#each entry.tags as tag (tag)}
                <button
                  type="button"
                  class="rounded-full bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-border-subtle)]"
                  title="Clear every entry with this tag"
                  disabled={busy}
                  onclick={() => clearCacheByTag(tag)}
                >
                  {tag}
                </button>
              {/each}
              {#if entry.expired}<Badge tone="caution">expired</Badge>{/if}
            </span>
          </td>
          <td class="hidden px-3 py-2 text-right text-xs md:table-cell">
            {entry.expiresAt ? formatRelative(entry.expiresAt) : 'never'}
          </td>
          <td class="max-w-sm px-3 py-2">
            {#if entry.value !== undefined && revealingCacheKeys.has(entry.key)}
              <code class="block font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(entry.value)}</code>
            {:else}
              <span class="text-[11px] text-[var(--color-ink-subtle)]">hidden</span>
            {/if}
          </td>
          <td class="px-3 py-2">
            <div class="flex justify-end">
              {#if entry.value !== undefined && !revealingCacheKeys.has(entry.key)}
                <Button size="sm" variant="ghost" onclick={() => revealCache(entry.key)}>Reveal</Button>
              {/if}
            </div>
          </td>
        {/snippet}
      </DataTable>
    {/if}
  {/if}
</div>

<Modal
  open={createCollectionOpen}
  title="New collection"
  description="A collection is a structured document store with an optional JSON schema applied to every record."
  width="40rem"
  onclose={() => (createCollectionOpen = false)}
>
  <div class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-2">
      <Input label="Key" bind:value={collectionKey} placeholder="customers" />
      <Input label="Name" bind:value={collectionName} placeholder="Customers" />
    </div>
    <Input label="Description" bind:value={collectionDescription} placeholder="Optional" />
    <Select
      label="Scope"
      options={[
        { value: '', label: 'Workspace-level' },
        ...workflows.map((entry) => ({ value: entry.id, label: `Workflow: ${entry.name}` }))
      ]}
      bind:value={collectionWorkflowId}
    />
    <Textarea label="JSON schema" mono rows={8} bind:value={collectionSchema} />
    {#if collectionFormError}<p class="text-xs text-[var(--color-danger)]">{collectionFormError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (createCollectionOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={createCollection}>Create collection</Button>
    </div>
  </div>
</Modal>

<Modal
  open={recordOpen}
  title={editingRecord ? 'Edit record' : 'New record'}
  description="The document is validated against the collection schema and written with optimistic versioning."
  width="44rem"
  onclose={() => (recordOpen = false)}
>
  <div class="space-y-3">
    {#if !editingRecord}
      <Input label="External key" bind:value={recordExternalKey} hint="Optional; makes ingestion idempotent for the same source record." />
    {/if}
    <Textarea label="Record (JSON)" mono rows={14} bind:value={recordData} />
    {#if editingRecord}
      <p class="text-[11px] text-[var(--color-ink-subtle)]">
        Editing version {editingRecord.version}. If someone else writes first, this save is rejected
        rather than overwriting them.
      </p>
    {/if}
    {#if recordFormError}
      <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">
        {recordFormError}
      </p>
    {/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (recordOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={saveRecord}>
        {editingRecord ? 'Save record' : 'Create record'}
      </Button>
    </div>
  </div>
</Modal>
