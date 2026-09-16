<script lang="ts">
/**
 * Workflow field configuration.
 *
 * Fields are reusable workspace definitions; attaching one to a workflow decides
 * how it behaves here. Flag changes are applied optimistically and rolled back
 * together, because the API replaces the whole set in one write.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import { pushToast } from '$ui/toast';
import MultiSelect from '$ui/work/MultiSelect.svelte';
import type { FieldDefinition, FieldType, WorkflowFieldView, WorkflowState } from '$ui/work/types';

interface Props {
  workflowId: string;
  fields: WorkflowFieldView[];
  workspaceFields: FieldDefinition[];
  states: WorkflowState[];
  onReload: () => Promise<void>;
}

let { workflowId, fields, workspaceFields, states, onReload }: Props = $props();

const FIELD_TYPES: FieldType[] = [
  'short_text',
  'long_text',
  'number',
  'currency',
  'boolean',
  'date',
  'datetime',
  'select',
  'multi_select',
  'user',
  'team',
  'url',
  'email',
  'phone',
  'json'
];

let rows = $state<WorkflowFieldView[]>([...fields]);
let error = $state<string | null>(null);
let attaching = $state('');
let createOpen = $state(false);
let creating = $state(false);
let createError = $state<string | null>(null);
let draft = $state({ name: '', key: '', type: 'short_text' as FieldType, choices: '' });

$effect(() => {
  rows = [...fields];
});

const stateOptions = $derived(states.map((state) => ({ value: state.id, label: state.name })));
const unattached = $derived(
  workspaceFields.filter(
    (definition) => !rows.some((row) => row.fieldDefinitionId === definition.id)
  )
);

function payload(list: WorkflowFieldView[]): Record<string, unknown> {
  return {
    fields: list.map((row, index) => ({
      fieldDefinitionId: row.fieldDefinitionId,
      position: index,
      required: row.required,
      visible: row.visible,
      editable: row.editable,
      defaultValue: row.defaultValue,
      requiredInStates: row.requiredInStates,
      showOnCard: row.showOnCard,
      showInList: row.showInList,
      filterable: row.filterable,
      requiredForTransfer: row.requiredForTransfer
    }))
  };
}

async function commit(next: WorkflowFieldView[]) {
  const previous = rows;
  rows = next;
  error = null;
  try {
    await api.put(`/api/workflows/${workflowId}/fields`, payload(next));
    await onReload();
  } catch (failure) {
    rows = previous;
    error = describeApiError(failure);
  }
}

function toggleFlag(
  view: WorkflowFieldView,
  key:
    | 'required'
    | 'visible'
    | 'editable'
    | 'showOnCard'
    | 'showInList'
    | 'filterable'
    | 'requiredForTransfer'
) {
  void commit(rows.map((row) => (row.id === view.id ? { ...row, [key]: !row[key] } : row)));
}

async function attach(definitionId: string) {
  if (definitionId === '') return;
  const definition = workspaceFields.find((entry) => entry.id === definitionId);
  if (!definition) return;
  const placeholder: WorkflowFieldView = {
    id: `pending-${definition.id}`,
    workspaceId: '',
    workflowId,
    fieldDefinitionId: definition.id,
    position: rows.length,
    required: false,
    visible: true,
    editable: true,
    defaultValue: null,
    requiredInStates: null,
    showOnCard: false,
    showInList: true,
    filterable: true,
    requiredForTransfer: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    definition
  };
  attaching = '';
  await commit([...rows, placeholder]);
}

async function createField() {
  const name = draft.name.trim();
  if (name === '') return;
  creating = true;
  createError = null;
  try {
    const choices = draft.choices
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => {
        const [value, label] = entry.split(':');
        return { value: (value ?? '').trim(), label: (label ?? value ?? '').trim() };
      });
    const response = await api.post<{ field: FieldDefinition }>('/api/fields', {
      name,
      key: draft.key.trim() === '' ? undefined : draft.key.trim(),
      type: draft.type,
      scope: 'ticket',
      options: choices.length > 0 ? { choices } : undefined
    });
    await onReload();
    await attach(response.field.id);
    draft = { name: '', key: '', type: 'short_text', choices: '' };
    createOpen = false;
  } catch (failure) {
    createError = describeApiError(failure);
  } finally {
    creating = false;
  }
}
</script>

<div class="space-y-4" data-testid="field-configuration">
  {#if error}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <div class="w-64">
      <Select
        label="Attach a workspace field"
        placeholder="Choose a field"
        value={attaching}
        options={unattached.map((definition) => ({
          value: definition.id,
          label: `${definition.name} (${definition.type})`
        }))}
        onchange={(event) => attach((event.currentTarget as HTMLSelectElement).value)}
      />
    </div>
    <Button size="sm" variant="secondary" onclick={() => (createOpen = !createOpen)}>
      {createOpen ? 'Cancel' : 'Create new field'}
    </Button>
  </div>

  {#if createOpen}
    <div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <div class="grid gap-3 sm:grid-cols-3">
        <Input value={draft.name} oninput={(event) => (draft.name = (event.currentTarget as HTMLInputElement).value)} label="Name" placeholder="Claim amount" />
        <Input value={draft.key} oninput={(event) => (draft.key = (event.currentTarget as HTMLInputElement).value)} label="Key" placeholder="claim_amount" hint="Generated when empty." />
        <Select
          label="Type"
          value={draft.type}
          options={FIELD_TYPES.map((type) => ({ value: type, label: type }))}
          onchange={(event) =>
            (draft.type = (event.currentTarget as HTMLSelectElement).value as FieldType)}
        />
      </div>
      {#if draft.type === 'select' || draft.type === 'multi_select'}
        <Input
          value={draft.choices} oninput={(event) => (draft.choices = (event.currentTarget as HTMLInputElement).value)}
          label="Choices"
          placeholder="low:Low, high:High"
          hint="Comma separated value:label pairs."
        />
      {/if}
      {#if createError}
        <p class="text-xs text-[var(--color-danger)]" role="alert">{createError}</p>
      {/if}
      <div class="flex justify-end">
        <Button size="sm" variant="primary" loading={creating} onclick={createField}>
          Create and attach
        </Button>
      </div>
    </div>
  {/if}

  {#if rows.length === 0}
    <EmptyState
      title="No fields configured"
      description="Attach reusable workspace fields to give tickets a schema; they appear on cards and in the list when you say so."
    />
  {:else}
    <div class="space-y-2">
      {#each rows as view (view.id)}
        <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium">{view.definition.name}</span>
            <Badge tone="muted">{view.definition.type}</Badge>
            <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]"
              >{view.definition.key}</span
            >
            <span class="ml-auto">
              <Button
                size="sm"
                variant="ghost"
                onclick={() => commit(rows.filter((row) => row.id !== view.id))}
              >
                Detach
              </Button>
            </span>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={view.required} onchange={() => void toggleFlag(view, 'required')} />
              Required
            </label>
            <label class="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={view.visible} onchange={() => void toggleFlag(view, 'visible')} />
              Visible
            </label>
            <label class="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={view.editable} onchange={() => void toggleFlag(view, 'editable')} />
              Editable
            </label>
            <label class="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={view.showOnCard}
                onchange={() => void toggleFlag(view, 'showOnCard')}
              />
              Show on card
            </label>
            <label class="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={view.showInList}
                onchange={() => void toggleFlag(view, 'showInList')}
              />
              Show in list
            </label>
            <label class="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={view.filterable}
                onchange={() => void toggleFlag(view, 'filterable')}
              />
              Filterable
            </label>
            <label class="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={view.requiredForTransfer}
                onchange={() => void toggleFlag(view, 'requiredForTransfer')}
              />
              Required for transfer
            </label>
          </div>
          <div class="mt-2">
            <MultiSelect
              label="Required in states"
              selected={view.requiredInStates ?? []}
              options={stateOptions}
              onchange={(value) =>
                commit(rows.map((row) =>
                  row.id === view.id ? { ...row, requiredInStates: value } : row
                ))}
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
