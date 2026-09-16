<script lang="ts">
/**
 * TriggerList: the triggers that belong to a workspace, with their live state.
 *
 * This is a component rather than a route because triggers are one block of the
 * Integrations overview. It owns its own loading, its optimistic enabled toggle and
 * the editor drawer, so the page around it stays a summary.
 */

import { formatDateTime, formatNumber, formatRelative, truncate } from '$shared/format';
import { api, describeApiError, mutateOptimistic } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import CopyButton from '$ui/http/controls/CopyButton.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import Drawer from '$ui/primitives/Drawer.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import TriggerEditor from './TriggerEditor.svelte';
import {
  TRIGGER_TYPE_LABELS,
  type TriggerView,
  type WorkflowOption,
  type WorkflowStateOption
} from './types';

interface Props {
  class?: string;
}

let { class: className = '' }: Props = $props();

let triggers = $state<TriggerView[] | null>(null);
let workflows = $state<WorkflowOption[]>([]);
let stateNames = $state<Record<string, string>>({});
let error = $state<string | null>(null);
let loading = $state(true);
let editorOpen = $state(false);
let editing = $state<TriggerView | null>(null);
let editorKey = $state(0);

function shortId(id: string): string {
  return truncate(id, 10);
}

async function loadStateNames(workflowIds: string[]) {
  const pending = [...new Set(workflowIds)].filter((id) => stateNames[id] === undefined);
  if (pending.length === 0) return;
  const results = await Promise.all(
    pending.map(async (id) => {
      try {
        return await api.get<{ states: WorkflowStateOption[] }>(`/api/workflows/${id}`);
      } catch {
        // State names are supplementary; the row still shows the raw id.
        return null;
      }
    })
  );
  const next = { ...stateNames };
  for (const result of results) {
    if (!result) continue;
    for (const state of result.states) next[state.id] = state.name;
  }
  stateNames = next;
}

async function load() {
  loading = true;
  error = null;
  try {
    const [triggerResult, workflowResult] = await Promise.all([
      api.get<{ triggers: TriggerView[] }>('/api/triggers'),
      api.get<{ workflows: WorkflowOption[] }>('/api/workflows')
    ]);
    triggers = triggerResult.triggers;
    workflows = workflowResult.workflows;
    void loadStateNames(triggerResult.triggers.map((row) => row.workflowId));
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

function replace(updated: TriggerView) {
  triggers = (triggers ?? []).map((row) => (row.id === updated.id ? updated : row));
}

async function toggleEnabled(row: TriggerView) {
  const next = !row.enabled;
  await mutateOptimistic(
    () => api.patch<{ trigger: TriggerView }>(`/api/triggers/${row.id}`, { enabled: next }),
    {
      optimistic: () => {
        const previous = triggers;
        triggers = (triggers ?? []).map((entry) =>
          entry.id === row.id ? { ...entry, enabled: next } : entry
        );
        return () => {
          triggers = previous;
        };
      },
      onSuccess: (result) => replace(result.trigger),
      onError: (failure) => {
        pushToast({
          tone: 'error',
          title: 'Could not change the trigger',
          description: failure.message
        });
      }
    }
  );
}

async function archive(row: TriggerView) {
  try {
    await api.delete(`/api/triggers/${row.id}`);
    triggers = (triggers ?? []).filter((entry) => entry.id !== row.id);
    pushToast({ tone: 'success', title: 'Trigger archived', description: row.name });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not archive the trigger',
      description: describeApiError(failure)
    });
  }
}

function openEditor(row: TriggerView | null) {
  editing = row;
  editorKey += 1;
  editorOpen = true;
}

function closeEditor() {
  editorOpen = false;
  editing = null;
}

function onSaved(updated: TriggerView) {
  const exists = (triggers ?? []).some((row) => row.id === updated.id);
  triggers = exists
    ? (triggers ?? []).map((row) => (row.id === updated.id ? updated : row))
    : [...(triggers ?? []), updated];
  void loadStateNames([updated.workflowId]);
  closeEditor();
}

function workflowLabel(row: TriggerView): string {
  return (
    workflows.find((workflow) => workflow.id === row.workflowId)?.name ?? shortId(row.workflowId)
  );
}

function stateLabel(row: TriggerView): string {
  const stateId = row.targetStateId;
  if (!stateId) return 'Workflow default';
  return stateNames[stateId] ?? shortId(stateId);
}

function webhookUrl(row: TriggerView): string | null {
  if (row.type !== 'webhook' || row.webhookToken === null) return null;
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return origin.length > 0 ? `${origin}/api/webhooks/${row.webhookToken}` : null;
}
</script>

<div class="space-y-4 {className}">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <p class="text-sm font-semibold text-[var(--color-ink)]">Triggers</p>
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Webhooks, schedules and on-demand entry points that turn an inbound signal into a ticket.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Button size="sm" variant="ghost" loading={loading} onclick={load}>Refresh</Button>
      <Button size="sm" variant="primary" onclick={() => openEditor(null)}>New trigger</Button>
    </div>
  </div>

  {#if loading && triggers === null}
    <div class="space-y-2">
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else if triggers === null || triggers.length === 0}
    <EmptyState
      title="No triggers yet"
      description="Add a webhook to accept an external payload, a schedule to start work on a cadence, or a manual trigger for people and API callers."
    >
      <Button size="sm" variant="primary" onclick={() => openEditor(null)}>Create a trigger</Button>
    </EmptyState>
  {:else}
    <ul class="space-y-3">
      {#each triggers as row (row.id)}
        <li>
          <Card padding="md" class="space-y-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <p class="truncate text-sm font-medium text-[var(--color-ink)]">{row.name}</p>
                  <Badge tone="neutral">{TRIGGER_TYPE_LABELS[row.type]}</Badge>
                  <Badge tone={row.enabled ? 'positive' : 'muted'} dot>
                    {row.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </div>
                {#if row.description}
                  <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">{row.description}</p>
                {/if}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  {workflowLabel(row)} · {stateLabel(row)} · fired {formatNumber(row.fireCount)}×
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={row.enabled}
                  aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.name}`}
                  class="inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors
                    {row.enabled
                      ? 'border-transparent bg-[var(--color-accent)]'
                      : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)]'}"
                  onclick={() => toggleEnabled(row)}
                >
                  <span
                    class="h-3.5 w-3.5 rounded-full bg-[var(--color-surface)] shadow-[var(--shadow-card)] transition-transform
                      {row.enabled ? 'translate-x-4' : 'translate-x-0.5'}"
                  ></span>
                </button>
                <Button size="sm" variant="secondary" onclick={() => openEditor(row)}>Edit</Button>
                <ConfirmButton
                  label="Archive"
                  confirmLabel="Archive trigger"
                  onconfirm={() => archive(row)}
                />
              </div>
            </div>

            <dl class="grid gap-3 text-xs sm:grid-cols-3">
              <div class="space-y-0.5">
                <dt class="text-[11px] text-[var(--color-ink-subtle)]">Last fired</dt>
                <dd class="text-[var(--color-ink-muted)]">
                  {formatDateTime(row.lastFiredAt)}
                  {#if row.lastFiredAt !== null}
                    <span class="text-[var(--color-ink-subtle)]">· {formatRelative(row.lastFiredAt)}</span>
                  {/if}
                </dd>
              </div>
              <div class="space-y-0.5">
                <dt class="text-[11px] text-[var(--color-ink-subtle)]">Next run</dt>
                <dd class="text-[var(--color-ink-muted)]">
                  {row.type === 'cron' ? formatDateTime(row.nextRunAt) : 'Not scheduled'}
                </dd>
              </div>
              <div class="space-y-0.5">
                <dt class="text-[11px] text-[var(--color-ink-subtle)]">Deliveries</dt>
                <dd class="text-[var(--color-ink-muted)]">{formatNumber(row.fireCount)}</dd>
              </div>
            </dl>

            {#if row.lastError}
              <p class="rounded-[var(--radius-sm)] bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)] px-2 py-1.5 text-xs text-[var(--color-danger)]">
                Last error: {truncate(row.lastError, 240)}
              </p>
            {/if}

            {#if row.type === 'webhook'}
              {@const url = webhookUrl(row)}
              {#if url}
                <div class="flex flex-wrap items-center gap-2">
                  <code class="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-ink-muted)]">{url}</code>
                  <CopyButton text={url} label="Copy URL" />
                </div>
              {:else}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  Webhook URL appears once the page knows its origin.
                </p>
              {/if}
            {/if}
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Drawer
  open={editorOpen}
  title={editing ? `Edit ${editing.name}` : 'New trigger'}
  subtitle={editing ? TRIGGER_TYPE_LABELS[editing.type] : 'Choose a workflow and a type'}
  width="46rem"
  onclose={closeEditor}
>
  {#key editorKey}
    <div class="p-4 md:p-6">
      <TriggerEditor trigger={editing} {workflows} onsaved={onSaved} oncancel={closeEditor} />
    </div>
  {/key}
</Drawer>
