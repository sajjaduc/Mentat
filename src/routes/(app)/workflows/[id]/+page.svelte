<script lang="ts">
/**
 * Workflow workspace.
 *
 * The five work surfaces of one workflow, with the tab and the open ticket both in
 * the URL. Tab switches and filter changes use the History API rather than the
 * router: no loader re-runs, no remount, and back/forward still walk the surfaces
 * the user actually visited.
 */
import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import BoardView from '$ui/board/BoardView.svelte';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import TicketDrawer from '$ui/ticket/TicketDrawer.svelte';
import {
  emptyFilterState,
  type FilterState,
  filterAstToState,
  filterStateFromQuery,
  filterStateToQuery
} from '$ui/work/filters';
import TicketList from '$ui/work/TicketList.svelte';
import type {
  AgentOption,
  AppliedSavedView,
  Label,
  MemberOption,
  SortSpec,
  TeamOption,
  WorkflowDetailResponse,
  WorkflowFieldView
} from '$ui/work/types';
import { closeTicketInUrl, openTicketInUrl, pushQuery, replaceQuery } from '$ui/work/url';
import WorkflowActivity from '$ui/work/WorkflowActivity.svelte';
import WorkflowConfiguration from '$ui/work/WorkflowConfiguration.svelte';
import WorkflowData from '$ui/work/WorkflowData.svelte';

const TABS = ['board', 'list', 'activity', 'data', 'configuration'] as const;
type TabId = (typeof TABS)[number];

let detail = $state<WorkflowDetailResponse | null>(null);
let fieldConfig = $state<WorkflowFieldView[]>([]);
let members = $state<MemberOption[]>([]);
let teams = $state<TeamOption[]>([]);
let labels = $state<Label[]>([]);
let agents = $state<AgentOption[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let refreshKey = $state(0);

let filter = $state<FilterState>(emptyFilterState());
let lastFilterParam: string | null = null;
let sort = $state<SortSpec>({ field: 'updated', direction: 'desc' });
let columns = $state<string[]>([]);

const workflowId = $derived(page.params.id ?? '');
const workspaceId = $derived(page.data.workspace?.id ?? '');
const rawTab = $derived(page.url.searchParams.get('tab'));
const activeTab = $derived<TabId>(
  TABS.includes((rawTab ?? 'board') as TabId) ? ((rawTab ?? 'board') as TabId) : 'board'
);
const openTicketId = $derived(page.url.searchParams.get('ticket'));

const tabs = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'activity', label: 'Activity' },
  { id: 'data', label: 'Data' },
  { id: 'configuration', label: 'Configuration' }
];

const defaultColumns = $derived([
  'key',
  'title',
  'state',
  'priority',
  'owner',
  'labels',
  'updated',
  ...fieldConfig.filter((view) => view.showInList).map((view) => `field:${view.definition.key}`)
]);

const agentNames = $derived(
  Object.fromEntries(agents.map((agent) => [agent.id, agent.name])) as Record<string, string>
);

async function load(id: string) {
  loading = true;
  error = null;
  try {
    const [detailResponse, fieldResponse] = await Promise.all([
      api.get<WorkflowDetailResponse>(`/workflows/${id}`),
      api.get<{ fields: WorkflowFieldView[] }>(`/workflows/${id}/fields`)
    ]);
    detail = detailResponse;
    fieldConfig = fieldResponse.fields;
    if (columns.length === 0) columns = defaultColumns;
    void loadResources();
  } catch (failure) {
    error = describeApiError(failure);
    detail = null;
  } finally {
    loading = false;
  }
}

async function loadResources() {
  const requests: Array<Promise<unknown>> = [
    api
      .get<{ teams: TeamOption[] }>('/teams')
      .then((response) => (teams = response.teams))
      .catch(() => undefined),
    api
      .get<{ labels: Label[] }>('/labels')
      .then((response) => (labels = response.labels))
      .catch(() => undefined),
    api
      .get<{ agents: AgentOption[] }>('/agents')
      .then((response) => (agents = response.agents))
      .catch(() => undefined)
  ];
  if (workspaceId !== '') {
    requests.push(
      api
        .get<{ members: MemberOption[] }>(`/workspaces/${workspaceId}/members`)
        .then((response) => (members = response.members))
        .catch(() => undefined)
    );
  }
  await Promise.all(requests);
}

$effect(() => {
  const id = workflowId;
  if (id === '') return;
  void load(id);
});

$effect(() => {
  const raw = page.url.searchParams.get('filter');
  if (raw === lastFilterParam) return;
  lastFilterParam = raw;
  filter = filterStateFromQuery(raw);
});

function changeTab(id: string) {
  replaceQuery({ tab: id === 'board' ? null : id });
}

function changeFilter(next: FilterState) {
  filter = next;
  const serialised = filterStateToQuery(next);
  lastFilterParam = serialised;
  pushQuery({ filter: serialised });
}

function applyView(view: AppliedSavedView) {
  const next = filterAstToState(view.filter);
  changeFilter(next);
  const first = view.sort[0];
  if (first) sort = first;
  if (view.columns.length > 0) columns = view.columns;
}

function openTicket(ticketId: string) {
  openTicketInUrl(ticketId);
}

function onTransferred() {
  refreshKey += 1;
}
</script>

<div class="flex min-h-0 flex-1 flex-col">
  {#if loading && detail === null}
    <div class="space-y-3 p-6">
      <Skeleton lines={2} />
      <Skeleton lines={4} height="2rem" />
    </div>
  {:else if error}
    <div class="p-6"><ErrorState message={error} onRetry={() => load(workflowId)} /></div>
  {:else if detail}
    <header class="flex flex-wrap items-center gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <a
            href="/workflows"
            class="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-accent)]"
            >Workflows</a
          >
          <span class="text-[11px] text-[var(--color-ink-subtle)]">/</span>
          <h1 class="truncate text-base font-semibold">{detail.workflow.name}</h1>
          <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]"
            >{detail.workflow.key}</span
          >
        </div>
        {#if detail.workflow.description}
          <p class="truncate text-xs text-[var(--color-ink-subtle)]">
            {detail.workflow.description}
          </p>
        {/if}
      </div>
      <div class="ml-auto">
        <Button size="sm" variant="ghost" onclick={() => changeTab('configuration')}>
          Configure
        </Button>
      </div>
    </header>

    <div class="px-4 pt-2">
      <Tabs {tabs} active={activeTab} onselect={changeTab} />
    </div>

    {#if activeTab === 'board'}
      <BoardView
        workflow={detail.workflow}
        states={detail.states}
        {fieldConfig}
        {filter}
        {members}
        {teams}
        {labels}
        {agentNames}
        {refreshKey}
        onFilterChange={changeFilter}
        onApplyView={applyView}
        onOpenTicket={openTicket}
        onConfigure={() => changeTab('configuration')}
      />
    {:else if activeTab === 'list'}
      <TicketList
        workflow={detail.workflow}
        states={detail.states}
        {fieldConfig}
        {filter}
        {members}
        {teams}
        {labels}
        {sort}
        columns={columns.length === 0 ? defaultColumns : columns}
        {refreshKey}
        onFilterChange={changeFilter}
        onApplyView={applyView}
        onOpenTicket={openTicket}
        onSortChange={(next) => (sort = next)}
        onColumnsChange={(next) => (columns = next)}
      />
    {:else if activeTab === 'activity'}
      <WorkflowActivity workflowId={workflowId} />
    {:else if activeTab === 'data'}
      <WorkflowData workflowId={workflowId} />
    {:else}
      <WorkflowConfiguration workflowId={workflowId} {workspaceId} />
    {/if}
  {:else}
    <div class="p-6">
      <ErrorState message="Workflow not found" onRetry={() => load(workflowId)} />
    </div>
  {/if}
</div>

{#if openTicketId}
  <TicketDrawer
    ticketId={openTicketId}
    {workspaceId}
    onclose={closeTicketInUrl}
    onOpenTicket={openTicket}
    onTransferred={onTransferred}
  />
{/if}
