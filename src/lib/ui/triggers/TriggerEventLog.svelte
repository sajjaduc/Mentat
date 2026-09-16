<script lang="ts">
/**
 * TriggerEventLog: the delivery history for one trigger.
 *
 * Each row is one durable event: what arrived, what Mentat did with it, and the
 * redacted payload snapshot. Redaction happens on the server, so the payload shown
 * here is the same one an operator may inspect — never a raw credential.
 */

import { formatDateTime, formatNumber } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import CodeBlock from '$ui/http/controls/CodeBlock.svelte';
import StatusBadge from '$ui/http/controls/StatusBadge.svelte';
import { formatJson } from '$ui/http/json';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { TRIGGER_EVENT_TONES, type TriggerEvent, type TriggerEventStatus } from './types';

interface Props {
  triggerId: string;
}

let { triggerId }: Props = $props();

const STATUS_ORDER: TriggerEventStatus[] = [
  'received',
  'processed',
  'duplicate',
  'failed',
  'ignored'
];

let events = $state<TriggerEvent[] | null>(null);
let error = $state<string | null>(null);
let loading = $state(true);
let expanded = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const result = await api.get<{ events: TriggerEvent[] }>(`/api/triggers/${triggerId}/events`);
    events = result.events;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  const id = triggerId;
  void id;
  void load();
});

const counts = $derived.by(() => {
  const out: Record<TriggerEventStatus, number> = {
    received: 0,
    processed: 0,
    duplicate: 0,
    failed: 0,
    ignored: 0
  };
  for (const event of events ?? []) out[event.status] += 1;
  return out;
});

function toggle(eventId: string) {
  expanded = expanded === eventId ? null : eventId;
}
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-xs font-medium text-[var(--color-ink-muted)]">Recent deliveries</p>
    <Button size="sm" variant="ghost" loading={loading} onclick={load}>Refresh</Button>
  </div>

  {#if loading && events === null}
    <Skeleton lines={3} />
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else if events === null || events.length === 0}
    <EmptyState
      title="No deliveries yet"
      description="Events appear here as soon as this trigger receives a payload, fires on schedule, or is fired by a person or an API caller."
    />
  {:else}
    <div class="flex flex-wrap items-center gap-1.5">
      {#each STATUS_ORDER as status (status)}
        <StatusBadge status={status} label={`${status} ${formatNumber(counts[status])}`} />
      {/each}
    </div>

    <ul class="space-y-2">
      {#each events as event (event.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <Badge tone={TRIGGER_EVENT_TONES[event.status]} dot>{event.status}</Badge>
              <span class="text-xs text-[var(--color-ink-muted)]">{formatDateTime(event.receivedAt)}</span>
              {#if event.payloadBytes !== null}
                <span class="text-[11px] text-[var(--color-ink-subtle)]">{formatNumber(event.payloadBytes)} bytes</span>
              {/if}
            </div>
            <button
              type="button"
              class="text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
              aria-expanded={expanded === event.id}
              onclick={() => toggle(event.id)}
            >
              {expanded === event.id ? 'Hide payload' : 'Show payload'}
            </button>
          </div>

          <dl class="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <dt class="text-[var(--color-ink-subtle)]">Idempotency key</dt>
              <dd class="truncate font-mono text-[var(--color-ink-muted)]">{event.idempotencyKey}</dd>
            </div>
            <div class="flex min-w-0 items-center gap-1.5">
              <dt class="text-[var(--color-ink-subtle)]">Source</dt>
              <dd class="truncate font-mono text-[var(--color-ink-muted)]">{event.source ?? '—'}</dd>
            </div>
            <div class="flex min-w-0 items-center gap-1.5">
              <dt class="text-[var(--color-ink-subtle)]">Ticket</dt>
              <dd class="truncate font-mono text-[var(--color-ink-muted)]">{event.ticketId ?? '—'}</dd>
            </div>
            <div class="flex min-w-0 items-center gap-1.5">
              <dt class="text-[var(--color-ink-subtle)]">Job</dt>
              <dd class="truncate font-mono text-[var(--color-ink-muted)]">{event.jobId ?? '—'}</dd>
            </div>
          </dl>

          {#if event.error}
            <p class="mt-2 rounded-[var(--radius-sm)] bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)] px-2 py-1.5 text-xs text-[var(--color-danger)]">
              {event.error}
            </p>
          {/if}

          {#if expanded === event.id}
            <div class="mt-3">
              <CodeBlock value={formatJson(event.payload)} label="Redacted payload" maxHeight="16rem" />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
