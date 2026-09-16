<script lang="ts">
/**
 * Agents index.
 *
 * Lists every agent with the run statistics the list endpoint already computes.
 * The bound-state column has no endpoint of its own, so it is assembled from each
 * workflow's states and degrades to an em dash — per agent — when a workflow cannot
 * be read, rather than failing the page.
 */
import { goto } from '$app/navigation';
import { formatNumber, formatRelative, pluralize, truncate } from '$shared/format';
import type { AgentView, Model, Provider, WorkflowOption } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';

type CountsState = 'loading' | 'ready' | 'partial';

interface WorkflowStateRow {
  id: string;
  agentId: string | null;
}

let agents = $state<AgentView[] | null>(null);
let error = $state<string | null>(null);
let loading = $state(true);

let workflows = $state<WorkflowOption[]>([]);
let modelLabels = $state(new Map<string, string>());
let boundCounts = $state(new Map<string, number | null>());
let countsState = $state<CountsState>('loading');

let createOpen = $state(false);
let createName = $state('');
let createDescription = $state('');
let createWorkflowId = $state('');
let creating = $state(false);
let createError = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const result = await api.get<{ agents: AgentView[] }>('/api/agents');
    agents = result.agents;
    loading = false;
    void loadSupporting(result.agents);
  } catch (failure) {
    error = describeApiError(failure);
    loading = false;
  }
}

$effect(() => {
  void load();
});

async function loadSupporting(agentList: AgentView[]) {
  countsState = 'loading';
  const [modelResult, providerResult, workflowResult] = await Promise.allSettled([
    api.get<{ models: Model[] }>('/api/models'),
    api.get<{ providers: Provider[] }>('/api/providers'),
    api.get<{ workflows: WorkflowOption[] }>('/api/workflows')
  ]);

  if (modelResult.status === 'fulfilled' && providerResult.status === 'fulfilled') {
    modelLabels = buildModelLabels(modelResult.value.models, providerResult.value.providers);
  }

  if (workflowResult.status !== 'fulfilled') {
    boundCounts = new Map(agentList.map((agent) => [agent.id, null]));
    countsState = 'partial';
    return;
  }

  workflows = workflowResult.value.workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    key: workflow.key
  }));
  const derived = await deriveBoundCounts(workflows, agentList);
  boundCounts = derived.counts;
  countsState = derived.failedWorkflows > 0 ? 'partial' : 'ready';
}

function buildModelLabels(modelList: Model[], providerList: Provider[]): Map<string, string> {
  const providerNames = new Map(providerList.map((provider) => [provider.id, provider.name]));
  const labels = new Map<string, string>();
  for (const model of modelList) {
    const providerName = providerNames.get(model.providerId);
    labels.set(
      model.id,
      providerName === undefined ? model.displayName : `${providerName} · ${model.displayName}`
    );
  }
  return labels;
}

async function deriveBoundCounts(
  workflowList: WorkflowOption[],
  agentList: AgentView[]
): Promise<{ counts: Map<string, number | null>; failedWorkflows: number }> {
  const results = await Promise.allSettled(
    workflowList.map((workflow) =>
      api.get<{ states: WorkflowStateRow[] }>(`/api/workflows/${workflow.id}`)
    )
  );

  const totals = new Map<string, number>();
  const failed = new Set<string>();
  results.forEach((result, index) => {
    const workflow = workflowList[index];
    if (workflow === undefined) return;
    if (result.status === 'fulfilled') {
      for (const state of result.value.states) {
        if (state.agentId === null) continue;
        totals.set(state.agentId, (totals.get(state.agentId) ?? 0) + 1);
      }
    } else {
      failed.add(workflow.id);
    }
  });

  const counts = new Map<string, number | null>();
  for (const agent of agentList) {
    const scope = agent.workflowId;
    const known = scope === null ? failed.size === 0 : !failed.has(scope);
    counts.set(agent.id, known ? (totals.get(agent.id) ?? 0) : null);
  }
  return { counts, failedWorkflows: failed.size };
}

function modelLabel(agent: AgentView): string {
  if (agent.modelId === null) return 'Provider default';
  return modelLabels.get(agent.modelId) ?? agent.modelId;
}

function workflowName(id: string | null): string {
  if (id === null) return 'Workspace common';
  return workflows.find((workflow) => workflow.id === id)?.name ?? 'Workflow-scoped';
}

function boundStateCount(agent: AgentView): number | null {
  const count = boundCounts.get(agent.id);
  return count === undefined ? null : count;
}

const scopeOptions = $derived([
  { value: '', label: 'Workspace common (any workflow)' },
  ...workflows.map((workflow) => ({
    value: workflow.id,
    label: `${workflow.name} (${workflow.key})`
  }))
]);

function openCreate() {
  createName = '';
  createDescription = '';
  createWorkflowId = '';
  createError = null;
  createOpen = true;
}

async function submitCreate(event: SubmitEvent) {
  event.preventDefault();
  if (createName.trim().length === 0) {
    createError = 'Give the agent a name.';
    return;
  }
  creating = true;
  createError = null;
  try {
    const created = await api.post<{ agent: AgentView }>('/api/agents', {
      name: createName.trim(),
      description: createDescription.trim().length > 0 ? createDescription.trim() : null,
      workflowId: createWorkflowId === '' ? null : createWorkflowId
    });
    createOpen = false;
    await goto(`/agents/${created.agent.id}`);
  } catch (failure) {
    createError = describeApiError(failure);
  } finally {
    creating = false;
  }
}
</script>

<svelte:head><title>Agents · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Agents"
    description="Reusable AI workers. Each agent pins an immutable version, references skills and tools, and holds only the permissions it was explicitly granted."
  >
    {#snippet actions()}
      <Button variant="ghost" onclick={load} disabled={loading}>Refresh</Button>
      <Button variant="primary" onclick={openCreate}>New agent</Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <Card>
      <Skeleton lines={6} height="1.5rem" />
    </Card>
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else if agents === null || agents.length === 0}
    <Card padding="none">
      <EmptyState
        title="No agents yet"
        description="Create an agent, choose a provider and model, then grant it the skills, tools and capabilities it needs. Bind it to a workflow state once it is configured."
      >
        <Button variant="primary" onclick={openCreate}>Create the first agent</Button>
      </EmptyState>
    </Card>
  {:else}
    {#if countsState === 'partial'}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        Some bound-state counts could not be derived; those rows show an em dash.
      </p>
    {/if}

    <Card padding="none">
      <div class="scrollbar-thin overflow-x-auto">
        <table class="w-full min-w-[46rem] border-collapse text-left">
          <thead>
            <tr
              class="border-b border-[var(--color-border-subtle)] text-[11px] tracking-wider text-[var(--color-ink-subtle)] uppercase"
            >
              <th scope="col" class="px-4 py-2.5 font-medium">Agent</th>
              <th scope="col" class="px-4 py-2.5 font-medium">Model</th>
              <th scope="col" class="px-4 py-2.5 font-medium">Bound states</th>
              <th scope="col" class="px-4 py-2.5 font-medium">Runs</th>
              <th scope="col" class="px-4 py-2.5 font-medium">Failures</th>
              <th scope="col" class="px-4 py-2.5 font-medium">Last run</th>
            </tr>
          </thead>
          <tbody>
            {#each agents as agent (agent.id)}
              {@const bound = boundStateCount(agent)}
              {@const stats = agent.stats ?? { runs: 0, failures: 0, lastRunAt: null }}
              <tr
                class="border-b border-[var(--color-border-subtle)] transition-colors last:border-0 hover:bg-[var(--color-surface-muted)]"
              >
                <td class="px-4 py-3">
                  <a
                    href={`/agents/${agent.id}`}
                    class="text-sm font-medium text-[var(--color-ink)] transition-colors hover:text-[var(--color-accent)]"
                  >
                    {agent.name}
                  </a>
                  {#if agent.description !== null}
                    <p class="mt-0.5 max-w-md text-xs text-[var(--color-ink-subtle)]">
                      {truncate(agent.description, 110)}
                    </p>
                  {/if}
                  <p class="mt-0.5 text-[11px] text-[var(--color-ink-subtle)]">
                    v{agent.currentVersion} · {workflowName(agent.workflowId)}
                  </p>
                </td>
                <td class="px-4 py-3">
                  <span class="font-mono text-xs text-[var(--color-ink-muted)]">
                    {modelLabel(agent)}
                  </span>
                </td>
                <td class="px-4 py-3 text-sm text-[var(--color-ink-muted)]">
                  {#if countsState === 'loading'}
                    <span class="text-[var(--color-ink-subtle)]">…</span>
                  {:else if bound === null}
                    <span
                      class="text-[var(--color-ink-subtle)]"
                      title="The state list for at least one workflow could not be read"
                    >
                      —
                    </span>
                  {:else}
                    {pluralize(bound, 'state')}
                  {/if}
                </td>
                <td class="px-4 py-3 text-sm text-[var(--color-ink-muted)]">
                  {formatNumber(stats.runs)}
                </td>
                <td class="px-4 py-3 text-sm">
                  {#if stats.failures > 0}
                    <Badge tone="danger">{formatNumber(stats.failures)}</Badge>
                  {:else}
                    <span class="text-[var(--color-ink-subtle)]">0</span>
                  {/if}
                </td>
                <td class="px-4 py-3 text-xs text-[var(--color-ink-muted)]">
                  {formatRelative(stats.lastRunAt)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>
  {/if}
</div>

<Modal
  open={createOpen}
  title="New agent"
  description="The agent is created with a name and a scope. Everything else — model, skills, tools, permissions — is configured on the next screen before it is bound to a state."
  width="34rem"
  onclose={() => {
    createOpen = false;
  }}
>
  <form id="create-agent-form" class="space-y-4" onsubmit={submitCreate}>
    <Input
      label="Name"
      value={createName}
      placeholder="Triage assistant"
      required
      maxlength={120}
      oninput={(event) => {
        createName = event.currentTarget.value;
      }}
    />
    <Textarea
      label="Description"
      value={createDescription}
      placeholder="What this agent is for."
      rows={3}
      maxlength={2000}
      oninput={(event) => {
        createDescription = event.currentTarget.value;
      }}
    />
    <Select
      label="Workflow scope"
      options={scopeOptions}
      value={createWorkflowId}
      hint="Workspace common agents can be bound to a state in any workflow."
      onchange={(event) => {
        createWorkflowId = event.currentTarget.value;
      }}
    />
    {#if createError !== null}
      <p class="text-xs text-[var(--color-danger)]">{createError}</p>
    {/if}
  </form>

  {#snippet footer()}
    <Button
      onclick={() => {
        createOpen = false;
      }}
    >
      Cancel
    </Button>
    <Button variant="primary" type="submit" form="create-agent-form" loading={creating}>
      Create agent
    </Button>
  {/snippet}
</Modal>
