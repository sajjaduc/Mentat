<script lang="ts">
/**
 * The filter bar shared by Board and List.
 *
 * The five controls write through to one `FilterState`, which the caller
 * serialises into `?filter=` as the shared filter AST. "Clear" is a first-class
 * control because an invisible active filter is the fastest way to make a board
 * look empty for no reason.
 */
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import SavedViewsMenu from '$ui/views/SavedViewsMenu.svelte';
import {
  countFilterConditions,
  emptyFilterState,
  type FilterState,
  PRIORITIES,
  type WorkItemPriority
} from '$ui/work/filters';
import { priorityLabel } from '$ui/work/format';
import MultiSelect from '$ui/work/MultiSelect.svelte';
import type {
  AppliedSavedView,
  Label,
  MemberOption,
  SortSpec,
  WorkflowState
} from '$ui/work/types';

interface Props {
  filter: FilterState;
  states: WorkflowState[];
  members: MemberOption[];
  labels: Label[];
  onchange: (filter: FilterState) => void;
  onApplyView: (view: AppliedSavedView) => void;
  workflowId?: string | null;
  sort?: SortSpec[] | null;
  columns?: string[] | null;
}

let {
  filter,
  states,
  members,
  labels,
  onchange,
  onApplyView,
  workflowId = null,
  sort = null,
  columns = null
}: Props = $props();

function patch(partial: Partial<FilterState>) {
  onchange({ ...filter, ...partial });
}

const activeCount = $derived(countFilterConditions(filter));
const hasUnresolvedOwner = $derived(
  filter.ownerUserId !== '' &&
    filter.ownerUserId !== 'unassigned' &&
    !members.some((member) => member.userId === filter.ownerUserId)
);
</script>

<div class="flex flex-wrap items-center gap-2">
  <div class="min-w-[12rem] flex-1">
    <Input
      size="sm"
      type="search"
      placeholder="Search title, key or description…"
      aria-label="Search work items"
      value={filter.search}
      oninput={(event) => patch({ search: (event.currentTarget as HTMLInputElement).value })}
    />
  </div>

  <MultiSelect
    label="State"
    selected={filter.stateIds}
    options={states.map((state) => ({ value: state.id, label: state.name, color: state.color }))}
    onchange={(stateIds) => patch({ stateIds })}
  />

  <MultiSelect
    label="Priority"
    selected={filter.priorities}
    options={PRIORITIES.map((priority) => ({ value: priority, label: priorityLabel(priority) }))}
    onchange={(values) =>
      patch({
        priorities: values.filter((value): value is WorkItemPriority =>
          (PRIORITIES as readonly string[]).includes(value)
        )
      })}
  />

  <div class="w-44">
    <Select
      aria-label="Owner"
      placeholder="Any owner"
      value={filter.ownerUserId}
      options={[
        { value: 'unassigned', label: 'Unassigned' },
        ...members.map((member) => ({ value: member.userId, label: member.name }))
      ]}
      onchange={(event) => patch({ ownerUserId: (event.currentTarget as HTMLSelectElement).value })}
    />
  </div>

  <div class="w-44">
    <Select
      aria-label="Label"
      placeholder="Any label"
      value={filter.labelIds[0] ?? ''}
      options={labels.map((label) => ({ value: label.id, label: label.name }))}
      onchange={(event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        patch({ labelIds: value === '' ? [] : [value] });
      }}
    />
  </div>

  {#if activeCount > 0}
    <Button variant="ghost" size="sm" onclick={() => onchange(emptyFilterState())}>
      Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
    </Button>
  {/if}

  <SavedViewsMenu {workflowId} {filter} {sort} {columns} onApply={onApplyView} />
</div>

{#if hasUnresolvedOwner}
  <p class="mt-1 text-[11px] text-[var(--color-caution)]">
    This view filters by an owner who is no longer a member; results will be empty.
  </p>
{/if}
