<script lang="ts">
/**
 * FileDetail: `/files/[id]` with the six tabs the requirements name.
 *
 * Design notes worth keeping:
 *
 *  - **Fields are per workflow context.** The same bytes can be a `Policy Schedule`
 *    in one workflow and `Evidence` in another, so field values are grouped by the
 *    context they were extracted under and never merged into one list.
 *  - **Processing is read from the ledger.** No REST route returns
 *    `file_processing_runs`, so the Processing tab reconstructs the run timeline
 *    from the append-only audit ledger (`file.processing.*`) and says so. It does
 *    not invent attempt numbers or durations it cannot observe.
 *  - **No fake writes.** The API has no `PATCH /api/files/:id`, so the summary is
 *    read-only here and the UI explains why rather than showing an Edit button that
 *    cannot persist. Field corrections, work item links and workflow contexts are real
 *    mutations and are optimistic with rollback.
 */
import { untrack } from 'svelte';
import { formatBytes, formatDateTime, formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import {
  displayValue,
  fileStatusLabel,
  fileStatusTone,
  readFieldValue,
  sourceTypeLabel
} from '$ui/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import { pushToast } from '$ui/toast';
import {
  type AuditEventRecord,
  type ContentResponse,
  type ExtractedContent,
  type FileFieldValueRow,
  type FileSummary,
  RECORD_FILE_RELATIONSHIPS,
  type RecordFileRelationship,
  type WorkflowSummary,
  type WorkItemDetailView
} from '$ui/types';

interface Props {
  fileId: string;
  initialTab: string;
  ontabchange: (tab: string) => void;
}

let { fileId, initialTab, ontabchange }: Props = $props();

type TabId = 'overview' | 'fields' | 'content' | 'relationships' | 'processing' | 'history';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'fields', label: 'Fields' },
  { id: 'content', label: 'Content' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'processing', label: 'Processing' },
  { id: 'history', label: 'History' }
];

let tab = $state<TabId>((TABS.find((entry) => entry.id === initialTab)?.id ?? 'overview') as TabId);
let file = $state<FileSummary | null>(null);
let content = $state<ExtractedContent | null>(null);
let contentPending = $state(false);
let fieldRows = $state<FileFieldValueRow[]>([]);
let workflows = $state<WorkflowSummary[]>([]);
let workItems = $state<WorkItemDetailView[]>([]);
let audit = $state<AuditEventRecord[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let busy = $state(false);
let fieldDrafts = $state<Record<string, string>>({});
let savingField = $state<string | null>(null);
let linkWorkItemId = $state('');
let linkRelationship = $state<RecordFileRelationship>('attachment');
let contextWorkflowId = $state('');
let contextLabel = $state('');
let contentPage = $state(0);

const workflowName = $derived(new Map(workflows.map((entry) => [entry.id, entry.name])));
const workflowOptions = $derived(
  workflows.map((entry) => ({ value: entry.id, label: entry.name }))
);

/** The latest ingestion provenance entry, if the ledger recorded one. */
const provenanceEvent = $derived(audit.find((event) => event.action === 'file.ingested') ?? null);
const dedupeEvent = $derived(
  audit.find((event) => event.action === 'file.blob.deduplicated') ?? null
);

/** Field values grouped by the workflow context they belong to. */
const fieldsByContext = $derived.by(() => {
  const groups = new Map<string, FileFieldValueRow[]>();
  for (const row of fieldRows) {
    const key = row.workflow_id ?? '';
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([workflowIdValue, rows]) => ({
    workflowId: workflowIdValue,
    label: workflowIdValue
      ? (workflowName.get(workflowIdValue) ?? workflowIdValue.slice(0, 8))
      : 'No workflow context',
    rows
  }));
});

/** Segments provide page navigation when the extractor recorded them. */
const segments = $derived(
  content?.segments && content.segments.length > 0
    ? content.segments
    : content
      ? [{ text: content.text }]
      : []
);

const processingEvents = $derived(
  audit.filter((event) => event.action.startsWith('file.processing'))
);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ file: FileSummary }>(`/files/${fileId}`);
    file = response.file;
    await Promise.all([loadContent(), loadFields(), loadWorkflows(), loadAudit()]);
    await loadWorkItems(response.file.workflowItemIds);
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function loadContent() {
  try {
    const response = await api.get<ContentResponse>(`/files/${fileId}/content`);
    content = response.content;
    contentPending = response.pending;
    contentPage = 0;
  } catch {
    // A file with no extract yet is a normal state, not an error.
  }
}

async function loadFields() {
  try {
    const response = await api.get<{ fields: FileFieldValueRow[] }>(`/files/${fileId}/fields`);
    fieldRows = response.fields;
    fieldDrafts = Object.fromEntries(
      response.fields.map((row) => [row.id, displayValue(readFieldValue(row))])
    );
  } catch {
    fieldRows = [];
  }
}

async function loadWorkflows() {
  try {
    const response = await api.get<{ workflows: WorkflowSummary[] }>('/workflows');
    workflows = response.workflows;
  } catch {
    workflows = [];
  }
}

async function loadAudit() {
  try {
    const response = await api.get<{ events: AuditEventRecord[] }>('/audit', {
      fileId,
      limit: 200
    });
    audit = response.events;
  } catch {
    audit = [];
  }
}

async function loadWorkItems(ids: string[]) {
  if (ids.length === 0) {
    workItems = [];
    return;
  }
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await api.get<WorkItemDetailView>(`/workflow-items/${id}`);
      } catch {
        return null;
      }
    })
  );
  workItems = results.filter((entry): entry is WorkItemDetailView => entry !== null);
}

$effect(() => {
  void fileId;
  untrack(() => void load());
});

function selectTab(id: string) {
  tab = id as TabId;
  ontabchange(id);
}

async function copyHash() {
  if (!file?.contentHash) return;
  try {
    await navigator.clipboard.writeText(file.contentHash);
    pushToast({ tone: 'success', title: 'Content hash copied' });
  } catch {
    pushToast({
      tone: 'error',
      title: 'Could not copy',
      description: 'The clipboard is unavailable in this browser context.'
    });
  }
}

async function saveField(row: FileFieldValueRow) {
  const raw = fieldDrafts[row.id] ?? '';
  savingField = row.id;
  const previous = readFieldValue(row);
  const optimisticRow: FileFieldValueRow = {
    ...row,
    value_text: raw,
    value_number: null,
    value_date: null,
    value_bool: null,
    value_json: null,
    source: 'human'
  };
  fieldRows = fieldRows.map((entry) => (entry.id === row.id ? optimisticRow : entry));
  try {
    await api.put(`/files/${fileId}/fields`, {
      workflowId: row.workflow_id,
      values: { [row.key]: coerceFieldValue(raw, row.type) }
    });
    pushToast({
      tone: 'success',
      title: `${row.name} corrected`,
      description: 'The previous value stays in history.'
    });
    await loadAudit();
  } catch (failure) {
    // Roll back to the value the server still holds.
    fieldRows = fieldRows.map((entry) => (entry.id === row.id ? row : entry));
    fieldDrafts = { ...fieldDrafts, [row.id]: displayValue(previous) };
    pushToast({ tone: 'error', title: 'Field not saved', description: describeApiError(failure) });
  } finally {
    savingField = null;
  }
}

function coerceFieldValue(raw: string, type: string): unknown {
  if (type === 'number' || type === 'currency') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (type === 'boolean') return raw === 'true' || raw === 'Yes';
  if (type === 'date' || type === 'datetime') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

async function reprocess() {
  busy = true;
  try {
    await api.post(`/files/${fileId}/process`, { workflowId: null, force: true });
    pushToast({
      tone: 'success',
      title: 'Reprocessing queued',
      description: 'A changed processor identity produces a new processing key.'
    });
    await loadAudit();
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not queue reprocessing',
      description: describeApiError(failure)
    });
  } finally {
    busy = false;
  }
}

async function addContext() {
  if (!contextWorkflowId) return;
  busy = true;
  try {
    await api.post(`/files/${fileId}/workflow-context`, {
      workflowId: contextWorkflowId,
      contextLabel: contextLabel.trim() || null
    });
    file = file
      ? { ...file, workflowIds: [...new Set([...file.workflowIds, contextWorkflowId])] }
      : file;
    contextLabel = '';
    pushToast({ tone: 'success', title: 'Workflow context added' });
    await loadFields();
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not add context',
      description: describeApiError(failure)
    });
  } finally {
    busy = false;
  }
}

async function removeContext(workflowIdValue: string) {
  const previous = file;
  busy = true;
  // Optimistic: the row disappears at once and returns if the server refuses.
  file = file
    ? { ...file, workflowIds: file.workflowIds.filter((id) => id !== workflowIdValue) }
    : file;
  try {
    await api.delete(`/files/${fileId}/workflow-context/${workflowIdValue}`);
    pushToast({
      tone: 'success',
      title: 'Context removed',
      description: 'The file and its bytes are untouched; only this interpretation was removed.'
    });
    await loadFields();
  } catch (failure) {
    file = previous;
    pushToast({
      tone: 'error',
      title: 'Could not remove context',
      description: describeApiError(failure)
    });
  } finally {
    busy = false;
  }
}

async function linkWorkItem() {
  const raw = linkWorkItemId.trim();
  if (!raw) return;
  busy = true;
  try {
    const target = workItems.find((entry) => entry.workItem.id === raw || entry.key === raw);
    const workflowItemId = target?.workItem.id ?? raw;
    await api.post(`/workflow-items/${workflowItemId}/files`, {
      fileId,
      relationship: linkRelationship
    });
    linkWorkItemId = '';
    pushToast({ tone: 'success', title: 'Work item linked' });
    await load();
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not link work item',
      description: describeApiError(failure)
    });
  } finally {
    busy = false;
  }
}

async function unlinkWorkItem(workflowItemId: string) {
  const previousWorkItems = workItems;
  const previousFile = file;
  busy = true;
  workItems = workItems.filter((entry) => entry.workItem.id !== workflowItemId);
  file = file
    ? { ...file, workflowItemIds: file.workflowItemIds.filter((id) => id !== workflowItemId) }
    : file;
  try {
    await api.post(`/files/${fileId}/unlink`, { workflowItemId });
    pushToast({
      tone: 'success',
      title: 'Unlinked',
      description: 'Unlinking never deletes the file or its bytes; other links are unaffected.'
    });
  } catch (failure) {
    workItems = previousWorkItems;
    file = previousFile;
    pushToast({ tone: 'error', title: 'Could not unlink', description: describeApiError(failure) });
  } finally {
    busy = false;
  }
}

async function deleteFile() {
  busy = true;
  try {
    await api.delete(`/files/${fileId}`);
    pushToast({
      tone: 'success',
      title: 'File deleted',
      description: 'The blob is reclaimed only when no other retained file references it.'
    });
    window.location.href = '/files';
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not delete', description: describeApiError(failure) });
    busy = false;
  }
}

/** Best-effort processor name from a redacted audit payload. */
function processorOf(event: AuditEventRecord): string {
  const data = event.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const processor = record.processorType ?? record.processor ?? record.processor_type;
    const version = record.processorVersion ?? record.version;
    if (typeof processor === 'string') {
      return version ? `${processor} v${String(version)}` : processor;
    }
  }
  return '—';
}
</script>

<div class="space-y-4 p-4 md:p-6">
  <div>
    <a href="/files" class="text-xs text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]">← All files</a>
  </div>

  {#if loading}
    <Card class="space-y-3">
      <Skeleton height="1.2rem" />
      <Skeleton lines={3} />
    </Card>
  {:else if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if file}
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1.5">
        <h1 class="truncate text-lg font-semibold tracking-tight">{file.filename}</h1>
        <div class="flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-muted)]">
          <Badge tone={fileStatusTone(file.status)} dot>{fileStatusLabel(file.status)}</Badge>
          <span>{file.mimeType}</span>
          <span>·</span>
          <span>{formatBytes(file.size)}</span>
          <span>·</span>
          <span title={formatDateTime(file.createdAt)}>created {formatRelative(file.createdAt)}</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="secondary" loading={busy} onclick={reprocess}>Reprocess</Button>
        <Button variant="ghost" loading={busy} onclick={deleteFile}>Delete file</Button>
      </div>
    </header>

    <Tabs tabs={TABS} active={tab} onselect={selectTab} />

    {#if tab === 'overview'}
      <div class="grid gap-4 lg:grid-cols-3">
        <Card class="space-y-3 lg:col-span-2">
          <h2 class="text-sm font-semibold">Identity</h2>
          <dl class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            <div>
              <dt class="text-[var(--color-ink-subtle)]">Filename</dt>
              <dd class="break-all">{file.filename}</dd>
            </div>
            <div>
              <dt class="text-[var(--color-ink-subtle)]">MIME type</dt>
              <dd>{file.mimeType}</dd>
            </div>
            <div>
              <dt class="text-[var(--color-ink-subtle)]">Size</dt>
              <dd>{formatBytes(file.size)} ({file.size.toLocaleString()} bytes)</dd>
            </div>
            <div>
              <dt class="text-[var(--color-ink-subtle)]">Status</dt>
              <dd>{fileStatusLabel(file.status)}</dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-[var(--color-ink-subtle)]">Content hash (SHA-256)</dt>
              <dd class="flex items-center gap-2">
                <code class="break-all font-mono text-[11px]">{file.contentHash || '—'}</code>
                {#if file.contentHash}
                  <Button size="sm" variant="ghost" onclick={copyHash}>Copy</Button>
                {/if}
              </dd>
            </div>
          </dl>
        </Card>

        <Card class="space-y-3">
          <h2 class="text-sm font-semibold">Generic metadata</h2>
          <dl class="space-y-2 text-xs">
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Page count</dt>
              <dd>{content?.page_count ?? '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Detected language</dt>
              <dd>{content?.language ?? '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Characters extracted</dt>
              <dd>{content ? content.char_count.toLocaleString() : '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Content kind</dt>
              <dd>{content?.content_kind ?? '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Truncated</dt>
              <dd>{content ? (content.truncated ? 'Yes' : 'No') : '—'}</dd>
            </div>
          </dl>
          <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
            Metadata a processor discovers is generic to the document. Workflow-specific meaning
            lives in the Fields tab, under a workflow context.
          </p>
        </Card>

        <Card class="space-y-3 lg:col-span-2">
          <h2 class="text-sm font-semibold">Summary</h2>
          <p class="text-sm leading-relaxed text-[var(--color-ink)]">
            {file.summary ?? 'No summary yet. Processing writes one when it completes.'}
          </p>
          <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
            A generated summary is history: the API exposes no `PATCH /api/files/:id`, so editing it
            here is not offered rather than shown and silently dropped. Regenerating a summary
            through reprocessing records a new summary version alongside the previous one.
          </p>
        </Card>

        <Card class="space-y-3">
          <h2 class="text-sm font-semibold">Provenance</h2>
          <dl class="space-y-2 text-xs">
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Source type</dt>
              <dd>{file.provenance ? sourceTypeLabel(file.provenance.sourceType) : '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Reference</dt>
              <dd class="truncate">{file.provenance?.sourceLabel ?? '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Actor</dt>
              <dd>
                {provenanceEvent
                  ? `${provenanceEvent.actorType}${provenanceEvent.actorLabel ? ` · ${provenanceEvent.actorLabel}` : ''}`
                  : '—'}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Ingested</dt>
              <dd>{provenanceEvent ? formatDateTime(provenanceEvent.occurredAt) : '—'}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-[var(--color-ink-subtle)]">Bytes deduplicated</dt>
              <dd>
                {#if dedupeEvent}
                  <Badge tone="caution">Yes — existing blob reused</Badge>
                {:else}
                  No — stored as a new blob
                {/if}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    {:else if tab === 'fields'}
      <div class="space-y-4">
        <Card class="space-y-3">
          <h2 class="text-sm font-semibold">Workflow contexts</h2>
          <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
            A file is a workspace object; a workflow context records how one workflow interprets it.
            The same document can be a Policy Schedule in underwriting and Evidence in compliance,
            with separate field values.
          </p>
          <ul class="space-y-1.5">
            {#each file.workflowIds as id (id)}
              <li
                class="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2.5 py-1.5"
              >
                <span class="flex-1 text-xs">{workflowName.get(id) ?? id}</span>
                <Button size="sm" variant="ghost" disabled={busy} onclick={() => removeContext(id)}>
                  Remove context
                </Button>
              </li>
            {/each}
            {#if file.workflowIds.length === 0}
              <li class="text-xs text-[var(--color-ink-subtle)]">No workflow context yet.</li>
            {/if}
          </ul>
          <div class="flex flex-wrap items-end gap-2">
            <div class="w-52">
              <Select
                label="Add workflow context"
                options={[{ value: '', label: 'Choose a workflow' }, ...workflowOptions]}
                bind:value={contextWorkflowId}
              />
            </div>
            <div class="w-44">
              <Input label="Context label" bind:value={contextLabel} placeholder="Evidence" />
            </div>
            <Button variant="secondary" loading={busy} disabled={!contextWorkflowId} onclick={addContext}>
              Add context
            </Button>
          </div>
        </Card>

        {#if fieldsByContext.length === 0}
          <Card>
            <EmptyState
              title="No field values extracted yet"
              description="File fields are configured per workflow and extracted during processing. Correcting a value here always keeps the previous value in history."
            />
          </Card>
        {:else}
          {#each fieldsByContext as group (group.workflowId)}
            <Card class="space-y-3">
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold">{group.label}</h3>
                <Badge tone="neutral">{group.rows.length} field(s)</Badge>
              </div>
              <div class="space-y-2">
                {#each group.rows as row (row.id)}
                  <div
                    class="grid gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2.5 sm:grid-cols-[1fr_auto]"
                  >
                    <div class="space-y-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-xs font-medium">{row.name}</span>
                        <Badge tone="muted">{row.type}</Badge>
                        {#if row.confidence !== null && row.confidence !== undefined}
                          <Badge tone={row.confidence >= 0.8 ? 'positive' : 'caution'}>
                            confidence {Math.round(row.confidence * 100)}%
                          </Badge>
                        {/if}
                        {#if row.source_page !== null && row.source_page !== undefined}
                          <span class="text-[10px] text-[var(--color-ink-subtle)]">
                            page {row.source_page}{row.source_span ? ` · ${row.source_span}` : ''}
                          </span>
                        {/if}
                      </div>
                      <div class="flex items-end gap-2">
                        <Input
                          label="Value"
                          value={fieldDrafts[row.id] ?? ''}
                          oninput={(event) =>
                            (fieldDrafts = { ...fieldDrafts, [row.id]: event.currentTarget.value })}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={savingField === row.id}
                          onclick={() => saveField(row)}
                        >
                          Correct
                        </Button>
                      </div>
                    </div>
                    <p class="text-[11px] text-[var(--color-ink-subtle)] sm:text-right">
                      {row.source === 'human' ? 'Human-corrected' : 'Extracted'}
                      {#if row.updated_at}<span class="block">{formatRelative(row.updated_at)}</span>{/if}
                    </p>
                  </div>
                {/each}
              </div>
            </Card>
          {/each}
        {/if}
      </div>
    {:else if tab === 'content'}
      <Card class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold">Extracted content</h2>
          {#if content}
            <Badge tone="neutral">{content.char_count.toLocaleString()} characters</Badge>
            {#if content.page_count !== null}<Badge tone="neutral">{content.page_count} page(s)</Badge>{/if}
            {#if content.language}<Badge tone="neutral">{content.language}</Badge>{/if}
            {#if content.truncated}<Badge tone="caution">truncated</Badge>{/if}
          {/if}
          <div class="ml-auto">
            <Button size="sm" variant="secondary" loading={busy} onclick={reprocess}>Reprocess</Button>
          </div>
        </div>

        {#if contentPending || !content}
          <EmptyState
            title="No extracted content yet"
            description="Content is persisted separately from the raw bytes and written by the processing pipeline. Queue processing to extract it."
          >
            <div class="mt-2">
              <Button size="sm" variant="primary" loading={busy} onclick={reprocess}>Process this file</Button>
            </div>
          </EmptyState>
        {:else}
          {#if content.truncated}
            <p
              class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-caution)_18%,transparent)] px-3 py-2 text-[11px] text-[var(--color-ink)]"
            >
              The extractor truncated this document. The stored text is a prefix; the raw bytes are
              unchanged and the full content can be obtained by reprocessing.
            </p>
          {/if}
          {#if segments.length > 1}
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-[11px] text-[var(--color-ink-subtle)]">Segments</span>
              {#each segments as segment, index (index)}
                <button
                  type="button"
                  class="rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px]
                    {contentPage === index
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                      : 'border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-muted)]'}"
                  onclick={() => (contentPage = index)}
                >
                  {segment.page !== undefined ? `Page ${segment.page}` : `Segment ${index + 1}`}
                </button>
              {/each}
            </div>
          {/if}
          <pre
            class="scrollbar-thin max-h-[32rem] overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{segments[contentPage]?.text ?? content.text}</pre>
        {/if}
      </Card>
    {:else if tab === 'relationships'}
      <div class="grid gap-4 lg:grid-cols-2">
        <Card class="space-y-3">
          <h2 class="text-sm font-semibold">Workflows contextualising this file</h2>
          <ul class="space-y-1.5">
            {#each file.workflowIds as id (id)}
              <li class="flex items-center gap-2 text-xs">
                <Badge tone="neutral">{workflowName.get(id) ?? id}</Badge>
              </li>
            {/each}
            {#if file.workflowIds.length === 0}
              <li class="text-xs text-[var(--color-ink-subtle)]">No workflow context.</li>
            {/if}
          </ul>
        </Card>

        <Card class="space-y-3">
          <h2 class="text-sm font-semibold">Work items</h2>
          <ul class="space-y-1.5">
            {#each workItems as link (link.workItem.id)}
              <li
                class="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2.5 py-1.5"
              >
                <span class="min-w-0 flex-1 truncate text-xs">
                  <span class="font-mono text-[11px]">{link.key}</span>
                  <span class="ml-2">{link.workItem.title}</span>
                  <span class="ml-2 text-[10px] text-[var(--color-ink-subtle)]">{link.workflow.name}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onclick={() => unlinkWorkItem(link.workItem.id)}>
                  Unlink
                </Button>
              </li>
            {/each}
            {#if workItems.length === 0}
              <li class="text-xs text-[var(--color-ink-subtle)]">Not linked to any work item.</li>
            {/if}
          </ul>
          <div class="flex flex-wrap items-end gap-2">
            <div class="min-w-48 flex-1">
              <Input label="Link a work item" bind:value={linkWorkItemId} placeholder="Work item id or key" />
            </div>
            <div class="w-40">
              <Select
                label="Relationship"
                options={RECORD_FILE_RELATIONSHIPS.map((value) => ({ value, label: value }))}
                bind:value={linkRelationship}
              />
            </div>
            <Button variant="secondary" loading={busy} onclick={linkWorkItem}>Link</Button>
          </div>
          <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
            Unlinking removes only this association. It never deletes the file or its bytes, and it
            does not affect the other work items that share it.
          </p>
        </Card>
      </div>
    {:else if tab === 'processing'}
      <div class="space-y-4">
        <Card class="space-y-3">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-semibold">Processing runs</h2>
            <Badge tone="neutral">{processingEvents.length}</Badge>
            <div class="ml-auto">
              <Button size="sm" variant="secondary" loading={busy} onclick={reprocess}>Reprocess</Button>
            </div>
          </div>
          <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
            A processing run is identified by
            <code class="font-mono text-[11px]">contentHash + processorType + processorVersion + configurationFingerprint</code>.
            Blob dedupe is not processing dedupe: if any part of that identity changes — a better
            parser, a new prompt, a changed field schema — the same bytes are processed again. The
            timeline below is reconstructed from the append-only audit ledger, because no REST route
            returns the `file_processing_runs` rows yet.
          </p>
          {#if processingEvents.length === 0}
            <EmptyState
              title="No processing runs recorded"
              description="Processing is durable and versioned. Queue a run to extract content, metadata, a summary and workflow field values."
            />
          {:else}
            <DataTable
              columns={[
                { key: 'action', label: 'Event' },
                { key: 'processor', label: 'Processor' },
                { key: 'status', label: 'Status' },
                { key: 'at', label: 'When', align: 'right' }
              ]}
              rows={processingEvents}
              rowKey={(item) => String((item as AuditEventRecord).seq)}
            >
              {#snippet row(item)}
                {@const event = item as AuditEventRecord}
                <td class="px-3 py-2 font-mono text-[11px]">{event.action.replace('file.processing.', '')}</td>
                <td class="px-3 py-2 text-xs">{processorOf(event)}</td>
                <td class="px-3 py-2">
                  <Badge
                    tone={event.action.endsWith('failed')
                      ? 'danger'
                      : event.action.endsWith('completed')
                        ? 'positive'
                        : 'neutral'}
                  >
                    {event.action.split('.').pop()}
                  </Badge>
                </td>
                <td class="px-3 py-2 text-right text-xs whitespace-nowrap">{formatDateTime(event.occurredAt)}</td>
              {/snippet}
            </DataTable>
          {/if}
        </Card>

        <Card class="space-y-2">
          <h2 class="text-sm font-semibold">Why a version change forces reprocessing</h2>
          <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
            Reusing a result is only safe when the whole processing identity matches. A new parser
            version may read a table the old one skipped; a changed prompt or schema produces
            different fields; a different model version answers differently. Reusing across those
            changes would silently present stale extraction as current, so Mentat re-runs instead.
            The bytes are still stored once — only the derived results are recomputed.
          </p>
        </Card>
      </div>
    {:else}
      <Card class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold">Audit history</h2>
          <Badge tone="neutral">{audit.length} entries</Badge>
          <span class="text-[11px] text-[var(--color-ink-subtle)]">append-only, newest first</span>
        </div>
        {#if audit.length === 0}
          <EmptyState
            title="No history yet"
            description="Every ingestion, dedupe, processing, extraction, correction and link is appended to the ledger."
          />
        {:else}
          <ul class="space-y-1.5">
            {#each audit as event (event.seq)}
              <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge tone="muted">{event.action}</Badge>
                  <span class="text-xs">{event.summary ?? event.action}</span>
                  <span
                    class="ml-auto text-[10px] text-[var(--color-ink-subtle)]"
                    title={formatDateTime(event.occurredAt)}
                  >
                    {formatRelative(event.occurredAt)}
                  </span>
                </div>
                <div class="mt-1 flex flex-wrap gap-2 text-[10px] text-[var(--color-ink-subtle)]">
                  <span>seq {event.seq}</span>
                  <span>actor {event.actorType}{event.actorLabel ? ` · ${event.actorLabel}` : ''}</span>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    {/if}
  {/if}
</div>
