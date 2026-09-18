<script lang="ts">
/**
 * Records browser: list Records of the selected Object Type.
 *
 * Records are durable things, so the list is neutral about Work items: it shows the
 * Object Type's own fields, and "New" creates a Record without starting work.
 */
import { goto } from '$app/navigation';
import { describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import Pagination from '$ui/common/Pagination.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import { recordsApi } from './api';
import type {
  ObjectTypeFieldView,
  ObjectTypeSummary,
  RecordListPage,
  RecordListRow
} from './types';

interface Props {
  initialObjectTypeId?: string;
}
let { initialObjectTypeId }: Props = $props();

let objectTypes = $state<ObjectTypeSummary[]>([]);
let selectedTypeId = $state<string>('');
let fields = $state<ObjectTypeFieldView[]>([]);
let page = $state<RecordListPage | null>(null);
let search = $state('');
let cursor = $state<string | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

let createOpen = $state(false);
let creating = $state(false);
let draftName = $state('');

const columns = $derived([
  { key: 'displayName', label: 'Name' },
  { key: 'key', label: 'Key', hideBelow: 'sm' as const },
  ...fields
    .filter((field) => field.showInList)
    .slice(0, 3)
    .map((field) => ({ key: field.key, label: field.name, hideBelow: 'md' as const })),
  { key: 'updatedAt', label: 'Updated', hideBelow: 'sm' as const }
]);

async function loadTypes() {
  try {
    objectTypes = await recordsApi.listObjectTypes();
    if (!selectedTypeId) {
      selectedTypeId =
        (initialObjectTypeId && objectTypes.some((type) => type.id === initialObjectTypeId)
          ? initialObjectTypeId
          : objectTypes[0]?.id) ?? '';
    }
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    // The record list is driven by whichever Object Type is selected, so when a
    // workspace has none the loadRecords effect never runs. Releasing the skeleton
    // here is what turns "loading forever" into the empty state; when a type was
    // selected, the effect picks the load up and this leaves `loading` alone.
    if (!selectedTypeId) loading = false;
  }
}

async function loadRecords() {
  if (!selectedTypeId) {
    // No Object Type means there is no record list to load — a fresh workspace has
    // none until one is defined under Settings. Returning early while `loading` was
    // still true left this surface spinning forever instead of showing the
    // "no Object Types" empty state.
    page = null;
    fields = [];
    error = null;
    loading = false;
    return;
  }
  loading = true;
  error = null;
  try {
    const [recordPage, typeFields] = await Promise.all([
      recordsApi.listRecords({
        objectTypeId: selectedTypeId,
        search: search.trim() || undefined,
        cursor: cursor ?? undefined,
        limit: 50
      }),
      recordsApi.objectTypeFields(selectedTypeId)
    ]);
    page = recordPage;
    fields = typeFields.filter((field) => field.showInList);
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void loadTypes();
});

$effect(() => {
  const typeId = selectedTypeId;
  const term = search;
  const position = cursor;
  if (!typeId) return;
  void typeId;
  void term;
  void position;
  void loadRecords();
});

function cellValue(row: RecordListRow, key: string): string {
  const direct = (row as unknown as Record<string, unknown>)[key];
  const value = direct !== undefined ? direct : row.fields[key];
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function createRecord() {
  const name = draftName.trim();
  creating = true;
  try {
    const record = await recordsApi.createRecord({
      objectTypeId: selectedTypeId,
      displayName: name === '' ? null : name
    });
    createOpen = false;
    draftName = '';
    const created = objectTypes.find((type) => type.id === selectedTypeId);
    pushToast({ tone: 'success', title: `${created?.name ?? 'Record'} created` });
    await goto(`/records/${record.id}`);
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    creating = false;
  }
}
</script>

<div class="space-y-4 p-4 sm:p-6">
  <PageHeader
    eyebrow="Records"
    title="Records"
    description="Durable things Mentat knows about — of any Object Type. Work is started separately from here."
  >
    {#snippet actions()}
      <Button onclick={() => (createOpen = true)} disabled={!selectedTypeId}>New record</Button>
    {/snippet}
  </PageHeader>

  <div class="flex flex-wrap items-end gap-3">
    <div class="min-w-48">
      <Select
        label="Object Type"
        options={objectTypes.map((type) => ({
          value: type.id,
          label: `${type.pluralName} (${type.recordCount})`
        }))}
        bind:value={selectedTypeId}
      />
    </div>
    <div class="min-w-64 flex-1">
      <Input label="Search" placeholder="Name or key" bind:value={search} />
    </div>
  </div>

  {#if error}
    <ErrorState message={error} onRetry={() => void loadRecords()} />
  {:else if loading && !page}
    <Skeleton class="h-64 w-full" />
  {:else if objectTypes.length === 0}
    <EmptyState
      title="No Object Types are defined yet"
      description="A record needs an Object Type to describe its fields. Define one under Settings → Object Types, then come back here."
    >
      <Button onclick={() => void goto('/settings/object-types')}>Define an Object Type</Button>
    </EmptyState>
  {:else if (page?.rows.length ?? 0) === 0}
    <EmptyState
      title="No records yet"
      description="Create the first record of this Object Type. Definitions live under Settings → Object Types."
    >
      <Button onclick={() => (createOpen = true)}>New record</Button>
    </EmptyState>
  {:else}
    <DataTable
      {columns}
      rows={page?.rows ?? []}
      rowKey={(row) => (row as { id: string }).id}
    >
      {#snippet row(entry)}
        {@const record = entry as RecordListRow}
        <td class="px-3 py-2">
          <a class="font-medium text-[var(--color-ink)] hover:text-[var(--color-accent)]" href={`/records/${record.id}`}>
            {record.displayName}
          </a>
        </td>
        <td class="hidden px-3 py-2 font-mono text-[11px] text-[var(--color-ink-subtle)] sm:table-cell">
          {record.key ?? '—'}
        </td>
        {#each columns.slice(2, -1) as column (column.key)}
          <td class="hidden px-3 py-2 text-xs text-[var(--color-ink-muted)] md:table-cell">
            {cellValue(record, column.key)}
          </td>
        {/each}
        <td class="hidden px-3 py-2 text-xs text-[var(--color-ink-subtle)] sm:table-cell">
          {new Date(record.updatedAt).toLocaleDateString()}
        </td>
      {/snippet}
    </DataTable>
    <Pagination
      nextCursor={page?.nextCursor ?? null}
      cursor={cursor}
      oncursor={(next) => (cursor = next)}
      count={page?.rows.length ?? 0}
      noun="records"
    />
  {/if}
</div>

<Modal open={createOpen} title="New record" onclose={() => (createOpen = false)}>
  <div class="space-y-3">
    <p class="text-xs text-[var(--color-ink-subtle)]">
      Only the display name is set here; open the record to fill its fields.
    </p>
    <Input label="Display name" bind:value={draftName} placeholder="Derived from the primary field if left blank" />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button loading={creating} onclick={() => void createRecord()}>Create</Button>
    </div>
  </div>
</Modal>
