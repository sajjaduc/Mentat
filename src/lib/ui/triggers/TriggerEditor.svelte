<script lang="ts">
/**
 * TriggerEditor: create or edit one trigger.
 *
 * The editor keeps a local draft and saves explicitly. Editing an existing trigger
 * never sends its workflow or type — the server treats both as immutable — and a
 * visible dirty marker tells the operator whether the draft differs from what is
 * stored.
 */

import { api, describeApiError } from '$ui/api';
import Section from '$ui/http/controls/Section.svelte';
import Toggle from '$ui/http/controls/Toggle.svelte';
import { formatJson, parseJson } from '$ui/http/json';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import CronConfig from './CronConfig.svelte';
import { validateCronExpression } from './cron';
import ManualConfig from './ManualConfig.svelte';
import {
  TRIGGER_TYPE_HINTS,
  TRIGGER_TYPE_LABELS,
  type TriggerConfig,
  type TriggerMapping,
  type TriggerType,
  type TriggerView,
  type WorkflowOption,
  type WorkflowStateOption
} from './types';
import WebhookConfig from './WebhookConfig.svelte';

interface Props {
  trigger: TriggerView | null;
  workflows: WorkflowOption[];
  onsaved: (trigger: TriggerView) => void;
  oncancel: () => void;
}

let { trigger, workflows, onsaved, oncancel }: Props = $props();

const TYPES: TriggerType[] = ['webhook', 'cron', 'manual', 'api'];

// TriggerList remounts this editor per trigger, so the incoming props are an
// intentional snapshot: copy them once and edit the copy.
// svelte-ignore state_referenced_locally
const initial = trigger;
// svelte-ignore state_referenced_locally
const initialWorkflows = workflows;
const stored: TriggerConfig = initial?.config ?? {};

function normalizeMapping(source: TriggerMapping | undefined): TriggerMapping {
  return {
    ...(source ?? {}),
    fieldPaths: source?.fieldPaths ?? {},
    fieldTemplates: source?.fieldTemplates ?? {},
    labels: source?.labels ?? [],
    attachmentPaths: source?.attachmentPaths ?? []
  };
}

const initialMapping = normalizeMapping(stored.mapping);

let name = $state(initial?.name ?? '');
let description = $state(initial?.description ?? '');
let enabled = $state(initial?.enabled ?? true);
let type = $state<TriggerType>(initial?.type ?? 'webhook');
let workflowId = $state(initial?.workflowId ?? initialWorkflows[0]?.id ?? '');
let targetStateId = $state(initial?.targetStateId ?? '');
let upsertOnDedupe = $state(initial?.upsertOnDedupe ?? false);

let webhookSignatureRequired = $state(stored.signatureRequired ?? false);
let webhookSignatureHeader = $state(stored.signatureHeader ?? 'X-Mentat-Signature');
let webhookSignatureSecretId = $state(stored.signatureSecretId ?? '');
let webhookMaxPayloadBytes = $state(
  stored.maxPayloadBytes === undefined ? '' : String(stored.maxPayloadBytes)
);
let cronExpression = $state(stored.expression ?? '0 9 * * 1-5');
let cronTimezone = $state(stored.timezone ?? 'UTC');
let cronSkipIfRunning = $state(stored.skipIfRunning ?? false);
let inputSchemaText = $state(
  stored.inputSchema === undefined || stored.inputSchema === null
    ? ''
    : formatJson(stored.inputSchema)
);
let mapping = $state<TriggerMapping>({ ...initialMapping });

let saveBusy = $state(false);
let saveError = $state<string | null>(null);
let statesError = $state<string | null>(null);
let states = $state<WorkflowStateOption[]>([]);

const original = JSON.stringify({
  name: initial?.name ?? '',
  description: initial?.description ?? '',
  enabled: initial?.enabled ?? true,
  type: initial?.type ?? 'webhook',
  workflowId: initial?.workflowId ?? initialWorkflows[0]?.id ?? '',
  targetStateId: initial?.targetStateId ?? '',
  upsertOnDedupe: initial?.upsertOnDedupe ?? false,
  webhookSignatureRequired: stored.signatureRequired ?? false,
  webhookSignatureHeader: stored.signatureHeader ?? 'X-Mentat-Signature',
  webhookSignatureSecretId: stored.signatureSecretId ?? '',
  webhookMaxPayloadBytes:
    stored.maxPayloadBytes === undefined ? '' : String(stored.maxPayloadBytes),
  cronExpression: stored.expression ?? '0 9 * * 1-5',
  cronTimezone: stored.timezone ?? 'UTC',
  cronSkipIfRunning: stored.skipIfRunning ?? false,
  inputSchemaText:
    stored.inputSchema === undefined || stored.inputSchema === null
      ? ''
      : formatJson(stored.inputSchema),
  mapping: initialMapping
});

const dirty = $derived(
  JSON.stringify({
    name,
    description,
    enabled,
    type,
    workflowId,
    targetStateId,
    upsertOnDedupe,
    webhookSignatureRequired,
    webhookSignatureHeader,
    webhookSignatureSecretId,
    webhookMaxPayloadBytes,
    cronExpression,
    cronTimezone,
    cronSkipIfRunning,
    inputSchemaText,
    mapping
  }) !== original
);

const workflowOptions = $derived(
  workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))
);
const typeOptions = $derived(TYPES.map((value) => ({ value, label: TRIGGER_TYPE_LABELS[value] })));
const stateOptions = $derived(states.map((state) => ({ value: state.id, label: state.name })));

$effect(() => {
  const id = workflowId;
  if (!id) {
    states = [];
    statesError = null;
    return;
  }
  let cancelled = false;
  statesError = null;
  void api
    .get<{ states: WorkflowStateOption[] }>(`/api/workflows/${id}`)
    .then((result) => {
      if (!cancelled) states = result.states;
    })
    .catch((failure) => {
      if (!cancelled) statesError = describeApiError(failure);
    });
  return () => {
    cancelled = true;
  };
});

type BuildResult = { ok: true; config: TriggerConfig } | { ok: false; error: string };

function buildWebhookConfig(): BuildResult {
  if (webhookSignatureRequired && webhookSignatureSecretId.trim().length === 0) {
    return {
      ok: false,
      error: 'Choose a signature secret, or turn off the signature requirement.'
    };
  }
  let maxPayloadBytes: number | undefined;
  if (webhookMaxPayloadBytes.trim().length > 0) {
    const parsed = Number.parseInt(webhookMaxPayloadBytes, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ok: false, error: 'Max payload bytes must be a positive whole number.' };
    }
    maxPayloadBytes = parsed;
  }
  return {
    ok: true,
    config: {
      signatureRequired: webhookSignatureRequired,
      signatureHeader: webhookSignatureHeader.trim() || 'X-Mentat-Signature',
      signatureSecretId:
        webhookSignatureSecretId.trim().length > 0 ? webhookSignatureSecretId : undefined,
      maxPayloadBytes,
      mapping
    }
  };
}

function buildConfig(): BuildResult {
  if (type === 'webhook') return buildWebhookConfig();
  if (type === 'cron') {
    const cronError = validateCronExpression(cronExpression);
    if (cronError) return { ok: false, error: cronError };
    if (cronTimezone.trim().length === 0) return { ok: false, error: 'Choose a timezone.' };
    return {
      ok: true,
      config: {
        expression: cronExpression.trim(),
        timezone: cronTimezone,
        skipIfRunning: cronSkipIfRunning,
        mapping
      }
    };
  }
  const schema = parseJson(inputSchemaText);
  if (!schema.ok) return { ok: false, error: `Input schema: ${schema.error}` };
  return { ok: true, config: { inputSchema: schema.value ?? undefined } };
}

async function save() {
  if (name.trim().length === 0) {
    saveError = 'A name is required.';
    return;
  }
  if (!trigger && workflowId.trim().length === 0) {
    saveError = 'Choose a workflow for this trigger.';
    return;
  }
  const built = buildConfig();
  if (!built.ok) {
    saveError = built.error;
    return;
  }
  saveBusy = true;
  saveError = null;
  const body = {
    name: name.trim(),
    description: description.trim().length > 0 ? description.trim() : null,
    enabled,
    type,
    config: built.config,
    targetStateId: targetStateId.trim().length > 0 ? targetStateId : null,
    upsertOnDedupe
  };
  try {
    const result = trigger
      ? await api.patch<{ trigger: TriggerView }>(`/api/triggers/${trigger.id}`, body)
      : await api.post<{ trigger: TriggerView }>('/api/triggers', { ...body, workflowId });
    pushToast({
      tone: 'success',
      title: trigger ? 'Trigger saved' : 'Trigger created',
      description: result.trigger.name
    });
    onsaved(result.trigger);
  } catch (failure) {
    saveError = describeApiError(failure);
  } finally {
    saveBusy = false;
  }
}
</script>

<div class="space-y-5">
  <Section
    title="Basics"
    description="A trigger normalizes an inbound signal into a work item. Name it for the signal, not the integration."
  >
    <div class="grid gap-4 md:grid-cols-2">
      <Input
        label="Name"
        value={name}
        placeholder="Support inbox"
        oninput={(event) => (name = event.currentTarget.value)}
      />
      <div class="space-y-1.5">
        <Select
          label="Type"
          options={typeOptions}
          value={type}
          disabled={trigger !== null}
          onchange={(event) => (type = event.currentTarget.value as TriggerType)}
        />
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          {TRIGGER_TYPE_HINTS[type]}{trigger ? ' The type is fixed once a trigger exists.' : ''}
        </p>
      </div>
    </div>

    <Textarea
      label="Description"
      value={description}
      rows={2}
      placeholder="Creates a work item from each inbound support email."
      oninput={(event) => (description = event.currentTarget.value)}
    />

    <div class="grid gap-4 md:grid-cols-2">
      <div class="space-y-1.5">
        <Select
          label="Workflow"
          options={workflowOptions}
          value={workflowId}
          disabled={trigger !== null || workflowOptions.length === 0}
          placeholder={workflowOptions.length === 0 ? 'No workflows available' : undefined}
          onchange={(event) => {
            workflowId = event.currentTarget.value;
            targetStateId = '';
          }}
        />
        {#if workflowOptions.length === 0}
          <p class="text-xs text-[var(--color-danger)]">
            Create a workflow before adding a trigger.
          </p>
        {:else if trigger}
          <p class="text-xs text-[var(--color-ink-subtle)]">
            The workflow is fixed once a trigger exists.
          </p>
        {/if}
      </div>
      <div class="space-y-1.5">
        <Select
          label="Target state"
          placeholder="Workflow's start state"
          options={stateOptions}
          value={targetStateId}
          onchange={(event) => (targetStateId = event.currentTarget.value)}
        />
        {#if statesError}
          <p class="text-xs text-[var(--color-danger)]">{statesError}</p>
        {:else if workflowId && stateOptions.length === 0}
          <p class="text-xs text-[var(--color-ink-subtle)]">
            No states found for this workflow; the start state will be used.
          </p>
        {/if}
      </div>
    </div>

    <Toggle
      bind:checked={enabled}
      label="Enabled"
      hint="A disabled trigger is kept and editable but rejects deliveries and never fires."
    />
    <Toggle
      bind:checked={upsertOnDedupe}
      label="Update on duplicate"
      hint="When a dedupe key matches an existing work item, refresh that work item instead of skipping the delivery."
    />
  </Section>

  {#if type === 'webhook'}
    <Section
      title="Webhook"
      description="An external system POSTs a payload to the trigger's public URL."
    >
      <WebhookConfig
        bind:signatureRequired={webhookSignatureRequired}
        bind:signatureHeader={webhookSignatureHeader}
        bind:signatureSecretId={webhookSignatureSecretId}
        bind:maxPayloadBytes={webhookMaxPayloadBytes}
        bind:mapping
        {workflows}
        triggerId={trigger?.id ?? null}
        {enabled}
      />
    </Section>
  {:else if type === 'cron'}
    <Section
      title="Schedule"
      description="Mentat fires this trigger on a persisted, timezone-aware cron schedule."
    >
      <CronConfig
        bind:expression={cronExpression}
        bind:timezone={cronTimezone}
        bind:skipIfRunning={cronSkipIfRunning}
        bind:mapping
        {workflows}
        {enabled}
      />
    </Section>
  {:else}
    <Section
      title={type === 'api' ? 'API input' : 'Manual input'}
      description={TRIGGER_TYPE_HINTS[type]}
    >
      <ManualConfig
        bind:inputSchema={inputSchemaText}
        triggerId={trigger?.id ?? null}
        {enabled}
        {type}
      />
    </Section>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-subtle)] pt-4">
    <div class="flex items-center gap-2">
      {#if dirty}
        <Badge tone="caution" dot>Unsaved changes</Badge>
      {:else}
        <span class="text-xs text-[var(--color-ink-subtle)]">No unsaved changes</span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <Button variant="ghost" onclick={oncancel}>Cancel</Button>
      <Button variant="primary" loading={saveBusy} disabled={!dirty && trigger !== null} onclick={save}>
        {trigger ? 'Save changes' : 'Create trigger'}
      </Button>
    </div>
  </div>

  {#if saveError}
    <p
      class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]"
      role="alert"
    >
      {saveError}
    </p>
  {/if}
</div>
