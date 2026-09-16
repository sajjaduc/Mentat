<script lang="ts">
/**
 * Cross-workflow transfer dialog.
 *
 * Moving a ticket between workflows is a controlled operation, so the dialog shows
 * the preview before it acts: the policy verdict, which fields carry over, which
 * destination fields are still unsatisfied and which source fields have no home.
 * A refusal is explained in place rather than as a lost toast.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import type { TransferPreview, WorkflowFieldView, WorkflowListItem } from '$ui/work/types';

interface Props {
  open: boolean;
  ticketId: string;
  currentWorkflowId: string;
  onclose: () => void;
  onTransfer: (input: {
    targetWorkflowId: string;
    targetStateId?: string;
    reason?: string;
    fieldMappings?: Record<string, string>;
  }) => Promise<void>;
}

let { open, ticketId, currentWorkflowId, onclose, onTransfer }: Props = $props();

let workflows = $state<WorkflowListItem[]>([]);
let targetId = $state('');
let preview = $state<TransferPreview | null>(null);
let targetFields = $state<WorkflowFieldView[]>([]);
let sourceFields = $state<WorkflowFieldView[]>([]);
let targetStateId = $state('');
let mappings = $state<Array<{ source: string; target: string }>>([]);
let reason = $state('');
let loading = $state(false);
let previewError = $state<string | null>(null);
let submitting = $state(false);
let failure = $state<string | null>(null);

$effect(() => {
  if (!open) return;
  void initialise();
});

async function initialise() {
  loading = true;
  previewError = null;
  failure = null;
  try {
    const response = await api.get<{ workflows: WorkflowListItem[] }>('/api/workflows');
    workflows = response.workflows.filter(
      (workflow) => workflow.id !== currentWorkflowId && workflow.archivedAt === null
    );
    const fields = await api.get<{ fields: WorkflowFieldView[] }>(
      `/api/workflows/${currentWorkflowId}/fields`
    );
    sourceFields = fields.fields;
  } catch (error) {
    previewError = describeApiError(error);
  } finally {
    loading = false;
  }
}

async function chooseTarget(id: string) {
  targetId = id;
  preview = null;
  previewError = null;
  failure = null;
  if (id === '') return;
  loading = true;
  try {
    const response = await api.post<TransferPreview>(`/api/tickets/${ticketId}/transfer-preview`, {
      targetWorkflowId: id
    });
    preview = response;
    mappings = response.mapped.map((entry) => ({ ...entry }));
    const fields = await api.get<{ fields: WorkflowFieldView[] }>(`/api/workflows/${id}/fields`);
    targetFields = fields.fields;
    targetStateId = response.defaultTargetStateId ?? response.targetWorkflow.states[0]?.id ?? '';
  } catch (error) {
    previewError = describeApiError(error);
  } finally {
    loading = false;
  }
}

async function submit() {
  if (targetId === '') return;
  submitting = true;
  failure = null;
  const mappingRecord: Record<string, string> = {};
  for (const mapping of mappings) {
    if (mapping.source !== '' && mapping.target !== '')
      mappingRecord[mapping.source] = mapping.target;
  }
  try {
    await onTransfer({
      targetWorkflowId: targetId,
      targetStateId: targetStateId === '' ? undefined : targetStateId,
      reason: reason.trim() === '' ? undefined : reason.trim(),
      fieldMappings: Object.keys(mappingRecord).length > 0 ? mappingRecord : undefined
    });
    onclose();
  } catch (error) {
    failure = describeApiError(error);
  } finally {
    submitting = false;
  }
}

const sourceKeyOptions = $derived([
  { value: '', label: '—' },
  ...sourceFields.map((field) => ({ value: field.definition.key, label: field.definition.name }))
]);
const targetKeyOptions = $derived([
  { value: '', label: '—' },
  ...targetFields.map((field) => ({ value: field.definition.key, label: field.definition.name }))
]);
</script>

<Modal
  {open}
  title="Transfer ticket"
  description="Move this ticket to another workflow. Identity, notes, artifacts and history are preserved."
  width="40rem"
  onclose={onclose}
>
  <div class="space-y-4">
    <Select
      label="Destination workflow"
      placeholder="Choose a workflow"
      value={targetId}
      options={workflows.map((workflow) => ({
        value: workflow.id,
        label: `${workflow.name} (${workflow.ticketCount} tickets)`
      }))}
      onchange={(event) => chooseTarget((event.currentTarget as HTMLSelectElement).value)}
    />

    {#if previewError}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{previewError}</p>
    {/if}

    {#if preview}
      <div class="space-y-3">
        {#if !preview.policy.allowed}
          <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] p-2 text-xs text-[var(--color-danger)]">
            {preview.policy.reason ?? 'This transfer is not allowed.'}
          </p>
        {:else if preview.policy.requiresApproval}
          <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-caution)_14%,transparent)] p-2 text-xs text-[var(--color-ink)]">
            Transfers out of this workflow require approval. The request will be recorded and must
            be approved before the move applies.
          </p>
        {/if}

        <div class="grid gap-3 sm:grid-cols-2">
          <Select
            label="Destination state"
            value={targetStateId}
            options={preview.targetWorkflow.states.map((state) => ({
              value: state.id,
              label: state.name
            }))}
            onchange={(event) => (targetStateId = (event.currentTarget as HTMLSelectElement).value)}
          />
          <div class="space-y-1 text-xs">
            <p class="font-medium text-[var(--color-ink-muted)]">Field compatibility</p>
            <div class="flex flex-wrap gap-1">
              <Badge tone="positive">{preview.compatible.length} carry over</Badge>
              <Badge tone="accent">{preview.mapped.length} mapped</Badge>
              <Badge tone="caution">{preview.sourceOnly.length} source-only</Badge>
            </div>
          </div>
        </div>

        {#if preview.destinationRequired.length > 0}
          <div class="text-xs">
            <p class="font-medium text-[var(--color-ink-muted)]">Required in destination</p>
            <ul class="mt-1 space-y-0.5">
              {#each preview.destinationRequired as required (required.key)}
                <li class="flex items-center gap-1.5">
                  <span class={required.satisfied ? 'text-[var(--color-positive)]' : 'text-[var(--color-danger)]'}>
                    {required.satisfied ? '✓' : '✕'}
                  </span>
                  {required.name}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

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
                  options={sourceKeyOptions}
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
                  options={targetKeyOptions}
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

        {#if preview.sourceOnly.length > 0}
          <p class="text-[11px] text-[var(--color-ink-subtle)]">
            Values for {preview.sourceOnly.join(', ')} stay in history but are not active in the
            destination workflow.
          </p>
        {/if}

        <Textarea value={reason} oninput={(event) => (reason = (event.currentTarget as HTMLTextAreaElement).value)} label="Reason" rows={2} placeholder="Why is this moving?" />
      </div>
    {/if}

    {#if failure}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{failure}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button
      variant="primary"
      disabled={preview === null || !preview.policy.allowed || loading}
      loading={submitting}
      onclick={submit}
    >
      Transfer ticket
    </Button>
  {/snippet}
</Modal>
