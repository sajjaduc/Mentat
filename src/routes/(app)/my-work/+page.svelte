<script lang="ts">
/**
 * My Work.
 *
 * Five buckets, each a real query over persisted state — so the counts here can
 * never drift from the board. Ownership is deliberately independent of which agent
 * is working: "assigned to me" and "waiting for an agent" are different answers to
 * different questions.
 */
import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import TicketDrawer from '$ui/ticket/TicketDrawer.svelte';
import TicketTable from '$ui/work/TicketTable.svelte';
import type { MyWorkBucket, MyWorkResponse, TeamOption, TicketColumn } from '$ui/work/types';
import { closeTicketInUrl, openTicketInUrl, replaceQuery } from '$ui/work/url';

const BUCKETS: Array<{ id: MyWorkBucket; label: string; empty: string }> = [
  {
    id: 'assigned',
    label: 'Assigned',
    empty:
      'Nothing is assigned to you. Tickets you own appear here regardless of who is working them.'
  },
  {
    id: 'waitingForMe',
    label: 'Waiting for me',
    empty: 'No ticket is waiting on a human right now.'
  },
  {
    id: 'waitingForAgent',
    label: 'Waiting for agent',
    empty: 'No ticket is waiting on an agent run.'
  },
  {
    id: 'waitingForApproval',
    label: 'Waiting for approval',
    empty: 'No ticket has a pending approval.'
  },
  {
    id: 'needsAttention',
    label: 'Needs attention',
    empty: 'No failed runs or stalled triggers. Nothing needs rescuing.'
  }
];

const COLUMNS: TicketColumn[] = [
  { key: 'key', label: 'Key', width: '7rem' },
  { key: 'title', label: 'Title' },
  { key: 'state', label: 'State' },
  { key: 'priority', label: 'Priority' },
  { key: 'owner', label: 'Owner' },
  { key: 'age', label: 'Age in state' }
];

let data = $state<MyWorkResponse | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let teams = $state<TeamOption[]>([]);

const workspaceId = $derived(page.data.workspace?.id ?? '');
const rawBucket = $derived(page.url.searchParams.get('bucket'));
const activeBucket = $derived<MyWorkBucket>(
  BUCKETS.some((bucket) => bucket.id === rawBucket) ? (rawBucket as MyWorkBucket) : 'assigned'
);
const openTicketId = $derived(page.url.searchParams.get('ticket'));

const tabs = $derived(
  BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    count: data ? data[bucket.id].length : undefined
  }))
);

const activeConfig = $derived(BUCKETS.find((bucket) => bucket.id === activeBucket) ?? BUCKETS[0]);
const rows = $derived(data ? data[activeBucket] : []);

async function load() {
  loading = true;
  error = null;
  try {
    data = await api.get<MyWorkResponse>('/api/my-work', { limit: 100 });
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function loadTeams() {
  try {
    const response = await api.get<{ teams: TeamOption[] }>('/api/teams');
    teams = response.teams;
  } catch {
    // Team names are cosmetic in this table.
  }
}

load();
loadTeams();
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <header class="border-b border-[var(--color-border-subtle)] px-4 pt-4">
    <h1 class="text-lg font-semibold">My Work</h1>
    <p class="mb-2 text-xs text-[var(--color-ink-subtle)]">
      Everything waiting on you, on an agent, or on a decision.
    </p>
    <Tabs
      {tabs}
      active={activeBucket}
      onselect={(id) => replaceQuery({ bucket: id === 'assigned' ? null : id })}
    />
  </header>

  <div class="min-h-0 flex-1 overflow-auto p-4">
    {#if loading && data === null}
      <Skeleton lines={8} height="1.5rem" />
    {:else if error}
      <ErrorState message={error} onRetry={load} />
    {:else}
      <TicketTable
        {rows}
        columns={COLUMNS}
        onRowClick={openTicketInUrl}
        {teams}
        emptyTitle={`Nothing in “${activeConfig?.label ?? activeBucket}”`}
        emptyDescription={activeConfig?.empty}
      />
    {/if}
  </div>
</div>

{#if openTicketId}
  <TicketDrawer
    ticketId={openTicketId}
    {workspaceId}
    onclose={() => {
      closeTicketInUrl();
      void load();
    }}
    onOpenTicket={openTicketInUrl}
  />
{/if}
