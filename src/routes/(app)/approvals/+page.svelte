<script lang="ts">
/**
 * Approvals inbox.
 *
 * An approval suspends a running execution, so the reviewer must see the exact
 * action and its arguments before deciding — not a summary. Rejection requires a
 * comment because the API enforces it; the UI says so before the round trip rather
 * than after. Decisions update the row immediately and the live stream confirms the
 * resume.
 */

import { page } from '$app/state';
import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import { openEventStream } from '$ui/work/events';
import { approvalStatusTone } from '$ui/work/format';
import JsonBlock from '$ui/work/JsonBlock.svelte';
import type { ApprovalView, AuditEventView } from '$ui/work/types';
import { replaceQuery } from '$ui/work/url';

const ALL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];
const STATUS_FILTERS = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' }
];

let approvals = $state<ApprovalView[] | null>(null);
let pendingCount = $state(0);
let loading = $state(true);
let error = $state<string | null>(null);
let selectedId = $state<string | null>(null);
let comment = $state('');
let deciding = $state(false);
let decideError = $state<string | null>(null);
let history = $state<AuditEventView[]>([]);

const rawStatus = $derived(page.url.searchParams.get('status') ?? 'pending');
const activeStatus = $derived(
  STATUS_FILTERS.some((filter) => filter.id === rawStatus) ? rawStatus : 'pending'
);
const ticketFilter = $derived(page.url.searchParams.get('ticketId'));
const selected = $derived(approvals?.find((approval) => approval.id === selectedId) ?? null);

function statusQuery(): string {
  if (activeStatus === 'all') {
    return ALL_STATUSES.map((status) => `status=${status}`).join('&');
  }
  return `status=${activeStatus}`;
}

async function load(selectFirst = false) {
  loading = true;
  error = null;
  try {
    const query = statusQuery();
    const ticketPart = ticketFilter ? `&ticketId=${ticketFilter}` : '';
    const response = await api.get<{ approvals: ApprovalView[]; pendingCount: number }>(
      `/api/approvals?${query}${ticketPart}&limit=100`
    );
    approvals = response.approvals;
    pendingCount = response.pendingCount;
    if (selectFirst && response.approvals[0]) selectedId = response.approvals[0].id;
    if (selectedId && !response.approvals.some((approval) => approval.id === selectedId)) {
      selectedId = response.approvals[0]?.id ?? null;
    }
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function loadHistory(approvalId: string) {
  history = [];
  try {
    const response = await api.get<{ events: AuditEventView[] }>(
      `/api/audit?entityType=approval&entityId=${approvalId}&limit=50`
    );
    history = response.events;
  } catch {
    // History is supporting evidence; the approval itself still renders.
  }
}

$effect(() => {
  const status = activeStatus;
  const ticket = ticketFilter;
  void status;
  void ticket;
  selectedId = null;
  comment = '';
  void load(true);
});

$effect(() => {
  const id = selectedId;
  if (id === null) return;
  void loadHistory(id);
});

$effect(() => {
  const close = openEventStream({
    since: 0,
    onEvent: (event) => {
      if (
        event.type === 'approval.decided' ||
        event.type === 'run.resumed' ||
        event.type === 'approval.requested'
      ) {
        void load();
        if (selectedId) void loadHistory(selectedId);
      }
    }
  });
  return close;
});

async function decide(decision: 'approved' | 'rejected') {
  const approval = selected;
  if (!approval) return;
  if (decision === 'rejected' && comment.trim() === '') {
    decideError = 'A rejection needs a comment so the requester knows what to change.';
    return;
  }
  deciding = true;
  decideError = null;
  const previous = approvals ?? [];
  approvals = previous.map((entry) =>
    entry.id === approval.id
      ? {
          ...entry,
          status: decision,
          decidedAt: Date.now(),
          decidedByLabel: entry.decidedByLabel ?? 'You',
          decisionComment: comment.trim() === '' ? null : comment.trim()
        }
      : entry
  );
  try {
    await api.post(`/api/approvals/${approval.id}/decide`, {
      decision,
      comment: comment.trim() === '' ? undefined : comment.trim()
    });
    pendingCount = Math.max(0, pendingCount - (activeStatus === 'pending' ? 1 : 0));
    comment = '';
    pushToast({
      tone: 'success',
      title: decision === 'approved' ? 'Approved' : 'Rejected',
      description: decision === 'approved' ? 'The run will resume.' : 'The run will not continue.'
    });
    await load();
    if (selectedId) await loadHistory(selectedId);
  } catch (failure) {
    approvals = previous;
    decideError = describeApiError(failure);
  } finally {
    deciding = false;
  }
}

const rejectBlocked = $derived(comment.trim() === '');
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <header class="border-b border-[var(--color-border-subtle)] px-4 py-3">
    <div class="flex flex-wrap items-center gap-3">
      <div>
        <h1 class="text-lg font-semibold">Approvals</h1>
        <p class="text-xs text-[var(--color-ink-subtle)]">
          {pendingCount} pending · approving resumes the suspended run
        </p>
      </div>
      <div class="ml-auto flex flex-wrap gap-1">
        {#each STATUS_FILTERS as filter (filter.id)}
          <button
            type="button"
            aria-pressed={activeStatus === filter.id}
            class="rounded-full border px-2.5 py-1 text-[11px] transition-colors
              {activeStatus === filter.id
              ? 'border-transparent bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'
              : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]'}"
            onclick={() =>
              replaceQuery({
                status: filter.id === 'pending' ? null : filter.id,
                ticketId: null
              })}
          >
            {filter.label}
          </button>
        {/each}
      </div>
    </div>
    {#if ticketFilter}
      <p class="mt-1 text-[11px] text-[var(--color-ink-subtle)]">
        Filtered to one ticket.
        <button
          type="button"
          class="underline decoration-dotted"
          onclick={() => replaceQuery({ ticketId: null })}>Clear</button
        >
      </p>
    {/if}
  </header>

  <div class="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 lg:grid-cols-[22rem_1fr]">
    <div class="scrollbar-thin min-h-0 overflow-y-auto">
      {#if loading && approvals === null}
        <Skeleton lines={6} height="2.5rem" />
      {:else if error}
        <ErrorState message={error} onRetry={() => load(true)} />
      {:else if !approvals || approvals.length === 0}
        <EmptyState
          title="Nothing to review"
          description="Approvals appear here when an agent asks for permission or a policy gates a change."
        />
      {:else}
        <ul class="space-y-2">
          {#each approvals as approval (approval.id)}
            <li>
              <button
                type="button"
                class="w-full rounded-[var(--radius-md)] border p-2.5 text-left transition-colors
                  {selectedId === approval.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40'
                  : 'border-[var(--color-border-subtle)] hover:border-[var(--color-border-strong)]'}"
                onclick={() => {
                  selectedId = approval.id;
                  comment = '';
                  decideError = null;
                }}
              >
                <div class="flex items-center gap-2">
                  <Badge tone={approvalStatusTone(approval.status)}>{approval.status}</Badge>
                  <Badge tone="muted">{approval.kind.replace('_', ' ')}</Badge>
                  <span class="ml-auto text-[10px] text-[var(--color-ink-subtle)]"
                    >{formatRelative(approval.createdAt)}</span
                  >
                </div>
                <p class="mt-1 truncate text-sm font-medium">{approval.title}</p>
                <p class="truncate text-[11px] text-[var(--color-ink-subtle)]">
                  {#if approval.ticketKey}<span class="font-mono">{approval.ticketKey}</span>{/if}
                  {approval.ticketTitle ?? approval.description ?? ''}
                </p>
                <p class="mt-1 text-[10px] text-[var(--color-ink-subtle)]">
                  Requested by {approval.requestedByLabel ?? approval.requestedByType}
                </p>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="scrollbar-thin min-h-0 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      {#if !selected}
        <EmptyState
          title="Select an approval"
          description="Pick a request to see exactly what it will do, then approve or reject it."
        />
      {:else}
        <div class="space-y-4">
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <Badge tone={approvalStatusTone(selected.status)}>{selected.status}</Badge>
              <Badge tone="muted">{selected.kind.replace('_', ' ')}</Badge>
              <span class="text-[11px] text-[var(--color-ink-subtle)]"
                >{formatRelative(selected.createdAt)}</span
              >
            </div>
            <h2 class="text-base font-semibold">{selected.title}</h2>
            {#if selected.description}
              <p class="text-xs text-[var(--color-ink-muted)]">{selected.description}</p>
            {/if}
            <p class="text-xs text-[var(--color-ink-subtle)]">
              Requested by {selected.requestedByLabel ?? selected.requestedByType}
              {#if selected.ticketKey}
                · <a class="underline decoration-dotted" href={`/tickets/${selected.ticketId}`}
                  >{selected.ticketKey}</a
                >
              {/if}
              {#if selected.runStatus}· run {selected.runStatus}{/if}
            </p>
          </div>

          <section class="space-y-2">
            <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
              Requested action
            </h3>
            <p class="text-xs text-[var(--color-ink-muted)]">
              This is exactly what will happen if you approve.
            </p>
            <div class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2">
              <JsonBlock value={selected.requestedAction} label="Arguments" open={true} />
            </div>
            {#if selected.contextSnapshot !== null && selected.contextSnapshot !== undefined}
              <JsonBlock value={selected.contextSnapshot} label="Context snapshot" />
            {/if}
          </section>

          {#if selected.status === 'pending'}
            <section class="space-y-2">
              <Textarea
                value={comment} oninput={(event) => (comment = (event.currentTarget as HTMLTextAreaElement).value)}
                label="Comment"
                rows={3}
                placeholder="Required when rejecting"
                error={decideError}
              />
              {#if rejectBlocked}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  A rejection needs a comment; add one to enable Reject.
                </p>
              {/if}
              <div class="flex justify-end gap-2">
                <Button
                  variant="danger"
                  disabled={rejectBlocked}
                  loading={deciding}
                  onclick={() => decide('rejected')}
                >
                  Reject
                </Button>
                <Button variant="primary" loading={deciding} onclick={() => decide('approved')}>
                  Approve
                </Button>
              </div>
            </section>
          {:else}
            <section class="space-y-1">
              <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
                Decision
              </h3>
              <p class="text-xs">
                {selected.status} by {selected.decidedByLabel ?? 'unknown'}
                {#if selected.decidedAt}· {formatRelative(selected.decidedAt)}{/if}
              </p>
              {#if selected.decisionComment}
                <p class="text-xs text-[var(--color-ink-subtle)]">“{selected.decisionComment}”</p>
              {/if}
            </section>
          {/if}

          <section class="space-y-2">
            <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
              Decision history
            </h3>
            {#if history.length === 0}
              <p class="text-xs text-[var(--color-ink-subtle)]">No recorded events yet.</p>
            {:else}
              <ul class="space-y-1">
                {#each history as event (event.id)}
                  <li class="flex items-center gap-2 text-[11px] text-[var(--color-ink-muted)]">
                    <Badge tone="muted">{event.action}</Badge>
                    <span>{event.actorLabel ?? event.actorType}</span>
                    <span class="ml-auto text-[var(--color-ink-subtle)]"
                      >{formatRelative(event.occurredAt)}</span
                    >
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        </div>
      {/if}
    </div>
  </div>
</div>
