<script lang="ts">
/**
 * DashboardIndex: `/dashboards`.
 *
 * A dashboard is a named, shareable collection of declarative widgets. This index
 * lists what exists, who can see it, and the fastest path to creating one.
 */

import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/common/PageHeader.svelte';
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
import type { Dashboard, DashboardDetail } from '$ui/types';

/**
 * `GET /api/dashboards` does not include widget counts, so each dashboard is
 * fetched once to show a real count rather than an invented or omitted one.
 */
let dashboards = $state<Array<Dashboard & { widgetCount: number | null }>>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let createOpen = $state(false);
let creating = $state(false);
let name = $state('');
let description = $state('');
let shared = $state(true);
let formError = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ dashboards: Dashboard[] }>('/dashboards');
    dashboards = response.dashboards.map((dashboard) => ({ ...dashboard, widgetCount: null }));
    await loadCounts();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

/**
 * Widget counts are not part of the list response, so each dashboard is fetched to
 * get them. This is bounded by the number of dashboards and keeps the index honest
 * rather than showing a count the API never produced.
 */
async function loadCounts() {
  const results = await Promise.all(
    dashboards.map(async (dashboard) => {
      try {
        const detail = await api.get<DashboardDetail>(`/dashboards/${dashboard.id}`);
        return { id: dashboard.id, count: detail.widgets.length };
      } catch {
        return { id: dashboard.id, count: null };
      }
    })
  );
  const counts = new Map(results.map((entry) => [entry.id, entry.count]));
  dashboards = dashboards.map((dashboard) => ({
    ...dashboard,
    widgetCount: counts.get(dashboard.id) ?? null
  }));
}

$effect(() => {
  void load();
});

async function create() {
  if (name.trim().length === 0) {
    formError = 'A dashboard needs a name.';
    return;
  }
  creating = true;
  formError = null;
  try {
    const response = await api.post<{ dashboard: Dashboard }>('/dashboards', {
      name: name.trim(),
      description: description.trim() || null,
      isShared: shared
    });
    pushToast({ tone: 'success', title: `Created "${name.trim()}"` });
    createOpen = false;
    name = '';
    description = '';
    window.location.href = `/dashboards/${response.dashboard.id}`;
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    creating = false;
  }
}

async function remove(dashboard: Dashboard) {
  try {
    await api.delete(`/dashboards/${dashboard.id}`);
    dashboards = dashboards.filter((entry) => entry.id !== dashboard.id);
    pushToast({ tone: 'success', title: `Deleted "${dashboard.name}"` });
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not delete', description: describeApiError(failure) });
  }
}
</script>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Dashboards"
    eyebrow="Platform"
    description="Widgets declare a data source, filter, measure, grouping and time range. Every number is derived from recorded history, and the filter language is the same one the ticket list uses."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={() => (createOpen = true)}>New dashboard</Button>
    {/snippet}
  </PageHeader>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each [0, 1, 2] as index (index)}
        <Card class="space-y-3"><Skeleton height="1rem" /><Skeleton lines={2} /></Card>
      {/each}
    </div>
  {:else if dashboards.length === 0}
    <Card>
      <EmptyState
        title="No dashboards yet"
        description="Build a dashboard from widgets: pick a workflow, a measure such as count or median duration, a grouping, and a time range. Funnels select ordered milestones explicitly; aging reads time-in-state from history."
      >
        <div class="mt-2 flex justify-center">
          <Button variant="primary" onclick={() => (createOpen = true)}>Create a dashboard</Button>
        </div>
      </EmptyState>
    </Card>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each dashboards as dashboard (dashboard.id)}
        <Card interactive class="space-y-2">
          <div class="flex items-start justify-between gap-2">
            <a href={`/dashboards/${dashboard.id}`} class="min-w-0">
              <p class="truncate text-sm font-semibold hover:underline">{dashboard.name}</p>
              <p class="line-clamp-2 text-xs text-[var(--color-ink-muted)]">
                {dashboard.description ?? 'No description.'}
              </p>
            </a>
            {#if dashboard.isDefault}<Badge tone="accent">default</Badge>{/if}
          </div>
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-subtle)]">
            <span>
              {dashboard.widgetCount === null ? 'widgets unknown' : `${dashboard.widgetCount} widget(s)`}
            </span>
            <span>·</span>
            <span>{dashboard.isShared ? 'shared with workspace' : 'private'}</span>
            <span>·</span>
            <span>updated {formatRelative(dashboard.updatedAt)}</span>
          </div>
          <div class="flex justify-end gap-1.5">
            <a
              href={`/dashboards/${dashboard.id}`}
              class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
            >
              Open
            </a>
            <Button size="sm" variant="ghost" onclick={() => remove(dashboard)}>Delete</Button>
          </div>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<Modal
  open={createOpen}
  title="New dashboard"
  description="A dashboard groups widgets and applies its own global filter on top of each widget's local filter. Both use the shared filter AST."
  onclose={() => (createOpen = false)}
>
  <div class="space-y-3">
    <Input label="Name" bind:value={name} placeholder="Claims operations" />
    <Textarea label="Description" bind:value={description} rows={3} placeholder="Optional" />
    <label class="flex items-center gap-2 text-xs">
      <input type="checkbox" bind:checked={shared} />
      Share with the workspace
    </label>
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={creating} onclick={create}>Create dashboard</Button>
    </div>
  </div>
</Modal>
