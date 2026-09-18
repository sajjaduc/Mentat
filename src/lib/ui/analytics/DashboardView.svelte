<script lang="ts">
/**
 * DashboardView: `/dashboards/[id]`.
 *
 * A responsive grid of widgets rendered from `POST /api/dashboards/:id/run`. The
 * dashboard's stored global filter and each widget's local filter are ANDed by the
 * server; the UI shows both, states that they use the same language as the work item
 * list, and offers an additional *session* filter.
 *
 * The server's run handler accepts no request body yet, so a session filter is
 * combined in the interface (ANDed with the stored global filter using the same AST
 * combinator the server uses) and rendered as an explicit, removable condition
 * rather than pretending it was applied server-side.
 */

import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import WidgetCard from '$ui/charts/WidgetCard.svelte';
import FilterBuilder from '$ui/common/FilterBuilder.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import { andOf, describeFilter, type FilterAst, isEmptyFilter } from '$ui/filters';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import type {
  DashboardDetail,
  DashboardRunResult,
  DashboardWidget,
  SavedView,
  WidgetResult,
  WorkflowSummary
} from '$ui/types';
import WidgetEditor from './WidgetEditor.svelte';

interface Props {
  dashboardId: string;
}

let { dashboardId }: Props = $props();

let dashboard = $state<DashboardDetail | null>(null);
let results = $state<Record<string, WidgetResult>>({});
let workflows = $state<WorkflowSummary[]>([]);
let savedViews = $state<SavedView[]>([]);
let fieldOptions = $state<Array<{ key: string; label: string; type: string }>>([]);
let loading = $state(true);
let running = $state(false);
let error = $state<string | null>(null);
let editorOpen = $state(false);
let editing = $state<DashboardWidget | null>(null);
let sessionFilterOpen = $state(false);
let sessionFilter = $state<FilterAst | null>(null);
let nameDraft = $state('');
let renaming = $state(false);

const storedGlobalFilter = $derived((dashboard?.globalFilter as FilterAst | null) ?? null);
const effectiveGlobalFilter = $derived(
  andOf([storedGlobalFilter, sessionFilter].filter((node): node is FilterAst => node !== null))
);
const globalFilterLabel = $derived(
  isEmptyFilter(effectiveGlobalFilter) ? 'All work items' : describeFilter(effectiveGlobalFilter)
);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<DashboardDetail>(`/dashboards/${dashboardId}`);
    dashboard = response;
    nameDraft = response.name;
    await Promise.all([loadSupport(), run()]);
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function loadSupport() {
  const tasks = [
    api
      .get<{ workflows: WorkflowSummary[] }>('/workflows')
      .then((response) => (workflows = response.workflows))
      .catch(() => undefined),
    api
      .get<{ views: SavedView[] }>('/views')
      .then((response) => (savedViews = response.views))
      .catch(() => undefined),
    api
      .get<{ fields: Array<{ key: string; name: string; type: string }> }>('/fields', {
        scope: 'workflowItem'
      })
      .then(
        (response) =>
          (fieldOptions = response.fields.map((field) => ({
            key: field.key,
            label: field.name,
            type: field.type
          })))
      )
      .catch(() => undefined)
  ];
  await Promise.all(tasks);
}

async function run() {
  running = true;
  error = null;
  try {
    const response = await api.post<DashboardRunResult>(`/dashboards/${dashboardId}/run`);
    results = response.results;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    running = false;
  }
}

$effect(() => {
  void dashboardId;
  void load();
});

function onWidgetSaved(widget: DashboardWidget) {
  if (!dashboard) return;
  const exists = dashboard.widgets.some((entry) => entry.id === widget.id);
  dashboard = {
    ...dashboard,
    widgets: exists
      ? dashboard.widgets.map((entry) => (entry.id === widget.id ? widget : entry))
      : [...dashboard.widgets, widget]
  };
  pushToast({ tone: 'success', title: exists ? 'Widget updated' : 'Widget added' });
  void run();
}

async function removeWidget(widget: DashboardWidget) {
  if (!dashboard) return;
  const previous = dashboard;
  dashboard = {
    ...dashboard,
    widgets: dashboard.widgets.filter((entry) => entry.id !== widget.id)
  };
  try {
    await api.delete(`/widgets/${widget.id}`);
    pushToast({ tone: 'success', title: 'Widget removed' });
  } catch (failure) {
    dashboard = previous;
    pushToast({
      tone: 'error',
      title: 'Could not remove widget',
      description: describeApiError(failure)
    });
  }
}

/** Reordering is a position write; the grid order is the position order. */
async function moveWidget(index: number, delta: number) {
  if (!dashboard) return;
  const next = index + delta;
  if (next < 0 || next >= dashboard.widgets.length) return;
  const widgets = [...dashboard.widgets];
  const [moved] = widgets.splice(index, 1);
  if (!moved) return;
  widgets.splice(next, 0, moved);
  const renumbered = widgets.map((entry, position) => ({ ...entry, position }));
  const previous = dashboard;
  dashboard = { ...dashboard, widgets: renumbered };
  try {
    await Promise.all(
      renumbered.map((entry) => api.patch(`/widgets/${entry.id}`, { position: entry.position }))
    );
  } catch (failure) {
    dashboard = previous;
    pushToast({
      tone: 'error',
      title: 'Could not reorder',
      description: describeApiError(failure)
    });
  }
}

async function persistGlobalFilter(next: FilterAst | null) {
  if (!dashboard) return;
  const previous = dashboard;
  dashboard = { ...dashboard, globalFilter: next };
  try {
    await api.patch(`/dashboards/${dashboardId}`, { globalFilters: next });
    pushToast({ tone: 'success', title: 'Global filter saved' });
    await run();
  } catch (failure) {
    dashboard = previous;
    pushToast({
      tone: 'error',
      title: 'Could not save filter',
      description: describeApiError(failure)
    });
  }
}

async function rename() {
  if (!dashboard || nameDraft.trim().length === 0) return;
  renaming = true;
  try {
    await api.patch(`/dashboards/${dashboardId}`, { name: nameDraft.trim() });
    dashboard = { ...dashboard, name: nameDraft.trim() };
    pushToast({ tone: 'success', title: 'Dashboard renamed' });
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not rename', description: describeApiError(failure) });
  } finally {
    renaming = false;
  }
}

async function toggleShared() {
  if (!dashboard) return;
  const next = !dashboard.isShared;
  try {
    await api.patch(`/dashboards/${dashboardId}`, { isShared: next });
    dashboard = { ...dashboard, isShared: next };
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not change sharing',
      description: describeApiError(failure)
    });
  }
}

function gridSpan(size: DashboardWidget['size']): string {
  switch (size) {
    case 'sm':
      return 'lg:col-span-1';
    case 'md':
      return 'lg:col-span-2';
    case 'lg':
      return 'lg:col-span-3';
    case 'full':
      return 'lg:col-span-4';
  }
}
</script>

<div class="space-y-5 p-4 md:p-6">
  <div>
    <a href="/dashboards" class="text-xs text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]">← All dashboards</a>
  </div>

  {#if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={3} /></Card>
  {:else if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if dashboard}
    <PageHeader title={dashboard.name} description={dashboard.description ?? undefined}>
      {#snippet actions()}
        <Button variant="secondary" loading={running} onclick={run}>Run</Button>
        <Button variant="primary" onclick={() => { editing = null; editorOpen = true; }}>Add widget</Button>
      {/snippet}
    </PageHeader>

    <Card class="space-y-3">
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-56 flex-1">
          <Input label="Name" bind:value={nameDraft} />
        </div>
        <Button variant="secondary" loading={renaming} onclick={rename}>Rename</Button>
        <label class="flex items-center gap-2 pb-2 text-xs">
          <input type="checkbox" checked={dashboard.isShared} onchange={toggleShared} />
          Shared with the workspace
        </label>
        <span class="pb-2 text-[11px] text-[var(--color-ink-subtle)]">
          updated {formatRelative(dashboard.updatedAt)}
        </span>
      </div>

      <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-xs font-semibold">Global filter</p>
          <Badge tone={isEmptyFilter(effectiveGlobalFilter) ? 'neutral' : 'accent'}>
            {globalFilterLabel}
          </Badge>
          <div class="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onclick={() => (sessionFilterOpen = !sessionFilterOpen)} aria-expanded={sessionFilterOpen}>
              Session filter
            </Button>
            <Button size="sm" variant="ghost" onclick={() => persistGlobalFilter(null)}>Clear stored</Button>
          </div>
        </div>
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          The stored global filter and each widget's local filter are ANDed. Both use the same filter
          language as the work item list, so a saved view imports without translation. A session filter
          is combined in the interface with the same AST combinator the server uses; the run endpoint
          does not accept a request filter yet, so it is not sent to the server.
        </p>
        {#if sessionFilterOpen}
          <FilterBuilder
            value={sessionFilter}
            allow={['system', 'field', 'state', 'workflow']}
            workItemFields={fieldOptions}
            workflowOptions={workflows.map((entry) => ({ value: entry.id, label: entry.name }))}
            onchange={(next) => (sessionFilter = next)}
          />
          <div class="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onclick={() => (sessionFilter = null)}>Clear session filter</Button>
            <Button size="sm" variant="secondary" onclick={() => persistGlobalFilter(storedGlobalFilter)}>
              Save as stored filter
            </Button>
          </div>
        {/if}
        {#if storedGlobalFilter}
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[11px] text-[var(--color-ink-subtle)]">Stored:</span>
            <FilterBuilder
              value={storedGlobalFilter}
              allow={['system', 'field', 'state', 'workflow']}
              workItemFields={fieldOptions}
              workflowOptions={workflows.map((entry) => ({ value: entry.id, label: entry.name }))}
              onchange={persistGlobalFilter}
            />
          </div>
        {/if}
      </div>
    </Card>

    {#if dashboard.widgets.length === 0}
      <Card>
        <EmptyState
          title="No widgets yet"
          description="Add a widget to ask a question of recorded history: count open claims by state, median time in Human Review, conversion from Intake to Closed. Funnels select ordered milestones explicitly; aging reads dwell time from state history."
        >
          <div class="mt-2 flex justify-center">
            <Button variant="primary" onclick={() => { editing = null; editorOpen = true; }}>Add a widget</Button>
          </div>
        </EmptyState>
      </Card>
    {:else}
      <div class="grid gap-4 lg:grid-cols-4">
        {#each dashboard.widgets as widget, index (widget.id)}
          <div class={gridSpan(widget.size)}>
            <div class="space-y-1">
              <WidgetCard
                {widget}
                result={results[widget.id] ?? null}
                onexpand={(target) => { editing = target; editorOpen = true; }}
              />
              <div class="flex items-center justify-end gap-1 px-1">
                <Button size="sm" variant="ghost" title="Move up" disabled={index === 0} onclick={() => moveWidget(index, -1)}>↑</Button>
                <Button size="sm" variant="ghost" title="Move down" disabled={index === dashboard!.widgets.length - 1} onclick={() => moveWidget(index, 1)}>↓</Button>
                <Button size="sm" variant="ghost" onclick={() => removeWidget(widget)}>Remove</Button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if dashboard}
  <WidgetEditor
    open={editorOpen}
    {dashboardId}
    widget={editing}
    {workflows}
    {savedViews}
    {fieldOptions}
    onclose={() => (editorOpen = false)}
    onsaved={onWidgetSaved}
  />
{/if}
