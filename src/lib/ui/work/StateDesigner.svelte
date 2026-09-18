<script lang="ts">
/**
 * State and transition designer.
 *
 * Order is the board order, so reordering is an explicit, persisted operation.
 * Deletion is confirmed because a state with workItems cannot be removed, and the
 * server's refusal is worth reading rather than losing to a toast.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import { pushToast } from '$ui/toast';
import { stateKindLabel, stateKindTone } from '$ui/work/format';
import MultiSelect from '$ui/work/MultiSelect.svelte';
import StateEditor from '$ui/work/StateEditor.svelte';
import type {
  AgentOption,
  MemberOption,
  TeamOption,
  WorkflowFieldView,
  WorkflowListItem,
  WorkflowState,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  workflowId: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  fields: WorkflowFieldView[];
  agents: AgentOption[];
  teams: TeamOption[];
  members: MemberOption[];
  workflows: WorkflowListItem[];
  onReload: () => Promise<void>;
}

let {
  workflowId,
  states,
  transitions,
  fields,
  agents,
  teams,
  members,
  workflows,
  onReload
}: Props = $props();

let editorOpen = $state(false);
let editing = $state<WorkflowState | null>(null);
let saving = $state(false);
let editorError = $state<string | null>(null);
let rowError = $state<string | null>(null);
let confirmDelete = $state<WorkflowState | null>(null);
let transitionOpen = $state(false);
let transitionSaving = $state(false);
let newTransition = $state({
  name: '',
  toStateId: '',
  requiresComment: false,
  requiredFieldKeys: [] as string[],
  allowedRoles: [] as string[]
});

const ordered = $derived([...states].sort((a, b) => a.position - b.position));
const stateOptions = $derived(ordered.map((state) => ({ value: state.id, label: state.name })));
const fieldOptions = $derived(
  fields.map((field) => ({ value: field.definition.key, label: field.definition.name }))
);

function openCreate() {
  editing = null;
  editorError = null;
  editorOpen = true;
}

function openEdit(state: WorkflowState) {
  editing = state;
  editorError = null;
  editorOpen = true;
}

async function saveState(body: Record<string, unknown>) {
  saving = true;
  editorError = null;
  try {
    if (editing) {
      await api.patch(`/api/states/${editing.id}`, body);
    } else {
      await api.post(`/api/workflows/${workflowId}/states`, body);
    }
    editorOpen = false;
    await onReload();
  } catch (failure) {
    editorError = describeApiError(failure);
  } finally {
    saving = false;
  }
}

async function removeState(state: WorkflowState) {
  rowError = null;
  try {
    await api.delete(`/api/states/${state.id}`);
    confirmDelete = null;
    await onReload();
  } catch (failure) {
    rowError = describeApiError(failure);
    confirmDelete = null;
  }
}

async function reorder(index: number, delta: number) {
  const next = [...ordered];
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  const [moved] = next.splice(index, 1);
  if (!moved) return;
  next.splice(target, 0, moved);
  const ids = next.map((state) => state.id);
  try {
    await api.put(`/api/workflows/${workflowId}/states/order`, { stateIds: ids });
    await onReload();
  } catch (failure) {
    rowError = describeApiError(failure);
  }
}

async function addTransition() {
  if (newTransition.name.trim() === '' || newTransition.toStateId === '') return;
  transitionSaving = true;
  try {
    await api.post(`/api/workflows/${workflowId}/transitions`, {
      name: newTransition.name.trim(),
      toStateId: newTransition.toStateId,
      requiresComment: newTransition.requiresComment,
      requiredFieldKeys: newTransition.requiredFieldKeys,
      allowedRoles: newTransition.allowedRoles
    });
    newTransition = {
      name: '',
      toStateId: '',
      requiresComment: false,
      requiredFieldKeys: [],
      allowedRoles: []
    };
    transitionOpen = false;
    await onReload();
  } catch (failure) {
    rowError = describeApiError(failure);
  } finally {
    transitionSaving = false;
  }
}

async function removeTransition(transition: WorkflowTransition) {
  rowError = null;
  try {
    await api.delete(`/api/transitions/${transition.id}`);
    await onReload();
  } catch (failure) {
    rowError = describeApiError(failure);
  }
}

const transitionRows = $derived(
  transitions.map((transition) => ({
    ...transition,
    toName: ordered.find((state) => state.id === transition.toStateId)?.name ?? 'Unknown'
  }))
);
</script>

<div class="space-y-6" data-testid="state-designer">
  {#if rowError}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{rowError}</p>
  {/if}

  <section class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        States
      </h3>
      <Button size="sm" variant="primary" onclick={openCreate}>Add state</Button>
    </div>

    {#if ordered.length === 0}
      <EmptyState
        title="No states yet"
        description="Every workflow needs at least one state before work items can move."
      >
        <Button variant="primary" onclick={openCreate}>Add the first state</Button>
      </EmptyState>
    {:else}
      <ul class="divide-y divide-[var(--color-border-subtle)] rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)]">
        {#each ordered as state, index (state.id)}
          <li class="flex items-start gap-2 p-2.5">
            <div class="flex flex-col gap-0.5">
              <button
                type="button"
                class="rounded-[var(--radius-xs)] px-1 text-[10px] text-[var(--color-ink-subtle)] hover:bg-[var(--color-surface-muted)]"
                aria-label="Move {state.name} up"
                disabled={index === 0}
                onclick={() => reorder(index, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                class="rounded-[var(--radius-xs)] px-1 text-[10px] text-[var(--color-ink-subtle)] hover:bg-[var(--color-surface-muted)]"
                aria-label="Move {state.name} down"
                disabled={index === ordered.length - 1}
                onclick={() => reorder(index, 1)}
              >
                ▼
              </button>
            </div>
            <span
              class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
              style="background-color:{state.color ?? 'var(--color-border-strong)'}"
              aria-hidden="true"
            ></span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-sm font-medium">{state.name}</span>
                <Badge tone={stateKindTone(state.kind)}>{stateKindLabel(state.kind)}</Badge>
                <Badge tone="muted">{state.category}</Badge>
                {#if state.humanGate?.enabled}<Badge tone="caution">Gate</Badge>{/if}
                {#if state.config?.wipLimit}<Badge tone="neutral"
                    >WIP {state.config.wipLimit}</Badge
                  >{/if}
                {#if state.isStart}<Badge tone="positive">Start</Badge>{/if}
                {#if state.isTerminal}<Badge tone="positive">Terminal</Badge>{/if}
              </div>
              {#if state.description}
                <p class="mt-0.5 text-xs text-[var(--color-ink-subtle)]">{state.description}</p>
              {/if}
            </div>
            <Button size="sm" variant="ghost" onclick={() => openEdit(state)}>Edit</Button>
            <Button size="sm" variant="ghost" onclick={() => (confirmDelete = state)}>Delete</Button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Transitions
      </h3>
      <Button size="sm" variant="secondary" onclick={() => (transitionOpen = !transitionOpen)}>
        {transitionOpen ? 'Cancel' : 'Add transition'}
      </Button>
    </div>

    {#if transitionOpen}
      <div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <Input value={newTransition.name} oninput={(event) => (newTransition.name = (event.currentTarget as HTMLInputElement).value)} label="Name" placeholder="Approve" />
          <Select
            label="Target state"
            placeholder="Choose a state"
            value={newTransition.toStateId}
            options={stateOptions}
            onchange={(event) =>
              (newTransition.toStateId = (event.currentTarget as HTMLSelectElement).value)}
          />
          <MultiSelect
            label="Required fields"
            selected={newTransition.requiredFieldKeys}
            options={fieldOptions}
            onchange={(value) => (newTransition.requiredFieldKeys = value)}
          />
          <MultiSelect
            label="Allowed roles"
            selected={newTransition.allowedRoles}
            options={[
              { value: 'owner', label: 'owner' },
              { value: 'admin', label: 'admin' },
              { value: 'member', label: 'member' }
            ]}
            onchange={(value) => (newTransition.allowedRoles = value)}
          />
        </div>
        <label class="flex items-center gap-2 text-xs">
          <input type="checkbox" bind:checked={newTransition.requiresComment} />
          Requires a comment
        </label>
        <div class="flex justify-end">
          <Button size="sm" variant="primary" loading={transitionSaving} onclick={addTransition}>
            Add transition
          </Button>
        </div>
      </div>
    {/if}

    {#if transitionRows.length === 0}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        No transitions yet. Without one, work items cannot move between states.
      </p>
    {:else}
      <ul class="divide-y divide-[var(--color-border-subtle)] rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)]">
        {#each transitionRows as transition (transition.id)}
          <li class="flex items-center gap-2 p-2.5 text-xs">
            <span class="font-medium">{transition.name}</span>
            <span class="text-[var(--color-ink-subtle)]">
              {transition.fromStateId
                ? (ordered.find((state) => state.id === transition.fromStateId)?.name ?? 'Any')
                : 'Any state'}
              → {transition.toName}
            </span>
            {#if transition.requiresComment}<Badge tone="muted">Comment</Badge>{/if}
            {#if transition.requiredFieldKeys && transition.requiredFieldKeys.length > 0}
              <Badge tone="muted">{transition.requiredFieldKeys.length} fields</Badge>
            {/if}
            <span class="ml-auto">
              <Button size="sm" variant="ghost" onclick={() => removeTransition(transition)}
                >Delete</Button
              >
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<StateEditor
  open={editorOpen}
  existing={editing}
  states={ordered}
  transitions={transitions}
  fields={fields}
  agents={agents}
  {teams}
  {members}
  {workflows}
  saving={saving}
  error={editorError}
  onclose={() => (editorOpen = false)}
  onsave={saveState}
/>

<Modal
  open={confirmDelete !== null}
  title="Delete state"
  description="A state that still holds work items cannot be deleted; move them first."
  onclose={() => (confirmDelete = null)}
>
  <p class="text-sm">Delete “{confirmDelete?.name}”? This cannot be undone.</p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (confirmDelete = null)}>Cancel</Button>
    <Button
      variant="danger"
      onclick={() => confirmDelete && removeState(confirmDelete)}>Delete state</Button
    >
  {/snippet}
</Modal>
