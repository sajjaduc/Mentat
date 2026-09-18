<script lang="ts">
/**
 * Shared Zod schema box.
 *
 * One authoring surface for every place a Zod contract lives — Object Types,
 * workflow overlays and workflow states. The source is formatted on blur, tested
 * against a JSON sample before saving, and only a passing test enables Save, so the
 * schema the engine later runs is the one the author saw working.
 */
import { untrack } from 'svelte';
import { describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { schemaApi } from '$ui/schema/api';
import {
  describeDefaultValue,
  describeFieldChoices,
  describeFieldValidation
} from '$ui/schema/field-summary';
import { formatZodSource } from '$ui/schema/format-zod';
import type { ZodSchemaTestResult } from '$ui/schema/types';

interface Props {
  /** The currently persisted source; seeds the draft and marks it "saved". */
  value: string;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  saving?: boolean;
  saveLabel?: string;
  /** Test button label; defaults to "Test against JSON". */
  testLabel?: string;
  /**
   * A source to prefill when nothing is saved yet (for example a schema generated
   * from legacy typed fields). Setting it replaces the draft without marking it saved.
   */
  draftSeed?: string;
  /** Persist validated source. Throwing surfaces an inline error. */
  onSave: (source: string) => Promise<void> | void;
}

let {
  value,
  label = 'Zod schema',
  hint = 'The schema is the contract: it is stored verbatim and compiled when records are validated.',
  placeholder = 'z.object({\n  name: z.string(),\n  amount: z.number().min(0)\n})',
  disabled = false,
  saving = false,
  saveLabel = 'Save schema',
  testLabel = 'Test against JSON',
  draftSeed = '',
  onSave
}: Props = $props();

const EMPTY_SAMPLE = '{}';

let draft = $state(untrack(() => value ?? ''));
let lastValue = $state(untrack(() => value ?? ''));
let sample = $state(EMPTY_SAMPLE);
let sampleError = $state<string | null>(null);
let testError = $state<string | null>(null);
let result = $state<ZodSchemaTestResult | null>(null);
let testing = $state(false);
let saveError = $state<string | null>(null);
let testedSource = $state('');
let lastSeed = $state('');

/** The draft is only saveable after it has been tested as-is. */
const tested = $derived(testedSource !== '' && testedSource === draft.trim());
const valid = $derived(tested && result?.ok === true && (result?.invalidKeys.length ?? 0) === 0);
const dirty = $derived(draft.trim() !== (value ?? '').trim());
const saved = $derived((value ?? '').trim() !== '' && !dirty);

$effect(() => {
  const next = value ?? '';
  if (next !== lastValue) {
    lastValue = next;
    draft = next;
    result = null;
    testedSource = '';
    saveError = null;
  }
});

$effect(() => {
  const seed = draftSeed ?? '';
  if (seed !== '' && seed !== lastSeed) {
    lastSeed = seed;
    draft = seed;
    result = null;
    testedSource = '';
    saveError = null;
  }
});

function onInput(next: string) {
  draft = next;
  if (next.trim() !== testedSource) result = null;
  saveError = null;
}

function format() {
  const formatted = formatZodSource(draft);
  if (formatted !== draft) onInput(formatted);
}

async function runTest() {
  sampleError = null;
  testError = null;
  saveError = null;
  let parsed: unknown;
  try {
    parsed = sample.trim() === '' ? {} : JSON.parse(sample);
  } catch {
    sampleError = 'The sample is not valid JSON.';
    return;
  }
  testing = true;
  try {
    result = await schemaApi.test(draft, parsed);
    testedSource = draft.trim();
  } catch (failure) {
    testError = describeApiError(failure);
    result = null;
    testedSource = '';
  } finally {
    testing = false;
  }
}

async function save() {
  if (!valid) return;
  saveError = null;
  try {
    await onSave(draft.trim());
  } catch (failure) {
    saveError = describeApiError(failure);
  }
}
</script>

<div class="space-y-3" data-testid="zod-schema-box">
  <div class="flex flex-wrap items-end justify-between gap-2">
    <div class="min-w-0">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</p>
      <p class="mt-0.5 text-[11px] text-[var(--color-ink-subtle)]">{hint}</p>
    </div>
    <div class="flex items-center gap-2">
      {#if saved}
        <Badge tone="positive">Saved</Badge>
      {:else if dirty}
        <Badge tone="muted">Unsaved changes</Badge>
      {/if}
    </div>
  </div>

  <Textarea
    value={draft}
    oninput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
    onblur={format}
    {placeholder}
    {disabled}
    mono={true}
    rows={10}
    spellcheck="false"
    aria-label={label}
  />

  <div class="grid gap-3 lg:grid-cols-[1fr_1fr]">
    <div class="space-y-2">
      <Textarea
        value={sample}
        oninput={(event) => {
          sample = (event.currentTarget as HTMLTextAreaElement).value;
          sampleError = null;
        }}
        label="Sample JSON"
        hint="A JSON object to run the schema against. Nothing is saved by testing."
        placeholder={'{ "name": "Example", "amount": 10 }'}
        rows={4}
        mono={true}
        spellcheck="false"
      />
      {#if sampleError}
        <p class="text-xs text-[var(--color-danger)]" role="alert">{sampleError}</p>
      {/if}
    </div>

    <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2.5">
      <p class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Test result
      </p>
      {#if testing}
        <p class="mt-2 text-xs text-[var(--color-ink-muted)]">Running…</p>
      {:else if testError}
        <p class="mt-2 text-xs text-[var(--color-danger)]" role="alert">{testError}</p>
      {:else if result === null}
        <p class="mt-2 text-xs text-[var(--color-ink-subtle)]">
          Test the schema against a sample to enable saving.
        </p>
      {:else if result.compiled === false}
        <p class="mt-2 text-xs text-[var(--color-danger)]" role="alert">{result.message}</p>
      {:else if result.ok}
        <div class="mt-2 space-y-1" data-testid="zod-test-success">
          <p class="text-xs text-[var(--color-positive)]">Valid — the sample satisfies the schema.</p>
          <pre class="max-h-32 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2 font-mono text-[11px] text-[var(--color-ink-muted)]">{JSON.stringify(result.data, null, 2)}</pre>
        </div>
      {:else}
        <div class="mt-2 space-y-1" data-testid="zod-test-issues">
          <p class="text-xs text-[var(--color-danger)]">
            {result.message ?? 'The sample does not satisfy the schema.'}
          </p>
          <ul class="space-y-0.5">
            {#each result.issues as issue, index (index)}
              <li class="text-[11px] text-[var(--color-danger)]">
                {#if issue.path}<span class="font-mono">{issue.path}</span>: {/if}{issue.message}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>

  {#if result?.invalidKeys && result.invalidKeys.length > 0}
    <p class="text-xs text-[var(--color-caution)]" role="alert">
      These keys cannot become field keys: {result.invalidKeys.join(', ')}. Rename them to
      lowercase letters, numbers and underscores starting with a letter.
    </p>
  {/if}

  {#if result?.fields && result.fields.length > 0}
    <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2.5">
      <p class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Fields this schema will create ({result.fields.length})
      </p>
      <ul class="mt-2 space-y-1.5">
        {#each result.fields as field (field.key)}
          {@const choices = describeFieldChoices(field.options)}
          {@const validation = describeFieldValidation(field.validation)}
          {@const fallback = describeDefaultValue(field.defaultValue)}
          <li
            class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] p-2"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-medium text-[var(--color-ink)]">{field.name}</span>
              <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{field.key}</span>
              <Badge tone={field.type === 'json' ? 'muted' : 'accent'}>{field.type}</Badge>
              <Badge tone={field.required ? 'neutral' : 'muted'}>
                {field.required ? 'required' : 'optional'}
              </Badge>
              {#if field.isIdentity}<Badge tone="caution">identity</Badge>{/if}
              {#if field.isPrimaryDisplay}<Badge tone="positive">primary</Badge>{/if}
              {#if !field.showInList}<Badge tone="muted">hidden in list</Badge>{/if}
              {#if field.showOnCard}<Badge tone="muted">on card</Badge>{/if}
              {#if !field.filterable}<Badge tone="muted">not filterable</Badge>{/if}
            </div>
            {#if field.description}
              <p class="mt-1 text-[11px] text-[var(--color-ink-muted)]">{field.description}</p>
            {/if}
            <div class="mt-1 space-y-0.5">
              {#if choices}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  Choices: <span class="text-[var(--color-ink-muted)]">{choices}</span>
                </p>
              {/if}
              {#if validation}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  Validation: <span class="font-mono">{validation}</span>
                </p>
              {/if}
              {#if fallback}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  Default: <span class="font-mono">{fallback}</span>
                </p>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      <p class="mt-2 text-[11px] text-[var(--color-ink-subtle)]">
        Use <span class="font-mono"
          >.meta({ '{' } identity: true, primary: true, list: false, card: true, filterable: false
          {'}' })</span
        >
        to control identity and display behaviour per field. Without
        <span class="font-mono">primary: true</span>, the first field becomes the record's display name
        when you save.
      </p>
    </div>
  {/if}

  {#if saveError}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{saveError}</p>
  {/if}

  <div class="flex flex-wrap items-center justify-end gap-2">
    {#if dirty}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onclick={() => {
          draft = value ?? '';
          result = null;
          testedSource = '';
          saveError = null;
        }}
      >
        Reset
      </Button>
    {/if}
    <Button size="sm" variant="secondary" loading={testing} disabled={disabled} onclick={runTest}>
      {testLabel}
    </Button>
    <Button
      size="sm"
      variant="primary"
      loading={saving}
      disabled={disabled || !valid}
      title={valid ? undefined : 'Test the schema against a sample first'}
      onclick={save}
    >
      {saveLabel}
    </Button>
  </div>
</div>
