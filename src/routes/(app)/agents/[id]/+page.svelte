<script lang="ts">
/**
 * Agent editor.
 *
 * The form owns a draft copy of the agent's editable body. Nothing is written until
 * Save, which PATCHes the whole body, replaces local state from the returned agent
 * and refetches the version list — so the history the user sees is the server's,
 * not an optimistic guess. The baseline snapshot that drives the dirty indicator is
 * taken from the same serializer that builds the request body, so "clean" means
 * "the next save would be a no-op".
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { formatNumber } from '$shared/format';
import ExecutionSettings from '$ui/agents/ExecutionSettings.svelte';
import ModelPicker from '$ui/agents/ModelPicker.svelte';
import PermissionEditor from '$ui/agents/PermissionEditor.svelte';
import SkillPicker from '$ui/agents/SkillPicker.svelte';
import ToolPicker from '$ui/agents/ToolPicker.svelte';
import type {
  AgentExecutionConfig,
  AgentPermissions,
  AgentVersion,
  AgentView,
  WorkflowOption
} from '$ui/agents/types';
import VersionHistory from '$ui/agents/VersionHistory.svelte';
import { ApiError, api, describeApiError } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import JsonTextarea from '$ui/http/controls/JsonTextarea.svelte';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import { formatJson, parseJson } from '$ui/http/json';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';

interface AgentBody {
  name: string;
  description: string | null;
  instructions: string;
  workflowId: string | null;
  providerId: string | null;
  modelId: string | null;
  skillIds: string[];
  toolIds: string[];
  outputSchema: unknown;
  executionConfig: Record<string, number | boolean>;
  permissions: {
    native: string[];
    httpOperationIds: string[];
    canTransferTickets: boolean;
    canCreateTickets: boolean;
    canWriteWorkspaceState: boolean;
    canUploadFiles: boolean;
    writableFieldKeys: string[];
  };
}

let agent = $state<AgentView | null>(null);
let versions = $state<AgentVersion[]>([]);
let workflows = $state<WorkflowOption[]>([]);
let agentId = $state('');
let loading = $state(true);
let error = $state<string | null>(null);

let activeTab = $state('identity');
let saving = $state(false);
let baseline = $state('');
let changeNote = $state('');
let archiveError = $state<{ message: string; code: string | null } | null>(null);
let scopeNotice = $state<string | null>(null);

let name = $state('');
let description = $state('');
let instructions = $state('');
let workflowId = $state('');
let providerId = $state<string | null>(null);
let modelId = $state<string | null>(null);
let skillIds = $state<string[]>([]);
let toolIds = $state<string[]>([]);
let outputSchema = $state('');

let maxSteps = $state<number | null>(null);
let maxOutputTokens = $state<number | null>(null);
let temperature = $state<number | null>(null);
let topP = $state<number | null>(null);
let timeoutSeconds = $state<number | null>(null);
let continueOnToolError = $state(false);
let retryOnProviderError = $state(false);
let requireApprovalForMutations = $state(false);

let nativePermissions = $state<string[]>([]);
let httpOperationIds = $state<string[]>([]);
let canCreateTickets = $state(false);
let canTransferTickets = $state(false);
let canWriteWorkspaceState = $state(false);
let canUploadFiles = $state(false);
let writableFieldKeys = $state<string[]>([]);

async function load(id: string) {
  loading = true;
  error = null;
  archiveError = null;
  scopeNotice = null;
  agentId = id;
  try {
    const [detail, workflowResult] = await Promise.all([
      api.get<{ agent: AgentView; versions: AgentVersion[] }>(`/api/agents/${id}`),
      api.get<{ workflows: WorkflowOption[] }>('/api/workflows')
    ]);
    agent = detail.agent;
    versions = detail.versions;
    workflows = workflowResult.workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      key: workflow.key
    }));
    hydrate(detail.agent);
    changeNote = '';
    baseline = JSON.stringify(buildBody());
  } catch (failure) {
    error = describeApiError(failure);
    agent = null;
  } finally {
    loading = false;
  }
}

$effect(() => {
  const id = page.params.id;
  if (id !== undefined && id.length > 0) void load(id);
});

function hydrate(next: AgentView) {
  name = next.name;
  description = next.description ?? '';
  instructions = next.instructions;
  workflowId = next.workflowId ?? '';
  providerId = next.providerId;
  modelId = next.modelId;
  skillIds = [...(next.skillIds ?? [])];
  toolIds = [...(next.toolIds ?? [])];
  outputSchema =
    next.outputSchema === null || next.outputSchema === undefined
      ? ''
      : formatJson(next.outputSchema);

  const config: AgentExecutionConfig = next.executionConfig ?? {};
  maxSteps = config.maxSteps ?? null;
  maxOutputTokens = config.maxOutputTokens ?? null;
  temperature = config.temperature ?? null;
  topP = config.topP ?? null;
  timeoutSeconds = config.timeoutSeconds ?? null;
  continueOnToolError = config.continueOnToolError ?? false;
  retryOnProviderError = config.retryOnProviderError ?? false;
  requireApprovalForMutations = config.requireApprovalForMutations ?? false;

  const permissions: AgentPermissions = next.permissions ?? {};
  nativePermissions = [...(permissions.native ?? [])];
  httpOperationIds = [...(permissions.httpOperationIds ?? [])];
  canCreateTickets = permissions.canCreateTickets ?? false;
  canTransferTickets = permissions.canTransferTickets ?? false;
  canWriteWorkspaceState = permissions.canWriteWorkspaceState ?? false;
  canUploadFiles = permissions.canUploadFiles ?? false;
  writableFieldKeys = [...(permissions.writableFieldKeys ?? [])];
}

function buildBody(): AgentBody {
  const parsed = parseJson(outputSchema);
  const executionConfig: Record<string, number | boolean> = {
    continueOnToolError,
    retryOnProviderError,
    requireApprovalForMutations
  };
  if (maxSteps !== null) executionConfig.maxSteps = maxSteps;
  if (maxOutputTokens !== null) executionConfig.maxOutputTokens = maxOutputTokens;
  if (temperature !== null) executionConfig.temperature = temperature;
  if (topP !== null) executionConfig.topP = topP;
  if (timeoutSeconds !== null) executionConfig.timeoutSeconds = timeoutSeconds;

  return {
    name: name.trim(),
    description: description.trim().length > 0 ? description.trim() : null,
    instructions,
    workflowId: workflowId === '' ? null : workflowId,
    providerId,
    modelId,
    skillIds: [...skillIds],
    toolIds: [...toolIds],
    outputSchema: parsed.ok ? parsed.value : null,
    executionConfig,
    permissions: {
      native: [...nativePermissions].sort(),
      httpOperationIds: [...httpOperationIds].sort(),
      canTransferTickets,
      canCreateTickets,
      canWriteWorkspaceState,
      canUploadFiles,
      writableFieldKeys: [...writableFieldKeys]
    }
  };
}

const dirty = $derived(JSON.stringify(buildBody()) !== baseline);

const instructionMeta = $derived(
  `${formatNumber(instructions.length)} characters · ≈${formatNumber(
    Math.ceil(instructions.length / 4)
  )} tokens`
);

const executionErrors = $derived({
  maxSteps:
    maxSteps === null || (Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 100)
      ? null
      : 'Enter a whole number from 1 to 100.',
  maxOutputTokens:
    maxOutputTokens === null || (Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1)
      ? null
      : 'Enter a whole number of at least 1.',
  temperature:
    temperature === null || (temperature >= 0 && temperature <= 2)
      ? null
      : 'Enter a number from 0 to 2.',
  topP: topP === null || (topP >= 0 && topP <= 1) ? null : 'Enter a number from 0 to 1.',
  timeoutSeconds:
    timeoutSeconds === null || (timeoutSeconds >= 5 && timeoutSeconds <= 3600)
      ? null
      : 'Enter a number from 5 to 3600.'
});

const executionInvalidCount = $derived(
  Object.values(executionErrors).filter((issue) => issue !== null).length
);

const grantedPermissionCount = $derived(
  nativePermissions.length +
    httpOperationIds.length +
    [canCreateTickets, canTransferTickets, canWriteWorkspaceState, canUploadFiles].filter(Boolean)
      .length
);

const scopeOptions = $derived([
  { value: '', label: 'Workspace common (any workflow)' },
  ...workflows.map((workflow) => ({
    value: workflow.id,
    label: `${workflow.name} (${workflow.key})`
  }))
]);

const tabs = $derived([
  { id: 'identity', label: 'Identity' },
  { id: 'skills', label: 'Skills', count: skillIds.length },
  { id: 'tools', label: 'Tools', count: toolIds.length },
  { id: 'permissions', label: 'Permissions', count: grantedPermissionCount },
  { id: 'execution', label: 'Execution' },
  { id: 'output', label: 'Output schema' },
  { id: 'versions', label: 'Versions', count: versions.length }
]);

async function save() {
  if (agent === null) return;
  const parsed = parseJson(outputSchema);
  if (!parsed.ok) {
    activeTab = 'output';
    pushToast({
      tone: 'error',
      title: 'Output schema is not valid JSON',
      description: parsed.error
    });
    return;
  }
  saving = true;
  scopeNotice = null;
  const submittedScope = workflowId;
  try {
    const result = await api.patch<{ agent: AgentView }>(`/api/agents/${agent.id}`, {
      ...buildBody(),
      changeNote: changeNote.trim().length > 0 ? changeNote.trim() : undefined
    });
    agent = result.agent;
    hydrate(result.agent);
    versions = (
      await api.get<{ versions: AgentVersion[] }>(`/api/agents/${result.agent.id}/versions`)
    ).versions;
    baseline = JSON.stringify(buildBody());
    changeNote = '';
    if ((result.agent.workflowId ?? '') !== submittedScope) {
      scopeNotice =
        'The workflow scope was not changed. Scope is fixed when the agent is created, so the stored value was kept.';
    }
    pushToast({ tone: 'success', title: `Saved version ${result.agent.currentVersion}` });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not save the agent',
      description: describeApiError(failure)
    });
  } finally {
    saving = false;
  }
}

async function archive() {
  if (agent === null) return;
  archiveError = null;
  try {
    await api.delete(`/api/agents/${agent.id}`);
    await goto('/agents');
  } catch (failure) {
    const message = describeApiError(failure);
    archiveError = { message, code: failure instanceof ApiError ? failure.code : null };
    pushToast({ tone: 'error', title: 'Could not archive the agent', description: message });
  }
}
</script>

<svelte:head><title>{agent?.name ?? 'Agent'} · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title={agent?.name ?? 'Agent'}
    description={agent?.description ??
      'Configure the model, skills, tools and permissions this agent runs with.'}
    backHref="/agents"
    backLabel="All agents"
  >
    {#snippet actions()}
      {#if agent !== null}
        <ConfirmButton
          label="Archive agent"
          confirmLabel="Confirm archive"
          title="Archive this agent"
          onconfirm={archive}
        />
      {/if}
    {/snippet}
  </PageHeader>

  {#if loading}
    <Skeleton lines={8} height="1.5rem" />
  {:else if error}
    <ErrorState
      message={error}
      onRetry={() => {
        void load(agentId);
      }}
    />
  {:else if agent === null}
    <EmptyState
      title="Agent not found"
      description="This agent may have been archived. Return to the list to pick another."
    >
      <Button
        variant="secondary"
        onclick={() => {
          void goto('/agents');
        }}
      >
        Back to agents
      </Button>
    </EmptyState>
  {:else}
    <div
      class="sticky top-0 z-20 -mx-4 flex flex-wrap items-end gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-canvas)] px-4 py-3 md:-mx-6 md:px-6"
    >
      <div class="min-w-56 flex-1">
        <Input
          label="Change note"
          value={changeNote}
          placeholder="What changed in this version?"
          hint="Recorded on the new immutable version."
          oninput={(event) => {
            changeNote = event.currentTarget.value;
          }}
        />
      </div>
      <div class="flex flex-wrap items-center gap-2 pb-1">
        {#if dirty}<Badge tone="caution">Unsaved changes</Badge>{/if}
        {#if executionInvalidCount > 0}
          <Badge tone="danger">
            {executionInvalidCount} invalid
            {executionInvalidCount === 1 ? 'setting' : 'settings'}
          </Badge>
        {/if}
        <Button
          variant="primary"
          loading={saving}
          disabled={!dirty || executionInvalidCount > 0}
          onclick={save}
        >
          Save
        </Button>
      </div>
    </div>

    {#if archiveError !== null}
      <ErrorState message={archiveError.message} code={archiveError.code} />
    {/if}

    <Tabs
      {tabs}
      active={activeTab}
      onselect={(id) => {
        activeTab = id;
      }}
      class="scrollbar-thin overflow-x-auto"
    />

    {#if activeTab === 'identity'}
      <Section
        title="Identity"
        description="The agent's name, scope and the instructions the model receives before any skill or ticket context."
      >
        <div class="grid gap-4 md:grid-cols-2">
          <Input
            label="Name"
            value={name}
            required
            maxlength={120}
            oninput={(event) => {
              name = event.currentTarget.value;
            }}
          />
          <Select
            label="Workflow scope"
            options={scopeOptions}
            value={workflowId}
            hint="Workspace common agents can be bound to a state in any workflow."
            onchange={(event) => {
              workflowId = event.currentTarget.value;
            }}
          />
        </div>
        {#if scopeNotice !== null}
          <p class="text-xs leading-relaxed text-[var(--color-caution)]">{scopeNotice}</p>
        {/if}
        <Textarea
          label="Description"
          value={description}
          rows={2}
          maxlength={2000}
          placeholder="What this agent is responsible for."
          oninput={(event) => {
            description = event.currentTarget.value;
          }}
        />
        <Textarea
          label="Instructions"
          value={instructions}
          rows={12}
          maxlength={20000}
          hint={instructionMeta}
          oninput={(event) => {
            instructions = event.currentTarget.value;
          }}
        />
      </Section>
      <ModelPicker bind:providerId bind:modelId />
    {:else if activeTab === 'skills'}
      <SkillPicker bind:skillIds />
    {:else if activeTab === 'tools'}
      <ToolPicker bind:toolIds />
    {:else if activeTab === 'permissions'}
      <PermissionEditor
        bind:native={nativePermissions}
        bind:httpOperationIds
        bind:canCreateTickets
        bind:canTransferTickets
        bind:canWriteWorkspaceState
        bind:canUploadFiles
        bind:writableFieldKeys
      />
    {:else if activeTab === 'execution'}
      <ExecutionSettings
        bind:maxSteps
        bind:maxOutputTokens
        bind:temperature
        bind:topP
        bind:timeoutSeconds
        bind:continueOnToolError
        bind:retryOnProviderError
        bind:requireApprovalForMutations
        errors={executionErrors}
      />
    {:else if activeTab === 'output'}
      <Section
        title="Output schema"
        description="A JSON Schema the agent's final answer is validated against."
      >
        <JsonTextarea
          bind:value={outputSchema}
          label="Schema"
          hint="Leave empty for free-form output."
          rows={14}
          allowEmpty
        />
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          When a schema is set, an answer that does not conform is recorded as schema-invalid on the
          run rather than being passed on silently.
        </p>
      </Section>
    {:else if activeTab === 'versions'}
      <VersionHistory {versions} currentVersionId={agent.currentVersionId} />
    {/if}
  {/if}
</div>
