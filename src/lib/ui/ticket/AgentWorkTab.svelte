<script lang="ts">
/**
 * Agent Work: the flagship execution surface.
 *
 * Runs are listed oldest-first and the newest is selected. A single managed SSE
 * connection appends live output deltas; because reconnection resumes from the last
 * sequence, a dropped connection shows exactly the gap and never duplicates. Every
 * other event type triggers a quiet re-read of the affected run.
 */
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import type { TicketActions } from '$ui/ticket/actions';
import RunTimeline from '$ui/ticket/RunTimeline.svelte';
import { pushToast } from '$ui/toast';
import { openEventStream } from '$ui/work/events';
import { runStatusLabel, runStatusTone } from '$ui/work/format';
import type { AgentRun, RunDetail, WorkEvent } from '$ui/work/types';

interface Props {
  ticketId: string;
  currentStateId: string;
  transitionNames: Record<string, string>;
  actions: TicketActions;
}

let { ticketId, currentStateId, transitionNames, actions }: Props = $props();

let runs = $state<AgentRun[] | null>(null);
let runsError = $state<string | null>(null);
let selectedRunId = $state<string | null>(null);
let detail = $state<RunDetail | null>(null);
let detailLoading = $state(false);
let detailError = $state<string | null>(null);
let liveByRun = $state<Record<string, string>>({});
let connected = $state(false);
let dispatching = $state(false);

const LIVE_STATUSES = new Set(['queued', 'running', 'awaiting_approval']);
let runsRef: Record<string, AgentRun> = {};
let selectedRef: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

$effect(() => {
  runsRef = Object.fromEntries((runs ?? []).map((run) => [run.id, run]));
  selectedRef = selectedRunId;
});

async function loadRuns() {
  runsError = null;
  try {
    const response = await api.get<{ runs: AgentRun[] }>(`/api/tickets/${ticketId}/runs`);
    runs = response.runs;
    const newest = response.runs[response.runs.length - 1];
    if (selectedRunId === null && newest) {
      selectedRunId = newest.id;
    }
  } catch (failure) {
    runsError = describeApiError(failure);
  }
}

async function loadDetail(runId: string) {
  detailLoading = true;
  detailError = null;
  try {
    detail = await api.get<RunDetail>(`/api/runs/${runId}`);
  } catch (failure) {
    detailError = describeApiError(failure);
    detail = null;
  } finally {
    detailLoading = false;
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadRuns();
    const active = selectedRef;
    if (active) void loadDetail(active);
  }, 200);
}

function handleEvent(event: WorkEvent) {
  if (event.type === 'run.output.delta' || event.type === 'run.reasoning.delta') {
    if (!event.runId) return;
    const known = runsRef[event.runId];
    // Only accumulate for a run that is still live; replaying old deltas for a
    // finished run would duplicate its persisted output.
    if (!known || !LIVE_STATUSES.has(known.status)) return;
    const data = event.data;
    const record =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const chunk =
      typeof record.text === 'string'
        ? record.text
        : typeof record.delta === 'string'
          ? record.delta
          : typeof record.content === 'string'
            ? record.content
            : '';
    if (chunk === '') return;
    const previous = liveByRun[event.runId] ?? '';
    liveByRun = { ...liveByRun, [event.runId]: (previous + chunk).slice(-20_000) };
    return;
  }
  if (event.type === 'stream.ready') return;
  if (
    event.type.startsWith('run.') ||
    event.type.startsWith('tool.') ||
    event.type.startsWith('step.') ||
    event.type.startsWith('approval.') ||
    event.type === 'retry.scheduled'
  ) {
    scheduleRefresh();
  }
  if (event.type === 'state.transition' || event.type === 'ticket.updated') {
    void actions.refresh();
  }
}

$effect(() => {
  const id = ticketId;
  void loadRuns();
  const close = openEventStream({
    ticketId: id,
    since: 0,
    onEvent: handleEvent,
    onReady: () => (connected = true),
    onDisconnect: () => (connected = false)
  });
  return () => {
    close();
    if (refreshTimer) clearTimeout(refreshTimer);
  };
});

$effect(() => {
  const id = selectedRunId;
  if (id === null) return;
  void loadDetail(id);
});

async function runNow() {
  dispatching = true;
  try {
    await actions.dispatch(currentStateId);
    pushToast({ tone: 'success', title: 'Run queued for the current state' });
  } finally {
    dispatching = false;
  }
}
</script>

<div class="space-y-3 p-4" data-testid="agent-work-tab">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Runs
    </h3>
    <span class="flex items-center gap-1 text-[11px] text-[var(--color-ink-subtle)]">
      <span
        class="h-1.5 w-1.5 rounded-full {connected ? 'bg-[var(--color-positive)]' : 'bg-[var(--color-caution)]'}"
        aria-hidden="true"
      ></span>
      {connected ? 'live' : 'reconnecting'}
    </span>
    <span class="ml-auto flex items-center gap-2">
      <a
        class="text-[11px] text-[var(--color-accent)] underline decoration-dotted"
        href={`/approvals?ticketId=${ticketId}`}>Run approvals</a
      >
      <Button size="sm" variant="secondary" loading={dispatching} onclick={runNow}>Run now</Button>
    </span>
  </div>

  {#if runsError}
    <ErrorState message={runsError} onRetry={() => loadRuns()} />
  {:else if runs === null}
    <Skeleton lines={4} height="2rem" />
  {:else if runs.length === 0}
    <EmptyState
      title="No runs yet"
      description="Runs appear here when the ticket enters an agent state or when you press Run now."
    >
      <Button variant="primary" loading={dispatching} onclick={runNow}>Run now</Button>
    </EmptyState>
  {:else}
    <div class="flex gap-1.5 overflow-x-auto pb-1">
      {#each runs as run (run.id)}
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border px-2 py-1 text-[11px] transition-colors
            {selectedRunId === run.id
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
            : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'}"
          onclick={() => (selectedRunId = run.id)}
        >
          <Badge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</Badge>
          <span>#{run.attempt}</span>
        </button>
      {/each}
    </div>

    {#if detailLoading && detail === null}
      <Skeleton lines={6} height="1.5rem" />
    {:else if detailError}
      <ErrorState message={detailError} onRetry={() => selectedRunId && loadDetail(selectedRunId)} />
    {:else if detail}
      <RunTimeline
        run={detail.run}
        steps={detail.steps}
        agentName={detail.agent?.name ?? null}
        agentVersion={
          typeof detail.agentSnapshot === 'object' && detail.agentSnapshot !== null
            ? Number((detail.agentSnapshot as { version?: unknown }).version ?? detail.run.agentVersion)
            : detail.run.agentVersion
        }
        {transitionNames}
        approvals={detail.approvals}
        liveText={liveByRun[detail.run.id] ?? ''}
        onCancel={(runId) => actions.cancelRun(runId)}
      />
    {/if}
  {/if}
</div>
