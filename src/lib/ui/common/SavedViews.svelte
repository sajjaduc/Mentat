<script lang="ts">
/**
 * SavedViews: list, apply, save and delete saved views for a scope.
 *
 * A saved view is persisted filter AST + columns + sort, so applying one is a
 * local state change rather than a different query path. That is the point of
 * ADR-0012: a view and an ad-hoc filter cannot drift apart because they are the
 * same object.
 *
 * Saving is an explicit modal because a view has a name and a sharing decision,
 * and both are worth one deliberate step.
 */
import { api, describeApiError } from '$ui/api';
import { describeFilter, type FilterAst } from '$ui/filters';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import { pushToast } from '$ui/toast';
import type { AppliedSavedView, SavedView, ViewScope } from '$ui/types';

interface Props {
  scope: ViewScope;
  views: SavedView[];
  currentFilter: FilterAst | null;
  currentColumns?: string[];
  onapply: (applied: { filter: FilterAst | null; columns: string[] | null }) => void;
  onchanged: () => void;
  class?: string;
}

let {
  scope,
  views,
  currentFilter,
  currentColumns = [],
  onapply,
  onchanged,
  class: className = ''
}: Props = $props();

let saveOpen = $state(false);
let saving = $state(false);
let viewName = $state('');
let viewDescription = $state('');
let viewShared = $state(false);
let error = $state<string | null>(null);
let busyId = $state<string | null>(null);

async function apply(view: SavedView) {
  busyId = view.id;
  error = null;
  try {
    const applied = await api.get<AppliedSavedView>(`/views/${view.id}/apply`);
    onapply({
      filter: (applied.filter as FilterAst | null) ?? null,
      columns: applied.columns ?? null
    });
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    busyId = null;
  }
}

async function remove(view: SavedView) {
  busyId = view.id;
  try {
    await api.delete(`/views/${view.id}`);
    onchanged();
    pushToast({ tone: 'success', title: `Deleted view "${view.name}"` });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not delete view',
      description: describeApiError(failure)
    });
  } finally {
    busyId = null;
  }
}

async function save() {
  if (viewName.trim().length === 0) {
    error = 'A view needs a name.';
    return;
  }
  saving = true;
  error = null;
  try {
    await api.post('/views', {
      name: viewName.trim(),
      description: viewDescription.trim() || null,
      scope,
      filterAst: currentFilter,
      columns: currentColumns.length > 0 ? currentColumns : null,
      isShared: viewShared
    });
    pushToast({ tone: 'success', title: `Saved view "${viewName.trim()}"` });
    saveOpen = false;
    viewName = '';
    viewDescription = '';
    viewShared = false;
    onchanged();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    saving = false;
  }
}
</script>

<div class="flex flex-wrap items-center gap-1.5 {className}">
  <span class="text-[11px] font-medium text-[var(--color-ink-subtle)]">Saved views</span>
  {#if views.length === 0}
    <span class="text-[11px] text-[var(--color-ink-subtle)]">none yet</span>
  {/if}
  {#each views as view (view.id)}
    <span
      class="group inline-flex items-center overflow-hidden rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
    >
      <button
        type="button"
        class="px-2.5 py-1 text-[11px] hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
        title={describeFilter(view.filterAst as FilterAst | null)}
        disabled={busyId === view.id}
        onclick={() => apply(view)}
      >
        {view.name}
        {#if view.isShared}<span class="text-[var(--color-ink-subtle)]"> · shared</span>{/if}
      </button>
      <button
        type="button"
        class="px-1.5 py-1 text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
        aria-label="Delete saved view {view.name}"
        disabled={busyId === view.id}
        onclick={() => remove(view)}
      >
        ✕
      </button>
    </span>
  {/each}
  <Button size="sm" variant="ghost" onclick={() => (saveOpen = true)}>+ Save view</Button>
</div>

{#if error && !saveOpen}
  <p class="mt-1 text-[11px] text-[var(--color-danger)]">{error}</p>
{/if}

<Modal
  open={saveOpen}
  title="Save this filter as a view"
  description="A view stores the filter AST, so reopening it later runs exactly the same query."
  onclose={() => (saveOpen = false)}
>
  <div class="space-y-3">
    <Input label="Name" bind:value={viewName} placeholder="Invoices from ACME" />
    <Input label="Description" bind:value={viewDescription} placeholder="Optional" />
    <Select
      label="Visibility"
      options={[
        { value: 'private', label: 'Private to me' },
        { value: 'shared', label: 'Shared with the workspace' }
      ]}
      value={viewShared ? 'shared' : 'private'}
      onchange={(event) => (viewShared = event.currentTarget.value === 'shared')}
    />
    <div class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2.5">
      <p class="mb-1 text-[11px] font-medium text-[var(--color-ink-muted)]">Filter preview</p>
      <p class="text-xs text-[var(--color-ink)]">{describeFilter(currentFilter)}</p>
      {#if currentColumns.length > 0}
        <p class="mt-1 flex flex-wrap gap-1">
          {#each currentColumns as column (column)}
            <Badge tone="neutral">{column}</Badge>
          {/each}
        </p>
      {/if}
    </div>
    {#if error}<p class="text-xs text-[var(--color-danger)]">{error}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (saveOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={saving} onclick={save}>Save view</Button>
    </div>
  </div>
</Modal>
