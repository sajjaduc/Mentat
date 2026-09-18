<script lang="ts">
/**
 * Workflow configuration.
 *
 * Three coherent surfaces — the state machine, the workItem schema and cross-workflow
 * policy — sharing one loader so a change in any of them refreshes the others.
 * Nothing here navigates; mutations re-read only what they changed.
 */

import { onMount } from 'svelte';
import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import type { ObjectTypeSummary } from '$ui/records/types';
import { pushToast } from '$ui/toast';
import FieldConfiguration from '$ui/work/FieldConfiguration.svelte';
import StateDesigner from '$ui/work/StateDesigner.svelte';
import TransferRules from '$ui/work/TransferRules.svelte';
import type {
  AgentOption,
  FieldDefinition,
  MemberOption,
  TeamOption,
  Workflow,
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
let workflow = $state<Workflow | null>(null);
let objectTypes = $state<ObjectTypeSummary[]>([]);
let objectTypeId = $state('');
let savingObjectType = $state(false);
let loading = $state(true);
let error = $state<string | null>(null);
let section = $state('states');

/** Only owners and admins may re-point a workflow at another Object Type. */
const canEditObjectType = $derived(
  page.data.actor?.role === 'owner' || page.data.actor?.role === 'admin'
);

const selectedObjectType = $derived(
  objectTypes.find((type) => type.id === workflow?.objectTypeId) ?? null
);

const tabs = [
  { id: 'states', label: 'States' },
  { id: 'fields', label: 'Fields' },
  { id: 'transfer', label: 'Transfer rules' }
];

async function load(id: string) {
  loading = true;
  error = null;
  try {
    const [
      detail,
      fieldResponse,
      workspaceFieldResponse,
      agentResponse,
      workflowResponse,
      typeResponse
    ] = await Promise.all([
      api.get<WorkflowDetailResponse>(`/api/workflows/${id}`),
      api.get<{ fields: WorkflowFieldView[] }>(`/api/workflows/${id}/fields`),
      api.get<{ fields: FieldDefinition[] }>('/api/fields'),
      api.get<{ agents: AgentOption[] }>('/api/agents'),
      api.get<{ workflows: WorkflowListItem[] }>('/api/workflows'),
      api.get<{ objectTypes: ObjectTypeSummary[] }>('/api/object-types')
    ]);
    states = detail.states;
    transitions = detail.transitions;
    rules = detail.transferRules;
    workflow = detail.workflow;
    objectTypeId = detail.workflow.objectTypeId ?? '';
    fields = fieldResponse.fields;
    // Overlay fields may be workflow-item- or record-scoped; file fields are not eligible.
    workspaceFields = workspaceFieldResponse.fields.filter(
      (field) => field.scope === 'workflowItem' || field.scope === 'record'
    );
    agents = agentResponse.agents;
    workflows = workflowResponse.workflows;
    objectTypes = typeResponse.objectTypes;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function saveObjectType() {
  if (!workflow || objectTypeId === '' || objectTypeId === workflow.objectTypeId) return;
  savingObjectType = true;
  try {
    const response = await api.patch<{ workflow: Workflow }>(`/api/workflows/${workflowId}`, {
      objectTypeId
    });
    workflow = { ...workflow, ...response.workflow, objectTypeId };
    pushToast({ tone: 'success', title: 'Object Type updated' });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not change the Object Type',
      description: describeApiError(failure)
    });
    objectTypeId = workflow.objectTypeId ?? '';
  } finally {
    savingObjectType = false;
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
    {#if workflow}
      <section
        class="mb-4 flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)]/40 p-3"
      >
        <div class="min-w-0">
          <p class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
            Object Type
          </p>
          <p class="text-sm font-medium">
            {selectedObjectType?.name ??
              workflow.objectTypeName ??
              (workflow.objectTypeId ? 'Unknown Object Type' : 'Not set')}
          </p>
          {#if selectedObjectType}
            <p class="text-[11px] text-[var(--color-ink-subtle)]">
              Records are called “{selectedObjectType.pluralName.toLowerCase()}” here.
            </p>
          {/if}
        </div>
        {#if canEditObjectType && objectTypes.length > 0}
          <div class="ml-auto flex items-end gap-2">
            <div class="w-64">
              <Select
                label="Change Object Type"
                bind:value={objectTypeId}
                options={objectTypes.map((type) => ({
                  value: type.id,
                  label: `${type.name} · ${type.pluralName}`
                }))}
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={savingObjectType}
              disabled={objectTypeId === '' || objectTypeId === workflow.objectTypeId}
              onclick={saveObjectType}
            >
              Save
            </Button>
          </div>
        {/if}
      </section>
    {/if}
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
        schemaSource={String(workflow?.settings?.zodSchema ?? '')}
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
