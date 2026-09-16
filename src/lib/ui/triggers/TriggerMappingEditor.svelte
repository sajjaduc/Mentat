<script lang="ts">
/**
 * TriggerMappingEditor: the declarative payload → ticket mapping.
 *
 * A mapping is data, not code. Dot-paths select a value out of the incoming
 * payload, `{{path.to.value}}` templates compose several of them, and typed fields
 * are filled by key. The editor edits that data and never emits a script.
 *
 * The strictness note is load-bearing: a title, dedupe key or field template that
 * references a path the payload does not contain fails the delivery. Silently
 * creating an empty ticket is the failure mode this mapping exists to prevent.
 */

import { api, describeApiError } from '$ui/api';
import KeyValueEditor from '$ui/http/controls/KeyValueEditor.svelte';
import TagsInput from '$ui/http/controls/TagsInput.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import type { TriggerMapping, WorkflowOption, WorkflowStateOption } from './types';

interface Props {
  mapping?: TriggerMapping;
  workflows: WorkflowOption[];
}

let { mapping = $bindable({}), workflows }: Props = $props();

type OptionalTextKey =
  | 'titlePath'
  | 'titleTemplate'
  | 'descriptionPath'
  | 'descriptionTemplate'
  | 'priorityPath'
  | 'ownerUserId'
  | 'ownerTeamId'
  | 'dedupeTemplate'
  | 'parentTicketPath';

let fieldPaths = $state<Record<string, string>>(mapping.fieldPaths ?? {});
let fieldTemplates = $state<Record<string, string>>(mapping.fieldTemplates ?? {});
let labels = $state<string[]>(mapping.labels ?? []);
let attachmentPaths = $state<string[]>(mapping.attachmentPaths ?? []);

let states = $state<WorkflowStateOption[]>([]);
let statesLoading = $state(false);
let statesError = $state<string | null>(null);

// The shared controls bind to local collections; one effect publishes them back
// onto the mapping object the parent will save. It never reads `mapping`'s other
// keys, so it cannot loop with itself.
$effect(() => {
  mapping.fieldPaths = fieldPaths;
  mapping.fieldTemplates = fieldTemplates;
  mapping.labels = labels;
  mapping.attachmentPaths = attachmentPaths;
});

// States belong to the target workflow, which may differ from the trigger's own.
$effect(() => {
  const workflowId = mapping.targetWorkflowId;
  if (!workflowId) {
    states = [];
    statesError = null;
    statesLoading = false;
    return;
  }
  let cancelled = false;
  statesLoading = true;
  statesError = null;
  void api
    .get<{ states: WorkflowStateOption[] }>(`/api/workflows/${workflowId}`)
    .then((result) => {
      if (!cancelled) states = result.states;
    })
    .catch((failure) => {
      if (!cancelled) statesError = describeApiError(failure);
    })
    .finally(() => {
      if (!cancelled) statesLoading = false;
    });
  return () => {
    cancelled = true;
  };
});

function setText(key: OptionalTextKey, value: string) {
  mapping[key] = value.trim().length > 0 ? value : undefined;
}

const workflowOptions = $derived(
  workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))
);

const stateOptions = $derived(states.map((state) => ({ value: state.id, label: state.name })));

function onWorkflowChange(value: string) {
  mapping.targetWorkflowId = value.length > 0 ? value : undefined;
  // A state id from the previous workflow is meaningless in the new one.
  mapping.targetStateId = undefined;
}

const textHint = 'Use a dot path such as data.customer.email, or a list index such as items[0].id.';
</script>

<div class="space-y-4">
  <p class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-subtle)]">
    Templates use <code class="font-mono">&#123;&#123;path.to.value&#125;&#125;</code> to read the incoming payload. A
    title, dedupe key or field template that references a path the payload does not contain
    fails the delivery instead of silently creating an empty ticket. Description templates
    are lenient: a missing optional value simply produces no description.
  </p>

  <div class="grid gap-4 md:grid-cols-2">
    <Input
      label="Title path"
      value={mapping.titlePath ?? ''}
      placeholder="data.subject"
      hint="A single payload value used verbatim as the ticket title."
      oninput={(event) => setText('titlePath', event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Title template"
      value={mapping.titleTemplate ?? ''}
      placeholder="&#123;&#123;customer.name&#125;&#125;: &#123;&#123;data.subject&#125;&#125;"
      hint="Composed title. Overrides the title path when set."
      oninput={(event) => setText('titleTemplate', event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Description path"
      value={mapping.descriptionPath ?? ''}
      placeholder="data.body"
      oninput={(event) => setText('descriptionPath', event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Description template"
      value={mapping.descriptionTemplate ?? ''}
      placeholder="From &#123;&#123;from.email&#125;&#125;"
      oninput={(event) => setText('descriptionTemplate', event.currentTarget.value)}
      class="font-mono"
    />
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    <Select
      label="Target workflow"
      placeholder="Use the trigger's workflow"
      options={workflowOptions}
      value={mapping.targetWorkflowId ?? ''}
      hint="Send the mapped ticket to a different workflow than the trigger's own."
      onchange={(event) => onWorkflowChange(event.currentTarget.value)}
    />
    <div class="space-y-1.5">
      <Select
        label="Target state"
        placeholder="Use the workflow's start state"
        options={stateOptions}
        value={mapping.targetStateId ?? ''}
        disabled={statesLoading || stateOptions.length === 0}
        onchange={(event) => {
          const value = event.currentTarget.value;
          mapping.targetStateId = value.length > 0 ? value : undefined;
        }}
      />
      {#if statesLoading}
        <p class="text-xs text-[var(--color-ink-subtle)]">Loading states…</p>
      {:else if statesError}
        <p class="text-xs text-[var(--color-danger)]">{statesError}</p>
      {:else if mapping.targetWorkflowId && stateOptions.length === 0}
        <p class="text-xs text-[var(--color-ink-subtle)]">That workflow has no states to choose from.</p>
      {/if}
    </div>
  </div>

  <div class="grid gap-4 md:grid-cols-3">
    <Input
      label="Priority path"
      value={mapping.priorityPath ?? ''}
      placeholder="data.priority"
      hint="Must resolve to low, normal, high or urgent."
      oninput={(event) => setText('priorityPath', event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Owner user id"
      value={mapping.ownerUserId ?? ''}
      placeholder="usr_…"
      hint="Assign every mapped ticket to this user."
      oninput={(event) => setText('ownerUserId', event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Owner team id"
      value={mapping.ownerTeamId ?? ''}
      placeholder="team_…"
      hint="Assign every mapped ticket to this team."
      oninput={(event) => setText('ownerTeamId', event.currentTarget.value)}
      class="font-mono"
    />
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    <div class="space-y-1.5">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Ticket fields from payload paths</p>
      <KeyValueEditor
        bind:value={fieldPaths}
        keyLabel="Field key"
        valueLabel="Payload path"
        keyPlaceholder="customer_email"
        valuePlaceholder="data.customer.email"
        addLabel="Add field"
        emptyLabel="No field paths yet."
      />
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">{textHint}</p>
    </div>
    <div class="space-y-1.5">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Ticket fields from templates</p>
      <KeyValueEditor
        bind:value={fieldTemplates}
        keyLabel="Field key"
        valueLabel="Template"
        keyPlaceholder="summary"
        valuePlaceholder="&#123;&#123;data.subject&#125;&#125; (&#123;&#123;from.email&#125;&#125;)"
        addLabel="Add field"
        emptyLabel="No field templates yet."
      />
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Field templates are strict: every referenced path must exist in the payload.
      </p>
    </div>
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    <TagsInput
      bind:values={labels}
      label="Labels"
      placeholder="urgent, from-webhook"
      hint="Applied by name; Mentat creates a label that does not exist yet."
      emptyLabel="No labels."
    />
    <TagsInput
      bind:values={attachmentPaths}
      label="Attachment paths"
      placeholder="data.attachments"
      hint="Each path resolves to one attachment object or an array of them."
      emptyLabel="No attachment paths."
    />
  </div>

  <div class="grid gap-4 md:grid-cols-2">
    <Input
      label="Dedupe template"
      value={mapping.dedupeTemplate ?? ''}
      placeholder="&#123;&#123;data.ticket_id&#125;&#125;"
      hint="Same key means the same ticket. Pair with “Update on duplicate” to refresh it."
      oninput={(event) => setText('dedupeTemplate', event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Parent ticket path"
      value={mapping.parentTicketPath ?? ''}
      placeholder="data.parent_ticket_id"
      hint="Must resolve to an existing ticket id."
      oninput={(event) => setText('parentTicketPath', event.currentTarget.value)}
      class="font-mono"
    />
  </div>
</div>
