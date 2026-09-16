<script lang="ts">
/**
 * Saved views menu, shared by the board and the list.
 *
 * A view is a named filter AST; this menu lists, applies, renames, deletes and
 * shares them without leaving the surface. Saving sends the `filter` field (the
 * name the service actually reads) and keeps the response local, so the menu never
 * triggers a reload.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import { type FilterState, filterStateToAst, isFilterActive } from '$ui/work/filters';
import type { AppliedSavedView, SavedView, SortSpec } from '$ui/work/types';

interface Props {
  workflowId?: string | null;
  filter: FilterState;
  sort?: SortSpec[] | null;
  columns?: string[] | null;
  onApply: (view: AppliedSavedView) => void;
}

let { workflowId = null, filter, sort = null, columns = null, onApply }: Props = $props();

let open = $state(false);
let views = $state<SavedView[] | null>(null);
let loading = $state(false);
let error = $state<string | null>(null);
let busyId = $state<string | null>(null);
let renamingId = $state<string | null>(null);
let renameDraft = $state('');
let saveName = $state('');
let saveShared = $state(true);
let saving = $state(false);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ views: SavedView[] }>('/api/views', { scope: 'tickets' });
    views = response.views;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

function toggle() {
  open = !open;
  if (open && views === null) void load();
}

async function apply(view: SavedView) {
  busyId = view.id;
  try {
    const applied = await api.get<AppliedSavedView>(`/api/views/${view.id}/apply`);
    onApply(applied);
    open = false;
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not apply view',
      description: describeApiError(failure)
    });
  } finally {
    busyId = null;
  }
}

async function saveCurrent() {
  const name = saveName.trim();
  if (name === '') return;
  saving = true;
  try {
    const created = await api.post<{ view: SavedView }>('/api/views', {
      name,
      scope: 'tickets',
      workflowId,
      filter: filterStateToAst(filter),
      sort,
      columns,
      isShared: saveShared
    });
    views = [...(views ?? []), created.view];
    saveName = '';
    pushToast({ tone: 'success', title: `Saved view “${created.view.name}”` });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not save view',
      description: describeApiError(failure)
    });
  } finally {
    saving = false;
  }
}

async function patch(view: SavedView, body: Record<string, unknown>, message: string) {
  busyId = view.id;
  try {
    const response = await api.patch<{ view: SavedView }>(`/api/views/${view.id}`, body);
    views = (views ?? []).map((entry) => (entry.id === view.id ? response.view : entry));
    pushToast({ tone: 'success', title: message });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not update view',
      description: describeApiError(failure)
    });
  } finally {
    busyId = null;
    renamingId = null;
  }
}

async function remove(view: SavedView) {
  busyId = view.id;
  const previous = views ?? [];
  views = previous.filter((entry) => entry.id !== view.id);
  try {
    await api.delete(`/api/views/${view.id}`);
    pushToast({ tone: 'success', title: `Deleted view “${view.name}”` });
  } catch (failure) {
    views = previous;
    pushToast({
      tone: 'error',
      title: 'Could not delete view',
      description: describeApiError(failure)
    });
  } finally {
    busyId = null;
  }
}

function startRename(view: SavedView) {
  renamingId = view.id;
  renameDraft = view.name;
}

const canSave = $derived(isFilterActive(filter) && saveName.trim() !== '');
</script>

<div class="relative">
  <Button variant="secondary" onclick={toggle} aria-expanded={open} aria-haspopup="menu">
    <span aria-hidden="true">▾</span>
    Views
    {#if views && views.length > 0}
      <span class="text-[10px] text-[var(--color-ink-subtle)]">{views.length}</span>
    {/if}
  </Button>

  {#if open}
    <button
      class="fixed inset-0 z-30 cursor-default"
      aria-label="Close views menu"
      onclick={() => (open = false)}
    ></button>
    <div
      role="menu"
      class="animate-pop-in absolute left-0 z-40 mt-1 w-80 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-overlay)]"
    >
      <div class="scrollbar-thin max-h-72 overflow-y-auto">
        {#if loading}
          <div class="p-2"><Skeleton lines={3} /></div>
        {:else if error}
          <ErrorState message={error} onRetry={load} />
        {:else if !views || views.length === 0}
          <EmptyState
            title="No saved views yet"
            description="Save the current filter to reuse it on the board and in the list."
          />
        {:else}
          {#each views as view (view.id)}
            <div
              class="rounded-[var(--radius-md)] p-1.5 hover:bg-[var(--color-surface-muted)]"
              role="none"
            >
              {#if renamingId === view.id}
                <form
                  class="flex items-center gap-1.5"
                  onsubmit={(event) => {
                    event.preventDefault();
                    void patch(view, { name: renameDraft.trim() }, 'View renamed');
                  }}
                >
                  <Input value={renameDraft} oninput={(event) => (renameDraft = (event.currentTarget as HTMLInputElement).value)} size="sm" aria-label="View name" />
                  <Button size="sm" variant="primary" type="submit" disabled={renameDraft.trim() === ''}
                    >Save</Button
                  >
                  <Button size="sm" variant="ghost" onclick={() => (renamingId = null)}>Cancel</Button>
                </form>
              {:else}
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    role="menuitem"
                    class="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] px-1 py-1 text-left text-xs font-medium hover:text-[var(--color-accent)]"
                    onclick={() => apply(view)}
                  >
                    {view.name}
                    {#if !view.isShared}<Badge tone="muted">Private</Badge>{/if}
                  </button>
                  {#if busyId === view.id}
                    <span
                      class="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-ink-subtle)] border-t-transparent"
                      aria-label="Working"
                    ></span>
                  {:else}
                    <button
                      type="button"
                      class="rounded-[var(--radius-xs)] px-1 text-[11px]"
                      title={view.isPinned ? 'Unpin view' : 'Pin view'}
                      aria-label={view.isPinned ? 'Unpin view' : 'Pin view'}
                      onclick={() => patch(view, { isPinned: !view.isPinned }, view.isPinned ? 'Unpinned' : 'Pinned')}
                    >
                      {view.isPinned ? '★' : '☆'}
                    </button>
                    <button
                      type="button"
                      class="rounded-[var(--radius-xs)] px-1 text-[11px]"
                      title={view.isShared ? 'Make private' : 'Share with workspace'}
                      aria-label={view.isShared ? 'Make private' : 'Share with workspace'}
                      onclick={() =>
                        patch(
                          view,
                          { isShared: !view.isShared },
                          view.isShared ? 'View is now private' : 'View shared'
                        )}
                    >
                      {view.isShared ? '⧉' : '⚿'}
                    </button>
                    <button
                      type="button"
                      class="rounded-[var(--radius-xs)] px-1 text-[11px]"
                      title="Rename view"
                      aria-label="Rename view"
                      onclick={() => startRename(view)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      class="rounded-[var(--radius-xs)] px-1 text-[11px] text-[var(--color-danger)]"
                      title="Delete view"
                      aria-label="Delete view"
                      onclick={() => remove(view)}
                    >
                      ✕
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      <form
        class="mt-2 space-y-2 border-t border-[var(--color-border-subtle)] pt-2"
        onsubmit={(event) => {
          event.preventDefault();
          void saveCurrent();
        }}
      >
        <Input value={saveName} oninput={(event) => (saveName = (event.currentTarget as HTMLInputElement).value)} size="sm" placeholder="Save current filter as…" label="New view" />
        <div class="flex items-center justify-between gap-2">
          <label class="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
            <input type="checkbox" bind:checked={saveShared} />
            Shared with workspace
          </label>
          <Button size="sm" variant="primary" type="submit" loading={saving} disabled={!canSave}>
            Save view
          </Button>
        </div>
        {#if !isFilterActive(filter)}
          <p class="text-[10px] text-[var(--color-ink-subtle)]">
            Set at least one filter control to save a view.
          </p>
        {/if}
      </form>
    </div>
  {/if}
</div>
