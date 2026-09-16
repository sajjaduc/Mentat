<script lang="ts">
/**
 * Typed field editor.
 *
 * Every one of the fifteen field types renders the control it deserves, validates
 * what it can locally (JSON syntax, numeric parse) and reports the value upward.
 * The parent owns persistence, which is what lets a write be applied optimistically
 * and rolled back with the server's validation message shown next to the field.
 */
import { untrack } from 'svelte';
import { formatDateTime } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import type { MemberOption, TeamOption, TicketFieldConfig } from '$ui/work/types';

interface Props {
  config: TicketFieldConfig;
  value: unknown;
  members?: MemberOption[];
  teams?: TeamOption[];
  error?: string | null;
  disabled?: boolean;
  onchange: (value: unknown) => void;
}

let {
  config,
  value,
  members = [],
  teams = [],
  error = null,
  disabled = false,
  onchange
}: Props = $props();

const editable = $derived(config.editable && !disabled);
let focused = $state(false);

function textOf(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'object') return JSON.stringify(input, null, 2);
  return String(input);
}

// Seeded once from the prop; the effect below re-syncs when the value changes.
let draft = $state(untrack(() => textOf(value)));
let localError = $state<string | null>(null);

$effect(() => {
  const next = textOf(value);
  if (!focused) draft = next;
});

function commitText() {
  focused = false;
  const trimmed = draft.trim();
  if (config.type === 'json') {
    if (trimmed === '') {
      localError = null;
      onchange(null);
      return;
    }
    try {
      JSON.parse(trimmed);
      localError = null;
      onchange(trimmed);
    } catch {
      localError = 'Must be valid JSON';
    }
    return;
  }
  if (config.type === 'number' || config.type === 'currency') {
    if (trimmed === '') {
      localError = null;
      onchange(null);
      return;
    }
    const numeric = Number(trimmed.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) {
      localError = 'Must be a number';
      return;
    }
    localError = null;
    onchange(numeric);
    return;
  }
  localError = null;
  onchange(trimmed === '' ? null : trimmed);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && config.type !== 'long_text' && config.type !== 'json') {
    event.preventDefault();
    (event.currentTarget as HTMLElement).blur();
  }
}

function dateValue(input: unknown): string {
  if (typeof input !== 'number' || !Number.isFinite(input)) return '';
  return new Date(input).toISOString().slice(0, 10);
}

function dateTimeValue(input: unknown): string {
  if (typeof input !== 'number' || !Number.isFinite(input)) return '';
  const date = new Date(input);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const selectedList = $derived<string[]>(
  Array.isArray(value) ? value.map((entry) => String(entry)) : []
);

function toggleChoice(entry: string) {
  const next = selectedList.includes(entry)
    ? selectedList.filter((item) => item !== entry)
    : [...selectedList, entry];
  onchange(next.length === 0 ? null : next);
}

const displayError = $derived(localError ?? error);
const choices = $derived(config.options?.choices ?? []);
</script>

<div class="flex flex-col gap-1.5">
  <div class="flex items-center justify-between gap-2">
    <span class="text-xs font-medium text-[var(--color-ink-muted)]">
      {config.name}
      {#if config.required}<span class="text-[var(--color-danger)]" aria-hidden="true">*</span>{/if}
    </span>
    {#if !config.editable}
      <Badge tone="muted">Read-only</Badge>
    {/if}
  </div>

  {#if config.type === 'long_text'}
    <Textarea
      value={draft}
      oninput={(event) => (draft = (event.currentTarget as HTMLTextAreaElement).value)}
      rows={4}
      disabled={!editable}
      error={displayError}
      onfocus={() => (focused = true)}
      onblur={commitText}
    />
  {:else if config.type === 'json'}
    <Textarea
      value={draft}
      oninput={(event) => (draft = (event.currentTarget as HTMLTextAreaElement).value)}
      mono={true}
      rows={5}
      disabled={!editable}
      error={displayError}
      onfocus={() => (focused = true)}
      onblur={commitText}
    />
  {:else if config.type === 'boolean'}
    <button
      type="button"
      role="switch"
      aria-checked={value === true}
      disabled={!editable}
      class="inline-flex h-8 w-fit items-center gap-2 rounded-full border px-2.5 text-xs transition-colors
        {value === true
        ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
        : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]'}"
      onclick={() => onchange(value === true ? false : true)}
    >
      <span
        class="h-3 w-3 rounded-full {value === true
          ? 'bg-[var(--color-accent)]'
          : 'bg-[var(--color-border-strong)]'}"
      ></span>
      {value === true ? 'Yes' : 'No'}
    </button>
    {#if displayError}<p class="text-xs text-[var(--color-danger)]">{displayError}</p>{/if}
  {:else if config.type === 'date'}
    <Input
      type="date"
      value={dateValue(value)}
      disabled={!editable}
      error={displayError}
      onchange={(event) => onchange((event.currentTarget as HTMLInputElement).value || null)}
    />
  {:else if config.type === 'datetime'}
    <Input
      type="datetime-local"
      value={dateTimeValue(value)}
      disabled={!editable}
      error={displayError}
      onchange={(event) => onchange((event.currentTarget as HTMLInputElement).value || null)}
    />
  {:else if config.type === 'select'}
    <Select
      options={choices.map((choice) => ({ value: choice.value, label: choice.label }))}
      value={value === null || value === undefined ? '' : String(value)}
      placeholder="Not set"
      disabled={!editable}
      error={displayError}
      onchange={(event) => onchange((event.currentTarget as HTMLSelectElement).value || null)}
    />
  {:else if config.type === 'multi_select'}
    <div class="flex flex-wrap gap-1.5">
      {#each choices as choice (choice.value)}
        <button
          type="button"
          disabled={!editable}
          aria-pressed={selectedList.includes(choice.value)}
          class="rounded-full border px-2 py-1 text-[11px] transition-colors
            {selectedList.includes(choice.value)
            ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
            : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'}"
          onclick={() => toggleChoice(choice.value)}
        >
          {choice.label}
        </button>
      {/each}
      {#if choices.length === 0}
        <p class="text-xs text-[var(--color-ink-subtle)]">This field has no options configured.</p>
      {/if}
    </div>
    {#if displayError}<p class="text-xs text-[var(--color-danger)]">{displayError}</p>{/if}
  {:else if config.type === 'user'}
    <Select
      options={members.map((member) => ({ value: member.userId, label: member.name }))}
      value={value === null || value === undefined ? '' : String(value)}
      placeholder="Unassigned"
      disabled={!editable}
      error={displayError}
      onchange={(event) => onchange((event.currentTarget as HTMLSelectElement).value || null)}
    />
  {:else if config.type === 'team'}
    <Select
      options={teams.map((team) => ({ value: team.id, label: team.name }))}
      value={value === null || value === undefined ? '' : String(value)}
      placeholder="No team"
      disabled={!editable}
      error={displayError}
      onchange={(event) => onchange((event.currentTarget as HTMLSelectElement).value || null)}
    />
  {:else}
    <Input
      type={config.type === 'email' ? 'email' : config.type === 'phone' ? 'tel' : config.type === 'url' ? 'url' : config.type === 'number' || config.type === 'currency' ? 'text' : 'text'}
      value={draft}
      oninput={(event) => (draft = (event.currentTarget as HTMLInputElement).value)}
      disabled={!editable}
      error={displayError}
      placeholder={config.options?.currency && config.type === 'currency' ? config.options.currency : undefined}
      onfocus={() => (focused = true)}
      onblur={commitText}
      onkeydown={onKeydown}
    />
  {/if}

  {#if value !== null && value !== undefined && config.type === 'datetime' && !displayError}
    <p class="text-[10px] text-[var(--color-ink-subtle)]">{formatDateTime(Number(value))}</p>
  {/if}
</div>
