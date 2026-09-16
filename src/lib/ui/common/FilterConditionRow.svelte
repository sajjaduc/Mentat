<script lang="ts">
/**
 * FilterConditionRow: one editable condition of the shared filter AST.
 *
 * Extracted from the recursive group editor so the recursion and the row stay
 * independently typed: a recursive component that also renders a snippet hits a
 * Svelte/TypeScript limit where the snippet's parameter is inferred as component
 * internals, which makes the row's handlers untyped.
 *
 * Unknown operators are preserved and flagged rather than dropped, so re-saving an
 * imported view cannot silently delete a condition this build does not understand.
 */

import {
  type FilterCondition,
  type FilterFieldKind,
  type FilterOperator,
  OPERATOR_LABELS,
  operatorTakesList,
  operatorTakesValue
} from '$ui/filters';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import { type BuilderFieldOption, conditionValueToText } from './filter-tree';

interface Props {
  condition: FilterCondition;
  nodePath: string;
  fields: BuilderFieldOption[];
  kindOptions: Array<{ value: string; label: string }>;
  onkind: (path: string, kind: FilterFieldKind) => void;
  onkey: (path: string, key: string) => void;
  onoperator: (path: string, operator: FilterOperator) => void;
  onvalue: (path: string, raw: string, list: boolean) => void;
  onremove: (path: string) => void;
}

let {
  condition,
  nodePath,
  fields,
  kindOptions,
  onkind,
  onkey,
  onoperator,
  onvalue,
  onremove
}: Props = $props();

const knownOperator = $derived(Object.hasOwn(OPERATOR_LABELS, condition.operator));
const takesValue = $derived(operatorTakesValue(condition.operator));
const takesList = $derived(operatorTakesList(condition.operator));
</script>

<div
  class="flex flex-wrap items-end gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-2"
>
  <div class="w-36">
    <Select
      label="Kind"
      options={kindOptions}
      value={condition.kind}
      onchange={(event) => onkind(nodePath, event.currentTarget.value as FilterFieldKind)}
    />
  </div>
  {#if fields.length > 0}
    <div class="w-48">
      <Select
        label="Field"
        options={fields.map((field) => ({ value: field.key, label: field.label }))}
        placeholder="Choose a field"
        value={condition.key}
        onchange={(event) => onkey(nodePath, event.currentTarget.value)}
      />
    </div>
  {:else}
    <div class="w-48">
      <Input
        label="Field key"
        value={condition.key}
        oninput={(event) => onkey(nodePath, event.currentTarget.value)}
      />
    </div>
  {/if}
  <div class="w-48">
    <Select
      label="Operator"
      options={Object.entries(OPERATOR_LABELS).map(([value, label]) => ({ value, label }))}
      value={condition.operator}
      onchange={(event) => onoperator(nodePath, event.currentTarget.value as FilterOperator)}
    />
  </div>
  {#if takesValue}
    <div class="min-w-44 flex-1">
      <Input
        label={takesList ? 'Values (comma separated)' : 'Value'}
        value={conditionValueToText(condition.value)}
        oninput={(event) => onvalue(nodePath, event.currentTarget.value, takesList)}
      />
    </div>
  {/if}
  <div class="flex items-center gap-1.5 pb-0.5">
    {#if !knownOperator}
      <Badge tone="caution">Preserved: {condition.operator}</Badge>
    {/if}
    <Button size="sm" variant="ghost" title="Remove condition" onclick={() => onremove(nodePath)}>
      ✕
    </Button>
  </div>
</div>
