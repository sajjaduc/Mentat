<script lang="ts">
/**
 * FilterGroupEditor: one node of the filter AST, rendered recursively.
 *
 * A group is edited as a bordered block with an AND/OR toggle and a list of
 * children; a condition is a row of kind → field → operator → value. Recursion is
 * what makes `A AND (B OR C)` expressible without a second editor, and an unknown
 * operator is preserved (and flagged) rather than dropped.
 */

import {
  FIELD_KIND_LABELS,
  type FilterCondition,
  type FilterFieldKind,
  type FilterGroup,
  type FilterOperator,
  isGroup,
  OPERATOR_LABELS,
  operatorTakesList,
  operatorTakesValue
} from '$ui/filters';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import FilterConditionRow from './FilterConditionRow.svelte';
import FilterGroupEditor from './FilterGroupEditor.svelte';
import {
  appendNode,
  type BuilderFieldOption,
  childPath,
  conditionTextToValue,
  removeNode,
  replaceNode,
  toggleGroupOperator
} from './filter-tree';

interface Props {
  group: FilterGroup;
  path: string;
  allow: FilterFieldKind[];
  kindOptions: Array<{ value: string; label: string }>;
  fieldOptionsFor: (kind: FilterFieldKind, current: string) => BuilderFieldOption[];
  onchange: (next: FilterGroup) => void;
}

let { group, path, allow, kindOptions, fieldOptionsFor, onchange }: Props = $props();

function addCondition() {
  onchange(
    appendNode(group, path, {
      type: 'condition',
      kind: allow[0] ?? 'system',
      key: '',
      operator: 'eq',
      value: ''
    })
  );
}

function addGroup() {
  onchange(appendNode(group, path, { type: 'group', op: 'or', children: [] }));
}

function setKind(childPathValue: string, kind: FilterFieldKind) {
  const first = fieldOptionsFor(kind, '')[0];
  onchange(
    replaceNode(group, childPathValue, (node) =>
      isGroup(node)
        ? node
        : {
            ...node,
            kind,
            key: first?.key ?? '',
            value: operatorTakesValue(node.operator) ? '' : undefined
          }
    )
  );
}

function setKey(childPathValue: string, key: string) {
  onchange(replaceNode(group, childPathValue, (node) => (isGroup(node) ? node : { ...node, key })));
}

function setOperator(childPathValue: string, operator: FilterOperator) {
  onchange(
    replaceNode(group, childPathValue, (node) => {
      if (isGroup(node)) return node;
      return {
        ...node,
        operator,
        value: operatorTakesValue(operator) ? (operatorTakesList(operator) ? [] : '') : undefined
      };
    })
  );
}

function setValue(childPathValue: string, raw: string, list: boolean) {
  onchange(
    replaceNode(group, childPathValue, (node) =>
      isGroup(node) ? node : { ...node, value: conditionTextToValue(raw, list) }
    )
  );
}
</script>

<div
  class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2.5
    {path === '' ? 'bg-transparent' : 'bg-[var(--color-surface)]'}"
>
  <div class="flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-[var(--color-surface-muted)]"
      onclick={() => onchange(toggleGroupOperator(group, path))}
      title="Toggle AND / OR"
    >
      {group.op}
    </button>
    <span class="text-[11px] text-[var(--color-ink-subtle)]">
      {group.op === 'and' ? 'all conditions must match' : 'any condition may match'}
    </span>
    <div class="ml-auto flex gap-1.5">
      <Button size="sm" variant="ghost" onclick={addCondition}>+ Condition</Button>
      <Button size="sm" variant="ghost" onclick={addGroup}>+ Group</Button>
    </div>
  </div>

  {#if group.children.length === 0}
    <p class="px-1 py-1 text-[11px] text-[var(--color-ink-subtle)]">
      Empty group — it matches everything.
    </p>
  {/if}

  {#each group.children as child, index (index)}
    {@const nodePath = childPath(path, index)}
    {#if isGroup(child)}
      <div class="relative pl-3">
        <span
          class="absolute top-3 bottom-2 left-0 w-px bg-[var(--color-border-strong)]"
          aria-hidden="true"
        ></span>
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <FilterGroupEditor
              group={child}
              path={nodePath}
              {allow}
              {kindOptions}
              {fieldOptionsFor}
              {onchange}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            title="Remove group"
            onclick={() => onchange(removeNode(group, nodePath))}
          >
            ✕
          </Button>
        </div>
      </div>
    {:else}
      <FilterConditionRow
        condition={child}
        {nodePath}
        fields={fieldOptionsFor(child.kind, child.key)}
        {kindOptions}
        onkind={setKind}
        onkey={setKey}
        onoperator={setOperator}
        onvalue={setValue}
        onremove={(removedPath) => onchange(removeNode(group, removedPath))}
      />
    {/if}
  {/each}
</div>
