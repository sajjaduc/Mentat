<script lang="ts">
/**
 * Workflow configuration.
 *
 * Three coherent surfaces — the state machine, the ticket schema and cross-workflow
 * policy — sharing one loader so a change in any of them refreshes the others.
 * Nothing here navigates; mutations re-read only what they changed.
 */
import { onMount } from 'svelte';
import { api, describeApiError } from '$ui/api';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import FieldConfiguration from '$ui/work/FieldConfiguration.svelte';
import StateDesigner from '$ui/work/StateDesigner.svelte';
import TransferRules from '$ui/work/TransferRules.svelte';
import type {
  AgentOption,
  FieldDefinition,
  MemberOption,
  TeamOption,
  WorkflowDetailResponse,
  WorkflowFieldView,
  WorkflowListItem,
  WorkflowState,
  WorkflowTransferRule,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  workflowId: string;
  workspaceId?: string;
}

let { workflowId, workspaceId = '' }: Props = $props();

let states = $state<WorkflowState[]>([]);
let transitions = $state<WorkflowTransition[]>([]);
let rules = $state<WorkflowTransferRule[]>([]);
let fields = $state<WorkflowFieldView[]>([]);
let workspaceFields = $state<FieldDefinition[]>([]);
let agents = $state<AgentOption[]>([]);
let teams = $state<TeamOption[]>([]);
let members = $state<MemberOption[]>([]);
let workflows = $state<WorkflowListItem[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let section = $state('states');

const tabs = [
  { id: 'states', label: 'States' },
  { id: 'fields', label: 'Fields' },
  { id: 'transfer', label: 'Transfer rules' }
];

async function load(id: string) {
  loading = true;
  error = null;
  try {
    const [detail, fieldResponse, workspaceFieldResponse, agentResponse, workflowResponse] =
      await Promise.all([
        api.get<WorkflowDetailResponse>(`/api/workflows/${id}`),
        api.get<{ fields: WorkflowFieldView[] }>(`/api/workflows/${id}/fields`),
        api.get<{ fields: FieldDefinition[] }>('/api/fields', { scope: 'ticket' }),
        api.get<{ agents: AgentOption[] }>('/api/agents'),
        api.get<{ workflows: WorkflowListItem[] }>('/api/workflows')
      ]);
    states = detail.states;
    transitions = detail.transitions;
    rules = detail.transferRules;
    fields = fieldResponse.fields;
    workspaceFields = workspaceFieldResponse.fields;
    agents = agentResponse.agents;
    workflows = workflowResponse.workflows;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

/**
 * Teams and members are reference data, not workflow data: they are fetched once
 * rather than on every workflow change.
 */
onMount(() => {
  void api
    .get<{ teams: TeamOption[] }>('/api/teams')
    .then((response) => (teams = response.teams))
    .catch(() => undefined);
  if (workspaceId !== '') {
    void api
      .get<{ members: MemberOption[] }>(`/api/workspaces/${workspaceId}/members`)
      .then((response) => (members = response.members))
      .catch(() => undefined);
  }
});

// Depends on `workflowId` and nothing else. The previous version called a resource
// loader synchronously here, which made the effect read `teams`/`members` and re-run
// when those settled — replacing every state row a moment after mount, which detached
// controls from under the user (and from under a test).
$effect(() => {
  void load(workflowId);
});
</script>

<div class="min-h-0 flex-1 overflow-y-auto p-4">
  {#if loading}
    <div class="space-y-3">
      <Skeleton lines={3} />
      <Skeleton lines={6} height="1.75rem" />
    </div>
  {:else if error}
    <ErrorState message={error} onRetry={() => load(workflowId)} />
  {:else}
    <Tabs {tabs} active={section} onselect={(id) => (section = id)} class="mb-4" />
    {#if section === 'states'}
      <StateDesigner
        {workflowId}
        {states}
        {transitions}
        {fields}
        {agents}
        {teams}
        {members}
        {workflows}
        onReload={() => load(workflowId)}
      />
    {:else if section === 'fields'}
      <FieldConfiguration
        {workflowId}
        {fields}
        {workspaceFields}
        {states}
        onReload={() => load(workflowId)}
      />
    {:else}
      <TransferRules {workflowId} rules={rules} {workflows} onReload={() => load(workflowId)} />
    {/if}
  {/if}
</div>
