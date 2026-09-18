<script lang="ts">
/**
 * Record detail surface.
 *
 * One component owns loading and every mutation, exactly like `WorkItemSurface`, and
 * renders tabs exclusively so a single record stays the subject of the page.
 * Overview edits the effective schema (base + workflow overlay); the other tabs
 * show activity, participation, files, relationships and provenance.
 */
import { untrack } from 'svelte';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import FieldInput from '$ui/work/FieldInput.svelte';
import type { MemberOption, TeamOption } from '$ui/work/types';
import { recordsApi } from './api';
import { toFieldConfig } from './field-config';
import type {
  RecordDetail,
  RecordFieldHistoryEntry,
  RecordFileView,
  RelatedRecordView,
  WorkflowItemListRow
} from './types';

interface Props {
  recordId: string;
  workspaceId?: string;
  initialTab?: string;
}
let { recordId, workspaceId, initialTab = 'overview' }: Props = $props();

let detail = $state<RecordDetail | null>(null);
let history = $state<RecordFieldHistoryEntry[]>([]);
let related = $state<RelatedRecordView[]>([]);
let work = $state<WorkflowItemListRow[]>([]);
let files = $state<RecordFileView[]>([]);
let members = $state<MemberOption[]>([]);
let teams = $state<TeamOption[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let tab = $state(untrack(() => initialTab));
let saving = $state<string | null>(null);
let fieldErrors = $state<Record<string, string | null>>({});
let noteDraft = $state('');
let addingNote = $state(false);
let linkTarget = $state('');
let linkKey = $state('');

const tabs = $derived([
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'work', label: 'Work', count: work.length },
  { id: 'files', label: 'Files', count: files.length },
  { id: 'related', label: 'Related', count: related.length },
  { id: 'history', label: 'History', count: history.length }
]);

async function load() {
  loading = true;
  error = null;
  try {
    const record = await recordsApi.getRecord(recordId);
    detail = record;
    const [historyRows, relatedRows, workRows, fileRows] = await Promise.all([
      recordsApi.recordHistory(recordId),
      recordsApi.recordRelated(recordId),
      recordsApi.listWorkItems({ recordId }),
      recordsApi.recordFiles(recordId)
    ]);
    history = historyRows;
    related = relatedRows;
    work = workRows;
    files = fileRows;
    if (workspaceId) {
      void loadResources(workspaceId);
    }
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function loadResources(workspace: string) {
  try {
    const [teamRows, memberRows] = await Promise.all([
      api.get<{ teams: TeamOption[] }>('/teams'),
      api.get<{ members: MemberOption[] }>(`/workspaces/${workspace}/members`)
    ]);
    teams = teamRows.teams;
    members = memberRows.members;
  } catch {
    // Resources are decorative; the field editor falls back to free text.
  }
}

$effect(() => {
  const id = recordId;
  void id;
  void load();
});

async function saveField(key: string, value: unknown) {
  if (!detail) return;
  const previous = detail.fields[key];
  detail = { ...detail, fields: { ...detail.fields, [key]: value } };
  saving = key;
  fieldErrors = { ...fieldErrors, [key]: null };
  try {
    await recordsApi.updateRecord(recordId, {
      fields: { [key]: value },
      expectedVersion: detail.version
    });
    const refreshed = await recordsApi.getRecord(recordId);
    detail = refreshed;
  } catch (failure) {
    detail = { ...detail, fields: { ...detail.fields, [key]: previous } };
    fieldErrors = { ...fieldErrors, [key]: describeApiError(failure) };
  } finally {
    saving = null;
  }
}

async function addNote() {
  const body = noteDraft.trim();
  if (body === '') return;
  addingNote = true;
  try {
    await recordsApi.addRecordNote(recordId, body);
    noteDraft = '';
    detail = await recordsApi.getRecord(recordId);
    pushToast({ tone: 'success', title: 'Note added' });
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    addingNote = false;
  }
}

async function dispatch(item: WorkflowItemListRow) {
  try {
    await recordsApi.dispatchWorkItem(item.id);
    work = await recordsApi.listWorkItems({ recordId });
    pushToast({ tone: 'success', title: `Dispatched ${item.stateName}` });
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  }
}

async function linkRelated() {
  if (linkTarget.trim() === '' || linkKey.trim() === '') return;
  try {
    await recordsApi.linkRelated(recordId, {
      toRecordId: linkTarget.trim(),
      relationshipKey: linkKey.trim()
    });
    linkTarget = '';
    related = await recordsApi.recordRelated(recordId);
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  }
}

const activity = $derived(
  [
    ...history.map((entry) => ({ kind: 'field' as const, at: entry.createdAt, entry })),
    ...(detail?.notes ?? []).map((note) => ({ kind: 'note' as const, at: note.createdAt, note }))
  ].sort((a, b) => b.at - a.at)
);

function showValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
</script>

{#if loading}
  <div class="space-y-3 p-4 sm:p-6">
    <Skeleton class="h-10 w-64" />
    <Skeleton class="h-40 w-full" />
  </div>
{:else if error || !detail}
  <div class="p-4 sm:p-6">
    <ErrorState message={error ?? 'Record not found'} onRetry={() => void load()} />
  </div>
{:else}
  <div class="space-y-4 p-4 sm:p-6">
    <header class="space-y-1">
      <p class="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-subtle)]">
        {detail.objectTypeName}{detail.key ? ` · ${detail.key}` : ''}
      </p>
      <h1 class="text-lg font-semibold text-[var(--color-ink)]">{detail.displayName}</h1>
      <div class="flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-subtle)]">
        <Badge tone="neutral">v{detail.version}</Badge>
        {#if detail.archivedAt}<Badge tone="caution">Archived</Badge>{/if}
        <span>Updated {new Date(detail.updatedAt).toLocaleString()}</span>
      </div>
    </header>

    <Tabs {tabs} active={tab} onselect={(id) => (tab = id)} />

    {#if tab === 'overview'}
      <Card>
        <div class="grid gap-3 sm:grid-cols-2">
          {#each detail.effectiveFields as field (field.bindingId)}
            <div>
              {#if field.source === 'workflow'}
                <p class="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-ink-subtle)]">
                  Workflow overlay
                </p>
              {/if}
              <FieldInput
                config={toFieldConfig(field)}
                value={detail.fields[field.key]}
                {members}
                {teams}
                error={fieldErrors[field.key] ?? null}
                disabled={saving === field.key || Boolean(detail.archivedAt)}
                onchange={(value) => void saveField(field.key, value)}
              />
            </div>
          {/each}
        </div>
      </Card>

      {#if detail.externalIds.length > 0}
        <Card>
          <h2 class="mb-2 text-sm font-medium text-[var(--color-ink)]">External identities</h2>
          <ul class="space-y-1">
            {#each detail.externalIds as external (external.id)}
              <li class="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
                <Badge tone="neutral">{external.system}</Badge>
                <span class="font-mono">{external.externalId}</span>
                {#if external.label}<span>{external.label}</span>{/if}
              </li>
            {/each}
          </ul>
        </Card>
      {/if}
    {:else if tab === 'activity'}
      <Card>
        {#if activity.length === 0}
          <EmptyState title="No activity yet" description="Field changes and notes appear here." />
        {:else}
          <ul class="space-y-3">
            {#each activity as item (item.kind === 'field' ? item.entry.id : item.note.id)}
              {#if item.kind === 'field'}
                <li class="text-xs text-[var(--color-ink-muted)]">
                  <span class="font-medium text-[var(--color-ink)]">{item.entry.fieldName}</span>
                  changed {showValue(item.entry.previousValue)} → {showValue(item.entry.newValue)}
                  <span class="text-[var(--color-ink-subtle)]">
                    · {item.entry.actorLabel ?? item.entry.actorType} ·
                    {new Date(item.entry.createdAt).toLocaleString()}
                  </span>
                </li>
              {:else}
                <li class="text-xs text-[var(--color-ink-muted)]">
                  <span class="font-medium text-[var(--color-ink)]">
                    {item.note.authorLabel ?? item.note.authorType}
                  </span>
                  — {item.note.body}
                  <span class="text-[var(--color-ink-subtle)]">
                    · {new Date(item.note.createdAt).toLocaleString()}
                  </span>
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
        <div class="mt-4 space-y-2">
          <Textarea label="Add a record note" bind:value={noteDraft} rows={3} />
          <Button loading={addingNote} onclick={() => void addNote()}>Add note</Button>
        </div>
      </Card>
    {:else if tab === 'work'}
      <Card>
        {#if work.length === 0}
          <EmptyState
            title="Not in any workflow"
            description="Start work from the workflow board, or add participation through the API."
          />
        {:else}
          <ul class="space-y-2">
            {#each work as item (item.id)}
              <li class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] p-3">
                <div class="text-xs">
                  <p class="font-medium text-[var(--color-ink)]">{item.workflowName}</p>
                  <p class="text-[var(--color-ink-subtle)]">
                    {item.stateName} · {item.participation}{item.waitingOn ? ` · waiting on ${item.waitingOn}` : ''}
                    {item.completedAt ? ' · completed' : ''}
                  </p>
                </div>
                {#if !item.completedAt}
                  <Button size="sm" variant="secondary" onclick={() => void dispatch(item)}>
                    Dispatch
                  </Button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    {:else if tab === 'files'}
      <Card>
        {#if files.length === 0}
          <EmptyState title="No files" description="Durable evidence linked to this record appears here." />
        {:else}
          <ul class="space-y-2">
            {#each files as file (file.id)}
              <li class="flex items-center justify-between gap-2 text-xs">
                <a class="font-medium text-[var(--color-ink)] hover:text-[var(--color-accent)]" href={`/files/${file.fileId}`}>
                  {file.filename}
                </a>
                <Badge tone="neutral">{file.relationship}</Badge>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    {:else if tab === 'related'}
      <Card>
        {#if related.length === 0}
          <EmptyState title="No relationships" description="Link this record to another by relationship key." />
        {:else}
          <ul class="space-y-2">
            {#each related as entry (entry.relationshipId)}
              <li class="flex items-center gap-2 text-xs">
                <Badge tone={entry.direction === 'outgoing' ? 'accent' : 'neutral'}>{entry.label}</Badge>
                <a class="text-[var(--color-ink)] hover:text-[var(--color-accent)]" href={`/records/${entry.record.id}`}>
                  {entry.record.displayName}
                </a>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="mt-4 flex flex-wrap items-end gap-2">
          <Input label="Target record id" bind:value={linkTarget} />
          <Input label="Relationship key" bind:value={linkKey} placeholder="HAS_POLICY" />
          <Button variant="secondary" onclick={() => void linkRelated()}>Link</Button>
        </div>
      </Card>
    {:else if tab === 'history'}
      <Card>
        {#if history.length === 0}
          <EmptyState title="No field history" description="Every field change is recorded here." />
        {:else}
          <ul class="space-y-2">
            {#each history as entry (entry.id)}
              <li class="text-xs text-[var(--color-ink-muted)]">
                <span class="font-medium text-[var(--color-ink)]">{entry.fieldName}</span>:
                {showValue(entry.previousValue)} → {showValue(entry.newValue)}
                <span class="text-[var(--color-ink-subtle)]">
                  · {entry.source ?? entry.actorType} · {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    {/if}
  </div>
{/if}
