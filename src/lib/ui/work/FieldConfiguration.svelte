<script lang="ts">
/**
 * Workflow overlay schema.
 *
 * The overlay is authored as Zod source in the same box used for Object Types, so a
 * schema tested here is the exact contract the engine compiles when work items are
 * validated. The typed fields below the box are the projection of that source; their
 * display and state requirements are still configurable, and flag changes are applied
 * optimistically and rolled back together because the API replaces the whole set.
 */
import { untrack } from 'svelte';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import { schemaApi } from '$ui/schema/api';
import { buildStarterZodSchema } from '$ui/schema/starter';
import ZodSchemaBox from '$ui/schema/ZodSchemaBox.svelte';
import { pushToast } from '$ui/toast';
import MultiSelect from '$ui/work/MultiSelect.svelte';
import type { FieldDefinition, WorkflowFieldView, WorkflowState } from '$ui/work/types';

interface Props {
  workflowId: string;
  /** The workflow's stored Zod source, if any. */
  schemaSource: string;
  fields: WorkflowFieldView[];
  workspaceFields: FieldDefinition[];
  states: WorkflowState[];
  onReload: () => Promise<void>;
}

let { workflowId, schemaSource, fields, workspaceFields, states, onReload }: Props = $props();

// Seeded once, then re-synced by the effect below.
let rows = $state<WorkflowFieldView[]>(untrack(() => [...fields]));
let error = $state<string | null>(null);
let savingSchema = $state(false);
let starter = $state('');

$effect(() => {
  rows = [...fields];
});

const stateOptions = $derived(states.map((state) => ({ value: state.id, label: state.name })));

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

async function saveSchema(source: string) {
  savingSchema = true;
  try {
    await schemaApi.saveWorkflow(workflowId, source);
    await onReload();
    starter = '';
    pushToast({ tone: 'success', title: 'Workflow schema saved' });
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
    throw failure;
  } finally {
    savingSchema = false;
  }
}

function generateStarter() {
  starter = buildStarterZodSchema(
    rows.map((row) => ({
      key: row.definition.key,
      name: row.definition.name,
      type: row.definition.type,
      required: row.required,
      options: row.definition.options,
      showInList: row.showInList,
      showOnCard: row.showOnCard,
      filterable: row.filterable
    }))
  );
}
</script>

<div class="space-y-4" data-testid="field-configuration">
  {#if error}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
  {/if}

  <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
    {#if schemaSource === '' && rows.length > 0}
      <div
        class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)]/50 p-2"
      >
        <p class="text-xs text-[var(--color-ink-muted)]">
          These fields are attached but have no Zod source. Generate a starter schema from them to
          make the contract explicit.
        </p>
        <Button size="sm" variant="secondary" onclick={generateStarter}>
          Generate starter schema
        </Button>
      </div>
    {/if}
    <ZodSchemaBox
      value={schemaSource}
      draftSeed={starter}
      saving={savingSchema}
      saveLabel="Save workflow schema"
      hint="Overlay fields for work items in this workflow. Validated in addition to the Object Type schema."
      placeholder={'z.object({\n  reviewer_note: z.string(),\n  approved: z.boolean()\n})'}
      onSave={saveSchema}
    />
  </div>

  {#if rows.length === 0}
    <EmptyState
      title="No overlay fields configured"
      description="Save a Zod schema above to give work items in this workflow extra typed fields. They appear on cards and in the list when you say so."
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
            {#if schemaSource === ''}
              <span class="ml-auto">
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => commit(rows.filter((row) => row.id !== view.id))}
                >
                  Detach
                </Button>
              </span>
            {/if}
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
    {#if workspaceFields.length > 0}
      <p class="text-[11px] text-[var(--color-ink-subtle)]">
        {workspaceFields.length} reusable workspace field{workspaceFields.length === 1 ? '' : 's'} available
        to other workflows.
      </p>
    {/if}
  {/if}
</div>
