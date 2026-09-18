<script lang="ts">
/**
 * ManualConfig: a typed, on-demand entry point.
 *
 * The input schema is a JSON Schema subset the server validates against `required`
 * and `properties[].type`. Firing posts the payload through the same event path a
 * webhook uses, so mapping, dedupe and audit cannot drift between the two.
 */

import { api, describeApiError } from '$ui/api';
import JsonTextarea from '$ui/http/controls/JsonTextarea.svelte';
import { formatJson, parseJson, sampleFromSchema } from '$ui/http/json';
import Button from '$ui/primitives/Button.svelte';
import type { FireResult, TriggerType } from './types';

interface Props {
  inputSchema?: string;
  triggerId?: string | null;
  enabled: boolean;
  type: TriggerType;
}

let { inputSchema = $bindable(''), triggerId = null, enabled, type }: Props = $props();

function asText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function prefill(schemaText: string): string {
  const parsed = parseJson(schemaText);
  if (!parsed.ok) return '';
  const sample = sampleFromSchema(parsed.value);
  if (sample === null || sample === undefined) return '';
  return formatJson(sample);
}

let inputText = $state(prefill(inputSchema));
let fireBusy = $state(false);
let fireResult = $state<FireResult | null>(null);
let fireError = $state<string | null>(null);

function regenerate() {
  inputText = prefill(inputSchema);
  fireError = null;
  fireResult = null;
}

async function fire() {
  if (!triggerId) return;
  const parsed = parseJson(inputText);
  if (!parsed.ok) {
    fireError = `Input payload: ${parsed.error}`;
    return;
  }
  const input = parsed.value;
  if (input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    fireError = 'The input payload must be a JSON object.';
    return;
  }
  fireBusy = true;
  fireError = null;
  fireResult = null;
  try {
    const result = await api.post<FireResult>(`/api/triggers/${triggerId}/fire`, {
      input: input ?? {}
    });
    fireResult = result;
  } catch (failure) {
    fireError = describeApiError(failure);
  } finally {
    fireBusy = false;
  }
}

const noun = $derived(type === 'api' ? 'API caller' : 'person');
</script>

<div class="space-y-5">
  <JsonTextarea
    bind:value={inputSchema}
    label="Input schema"
    rows={9}
    hint="Optional JSON Schema. The server checks required keys and the declared types before firing."
    placeholder={'{\n  "type": "object",\n  "required": ["subject"],\n  "properties": {\n    "subject": { "type": "string" }\n  }\n}'}
  />

  <div class="space-y-2 border-t border-[var(--color-border-subtle)] pt-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p class="text-sm font-semibold text-[var(--color-ink)]">Fire this trigger</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Fires the trigger as if a {noun} had started the work. The mapping on this trigger
          turns the payload into a work item.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button size="sm" variant="ghost" onclick={regenerate}>Prefill from schema</Button>
        <Button
          size="sm"
          variant="primary"
          loading={fireBusy}
          disabled={!triggerId || !enabled}
          onclick={fire}
          title={!triggerId
            ? 'Save the trigger before firing it'
            : !enabled
              ? 'This trigger is disabled'
              : 'Fire the trigger'}
        >
          Fire
        </Button>
      </div>
    </div>

    {#if !triggerId}
      <p class="text-xs text-[var(--color-ink-subtle)]">Save the trigger to enable firing.</p>
    {:else if !enabled}
      <p class="text-xs text-[var(--color-ink-subtle)]">This trigger is disabled.</p>
    {/if}

    <JsonTextarea
      bind:value={inputText}
      label="Input payload"
      rows={9}
      hint="The JSON object posted to the trigger. It is validated against the schema above."
      placeholder={'{\n  "subject": "…"\n}'}
    />

    {#if fireError}
      <p
        class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]"
        role="alert"
      >
        {fireError}
      </p>
    {/if}

    {#if fireResult}
      <div class="space-y-1 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-3">
        <p class="text-xs font-medium text-[var(--color-positive)]">
          {fireResult['duplicate'] === true ? 'Duplicate delivery ignored' : 'Trigger fired'}
        </p>
        <dl class="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
          <div class="flex min-w-0 items-center gap-1.5">
            <dt class="text-[var(--color-ink-subtle)]">Event</dt>
            <dd class="truncate font-mono text-[var(--color-ink-muted)]">{asText(fireResult['eventId'])}</dd>
          </div>
          <div class="flex min-w-0 items-center gap-1.5">
            <dt class="text-[var(--color-ink-subtle)]">Status</dt>
            <dd class="truncate font-mono text-[var(--color-ink-muted)]">{asText(fireResult['status'])}</dd>
          </div>
          <div class="flex min-w-0 items-center gap-1.5">
            <dt class="text-[var(--color-ink-subtle)]">Job</dt>
            <dd class="truncate font-mono text-[var(--color-ink-muted)]">{asText(fireResult['jobId'])}</dd>
          </div>
          <div class="flex min-w-0 items-center gap-1.5">
            <dt class="text-[var(--color-ink-subtle)]">Work item</dt>
            <dd class="truncate font-mono text-[var(--color-ink-muted)]">{asText(fireResult['workflowItemId'])}</dd>
          </div>
        </dl>
        {#if typeof fireResult['error'] === 'string'}
          <p class="text-xs text-[var(--color-danger)]">{fireResult['error']}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
