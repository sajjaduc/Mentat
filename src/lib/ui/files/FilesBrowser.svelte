<script lang="ts">
/**
 * FilesBrowser: the first-class Files surface.
 *
 * Files are not an attachments tab. This screen treats them as workspace objects:
 * a search mode that switches between *metadata* and *extracted content*, filters
 * that compose, a table whose columns are chosen by the user, a grid summary view,
 * an upload panel with honest dedupe reporting, and saved views.
 *
 * Filtering is server-side and single-sourced. The structured builder produces the
 * shared filter AST, which is serialized into `?filter=` exactly as a saved view or
 * a dashboard widget stores it; the metadata controls are translated by the API into
 * the same AST and ANDed with it (ADR-0012). Nothing here evaluates a filter the
 * server would evaluate differently.
 */
import { untrack } from 'svelte';
import { formatBytes, formatDateTime, formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import FilterBuilder from '$ui/common/FilterBuilder.svelte';
import { pruneIncompleteFilter } from '$ui/common/filter-tree';
import PageHeader from '$ui/common/PageHeader.svelte';
import Pagination from '$ui/common/Pagination.svelte';
import SavedViews from '$ui/common/SavedViews.svelte';
import SegmentedControl from '$ui/common/SegmentedControl.svelte';
import {
  andOf,
  type FilterAst,
  type FilterCondition,
  type FilterFieldKind,
  type FilterGroup,
  orOf,
  parseFilter,
  serializeFilter
} from '$ui/filters';
import { fileStatusLabel, fileStatusTone, sourceTypeLabel } from '$ui/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import {
  type ContentSearchHit,
  FILE_STATUSES,
  type FileSummary,
  type SavedView,
  type UploadResult,
  type WorkflowSummary
} from '$ui/types';
import UploadPanel from './UploadPanel.svelte';

interface Props {
  /** Seed values from the URL so a filtered list is a shareable link. */
  initialFilter: FilterAst | null;
  initialSearch: string;
  initialMode: 'metadata' | 'content';
  initialWorkflowId: string;
  initialStatus: string;
  initialMimeType: string;
  initialTicketId: string;
  initialFilename: string;
  onurlchange: (query: Record<string, string>) => void;
}

let {
  initialFilter,
  initialSearch,
  initialMode,
  initialWorkflowId,
  initialStatus,
  initialMimeType,
  initialTicketId,
  initialFilename,
  onurlchange
}: Props = $props();

type ColumnKey =
  | 'filename'
  | 'type'
  | 'size'
  | 'status'
  | 'summary'
  | 'workflow'
  | 'tickets'
  | 'provenance'
  | 'created';

const ALL_COLUMNS: Array<{ key: ColumnKey; label: string; always?: boolean }> = [
  { key: 'filename', label: 'Filename', always: true },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
  { key: 'status', label: 'Status' },
  { key: 'summary', label: 'Summary' },
  { key: 'workflow', label: 'Workflow context' },
  { key: 'tickets', label: 'Linked tickets' },
  { key: 'provenance', label: 'Provenance' },
  { key: 'created', label: 'Created' }
];

const DEFAULT_COLUMNS: ColumnKey[] = [
  'filename',
  'type',
  'size',
  'status',
  'summary',
  'workflow',
  'tickets',
  'provenance',
  'created'
];

let files = $state<FileSummary[]>([]);
let nextCursor = $state<string | null>(null);
let cursor = $state<string | null>(null);
let workflows = $state<WorkflowSummary[]>([]);
let views = $state<SavedView[]>([]);
let knownFields = $state<Array<{ key: string; label: string; type: string }>>([]);
let loading = $state(true);
let loadingMore = $state(false);
let error = $state<{ message: string; code: string | null } | null>(null);

let search = $state(initialSearch);
let mode = $state<'metadata' | 'content'>(initialMode);
let filename = $state(initialFilename);
let status = $state(initialStatus);
let mimeType = $state(initialMimeType);
let workflowId = $state(initialWorkflowId);
let ticketId = $state(initialTicketId);
let view = $state<'table' | 'grid'>('table');
let sortKey = $state<'createdAt' | 'updatedAt' | 'filename' | 'size'>('createdAt');
let sortDirection = $state<'asc' | 'desc'>('desc');
let filter = $state<FilterAst | null>(initialFilter);
let columns = $state<ColumnKey[]>([...DEFAULT_COLUMNS]);
let structuredOpen = $state(false);
let columnsOpen = $state(false);
let uploadOpen = $state(false);
let contentHits = $state<ContentSearchHit[] | null>(null);
let contentSearching = $state(false);

/** Rows added optimistically while their upload is still in flight. */
let pendingRows = $state<FileSummary[]>([]);

const workflowOptions = $derived(
  workflows.map((entry) => ({ value: entry.id, label: entry.name }))
);
const workflowName = $derived(new Map(workflows.map((entry) => [entry.id, entry.name])));

/**
 * The filter sent to the server: the user's structured AST ANDed with a metadata
 * search condition. Keeping it in one AST is what stops the search box and the
 * builder from disagreeing about semantics.
 */
const serverFilter = $derived.by(() => {
  const conditions: FilterAst[] = [];
  // Incomplete builder rows are visible but not applied; see `pruneIncompleteFilter`.
  const applied = filter ? pruneIncompleteFilter(filter) : null;
  if (applied) conditions.push(applied);
  const term = search.trim();
  if (mode === 'metadata' && term.length > 0) {
    const filenameCondition: FilterCondition = {
      type: 'condition',
      kind: 'system',
      key: 'filename',
      operator: 'contains',
      value: term
    };
    const summaryCondition: FilterCondition = {
      type: 'condition',
      kind: 'system',
      key: 'summary',
      operator: 'contains',
      value: term
    };
    conditions.push(orOf([filenameCondition, summaryCondition]));
  }
  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0] ?? null;
  return andOf(conditions);
});

const displayed = $derived([...pendingRows, ...files]);

const visibleColumns = $derived(
  ALL_COLUMNS.filter((column) => column.key === 'filename' || columns.includes(column.key))
);

export function openUpload() {
  uploadOpen = true;
}

async function load(options: { append?: boolean } = {}) {
  if (options.append) loadingMore = true;
  else loading = true;
  error = null;
  try {
    const response = await api.get<{ items: FileSummary[]; nextCursor: string | null }>('/files', {
      filename: filename || undefined,
      mimeType: mimeType || undefined,
      status: status || undefined,
      workflowId: workflowId || undefined,
      ticketId: ticketId || undefined,
      // The AST composes with the metadata shortcuts server-side, with AND.
      filter: serializeFilter(serverFilter) ?? undefined,
      sort: JSON.stringify({ key: sortKey, direction: sortDirection }),
      limit: 50,
      cursor: options.append ? cursor : undefined
    });
    files = options.append ? [...files, ...response.items] : response.items;
    nextCursor = response.nextCursor;
  } catch (failure) {
    error = { message: describeApiError(failure), code: null };
  } finally {
    loading = false;
    loadingMore = false;
  }
}

async function loadWorkflows() {
  try {
    const response = await api.get<{ workflows: WorkflowSummary[] }>('/workflows');
    workflows = response.workflows;
  } catch {
    // Workflow names are decoration on this screen; the ids remain usable.
  }
}

async function loadViews() {
  try {
    const response = await api.get<{ views: SavedView[] }>('/views', { scope: 'files' });
    views = response.views;
  } catch {
    // Saved views failing must not block the file list.
  }
}

async function loadFieldDefinitions() {
  try {
    const response = await api.get<{ fields: Array<{ key: string; name: string; type: string }> }>(
      '/fields',
      { scope: 'file' }
    );
    knownFields = response.fields.map((field) => ({
      key: field.key,
      label: field.name,
      type: field.type
    }));
  } catch {
    knownFields = [];
  }
}

$effect(() => {
  // Every filter is server-side, so any change re-queries from the first page. The
  // body is untracked so reads inside `load` cannot turn its own writes into a loop.
  void filename;
  void status;
  void mimeType;
  void workflowId;
  void ticketId;
  void mode;
  void search;
  void filter;
  void sortKey;
  void sortDirection;
  untrack(() => {
    cursor = null;
    void load({ append: false });
  });
});

$effect(() => {
  const target = cursor;
  if (target === null) return;
  untrack(() => void load({ append: true }));
});

$effect(() => {
  untrack(() => {
    void loadWorkflows();
    void loadViews();
    void loadFieldDefinitions();
  });
});

function submitSearch() {
  if (mode === 'content') {
    void runContentSearch();
  } else {
    cursor = null;
    void load();
  }
}

async function runContentSearch() {
  const query = search.trim();
  if (query.length === 0) {
    contentHits = null;
    return;
  }
  contentSearching = true;
  error = null;
  try {
    const response = await api.get<{ hits?: ContentSearchHit[] } | ContentSearchHit[]>(
      '/files/search',
      { q: query, workflowId: workflowId || undefined, limit: 50 }
    );
    contentHits = Array.isArray(response) ? response : (response.hits ?? []);
  } catch (failure) {
    error = { message: describeApiError(failure), code: null };
  } finally {
    contentSearching = false;
  }
}

function switchMode(next: string) {
  mode = next as 'metadata' | 'content';
  contentHits = null;
  publishUrl();
}

/**
 * Toggle or set the server-side sort. The table's column keys and the API's sort
 * keys differ for `created`, so the mapping is explicit rather than positional.
 */
const SORTABLE_COLUMNS: Record<string, 'createdAt' | 'filename' | 'size'> = {
  filename: 'filename',
  size: 'size',
  created: 'createdAt'
};

function toggleSort(columnKey: string) {
  const nextKey = SORTABLE_COLUMNS[columnKey];
  if (!nextKey) return;
  if (nextKey === sortKey) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = nextKey;
    sortDirection = nextKey === 'filename' ? 'asc' : 'desc';
  }
  cursor = null;
  untrack(() => void load({ append: false }));
}

function publishUrl() {
  onurlchange({
    filter: serializeFilter(filter) ?? '',
    q: search,
    mode,
    filename,
    status,
    mimeType,
    workflowId,
    ticketId
  });
}

function onFilterChange(next: FilterGroup | null) {
  filter = next;
  publishUrl();
}

async function onUploaded(
  result: UploadResult,
  context: { ticketId: string | null; workflowId: string | null }
) {
  // Drop the optimistic placeholder keyed by the logical file id the server
  // returned; the authoritative row (with provenance and workflow ids resolved)
  // comes from a refetch.
  pendingRows = pendingRows.filter((row) => !row.id.startsWith('pending-'));
  pushToast({
    tone: 'success',
    title: 'File stored',
    description: result.deduplicated
      ? 'These bytes already existed in this workspace; the existing blob was reused.'
      : `Stored ${formatBytes(result.size)} as a new blob.`
  });
  if (context.ticketId || context.workflowId) {
    // Associations change which filters match, so refetch rather than patch.
    cursor = null;
    await load();
  } else {
    try {
      const response = await api.get<{ file: FileSummary }>(`/files/${result.fileId}`);
      files = [response.file, ...files];
    } catch {
      cursor = null;
      await load();
    }
  }
  void loadViews();
}

/** Show a placeholder row the instant an upload starts, before it finishes. */
function onUploadStarted(context: {
  filename: string;
  size: number;
  ticketId: string | null;
  workflowId: string | null;
}) {
  const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingRows = [
    {
      id,
      filename: context.filename,
      mimeType: 'application/octet-stream',
      size: context.size,
      status: 'processing',
      summary: null,
      contentHash: '',
      createdAt: Date.now(),
      provenance: { sourceType: 'human_upload', sourceLabel: null },
      workflowIds: context.workflowId ? [context.workflowId] : [],
      ticketIds: context.ticketId ? [context.ticketId] : []
    },
    ...pendingRows
  ];
}

/** Withdraw a placeholder whose upload failed, so the list never lies. */
function onUploadFailed(filename: string) {
  pendingRows = pendingRows.filter((row) => row.filename !== filename);
}

function toggleColumn(key: ColumnKey) {
  if (columns.includes(key)) {
    if (key === 'filename') return;
    columns = columns.filter((entry) => entry !== key);
  } else {
    columns = [...columns, key];
  }
}

function ticketLabel(id: string): string {
  return id;
}

function fileHref(id: string): string {
  return `/files/${id}`;
}

const hasAnyFiles = $derived(files.length > 0 || pendingRows.length > 0);
</script>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Files"
    eyebrow="Resources"
    description="Durable, content-addressed documents in this workspace. The same file can be linked to many tickets and interpreted by more than one workflow."
  >
    {#snippet actions()}
      <SegmentedControl
        label="Result layout"
        value={view}
        onchange={(next) => (view = next as 'table' | 'grid')}
        options={[
          { value: 'table', label: 'Table', hint: 'Rows with configurable columns' },
          { value: 'grid', label: 'Grid', hint: 'Summary cards' }
        ]}
      />
      <Button variant="primary" onclick={() => (uploadOpen = true)}>Upload files</Button>
    {/snippet}
  </PageHeader>

  <Card padding="md" class="space-y-3">
    <div class="flex flex-wrap items-end gap-2">
      <div class="min-w-56 flex-1">
        <Input
          label={mode === 'metadata' ? 'Search metadata' : 'Search extracted content'}
          bind:value={search}
          placeholder={mode === 'metadata' ? 'Filename or summary…' : 'Terms inside the document…'}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitSearch();
            }
          }}
        />
      </div>
      <Button variant="primary" onclick={submitSearch} loading={contentSearching}>
        {mode === 'metadata' ? 'Apply' : 'Search content'}
      </Button>
      <SegmentedControl
        label="Search mode"
        value={mode}
        onchange={switchMode}
        options={[
          { value: 'metadata', label: 'Metadata', hint: 'Filename, type, status, fields' },
          { value: 'content', label: 'Content', hint: 'Full-text over extracted text' }
        ]}
      />
    </div>

    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Input label="Filename contains" bind:value={filename} placeholder="invoice" />
      <Select
        label="Processing status"
        options={[
          { value: '', label: 'Any status' },
          ...FILE_STATUSES.map((value) => ({ value, label: fileStatusLabel(value) }))
        ]}
        bind:value={status}
      />
      <Input label="MIME type" bind:value={mimeType} placeholder="application/pdf" />
      <Select
        label="Workflow context"
        options={[{ value: '', label: 'Any workflow' }, ...workflowOptions]}
        bind:value={workflowId}
      />
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <div class="min-w-56 flex-1">
        <Input label="Linked ticket id" bind:value={ticketId} placeholder="Ticket id" />
      </div>
      <Button variant="secondary" onclick={() => (structuredOpen = !structuredOpen)} aria-expanded={structuredOpen}>
        {structuredOpen ? 'Hide structured filters' : 'Structured filters'}
        {#if filter}<Badge tone="accent">on</Badge>{/if}
      </Button>
      <Button variant="secondary" onclick={() => (columnsOpen = !columnsOpen)} aria-expanded={columnsOpen}>
        Columns ({visibleColumns.length})
      </Button>
      <Button
        variant="ghost"
        onclick={() => {
          filename = '';
          status = '';
          mimeType = '';
          workflowId = '';
          ticketId = '';
          search = '';
          filter = null;
          contentHits = null;
          cursor = null;
          publishUrl();
        }}
      >
        Reset
      </Button>
    </div>

    {#if columnsOpen}
      <div class="flex flex-wrap gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-3">
        {#each ALL_COLUMNS as column (column.key)}
          <label class="inline-flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={columns.includes(column.key)}
              disabled={column.always}
              onchange={() => toggleColumn(column.key)}
            />
            {column.label}
            {#if column.always}<span class="text-[10px] text-[var(--color-ink-subtle)]">always</span>{/if}
          </label>
        {/each}
      </div>
    {/if}

    {#if structuredOpen}
      <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-xs font-medium">Structured file-field filters</p>
          <p class="max-w-xl text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
            Built as the shared filter AST, serialized to <code class="font-mono">?filter=</code> and
            run by the server over every file in the workspace — the same representation a saved view
            stores and a dashboard widget runs. Metadata controls above are translated into the same
            AST and ANDed with it.
          </p>
        </div>
        <FilterBuilder
          value={filter}
          allow={['system', 'file_field'] as FilterFieldKind[]}
          fileFields={knownFields}
          workflowOptions={workflowOptions}
          onchange={onFilterChange}
        />
        <div class="flex flex-wrap items-center gap-2">
          {#if knownFields.length > 0}
            <Button
              size="sm"
              variant="ghost"
              onclick={() =>
                (filter = {
                  type: 'group',
                  op: 'and',
                  children: [
                    {
                      type: 'condition',
                      kind: 'file_field',
                      key: knownFields[0]?.key ?? '',
                      operator: 'is_not_empty'
                    }
                  ]
                })}
            >
              Start from file fields
            </Button>
          {:else}
            <span class="text-[11px] text-[var(--color-ink-subtle)]">
              No file fields are defined for this workspace yet. Add one to a workflow's file fields,
              then filter on it here.
            </span>
          {/if}
          <span class="text-[11px] text-[var(--color-ink-subtle)]">
            Incomplete rows are kept in the builder but not sent until a field and value are chosen.
            Example: Document Type = Invoice AND Customer = ACME AND Document Date &gt; 2026-01-01
          </span>
        </div>
      </div>
    {/if}

    <SavedViews
      scope="files"
      {views}
      currentFilter={filter}
      currentColumns={columns}
      onapply={(applied) => {
        filter = applied.filter;
        if (applied.columns && applied.columns.length > 0) {
          columns = applied.columns.filter((entry): entry is ColumnKey =>
            ALL_COLUMNS.some((column) => column.key === entry)
          );
          if (!columns.includes('filename')) columns = ['filename', ...columns];
        }
        publishUrl();
      }}
      onchanged={() => void loadViews()}
    />
  </Card>

  {#if error}
    <ErrorState message={error.message} code={error.code} onRetry={() => void load()} />
  {/if}

  {#if mode === 'content' && contentHits !== null}
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">Content matches for “{search}”</h2>
        <Badge tone="accent">{contentHits.length}</Badge>
        <Button size="sm" variant="ghost" onclick={() => (contentHits = null)}>Back to metadata list</Button>
      </div>
      {#if contentHits.length === 0}
        <EmptyState
          title="No content matches"
          description="Full-text search runs over extracted text. A file that has not finished processing has no extracted content yet."
        />
      {:else}
        <ul class="space-y-2">
          {#each contentHits as hit (hit.fileId)}
            <li>
              <a
                href={fileHref(hit.fileId)}
                class="block rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <span class="flex items-center gap-2">
                  <span class="truncate text-sm font-medium">{hit.filename}</span>
                  {#if hit.pageCount !== null}
                    <Badge tone="neutral">{hit.pageCount} page(s)</Badge>
                  {/if}
                </span>
                <span class="mt-1 block text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  {hit.snippet}
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else if loading}
    <Card class="space-y-3">
      <Skeleton height="1rem" />
      <Skeleton lines={4} />
    </Card>
  {:else if !hasAnyFiles}
    <Card>
      <EmptyState
        title="No files yet"
        description="A File in Mentat is a durable, content-addressed document: the bytes are hashed and stored once, while the logical file carries provenance, extracted content, summaries and workflow-specific field values. One file can support many tickets."
      >
        <div class="mt-2 flex justify-center gap-2">
          <Button variant="primary" onclick={() => (uploadOpen = true)}>Upload a file</Button>
        </div>
      </EmptyState>
    </Card>
  {:else if view === 'table'}
    <div class="space-y-2">
      <DataTable
        columns={visibleColumns.map((column) => ({
          key: column.key,
          label: column.label,
          sortable: ['filename', 'size', 'created'].includes(column.key),
          align:
            column.key === 'size' || column.key === 'created'
              ? ('right' as const)
              : ('left' as const)
        }))}
        rows={displayed}
        rowKey={(item) => (item as FileSummary).id}
        sortKey={sortKey === 'createdAt' ? 'created' : sortKey}
        {sortDirection}
        onsort={toggleSort}
      >
        {#snippet row(item)}
          {@const file = item as FileSummary}
          <td class="px-3 py-2">
            <a href={fileHref(file.id)} class="font-medium text-[var(--color-ink)] hover:underline">
              {file.filename}
            </a>
            {#if file.id.startsWith('pending-')}
              <Badge tone="caution" class="ml-2">uploading…</Badge>
            {/if}
            <span class="mt-0.5 block font-mono text-[10px] text-[var(--color-ink-subtle)]">
              {file.contentHash ? file.contentHash.slice(0, 16) : 'hash pending'}
            </span>
          </td>
          {#if columns.includes('type')}
            <td class="hidden px-3 py-2 text-xs text-[var(--color-ink-muted)] md:table-cell">{file.mimeType}</td>
          {/if}
          {#if columns.includes('size')}
            <td class="px-3 py-2 text-right text-xs">{formatBytes(file.size)}</td>
          {/if}
          {#if columns.includes('status')}
            <td class="px-3 py-2">
              <Badge tone={fileStatusTone(file.status)} dot>{fileStatusLabel(file.status)}</Badge>
            </td>
          {/if}
          {#if columns.includes('summary')}
            <td class="hidden max-w-xs px-3 py-2 text-xs text-[var(--color-ink-muted)] lg:table-cell">
              {file.summary ?? '—'}
            </td>
          {/if}
          {#if columns.includes('workflow')}
            <td class="hidden px-3 py-2 lg:table-cell">
              {#if file.workflowIds.length === 0}
                <span class="text-xs text-[var(--color-ink-subtle)]">—</span>
              {:else}
                <span class="flex flex-wrap gap-1">
                  {#each file.workflowIds.slice(0, 2) as id (id)}
                    <Badge tone="neutral">{workflowName.get(id) ?? id.slice(0, 8)}</Badge>
                  {/each}
                  {#if file.workflowIds.length > 2}
                    <Badge tone="muted">+{file.workflowIds.length - 2}</Badge>
                  {/if}
                </span>
              {/if}
            </td>
          {/if}
          {#if columns.includes('tickets')}
            <td class="hidden px-3 py-2 lg:table-cell">
              {#if file.ticketIds.length === 0}
                <span class="text-xs text-[var(--color-ink-subtle)]">—</span>
              {:else}
                <span class="flex flex-wrap gap-1">
                  {#each file.ticketIds.slice(0, 2) as id (id)}
                    <Badge tone="accent">{ticketLabel(id)}</Badge>
                  {/each}
                  {#if file.ticketIds.length > 2}
                    <Badge tone="muted">+{file.ticketIds.length - 2}</Badge>
                  {/if}
                </span>
              {/if}
            </td>
          {/if}
          {#if columns.includes('provenance')}
            <td class="hidden px-3 py-2 text-xs text-[var(--color-ink-muted)] xl:table-cell">
              {file.provenance ? sourceTypeLabel(file.provenance.sourceType) : '—'}
              {#if file.provenance?.sourceLabel}
                <span class="block text-[10px] text-[var(--color-ink-subtle)]">{file.provenance.sourceLabel}</span>
              {/if}
            </td>
          {/if}
          {#if columns.includes('created')}
            <td class="px-3 py-2 text-right text-xs whitespace-nowrap text-[var(--color-ink-muted)]" title={formatDateTime(file.createdAt)}>
              {formatRelative(file.createdAt)}
            </td>
          {/if}
        {/snippet}
        {#snippet empty()}
          <EmptyState
            title="No files match these filters"
            description="Try clearing a filter, or switch to content search to look inside extracted text."
          />
        {/snippet}
      </DataTable>
      <Pagination
        nextCursor={nextCursor}
        loading={loadingMore}
        cursor={cursor}
        count={displayed.length}
        noun="files"
        oncursor={(next) => {
          cursor = next;
        }}
      />
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each displayed as file (file.id)}
        <a href={fileHref(file.id)} class="block">
          <Card interactive class="h-full space-y-2">
            <div class="flex items-start justify-between gap-2">
              <p class="min-w-0 truncate text-sm font-medium">{file.filename}</p>
              <Badge tone={fileStatusTone(file.status)} dot>{fileStatusLabel(file.status)}</Badge>
            </div>
            <p class="line-clamp-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
              {file.summary ?? 'No summary yet. Processing writes one when it completes.'}
            </p>
            <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)]">
              <span>{file.mimeType}</span>
              <span>·</span>
              <span>{formatBytes(file.size)}</span>
              <span>·</span>
              <span>{formatRelative(file.createdAt)}</span>
            </div>
            {#if file.workflowIds.length > 0 || file.ticketIds.length > 0}
              <div class="flex flex-wrap gap-1">
                {#each file.workflowIds.slice(0, 1) as id (id)}
                  <Badge tone="neutral">{workflowName.get(id) ?? id.slice(0, 8)}</Badge>
                {/each}
                {#each file.ticketIds.slice(0, 2) as id (id)}
                  <Badge tone="accent">{ticketLabel(id)}</Badge>
                {/each}
              </div>
            {/if}
          </Card>
        </a>
      {/each}
    </div>
  {/if}
</div>

{#if uploadOpen}
  <Modal
    open={uploadOpen}
    title="Upload files"
    description="Bytes are hashed with SHA-256 and stored once per workspace. A second upload of identical bytes reuses the blob but keeps its own provenance."
    width="44rem"
    onclose={() => (uploadOpen = false)}
  >
    <UploadPanel
      workflows={workflowOptions}
      onuploaded={onUploaded}
      onclose={() => (uploadOpen = false)}
    />
  </Modal>
{/if}
