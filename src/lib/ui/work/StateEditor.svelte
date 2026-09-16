<script lang="ts">
/**
 * State editor.
 *
 * A state is the unit of workflow policy: who may act, which agent runs, what the
 * deterministic fallback is, whether a human gate stops progression, and how much
 * context is assembled for the model. The form exposes all of it because a hidden
 * default is indistinguishable from a bug when a ticket behaves unexpectedly.
 */
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import MultiSelect from '$ui/work/MultiSelect.svelte';
import type {
  AgentOption,
  MemberOption,
  StateCategory,
  StateKind,
  SystemAction,
  TeamOption,
  WorkflowFieldView,
  WorkflowListItem,
  WorkflowState,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  open: boolean;
  /** The state being edited, or null when creating. Named `existing` so it cannot
   *  be mistaken for the `$state` rune. */
  existing: WorkflowState | null;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  fields: WorkflowFieldView[];
  agents: AgentOption[];
  teams: TeamOption[];
  members: MemberOption[];
  workflows: WorkflowListItem[];
  saving: boolean;
  error: string | null;
  onclose: () => void;
  onsave: (body: Record<string, unknown>) => void;
}

let {
  open,
  existing,
  states,
  transitions,
  fields,
  agents,
  teams,
  saving,
  error,
  onclose,
  onsave
}: Props = $props();

const KINDS: StateKind[] = ['manual', 'agent', 'system', 'terminal'];
const CATEGORIES: StateCategory[] = ['backlog', 'active', 'review', 'done', 'cancelled'];
const ACTION_TYPES: Array<{ value: '' | SystemAction['type']; label: string }> = [
  { value: '', label: 'None' },
  { value: 'transition', label: 'Transition to a state' },
  { value: 'setFields', label: 'Set field values' },
  { value: 'emitEvent', label: 'Emit an event' },
  { value: 'createTicket', label: 'Create a ticket' },
  { value: 'http', label: 'Call an HTTP operation' },
  { value: 'wait', label: 'Wait' }
];
const ROLES = ['owner', 'admin', 'member'];

interface Form {
  name: string;
  description: string;
  color: string;
  kind: StateKind;
  category: StateCategory;
  agentId: string;
  autoExecute: boolean;
  maxAttempts: string;
  timeoutSeconds: string;
  failureStateId: string;
  wipLimit: string;
  actionType: '' | SystemAction['type'];
  actionTargetStateId: string;
  actionValues: string;
  actionName: string;
  actionWorkflowId: string;
  actionTitleTemplate: string;
  actionOperationId: string;
  actionSeconds: string;
  gateEnabled: boolean;
  gateTransitions: string[];
  gateFields: string[];
  gateComment: boolean;
  gateRoles: string[];
  gateTeams: string[];
  gateInstructions: string;
  ctxTitle: boolean;
  ctxDescription: boolean;
  ctxFieldKeys: string[];
  ctxRecentNotes: string;
  ctxFileSummaries: boolean;
  ctxFileFields: string[];
  ctxFullFile: boolean;
  ctxHistory: boolean;
  ctxStateHistory: boolean;
}

function emptyForm(): Form {
  return {
    name: '',
    description: '',
    color: '',
    kind: 'manual',
    category: 'active',
    agentId: '',
    autoExecute: true,
    maxAttempts: '3',
    timeoutSeconds: '',
    failureStateId: '',
    wipLimit: '',
    actionType: '',
    actionTargetStateId: '',
    actionValues: '{}',
    actionName: '',
    actionWorkflowId: '',
    actionTitleTemplate: '',
    actionOperationId: '',
    actionSeconds: '60',
    gateEnabled: false,
    gateTransitions: [],
    gateFields: [],
    gateComment: false,
    gateRoles: [],
    gateTeams: [],
    gateInstructions: '',
    ctxTitle: true,
    ctxDescription: true,
    ctxFieldKeys: [],
    ctxRecentNotes: '',
    ctxFileSummaries: false,
    ctxFileFields: [],
    ctxFullFile: false,
    ctxHistory: false,
    ctxStateHistory: false
  };
}

function formOf(source: WorkflowState | null): Form {
  if (!source) return emptyForm();
  const action = source.config?.systemAction;
  const context = source.config?.context;
  const gate = source.humanGate;
  const record = (action ?? {}) as Record<string, unknown>;
  return {
    name: source.name,
    description: source.description ?? '',
    color: source.color ?? '',
    kind: source.kind,
    category: source.category,
    agentId: source.agentId ?? '',
    autoExecute: source.autoExecute,
    maxAttempts: String(source.maxAttempts),
    timeoutSeconds: source.timeoutSeconds === null ? '' : String(source.timeoutSeconds),
    failureStateId: source.failureStateId ?? '',
    wipLimit: source.config?.wipLimit === undefined ? '' : String(source.config.wipLimit),
    actionType: action?.type ?? '',
    actionTargetStateId: typeof record.targetStateId === 'string' ? record.targetStateId : '',
    actionValues:
      action?.type === 'setFields' ? JSON.stringify(action.values ?? {}, null, 2) : '{}',
    actionName: typeof record.name === 'string' ? record.name : '',
    actionWorkflowId: typeof record.workflowId === 'string' ? record.workflowId : '',
    actionTitleTemplate: typeof record.titleTemplate === 'string' ? record.titleTemplate : '',
    actionOperationId: typeof record.operationId === 'string' ? record.operationId : '',
    actionSeconds: typeof record.seconds === 'number' ? String(record.seconds) : '60',
    gateEnabled: gate?.enabled === true,
    gateTransitions: gate?.allowedTransitionIds ?? [],
    gateFields: gate?.requiredFieldKeys ?? [],
    gateComment: gate?.requiredComment === true,
    gateRoles: gate?.allowedRoles ?? [],
    gateTeams: gate?.allowedTeamIds ?? [],
    gateInstructions: gate?.instructions ?? '',
    ctxTitle: context?.includeTitle !== false,
    ctxDescription: context?.includeDescription !== false,
    ctxFieldKeys: context?.fieldKeys ?? [],
    ctxRecentNotes:
      context?.includeRecentNotes === undefined ? '' : String(context.includeRecentNotes),
    ctxFileSummaries: context?.includeFileSummaries === true,
    ctxFileFields: context?.includeFileFields ?? [],
    ctxFullFile: context?.includeFullFileContent === true,
    ctxHistory: context?.includeHistory === true,
    ctxStateHistory: context?.includeStateHistory === true
  };
}

let form = $state<Form>(formOf(existing));
let localError = $state<string | null>(null);

$effect(() => {
  form = formOf(existing);
  localError = null;
  void open;
});

const stateOptions = $derived(states.map((entry) => ({ value: entry.id, label: entry.name })));
const fieldOptions = $derived(
  fields.map((entry) => ({ value: entry.definition.key, label: entry.definition.name }))
);
const outgoingTransitions = $derived(
  existing ? transitions.filter((transition) => transition.fromStateId === existing.id) : []
);

function buildSystemAction(): SystemAction | undefined {
  switch (form.actionType) {
    case 'transition':
      return { type: 'transition', targetStateId: form.actionTargetStateId || undefined };
    case 'setFields': {
      try {
        const parsed = JSON.parse(form.actionValues) as Record<string, unknown>;
        return { type: 'setFields', values: parsed };
      } catch {
        localError = 'Set-field values must be valid JSON';
        return undefined;
      }
    }
    case 'emitEvent':
      return { type: 'emitEvent', name: form.actionName };
    case 'createTicket':
      return {
        type: 'createTicket',
        workflowId: form.actionWorkflowId,
        titleTemplate: form.actionTitleTemplate
      };
    case 'http':
      return { type: 'http', operationId: form.actionOperationId };
    case 'wait':
      return { type: 'wait', seconds: Number(form.actionSeconds) || 0 };
    default:
      return undefined;
  }
}

function save() {
  localError = null;
  if (form.name.trim() === '') {
    localError = 'A state needs a name.';
    return;
  }
  if (form.kind === 'agent' && form.agentId === '') {
    localError = 'Agent states must be bound to an agent.';
    return;
  }
  const systemAction = buildSystemAction();
  if (form.actionType !== '' && systemAction === undefined) return;
  const context = {
    includeTitle: form.ctxTitle,
    includeDescription: form.ctxDescription,
    fieldKeys: form.ctxFieldKeys,
    includeRecentNotes: form.ctxRecentNotes === '' ? undefined : Number(form.ctxRecentNotes),
    includeFileSummaries: form.ctxFileSummaries,
    includeFileFields: form.ctxFileFields,
    includeFullFileContent: form.ctxFullFile,
    includeHistory: form.ctxHistory,
    includeStateHistory: form.ctxStateHistory
  };
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    description: form.description === '' ? null : form.description,
    color: form.color === '' ? null : form.color,
    kind: form.kind,
    category: form.category,
    agentId: form.agentId === '' ? null : form.agentId,
    autoExecute: form.autoExecute,
    maxAttempts: Number(form.maxAttempts) || 1,
    timeoutSeconds: form.timeoutSeconds === '' ? null : Number(form.timeoutSeconds),
    failureStateId: form.failureStateId === '' ? null : form.failureStateId,
    humanGate: form.gateEnabled
      ? {
          enabled: true,
          allowedTransitionIds: form.gateTransitions,
          requiredFieldKeys: form.gateFields,
          requiredComment: form.gateComment,
          allowedRoles: form.gateRoles,
          allowedTeamIds: form.gateTeams,
          instructions: form.gateInstructions === '' ? undefined : form.gateInstructions
        }
      : { enabled: false },
    config: {
      systemAction,
      context,
      wipLimit: form.wipLimit === '' ? undefined : Number(form.wipLimit),
      runOncePerEntry: existing?.config?.runOncePerEntry,
      allowedToolKeys: existing?.config?.allowedToolKeys,
      slaSeconds: existing?.config?.slaSeconds
    }
  };
  onsave(body);
}
</script>

<Modal
  {open}
  title={existing ? `Edit ${existing.name}` : 'New state'}
  description="States define who acts, how context is assembled and when a human must decide."
  width="46rem"
  onclose={onclose}
>
  <div class="space-y-5">
    {#if localError ?? error}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{localError ?? error}</p>
    {/if}

    <section class="grid gap-3 sm:grid-cols-2">
      <Input value={form.name} oninput={(event) => (form.name = (event.currentTarget as HTMLInputElement).value)} label="Name" placeholder="Human review" />
      <Select
        label="Kind"
        value={form.kind}
        options={KINDS.map((kind) => ({ value: kind, label: kind }))}
        onchange={(event) => (form.kind = (event.currentTarget as HTMLSelectElement).value as StateKind)}
      />
      <Select
        label="Category"
        value={form.category}
        options={CATEGORIES.map((category) => ({ value: category, label: category }))}
        onchange={(event) =>
          (form.category = (event.currentTarget as HTMLSelectElement).value as StateCategory)}
      />
      <Input value={form.color} oninput={(event) => (form.color = (event.currentTarget as HTMLInputElement).value)} label="Colour" placeholder="oklch(…)" />
      <div class="sm:col-span-2">
        <Textarea value={form.description} oninput={(event) => (form.description = (event.currentTarget as HTMLTextAreaElement).value)} label="Description" rows={2} />
      </div>
    </section>

    <section class="grid gap-3 sm:grid-cols-2">
      <Select
        label="Agent binding"
        placeholder={form.kind === 'agent' ? 'Required' : 'None'}
        value={form.agentId}
        options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
        onchange={(event) => (form.agentId = (event.currentTarget as HTMLSelectElement).value)}
        hint={form.kind === 'agent' ? 'Agent states must name the agent that runs here.' : undefined}
      />
      <Select
        label="Failure state"
        placeholder="None"
        value={form.failureStateId}
        options={stateOptions}
        onchange={(event) => (form.failureStateId = (event.currentTarget as HTMLSelectElement).value)}
      />
      <Input
        type="number"
        label="Max attempts"
        min="1"
        max="20"
        value={form.maxAttempts}
        oninput={(event) => (form.maxAttempts = (event.currentTarget as HTMLInputElement).value)}
      />
      <Input
        type="number"
        label="Timeout (seconds)"
        min="5"
        max="3600"
        value={form.timeoutSeconds}
        oninput={(event) => (form.timeoutSeconds = (event.currentTarget as HTMLInputElement).value)}
      />
      <Input
        type="number"
        label="WIP limit"
        min="0"
        value={form.wipLimit}
        hint="Shown on the board column; 0 or empty means no limit."
        oninput={(event) => (form.wipLimit = (event.currentTarget as HTMLInputElement).value)}
      />
      <label class="mt-5 flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <input type="checkbox" bind:checked={form.autoExecute} />
        Auto-execute when the ticket enters this state
      </label>
    </section>

    <section class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Human gate
      </h3>
      <label class="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <input type="checkbox" bind:checked={form.gateEnabled} />
        Require a human decision to leave this state
      </label>
      {#if form.gateEnabled}
        <p class="text-[11px] text-[var(--color-ink-subtle)]">
          Agents cannot transition out of a gated state, even when every outgoing transition is
          configured.
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <MultiSelect
            label="Allowed transitions"
            selected={form.gateTransitions}
            options={outgoingTransitions.map((transition) => ({
              value: transition.id,
              label: transition.name
            }))}
            onchange={(value) => (form.gateTransitions = value)}
          />
          <MultiSelect
            label="Required fields"
            selected={form.gateFields}
            options={fieldOptions}
            onchange={(value) => (form.gateFields = value)}
          />
          <MultiSelect
            label="Allowed roles"
            selected={form.gateRoles}
            options={ROLES.map((role) => ({ value: role, label: role }))}
            onchange={(value) => (form.gateRoles = value)}
          />
          <MultiSelect
            label="Allowed teams"
            selected={form.gateTeams}
            options={teams.map((team) => ({ value: team.id, label: team.name }))}
            onchange={(value) => (form.gateTeams = value)}
          />
        </div>
        <label class="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
          <input type="checkbox" bind:checked={form.gateComment} />
          Require a comment with the decision
        </label>
        <Textarea
          value={form.gateInstructions} oninput={(event) => (form.gateInstructions = (event.currentTarget as HTMLTextAreaElement).value)}
          label="Instructions for the reviewer"
          rows={2}
        />
      {/if}
    </section>

    <section class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Context selection
      </h3>
      <p class="text-[11px] text-[var(--color-ink-subtle)]">
        Everything included here is assembled into every model call for this state. More context is
        more tokens: full file content is the most expensive, field keys and titles the cheapest.
      </p>
      <div class="flex flex-wrap gap-3">
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={form.ctxTitle} /> Title
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={form.ctxDescription} /> Description
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={form.ctxFileSummaries} /> File summaries
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={form.ctxFullFile} /> Full file content
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={form.ctxHistory} /> Ticket history
        </label>
        <label class="flex items-center gap-1.5 text-xs">
          <input type="checkbox" bind:checked={form.ctxStateHistory} /> State history
        </label>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <MultiSelect
          label="Field keys"
          selected={form.ctxFieldKeys}
          options={fieldOptions}
          onchange={(value) => (form.ctxFieldKeys = value)}
        />
        <MultiSelect
          label="File fields"
          selected={form.ctxFileFields}
          options={fieldOptions}
          onchange={(value) => (form.ctxFileFields = value)}
        />
        <Input
          type="number"
          label="Recent notes to include"
          min="0"
          value={form.ctxRecentNotes}
          oninput={(event) => (form.ctxRecentNotes = (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
    </section>

    <section class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Deterministic action
      </h3>
      <Select
        label="System action"
        value={form.actionType}
        options={ACTION_TYPES.map((entry) => ({ value: entry.value, label: entry.label }))}
        onchange={(event) =>
          (form.actionType = (event.currentTarget as HTMLSelectElement)
            .value as Form['actionType'])}
      />
      {#if form.actionType === 'transition'}
        <Select
          label="Target state"
          placeholder="Choose a state"
          value={form.actionTargetStateId}
          options={stateOptions}
          onchange={(event) =>
            (form.actionTargetStateId = (event.currentTarget as HTMLSelectElement).value)}
        />
      {:else if form.actionType === 'setFields'}
        <Textarea value={form.actionValues} oninput={(event) => (form.actionValues = (event.currentTarget as HTMLTextAreaElement).value)} mono={true} label="Values (JSON)" rows={4} />
      {:else if form.actionType === 'emitEvent'}
        <Input value={form.actionName} oninput={(event) => (form.actionName = (event.currentTarget as HTMLInputElement).value)} label="Event name" />
      {:else if form.actionType === 'createTicket'}
        <Select
          label="Target workflow"
          placeholder="Choose a workflow"
          value={form.actionWorkflowId}
          options={workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))}
          onchange={(event) =>
            (form.actionWorkflowId = (event.currentTarget as HTMLSelectElement).value)}
        />
        <Input value={form.actionTitleTemplate} oninput={(event) => (form.actionTitleTemplate = (event.currentTarget as HTMLInputElement).value)} label="Title template" placeholder="{{title}}" />
      {:else if form.actionType === 'http'}
        <Input value={form.actionOperationId} oninput={(event) => (form.actionOperationId = (event.currentTarget as HTMLInputElement).value)} label="HTTP operation id" />
      {:else if form.actionType === 'wait'}
        <Input
          type="number"
          label="Seconds"
          min="1"
          value={form.actionSeconds}
          oninput={(event) => (form.actionSeconds = (event.currentTarget as HTMLInputElement).value)}
        />
      {/if}
      <div class="flex items-center gap-2">
        <Badge tone="muted">Deterministic</Badge>
        <span class="text-[11px] text-[var(--color-ink-subtle)]">
          System actions run without a model call.
        </span>
      </div>
    </section>
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" loading={saving} onclick={save}>
      {existing ? 'Save state' : 'Create state'}
    </Button>
  {/snippet}
</Modal>
