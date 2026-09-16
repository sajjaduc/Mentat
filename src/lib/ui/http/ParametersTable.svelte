<script lang="ts">
/**
 * ParametersTable: the path/query/header/body parameter editor.
 *
 * Each row is a small block rather than a table row, because a parameter carries
 * seven attributes and a wide table on a narrow screen hides the ones that matter.
 * `default` is parsed as JSON when it looks like JSON, so a numeric default stays a
 * number and validation does not reject the operation's own sample.
 */

import SelectField from './controls/SelectField.svelte';
import TextField from './controls/TextField.svelte';
import Toggle from './controls/Toggle.svelte';
import type { HttpParameterLocation, HttpParameterMapping } from './types';

interface Props {
  parameters?: HttpParameterMapping[];
  missingPath?: string[];
  showLocation?: boolean;
  locations?: HttpParameterLocation[];
  onchange?: (parameters: HttpParameterMapping[]) => void;
  emptyLabel?: string;
  addLabel?: string;
}

let {
  parameters = $bindable<HttpParameterMapping[]>([]),
  missingPath = [],
  showLocation = true,
  locations = ['path', 'query', 'header', 'body'],
  onchange,
  emptyLabel = 'No parameters yet. Add one for every value the model must supply.',
  addLabel = 'Add parameter'
}: Props = $props();

const locationOptions = [
  { value: 'path', label: 'Path' },
  { value: 'query', label: 'Query' },
  { value: 'header', label: 'Header' },
  { value: 'body', label: 'Body' }
];

const typeOptions = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'object', label: 'object' },
  { value: 'array', label: 'array' }
];

const missing = $derived(new Set(missingPath));

function commit(next: HttpParameterMapping[]) {
  parameters = next;
  onchange?.(next);
}

function add() {
  commit([
    ...parameters,
    { name: `param${parameters.length + 1}`, location: locations[0] ?? 'query', type: 'string' }
  ]);
}

function remove(index: number) {
  commit(parameters.filter((_, position) => position !== index));
}

function addMissing() {
  const declared = new Set(parameters.map((parameter) => parameter.name));
  const additions = missingPath
    .filter((name) => !declared.has(name))
    .map<HttpParameterMapping>((name) => ({
      name,
      location: 'path',
      required: true,
      type: 'string'
    }));
  if (additions.length > 0) commit([...parameters, ...additions]);
}

function defaultText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseDefault(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
</script>

<div class="space-y-3">
  {#if missingPath.length > 0}
    <div
      class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_6%,var(--color-surface))] px-3 py-2"
    >
      <p class="text-xs text-[var(--color-danger)]">
        The path template references {missingPath.join(', ')}, which
        {missingPath.length === 1 ? 'is' : 'are'} not declared.
      </p>
      <button
        type="button"
        class="rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-2.5 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
        onclick={addMissing}
      >
        Declare {missingPath.length === 1 ? 'it' : 'them'}
      </button>
    </div>
  {/if}

  {#if parameters.length === 0}
    <p
      class="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-subtle)] px-3 py-3 text-xs text-[var(--color-ink-subtle)]"
    >
      {emptyLabel}
    </p>
  {/if}

  {#each parameters as parameter, index (index)}
    <div
      class="space-y-3 rounded-[var(--radius-md)] border bg-[var(--color-surface)] p-3
        {missing.has(parameter.name)
        ? 'border-[var(--color-danger)]'
        : 'border-[var(--color-border-subtle)]'}"
    >
      <div class="flex flex-wrap items-end gap-3">
        <div class="min-w-[10rem] flex-1">
          <TextField
            label="Name"
            value={parameter.name}
            placeholder="id"
            onchange={(next) => (parameter.name = next)}
          />
        </div>
        {#if showLocation}
          <div class="w-32">
            <SelectField
              label="Location"
              options={locationOptions}
              value={parameter.location}
              onchange={(next) => (parameter.location = next as HttpParameterLocation)}
            />
          </div>
        {/if}
        <div class="pb-1.5">
          <Toggle
            checked={parameter.required === true}
            label="Required"
            onchange={(next) => (parameter.required = next)}
          />
        </div>
        <button
          type="button"
          class="mb-1 rounded-[var(--radius-sm)] p-1.5 text-[var(--color-ink-subtle)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-danger)]"
          aria-label={`Remove parameter ${parameter.name}`}
          onclick={() => remove(index)}
        >
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField
          label="Wire name"
          value={parameter.wireName ?? ''}
          placeholder={parameter.name}
          hint="Defaults to the parameter name."
          onchange={(next) => (parameter.wireName = next.length > 0 ? next : undefined)}
        />
        <SelectField
          label="Type"
          options={typeOptions}
          value={parameter.type ?? 'string'}
          onchange={(next) =>
            (parameter.type = next as HttpParameterMapping['type'])}
        />
        <TextField
          label="Default"
          value={defaultText(parameter.default)}
          placeholder="0"
          hint="Parsed as JSON when possible."
          onchange={(next) => (parameter.default = parseDefault(next))}
        />
      </div>

      <TextField
        label="Description"
        value={parameter.description ?? ''}
        placeholder="Shown to the model in the tool schema."
        onchange={(next) => (parameter.description = next.length > 0 ? next : undefined)}
      />
    </div>
  {/each}

  <button
    type="button"
    class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2.5 py-1.5 text-xs text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]"
    onclick={add}
  >
    {addLabel}
  </button>
</div>
