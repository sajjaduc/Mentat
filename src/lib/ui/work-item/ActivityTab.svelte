<script lang="ts">
/**
 * Unified workItem activity.
 *
 * One chronological record across humans, agents, fields, states, tools and files.
 * Entries are grouped by day with sticky headers; a field change shows its
 * before/after values because "what changed" is the question the history exists to
 * answer. The feed re-reads itself when a live event arrives for this workItem.
 */
import { formatDate, formatDateTime, formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { openEventStream } from '$ui/work/events';
import { eventLabel, eventTone } from '$ui/work/format';
import type { AuditEventView, TimelineFilter } from '$ui/work/types';

interface Props {
  workflowItemId: string;
}

let { workflowItemId }: Props = $props();

const FILTERS: Array<{ id: TimelineFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'human', label: 'Human' },
  { id: 'agents', label: 'Agents' },
  { id: 'fields', label: 'Fields' },
  { id: 'states', label: 'States' },
  { id: 'tools', label: 'Tools' },
  { id: 'files', label: 'Files' }
];

let filter = $state<TimelineFilter>('all');
let events = $state<AuditEventView[] | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function load(active: TimelineFilter) {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ events: AuditEventView[] }>(
      `/api/workflow-items/${workflowItemId}/timeline`,
      {
        filter: active,
        limit: 200
      }
    );
    events = response.events;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  const current = filter;
  void load(current);
});

$effect(() => {
  const id = workflowItemId;
  const close = openEventStream({
    workflowItemId: id,
    since: 0,
    onEvent: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void load(filter);
      }, 400);
    }
  });
  return () => {
    close();
    if (refreshTimer) clearTimeout(refreshTimer);
  };
});

function changePair(event: AuditEventView): { before: unknown; after: unknown } | null {
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const before = record.before ?? record.previous ?? record.oldValue ?? record.from;
  const after = record.after ?? record.next ?? record.newValue ?? record.to;
  if (before === undefined && after === undefined) return null;
  return { before, after };
}

function changes(event: AuditEventView): Array<{ key: string; before: unknown; after: unknown }> {
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const list = (data as Record<string, unknown>).changes;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
    )
    .map((entry) => ({
      key: String(entry.key ?? entry.field ?? 'value'),
      before: entry.previous ?? entry.before,
      after: entry.next ?? entry.after
    }));
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const grouped = $derived.by(() => {
  const groups: Array<{ day: string; entries: AuditEventView[] }> = [];
  for (const event of events ?? []) {
    const day = formatDate(event.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(event);
    else groups.push({ day, entries: [event] });
  }
  return groups;
});
</script>

<div class="space-y-3 p-4" data-testid="activity-tab">
  <div class="flex flex-wrap gap-1">
    {#each FILTERS as entry (entry.id)}
      <button
        type="button"
        aria-pressed={filter === entry.id}
        class="rounded-full border px-2.5 py-1 text-[11px] transition-colors
          {filter === entry.id
          ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
          : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'}"
        onclick={() => (filter = entry.id)}
      >
        {entry.label}
      </button>
    {/each}
  </div>

  {#if loading && events === null}
    <Skeleton lines={6} height="1.5rem" />
  {:else if error}
    <ErrorState message={error} onRetry={() => load(filter)} />
  {:else if events && events.length === 0}
    <p class="py-6 text-center text-xs text-[var(--color-ink-subtle)]">
      No activity for this filter yet.
    </p>
  {:else}
    <div class="space-y-4">
      {#each grouped as group (group.day)}
        <section>
          <h4
            class="sticky top-0 z-10 -mx-1 bg-[var(--color-canvas)] px-1 py-1 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
          >
            {group.day}
          </h4>
          <ul class="space-y-2">
            {#each group.entries as event (event.id)}
              {@const pair = changePair(event)}
              {@const changeList = changes(event)}
              <li class="flex gap-2 border-l-2 border-[var(--color-border-subtle)] pl-3">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <Badge tone={eventTone(event.action)}>{eventLabel(event.action)}</Badge>
                    <span class="text-[11px] font-medium text-[var(--color-ink-muted)]">
                      {event.actorLabel ?? event.actorType}
                    </span>
                    <span
                      class="text-[10px] text-[var(--color-ink-subtle)]"
                      title={formatDateTime(event.occurredAt)}>{formatRelative(event.occurredAt)}</span
                    >
                  </div>
                  {#if event.summary}
                    <p class="mt-0.5 text-xs">{event.summary}</p>
                  {/if}
                  {#if pair}
                    <p class="mt-0.5 font-mono text-[11px] text-[var(--color-ink-subtle)]">
                      <span class="line-through">{display(pair.before)}</span>
                      →
                      <span class="text-[var(--color-ink)]">{display(pair.after)}</span>
                    </p>
                  {/if}
                  {#if changeList.length > 0}
                    <ul class="mt-0.5 space-y-0.5">
                      {#each changeList as change (change.key)}
                        <li class="font-mono text-[11px] text-[var(--color-ink-subtle)]">
                          {change.key}:
                          <span class="line-through">{display(change.before)}</span>
                          →
                          <span class="text-[var(--color-ink)]">{display(change.after)}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  <div class="mt-0.5 flex gap-2 text-[10px] text-[var(--color-ink-subtle)]">
                    {#if event.workflowItemId}
                      <a class="underline decoration-dotted" href={`/work-items/${event.workflowItemId}`}>workItem</a>
                    {/if}
                    {#if event.runId}
                      <span class="font-mono">run {event.runId.slice(0, 8)}</span>
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</div>
