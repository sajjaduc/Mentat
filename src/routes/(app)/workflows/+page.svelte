<script lang="ts">
/**
 * Workflows index.
 *
 * A workflow is both a project and a state machine, so the index shows the two
 * numbers that say whether it is alive: tickets and states. Creating one starts
 * from a template and lands directly on its board, because an empty configuration
 * screen is a worse first impression than a working board.
 */
import { goto } from '$app/navigation';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import type { WorkflowDetailResponse, WorkflowListItem, WorkflowTemplate } from '$ui/work/types';

let workflows = $state<WorkflowListItem[] | null>(null);
let templates = $state<WorkflowTemplate[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let includeArchived = $state(false);

let createOpen = $state(false);
let creating = $state(false);
let createError = $state<string | null>(null);
let draft = $state({
  name: '',
  key: '',
  description: '',
  template: 'basic' as WorkflowTemplate['key']
});

async function load() {
  loading = true;
  error = null;
  try {
    const [workflowResponse, templateResponse] = await Promise.all([
      api.get<{ workflows: WorkflowListItem[] }>('/api/workflows', { includeArchived }),
      api.get<{ templates: WorkflowTemplate[] }>('/api/workflow-templates')
    ]);
    workflows = workflowResponse.workflows;
    templates = templateResponse.templates;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function create() {
  const name = draft.name.trim();
  if (name === '') return;
  creating = true;
  createError = null;
  try {
    const response = await api.post<WorkflowDetailResponse>('/api/workflows', {
      name,
      key: draft.key.trim() === '' ? undefined : draft.key.trim(),
      description: draft.description.trim() === '' ? undefined : draft.description.trim(),
      template: draft.template
    });
    await goto(`/workflows/${response.workflow.id}?tab=board`);
  } catch (failure) {
    createError = describeApiError(failure);
  } finally {
    creating = false;
  }
}

async function archive(workflow: WorkflowListItem) {
  try {
    await api.delete(`/api/workflows/${workflow.id}`);
    workflows = (workflows ?? []).filter((entry) => entry.id !== workflow.id);
    pushToast({ tone: 'success', title: `${workflow.name} archived` });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not archive',
      description: describeApiError(failure)
    });
  }
}

load();
</script>

<div class="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
  <header class="mb-5 flex flex-wrap items-center gap-3">
    <div>
      <h1 class="text-lg font-semibold">Workflows</h1>
      <p class="text-xs text-[var(--color-ink-subtle)]">
        Each workflow is a project and a state machine: tickets move through states where humans,
        agents or deterministic actions do the work.
      </p>
    </div>
    <div class="ml-auto flex items-center gap-2">
      <label class="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
        <input type="checkbox" bind:checked={includeArchived} onchange={load} />
        Show archived
      </label>
      <Button variant="primary" onclick={() => (createOpen = true)}>Create workflow</Button>
    </div>
  </header>

  {#if loading && workflows === null}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each [0, 1, 2] as index (index)}
        <Card><Skeleton lines={3} /></Card>
      {/each}
    </div>
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else if !workflows || workflows.length === 0}
    <EmptyState
      title="No workflows yet"
      description="A workflow is where work lives. Pick a template to get states, transitions and a board in one step."
    >
      <Button variant="primary" onclick={() => (createOpen = true)}>Create from template</Button>
    </EmptyState>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each workflows as workflow (workflow.id)}
        <Card interactive={true}>
          <a
            href={`/workflows/${workflow.id}?tab=board`}
            class="block"
            data-testid="workflow-card"
          >
            <div class="flex items-start gap-2">
              <span
                class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                style="background-color:{workflow.color ?? 'var(--color-accent)'}"
                aria-hidden="true"
              ></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h2 class="truncate text-sm font-semibold">{workflow.name}</h2>
                  {#if workflow.archivedAt}<Badge tone="muted">Archived</Badge>{/if}
                </div>
                <p class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{workflow.key}</p>
                {#if workflow.description}
                  <p class="mt-1 line-clamp-2 text-xs text-[var(--color-ink-subtle)]">
                    {workflow.description}
                  </p>
                {/if}
              </div>
            </div>
            <div class="mt-3 flex items-center gap-3 text-[11px] text-[var(--color-ink-muted)]">
              <span><span class="font-mono">{workflow.ticketCount}</span> tickets</span>
              <span><span class="font-mono">{workflow.stateCount}</span> states</span>
            </div>
          </a>
          {#if !workflow.archivedAt}
            <div class="mt-2 flex justify-end">
              <Button size="sm" variant="ghost" onclick={() => archive(workflow)}>Archive</Button>
            </div>
          {/if}
        </Card>
      {/each}
    </div>
  {/if}
</div>

<Modal
  open={createOpen}
  title="Create a workflow"
  description="Choose a template. You can change every state, field and transition afterwards."
  width="38rem"
  onclose={() => (createOpen = false)}
>
  <div class="space-y-4">
    <Input value={draft.name} oninput={(event) => (draft.name = (event.currentTarget as HTMLInputElement).value)} label="Name" placeholder="Claims" />
    <Input value={draft.key} oninput={(event) => (draft.key = (event.currentTarget as HTMLInputElement).value)} label="Key" placeholder="CLAIM" hint="Used for ticket keys; generated when empty." />
    <Textarea value={draft.description} oninput={(event) => (draft.description = (event.currentTarget as HTMLTextAreaElement).value)} label="Description" rows={2} />

    <fieldset class="space-y-2">
      <legend class="text-xs font-medium text-[var(--color-ink-muted)]">Template</legend>
      {#if templates.length === 0}
        <Skeleton lines={3} />
      {/if}
      {#each templates as template (template.key)}
        <label
          class="flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border p-2.5 transition-colors
            {draft.template === template.key
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40'
            : 'border-[var(--color-border-subtle)] hover:border-[var(--color-border-strong)]'}"
        >
          <input
            type="radio"
            name="template"
            value={template.key}
            checked={draft.template === template.key}
            onchange={() => (draft.template = template.key)}
            class="mt-1"
          />
          <span class="min-w-0">
            <span class="flex items-center gap-2">
              <span class="text-sm font-medium">{template.label}</span>
              <Badge tone="muted">{template.stateCount} states</Badge>
            </span>
            <span class="block text-xs text-[var(--color-ink-subtle)]">{template.description}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    {#if createError}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{createError}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
    <Button
      variant="primary"
      loading={creating}
      disabled={draft.name.trim() === ''}
      onclick={create}
    >
      Create and open board
    </Button>
  {/snippet}
</Modal>
