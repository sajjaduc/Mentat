<script lang="ts">
/**
 * Ticket relationships.
 *
 * Links are created from a ticket search rather than by pasting an id, so the
 * person picking a parent or duplicate sees the ticket they are choosing. Removal
 * is immediate; the server soft-deletes the relationship and the timeline records it.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import { pushToast } from '$ui/toast';
import { relationshipLabel, relationshipTypeTone } from '$ui/work/format';
import type { TicketRelationshipView } from '$ui/work/types';

interface Props {
  ticketId: string;
  relationships: TicketRelationshipView[];
  /**
   * Applies the link. Resolves with `false` when the caller decided not to link (for
   * example because the API refused); the caller reports the reason.
   */
  onAdd: (toTicketId: string, type: string, note?: string) => Promise<unknown>;
  onRemove: (relationshipId: string) => Promise<void>;
  onOpenTicket: (ticketId: string) => void;
}

let { ticketId, relationships, onAdd, onRemove, onOpenTicket }: Props = $props();

const TYPES = [
  { value: 'parent', label: 'Parent' },
  { value: 'child', label: 'Child' },
  { value: 'related', label: 'Related' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'blocked_by', label: 'Blocked by' }
];

let linking = $state(false);
let type = $state('related');
let query = $state('');
let results = $state<Array<{ id: string; key?: string; title: string }>>([]);
let searching = $state(false);
let searchError = $state<string | null>(null);
let saving = $state(false);

async function search() {
  const term = query.trim();
  if (term.length < 2) {
    results = [];
    return;
  }
  searching = true;
  searchError = null;
  try {
    const response = await api.get<{ results: Array<{ id: string; key?: string; title: string }> }>(
      '/api/search',
      { q: term, limit: 8 }
    );
    results = response.results.filter((result) => result.id !== ticketId);
  } catch (failure) {
    searchError = describeApiError(failure);
  } finally {
    searching = false;
  }
}

async function link(targetId: string) {
  saving = true;
  const applied = (await onAdd(targetId, type)) !== false;
  saving = false;
  if (applied) {
    linking = false;
    query = '';
    results = [];
  } else {
    pushToast({ tone: 'error', title: 'Could not link the ticket' });
  }
}
</script>

<section class="space-y-2">
  <div class="flex items-center justify-between">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Relationships
    </h3>
    <Button size="sm" variant="ghost" onclick={() => (linking = !linking)}>
      {linking ? 'Cancel' : 'Link ticket'}
    </Button>
  </div>

  {#if linking}
    <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2">
      <Select value={type} onchange={(event) => (type = (event.currentTarget as HTMLSelectElement).value)} options={TYPES} label="Relationship" />
      <div class="flex items-end gap-2">
        <div class="flex-1">
          <Input
            value={query}
            oninput={(event) => {
              query = (event.currentTarget as HTMLInputElement).value;
              void search();
            }}
            label="Find a ticket"
            placeholder="Search by title or key"
          />
        </div>
      </div>
      {#if searching}
        <p class="text-xs text-[var(--color-ink-subtle)]">Searching…</p>
      {:else if searchError}
        <p class="text-xs text-[var(--color-danger)]">{searchError}</p>
      {:else if results.length > 0}
        <ul class="max-h-40 space-y-1 overflow-y-auto">
          {#each results as result (result.id)}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
                disabled={saving}
                onclick={() => link(result.id)}
              >
                {#if result.key}<span class="font-mono text-[10px] text-[var(--color-ink-subtle)]"
                    >{result.key}</span
                  >{/if}
                <span class="truncate">{result.title}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if query.trim().length >= 2}
        <p class="text-xs text-[var(--color-ink-subtle)]">No matching tickets.</p>
      {/if}
    </div>
  {/if}

  {#if relationships.length === 0}
    <p class="text-xs text-[var(--color-ink-subtle)]">
      No links yet. Relate tickets to show dependencies, duplicates or decomposition.
    </p>
  {:else}
    <ul class="space-y-1">
      {#each relationships as relationship (relationship.id)}
        <li
          class="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-2 py-1.5"
        >
          <Badge tone={relationshipTypeTone(relationship.type)}
            >{relationshipLabel(relationship.type)}</Badge
          >
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-xs hover:text-[var(--color-accent)]"
            onclick={() => onOpenTicket(relationship.ticket.id)}
          >
            <span class="font-mono text-[10px] text-[var(--color-ink-subtle)]"
              >{relationship.ticket.key}</span
            >
            {relationship.ticket.title}
          </button>
          <button
            type="button"
            class="rounded-[var(--radius-xs)] px-1 text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
            aria-label="Remove relationship"
            title="Remove relationship"
            onclick={() => onRemove(relationship.id)}
          >
            ✕
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
