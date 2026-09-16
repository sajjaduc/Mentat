<script lang="ts">
/**
 * Workflow configuration.
 *
 * Three coherent surfaces — the state machine, the ticket schema and cross-workflow
 * policy — sharing one loader so a change in any of them refreshes the others.
 * Nothing here navigates; mutations re-read only what they changed.
 */
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

async function load() {
  loading = true;
  error = null;
  try {
    const [detail, fieldResponse, workspaceFieldResponse, agentResponse, workflowResponse] =
      await Promise.all([
        api.get<WorkflowDetailResponse>(`/api/workflows/${workflowId}`),
        api.get<{ fields: WorkflowFieldView[] }>(`/api/workflows/${workflowId}/fields`),
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

async function loadResources() {
  if (teams.length === 0) {
    void api
      .get<{ teams: TeamOption[] }>('/api/teams')
      .then((response) => (teams = response.teams))
      .catch(() => undefined);
  }
  if (members.length === 0 && workspaceId !== '') {
    void api
      .get<{ members: MemberOption[] }>(`/api/workspaces/${workspaceId}/members`)
      .then((response) => (members = response.members))
      .catch(() => undefined);
  }
}

$effect(() => {
  const id = workflowId;
  void id;
  void load();
  void loadResources();
});
</script>

<div class="min-h-0 flex-1 overflow-y-auto p-4">
  {#if loading}
    <div class="space-y-3">
      <Skeleton lines={3} />
      <Skeleton lines={6} height="1.75rem" />
    </div>
  {:else if error}
    <ErrorState message={error} onRetry={load} />
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
        onReload={load}
      />
    {:else if section === 'fields'}
      <FieldConfiguration
        {workflowId}
        {fields}
        {workspaceFields}
        {states}
        onReload={load}
      />
    {:else}
      <TransferRules {workflowId} rules={rules} {workflows} onReload={load} />
    {/if}
  {/if}
</div>
