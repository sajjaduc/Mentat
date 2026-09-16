<script lang="ts">
/**
 * Cross-workflow transfer rules.
 *
 * A rule is the policy that lets a ticket leave this workflow. It names the
 * destination, the default state, how fields map, which destination fields must be
 * satisfied, and whether agents or humans may move the ticket at all.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import Select from '$ui/primitives/Select.svelte';
import MultiSelect from '$ui/work/MultiSelect.svelte';
import type {
  WorkflowFieldView,
  WorkflowListItem,
  WorkflowState,
  WorkflowTransferRule
} from '$ui/work/types';

interface Props {
  workflowId: string;
  rules: WorkflowTransferRule[];
  workflows: WorkflowListItem[];
  onReload: () => Promise<void>;
}

let { workflowId, rules, workflows, onReload }: Props = $props();

let error = $state<string | null>(null);
let editing = $state<WorkflowTransferRule | null>(null);

let formOpen = $state(false);
let saving = $state(false);
let targetId = $state('');
let targetStates = $state<WorkflowState[]>([]);
let sourceFields = $state<WorkflowFieldView[]>([]);
let targetFields = $state<WorkflowFieldView[]>([]);
let defaultTargetStateId = $state('');
let mappings = $state<Array<{ source: string; target: string }>>([]);
let requiredKeys = $state<string[]>([]);
let allowAgents = $state(true);
let allowHumans = $state(true);
let requiresApproval = $state(false);
let carryLabels = $state(true);

const targetOptions = $derived(
  workflows
    .filter((workflow) => workflow.id !== workflowId && workflow.archivedAt === null)
    .map((workflow) => ({ value: workflow.id, label: workflow.name }))
);

function targetName(id: string): string {
  return workflows.find((workflow) => workflow.id === id)?.name ?? id.slice(0, 8);
}

async function openForm(rule: WorkflowTransferRule | null) {
  editing = rule;
  error = null;
  formOpen = true;
  targetId = rule?.targetWorkflowId ?? '';
  defaultTargetStateId = rule?.defaultTargetStateId ?? '';
  mappings = rule?.fieldMappings
    ? Object.entries(rule.fieldMappings).map(([source, target]) => ({ source, target }))
    : [];
  requiredKeys = rule?.requiredTargetFieldKeys ?? [];
  allowAgents = rule?.allowAgents ?? true;
  allowHumans = rule?.allowHumans ?? true;
  requiresApproval = rule?.requiresApproval ?? false;
  carryLabels = rule?.carryLabels ?? true;
  await Promise.all([
    loadSourceFields(),
    targetId === '' ? Promise.resolve() : loadTarget(targetId)
  ]);
}

async function loadSourceFields() {
  try {
    const response = await api.get<{ fields: WorkflowFieldView[] }>(
      `/api/workflows/${workflowId}/fields`
    );
    sourceFields = response.fields;
  } catch (failure) {
    error = describeApiError(failure);
  }
}

async function loadTarget(id: string) {
  targetId = id;
  targetStates = [];
  targetFields = [];
  if (id === '') return;
  try {
    const [states, fields] = await Promise.all([
      api.get<{ states: WorkflowState[] }>(`/api/workflows/${id}/states`),
      api.get<{ fields: WorkflowFieldView[] }>(`/api/workflows/${id}/fields`)
    ]);
    targetStates = states.states;
    targetFields = fields.fields;
  } catch (failure) {
    error = describeApiError(failure);
  }
}

async function save() {
  if (targetId === '') return;
  saving = true;
  error = null;
  const mappingRecord: Record<string, string> = {};
  for (const mapping of mappings) {
    if (mapping.source !== '' && mapping.target !== '')
      mappingRecord[mapping.source] = mapping.target;
  }
  try {
    await api.put(`/api/workflows/${workflowId}/transfer-rules`, {
      targetWorkflowId: targetId,
      defaultTargetStateId: defaultTargetStateId === '' ? null : defaultTargetStateId,
      fieldMappings: mappingRecord,
      requiredTargetFieldKeys: requiredKeys,
      allowAgents,
      allowHumans,
      requiresApproval,
      carryLabels
    });
    formOpen = false;
    await onReload();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    saving = false;
  }
}

async function remove(rule: WorkflowTransferRule) {
  error = null;
  try {
    await api.delete(`/api/transfer-rules/${rule.id}`);
    await onReload();
  } catch (failure) {
    error = describeApiError(failure);
  }
}

const sourceOptions = $derived([
  { value: '', label: '—' },
  ...sourceFields.map((field) => ({ value: field.definition.key, label: field.definition.name }))
]);
const targetOptionsForFields = $derived([
  { value: '', label: '—' },
  ...targetFields.map((field) => ({ value: field.definition.key, label: field.definition.name }))
]);
</script>

<div class="space-y-3" data-testid="transfer-rules">
  <div class="flex items-center justify-between">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Transfer rules
    </h3>
    <Button size="sm" variant="secondary" onclick={() => openForm(null)}>Add rule</Button>
  </div>

  {#if error}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
  {/if}

  {#if rules.length === 0}
    <EmptyState
      title="No transfer rules"
      description="Without a rule, transfers fall back to the workflow settings and are allowed by default."
    />
  {:else}
    <ul class="space-y-2">
      {#each rules as rule (rule.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium">→ {targetName(rule.targetWorkflowId)}</span>
            {#if rule.allowAgents}<Badge tone="accent">Agents</Badge>{/if}
            {#if rule.allowHumans}<Badge tone="neutral">Humans</Badge>{/if}
            {#if rule.requiresApproval}<Badge tone="caution">Approval</Badge>{/if}
            {#if rule.carryLabels}<Badge tone="muted">Labels carried</Badge>{/if}
            <span class="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" onclick={() => openForm(rule)}>Edit</Button>
              <Button size="sm" variant="ghost" onclick={() => remove(rule)}>Delete</Button>
            </span>
          </div>
          <p class="mt-1 text-[11px] text-[var(--color-ink-subtle)]">
            {Object.keys(rule.fieldMappings ?? {}).length} mappings ·
            {(rule.requiredTargetFieldKeys ?? []).length} required destination fields
          </p>
        </li>
      {/each}
    </ul>
  {/if}

  {#if formOpen}
    <div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <Select
          label="Destination workflow"
          placeholder="Choose a workflow"
          value={targetId}
          options={targetOptions}
          onchange={(event) => loadTarget((event.currentTarget as HTMLSelectElement).value)}
        />
        <Select
          label="Default target state"
          placeholder="Workflow default"
          value={defaultTargetStateId}
          options={targetStates.map((state) => ({ value: state.id, label: state.name }))}
          onchange={(event) =>
            (defaultTargetStateId = (event.currentTarget as HTMLSelectElement).value)}
        />
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">Field mappings</p>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (mappings = [...mappings, { source: '', target: '' }])}
            >Add mapping</Button
          >
        </div>
        {#each mappings as mapping, index (index)}
          <div class="flex items-end gap-2">
            <div class="flex-1">
              <Select
                aria-label="Source field"
                value={mapping.source}
                options={sourceOptions}
                onchange={(event) => {
                  const next = [...mappings];
                  next[index] = { ...mapping, source: (event.currentTarget as HTMLSelectElement).value };
                  mappings = next;
                }}
              />
            </div>
            <span class="pb-2 text-xs text-[var(--color-ink-subtle)]">→</span>
            <div class="flex-1">
              <Select
                aria-label="Target field"
                value={mapping.target}
                options={targetOptionsForFields}
                onchange={(event) => {
                  const next = [...mappings];
                  next[index] = { ...mapping, target: (event.currentTarget as HTMLSelectElement).value };
                  mappings = next;
                }}
              />
            </div>
            <button
              type="button"
              class="pb-2 text-xs text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
              aria-label="Remove mapping"
              onclick={() => (mappings = mappings.filter((_, position) => position !== index))}
            >
              ✕
            </button>
          </div>
        {/each}
      </div>

      <MultiSelect
        label="Required destination fields"
        selected={requiredKeys}
        options={targetFields.map((field) => ({
          value: field.definition.key,
          label: field.definition.name
        }))}
        onchange={(value) => (requiredKeys = value)}
      />

      <div class="flex flex-wrap gap-3">
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={allowAgents} /> Allow agents
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={allowHumans} /> Allow humans
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={requiresApproval} /> Requires approval
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={carryLabels} /> Carry labels
        </label>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={() => (formOpen = false)}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={targetId === ''} onclick={save}>
          {editing ? 'Save rule' : 'Add rule'}
        </Button>
      </div>
    </div>
  {/if}
</div>
