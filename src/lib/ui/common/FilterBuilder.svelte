<script lang="ts">
/**
 * FilterBuilder: edit the one filter AST (ADR-0012).
 *
 * The builder does not invent a query language. It edits the same serializable
 * JSON that `?filter=` carries, that a saved view stores and that a dashboard
 * widget runs, so what a user sees here is exactly what the server will compile.
 *
 * A raw JSON mode sits beside the structured editor for two reasons: it makes the
 * "one filter language" claim inspectable, and it is the escape hatch for an
 * operator or field kind this build does not know how to render.
 */

import {
  cloneFilter,
  countConditions,
  describeFilter,
  emptyGroup,
  FIELD_KIND_LABELS,
  FILE_SYSTEM_FIELDS,
  type FilterAst,
  type FilterFieldKind,
  type FilterGroup,
  isGroup,
  parseFilter,
  serializeFilter,
  TICKET_SYSTEM_FIELDS
} from '$ui/filters';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import FilterGroupEditor from './FilterGroupEditor.svelte';
import type { BuilderFieldOption } from './filter-tree';

interface Props {
  /** The current AST; `null` means "no filter". */
  value: FilterAst | null;
  /** Which kinds of condition this surface offers. */
  allow: FilterFieldKind[];
  /** File-scoped definitions from `GET /api/fields?scope=file`. */
  fileFields?: BuilderFieldOption[];
  /** Ticket-scoped definitions from `GET /api/fields?scope=ticket`. */
  ticketFields?: BuilderFieldOption[];
  workflowOptions?: Array<{ value: string; label: string }>;
  stateOptions?: Array<{ value: string; label: string }>;
  onchange: (value: FilterGroup | null) => void;
  class?: string;
}

let {
  value,
  allow,
  fileFields = [],
  ticketFields = [],
  workflowOptions = [],
  stateOptions = [],
  onchange,
  class: className = ''
}: Props = $props();

let rawOpen = $state(false);
let rawDraft = $state('');
let rawError = $state<string | null>(null);

const kindOptions = $derived(
  allow.map((kind) => ({ value: kind, label: FIELD_KIND_LABELS[kind] ?? kind }))
);

const root = $derived(rootOf(value));
const conditionCount = $derived(countConditions(value));

function rootOf(ast: FilterAst | null): FilterGroup {
  if (!ast) return emptyGroup('and');
  if (isGroup(ast)) return cloneFilter(ast);
  return { type: 'group', op: 'and', children: [cloneFilter(ast)] };
}

function fieldOptionsFor(kind: FilterFieldKind, current: string): BuilderFieldOption[] {
  if (kind === 'field') return ticketFields;
  if (kind === 'file_field') return fileFields;
  if (kind === 'state') {
    return stateOptions.map((option) => ({ key: option.value, label: option.label, type: 'text' }));
  }
  if (kind === 'workflow') {
    return workflowOptions.map((option) => ({
      key: option.value,
      label: option.label,
      type: 'text'
    }));
  }
  if (kind === 'collection') return [];
  const builtins = kind === 'system' ? [...FILE_SYSTEM_FIELDS, ...TICKET_SYSTEM_FIELDS] : [];
  if (current && !builtins.some((field) => field.key === current)) {
    // Preserve a key the option list does not know about rather than blanking it.
    return [...builtins, { key: current, label: current, type: 'text' }];
  }
  return builtins;
}

function emit(next: FilterGroup) {
  onchange(next.children.length === 0 ? null : next);
}

function openRaw() {
  rawDraft = serializeFilter(value) ?? '';
  rawError = null;
  rawOpen = !rawOpen;
}

function applyRaw() {
  const trimmed = rawDraft.trim();
  if (trimmed.length === 0) {
    rawError = null;
    onchange(null);
    return;
  }
  const parsed = parseFilter(trimmed);
  if (!parsed) {
    rawError =
      'Not a valid filter AST. Expected a JSON object with "type": "group" or "condition".';
    return;
  }
  rawError = null;
  onchange(rootOf(parsed));
}
</script>

<div class="space-y-3 {className}">
  <div class="flex flex-wrap items-center gap-2">
    <Badge tone={conditionCount > 0 ? 'accent' : 'neutral'}>{conditionCount} condition(s)</Badge>
    <span class="text-[11px] text-[var(--color-ink-subtle)]">
      {describeFilter(value)}
    </span>
    <div class="ml-auto flex items-center gap-1.5">
      <Button size="sm" variant="ghost" onclick={() => emit(rootOf(null))}>Clear</Button>
      <Button size="sm" variant="ghost" aria-expanded={rawOpen} onclick={openRaw}>
        {rawOpen ? 'Hide JSON' : 'Edit JSON'}
      </Button>
    </div>
  </div>

  {#if rawOpen}
    <div
      class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-3"
    >
      <label
        class="block text-[11px] font-medium text-[var(--color-ink-muted)]"
        for="filter-ast-json">Filter AST (the same JSON `?filter=` carries)</label
      >
      <textarea
        id="filter-ast-json"
        class="h-32 w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2 font-mono text-[11px]"
        bind:value={rawDraft}
      ></textarea>
      {#if rawError}<p class="text-xs text-[var(--color-danger)]">{rawError}</p>{/if}
      <div class="flex justify-end gap-1.5">
        <Button size="sm" onclick={applyRaw}>Apply JSON</Button>
      </div>
    </div>
  {/if}

  <FilterGroupEditor
    group={root}
    path=""
    {allow}
    {kindOptions}
    {fieldOptionsFor}
    onchange={emit}
  />
</div>
