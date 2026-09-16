<script lang="ts">
/**
 * Workflow activity.
 *
 * A live feed of this workflow's run events. The SSE endpoint is workspace-scoped,
 * so the workflow's ticket set is the filter: it is loaded once and used to drop
 * other workflows' events, while payload workflow ids cover tickets created after
 * the page opened. Events are persisted first, so the replay on connect is a real
 * history and reconnection resumes exactly where it stopped.
 */
import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { openEventStream } from '$ui/work/events';
import { eventLabel, eventTone } from '$ui/work/format';
import type { TicketListRow, WorkEvent } from '$ui/work/types';

interface Props {
  workflowId: string;
}

let { workflowId }: Props = $props();

let tickets = $state<Record<string, { key: string; title: string }>>({});
let events = $state<WorkEvent[]>([]);
let ready = $state(false);
let connected = $state(false);
let error = $state<string | null>(null);
const known = new Set<string>();

const MAX_ROWS = 300;

async function loadTickets() {
  error = null;
  try {
    const response = await api.get<{ rows: TicketListRow[] }>('/api/tickets', {
      workflowId,
      limit: 200
    });
    const map: Record<string, { key: string; title: string }> = {};
    for (const row of response.rows) {
      known.add(row.ticket.id);
      map[row.ticket.id] = { key: row.ticket.key, title: row.ticket.title };
    }
    tickets = map;
  } catch (failure) {
    error = describeApiError(failure);
  }
}

function belongs(event: WorkEvent): boolean {
  if (event.ticketId && known.has(event.ticketId)) return true;
  const data = event.data;
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (record.workflowId === workflowId) return true;
  }
  return false;
}

function handleEvent(event: WorkEvent) {
  if (event.type === 'stream.ready') return;
  if (!belongs(event)) return;
  events = [event, ...events].slice(0, MAX_ROWS);
}

$effect(() => {
  const id = workflowId;
  void id;
  void loadTickets();
  const close = openEventStream({
    since: 0,
    onEvent: handleEvent,
    onReady: () => {
      ready = true;
      connected = true;
      void loadTickets();
    },
    onDisconnect: () => (connected = false)
  });
  return close;
});
</script>

<div class="min-h-0 flex-1 overflow-y-auto p-4" data-testid="workflow-activity">
  <div class="mb-3 flex items-center gap-2">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Live activity
    </h3>
    <span class="flex items-center gap-1 text-[11px] text-[var(--color-ink-subtle)]">
      <span
        class="h-1.5 w-1.5 rounded-full {connected ? 'bg-[var(--color-positive)]' : 'bg-[var(--color-caution)]'}"
        aria-hidden="true"
      ></span>
      {connected ? 'live' : 'reconnecting'}
    </span>
  </div>

  {#if error}
    <ErrorState message={error} onRetry={loadTickets} />
  {:else if !ready && events.length === 0}
    <Skeleton lines={6} height="1.25rem" />
  {:else if events.length === 0}
    <EmptyState
      title="No recent activity"
      description="Agent runs, tool calls, transitions and approvals for this workflow appear here as they happen."
    />
  {:else}
    <ul class="space-y-1.5">
      {#each events as event (event.seq)}
        {@const ticket = event.ticketId ? tickets[event.ticketId] : undefined}
        <li
          class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-2.5 py-1.5"
        >
          <Badge tone={eventTone(event.type)}>{eventLabel(event.type)}</Badge>
          {#if event.ticketId}
            <a
              class="min-w-0 truncate text-xs hover:text-[var(--color-accent)]"
              href={`/tickets/${event.ticketId}`}
            >
              {#if ticket}<span class="font-mono text-[10px] text-[var(--color-ink-subtle)]"
                  >{ticket.key}</span
                >
                {ticket.title}
              {:else}
                <span class="font-mono text-[10px]">{event.ticketId.slice(0, 8)}</span>
              {/if}
            </a>
          {/if}
          <span class="ml-auto flex items-center gap-2 text-[10px] text-[var(--color-ink-subtle)]">
            {#if event.runId && event.ticketId}
              <a
                class="font-mono underline decoration-dotted"
                href={`/tickets/${event.ticketId}?tab=agent-work`}
                >run {event.runId.slice(0, 8)}</a
              >
            {/if}
            <span>{formatRelative(event.createdAt)}</span>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
