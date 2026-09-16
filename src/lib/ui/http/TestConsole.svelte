<script lang="ts">
/**
 * TestConsole: the editor's Test Request path.
 *
 * "Send" deliberately differs from an agent invocation: a human asked for this call, so
 * approval is bypassed and the cache is ignored, while validation, redaction, rate
 * limiting, audit and logging all still apply and the log is marked as test traffic.
 * The input editor is prefilled from the operation's own schema so the first request is
 * usually already valid, and the response pane shows the redacted request the runtime
 * actually made — which is what the copy-as-cURL/fetch buttons render.
 */
import { browser } from '$app/environment';
import { formatDurationShort } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import { pushToast } from '$ui/toast';
import CodeBlock from './controls/CodeBlock.svelte';
import CopyButton from './controls/CopyButton.svelte';
import JsonTextarea from './controls/JsonTextarea.svelte';
import StatusBadge from './controls/StatusBadge.svelte';
import TextField from './controls/TextField.svelte';
import type { OperationDraft } from './draft';
import { sampleInput } from './draft';
import { formatJson, parseJson } from './json';
import { requestLabel, toCurl, toFetch } from './request-preview';
import type { TestRequestResult } from './types';

interface SavedExample {
  name: string;
  input: string;
  createdAt: number;
}

interface Props {
  operationId: string | null;
  draft: OperationDraft;
  result?: TestRequestResult | null;
  onSent?: () => void;
}

let {
  operationId,
  draft,
  result = $bindable<TestRequestResult | null>(null),
  onSent
}: Props = $props();

let inputText = $state('{}');
let sending = $state(false);
let localError = $state<string | null>(null);
let examples = $state<SavedExample[]>([]);
let exampleName = $state('');
let loadedFor = $state<string | null>(null);

const storageKey = $derived(operationId ? `mentat.http.examples.${operationId}` : null);

$effect(() => {
  const current = operationId;
  if (current === loadedFor) return;
  loadedFor = current;
  result = null;
  localError = null;
  inputText = formatJson(sampleInput(draft));
  if (!browser || !storageKey) {
    examples = [];
    return;
  }
  examples = readExamples(storageKey);
});

function readExamples(key: string): SavedExample[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry, index) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        name: typeof record.name === 'string' ? record.name : `Example ${index + 1}`,
        input: typeof record.input === 'string' ? record.input : '{}',
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0
      };
    });
  } catch {
    return [];
  }
}

function persist(next: SavedExample[]) {
  if (!browser || !storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked; examples are a convenience, not state.
  }
}

function resetFromSchema() {
  inputText = formatJson(sampleInput(draft));
  localError = null;
}

function saveExample() {
  const name =
    exampleName.trim().length > 0 ? exampleName.trim() : `Example ${examples.length + 1}`;
  const next = [...examples, { name, input: inputText, createdAt: Date.now() }];
  examples = next;
  persist(next);
  exampleName = '';
  pushToast({ tone: 'success', title: `Saved "${name}" in this browser` });
}

function deleteExample(index: number) {
  const next = examples.filter((_, position) => position !== index);
  examples = next;
  persist(next);
}

async function send() {
  if (!operationId) return;
  const parsed = parseJson(inputText);
  if (!parsed.ok) {
    localError = `Input is not valid JSON: ${parsed.error}`;
    return;
  }
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    localError = 'Input must be a JSON object.';
    return;
  }
  sending = true;
  localError = null;
  try {
    const next = await api.post<TestRequestResult>(`/api/http/operations/${operationId}/test`, {
      input: parsed.value,
      inferSchemaFromResponse: true
    });
    result = next;
    if (next.ok) {
      pushToast({
        tone: 'success',
        title: `HTTP ${next.status} in ${formatDurationShort(next.latencyMs)}`
      });
    } else {
      pushToast({ tone: 'error', title: next.error?.message ?? `HTTP ${next.status ?? 'error'}` });
    }
    onSent?.();
  } catch (failure) {
    localError = describeApiError(failure);
  } finally {
    sending = false;
  }
}

function headerText(headers: Record<string, string> | null | undefined): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}
</script>

<div class="space-y-4">
  <p
    class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]"
  >
    Test requests bypass approval and the cache, but validation, rate limits, redaction, audit and
    the request log all still apply. The exchange below is the redacted one Mentat recorded.
  </p>

  {#if !operationId}
    <p class="text-xs text-[var(--color-ink-subtle)]">
      Save this operation first; the test endpoint runs the persisted definition.
    </p>
  {/if}

  <div class="space-y-2">
    <JsonTextarea
      label="Input"
      bind:value={inputText}
      rows={10}
      placeholder={'{\n  "id": ""\n}'}
      hint="Prefilled from the operation's inferred schema."
    />
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="sm" loading={sending} disabled={!operationId} onclick={send}>
        Send
      </Button>
      <Button size="sm" variant="ghost" onclick={resetFromSchema}>Reset from schema</Button>
      <div class="ml-auto flex items-center gap-2">
        <TextField
          size="sm"
          value={exampleName}
          placeholder="Example name"
          onchange={(next) => (exampleName = next)}
        />
        <Button size="sm" variant="secondary" onclick={saveExample}>Save as example</Button>
      </div>
    </div>
    {#if localError}
      <p class="text-xs text-[var(--color-danger)]">{localError}</p>
    {/if}
  </div>

  {#if examples.length > 0}
    <div class="space-y-1.5">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Saved examples (this browser)</p>
      <ul class="flex flex-wrap gap-1.5">
        {#each examples as example, index (index)}
          <li
            class="flex items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-2 py-0.5"
          >
            <button
              type="button"
              class="text-[11px] text-[var(--color-ink)] hover:text-[var(--color-accent-ink)]"
              onclick={() => (inputText = example.input)}
            >
              {example.name}
            </button>
            <button
              type="button"
              class="text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
              aria-label={`Delete example ${example.name}`}
              onclick={() => deleteExample(index)}
            >
              <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
              </svg>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if result}
    <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge status={result.status} label={result.ok ? undefined : 'failed'} />
        <Badge tone={result.cacheStatus === 'hit' ? 'positive' : 'muted'}>cache {result.cacheStatus}</Badge>
        <span class="text-[11px] text-[var(--color-ink-subtle)]">
          {formatDurationShort(result.latencyMs)} · {result.attempts} attempt{result.attempts === 1 ? '' : 's'}
        </span>
        <span class="ml-auto font-mono text-[11px] text-[var(--color-ink-subtle)]">
          {requestLabel(result.request)}
        </span>
      </div>

      {#if result.error}
        <p class="text-xs text-[var(--color-danger)]">
          {result.error.code}: {result.error.message}
        </p>
      {/if}

      {#if result.retryTrace.length > 0}
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">Retry trace</p>
          <ul class="space-y-0.5">
            {#each result.retryTrace as entry, index (index)}
              <li class="font-mono text-[11px] text-[var(--color-ink-muted)]">
                attempt {entry.attempt}: {entry.status !== null && entry.status !== undefined
                  ? `HTTP ${entry.status}`
                  : (entry.error ?? 'transport error')}{entry.delayMs !== undefined
                  ? ` · waited ${formatDurationShort(entry.delayMs)}`
                  : ''}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <CodeBlock value={result.formattedBody} label="Response body" maxHeight="24rem" emptyLabel="Empty response body." />

      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">Redacted request</p>
          <div class="ml-auto flex items-center gap-1.5">
            <CopyButton text={toCurl(result.request)} label="Copy as cURL" />
            <CopyButton text={toFetch(result.request)} label="Copy as fetch" />
          </div>
        </div>
        <CodeBlock value={headerText(result.request.headers)} label="Request headers" maxHeight="12rem" />
        {#if result.request.body}
          <CodeBlock value={result.request.body} label="Request body" maxHeight="12rem" />
        {/if}
        <CodeBlock value={headerText(result.headers)} label="Response headers" maxHeight="12rem" />
      </div>
    </div>
  {/if}
</div>
