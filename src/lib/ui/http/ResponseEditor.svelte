<script lang="ts">
/**
 * ResponseEditor: success rules, response selection and output mapping.
 *
 * Success is a policy, not a status code check: an API that returns 200 with
 * `{"error": true}` must be able to fail the operation, and an API that returns 404 for
 * "not found as data" must be able to succeed. The editor exposes exactly the knobs the
 * runtime's `evaluateSuccessRules` reads.
 */

import Button from '$ui/primitives/Button.svelte';
import CodeBlock from './controls/CodeBlock.svelte';
import KeyValueEditor from './controls/KeyValueEditor.svelte';
import TagsInput from './controls/TagsInput.svelte';
import TextField from './controls/TextField.svelte';
import type { OperationDraft } from './draft';

interface Props {
  draft: OperationDraft;
  onInfer: () => void;
  inferAvailable: boolean;
  inferring: boolean;
}

let { draft, onInfer, inferAvailable, inferring }: Props = $props();

function setStatusCodes(entries: string[]) {
  const codes = entries
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 100 && entry < 600);
  draft.successRules = { ...draft.successRules, statusCodes: codes.length > 0 ? codes : undefined };
}
</script>

<div class="space-y-5">
  <div class="space-y-3">
    <TagsInput
      label="Successful status codes"
      values={(draft.successRules.statusCodes ?? []).map(String)}
      placeholder="200"
      hint="Leave empty to accept any 2xx. Set this when the API uses a non-2xx success code."
      onchange={setStatusCodes}
    />
    <p class="text-xs text-[var(--color-ink-subtle)]">
      Default: any 2xx succeeds, everything else fails with the status as the error code.
    </p>
  </div>

  <div class="grid gap-3 sm:grid-cols-2">
    <TextField
      label="Fail when path is truthy"
      value={draft.successRules.failWhenPath ?? ''}
      placeholder="error"
      hint="A JSON path into the response; a non-empty value fails the call."
      onchange={(next) =>
        (draft.successRules = {
          ...draft.successRules,
          failWhenPath: next.length > 0 ? next : undefined
        })}
    />
    <TextField
      label="Fail when body contains"
      value={draft.successRules.failWhenBodyContains ?? ''}
      placeholder="insufficient_scope"
      hint="Case-insensitive substring check over the raw body."
      onchange={(next) =>
        (draft.successRules = {
          ...draft.successRules,
          failWhenBodyContains: next.length > 0 ? next : undefined
        })}
    />
  </div>

  <TextField
    label="Response body path"
    value={draft.responseMapping.bodyPath ?? ''}
    placeholder="data.contact"
    hint="Selects the subtree the model should see. Leave empty to pass the whole body."
    onchange={(next) =>
      (draft.responseMapping = {
        ...draft.responseMapping,
        bodyPath: next.length > 0 ? next : undefined
      })}
  />

  <div class="space-y-1.5">
    <p class="text-xs font-medium text-[var(--color-ink-muted)]">Output template</p>
    <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
      Rename or derive fields from the selected body. A value that is exactly one
      <code class="font-mono">{'{{placeholder}}'}</code> keeps the original type; anything else is
      rendered as text.
    </p>
    <KeyValueEditor
      value={draft.responseMapping.outputTemplate ?? {}}
      keyPlaceholder="email"
      valuePlaceholder={'{{profile.email}}'}
      onchange={(next) =>
        (draft.responseMapping = {
          ...draft.responseMapping,
          outputTemplate: Object.keys(next).length > 0 ? next : undefined
        })}
    />
  </div>

  <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="space-y-0.5">
        <p class="text-xs font-medium text-[var(--color-ink-muted)]">Output schema</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          The shape an agent is told to expect. Infer it from a real response and then review it —
          the inference is a starting point, not a contract.
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        loading={inferring}
        disabled={!inferAvailable}
        onclick={onInfer}
        title={inferAvailable ? 'Infer from the last test response' : 'Run a test request first'}
      >
        Infer output schema from last response
      </Button>
    </div>
    {#if !inferAvailable}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        Run a test request from the console to enable inference.
      </p>
    {/if}
    <CodeBlock
      value={draft.outputSchemaText}
      label="Current output schema"
      maxHeight="18rem"
      emptyLabel="No output schema declared."
    />
  </div>
</div>
