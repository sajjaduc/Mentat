<script lang="ts">
/**
 * SettingsJobs: the durable job queue.
 *
 * Jobs live in the same transactional store as domain data, so "enqueue after the
 * state change commits" is literally true (ADR-0016). A worker leases a job, and if
 * it dies the lease expires and the job becomes leasable again — no external
 * reaper. The attempts drawer makes that visible, including the `lease_expired`
 * rows that explain a retry.
 */

import { formatDateTime, formatDurationShort, formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import { jobStatusLabel, jobStatusTone } from '$ui/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import Drawer from '$ui/primitives/Drawer.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import type { JobAttempt, JobRecord } from '$ui/types';

let jobs = $state<JobRecord[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let statusFilter = $state('');
let typeFilter = $state('');
let ticketFilter = $state('');

let selected = $state<JobRecord | null>(null);
let attempts = $state<JobAttempt[]>([]);
let attemptsLoading = $state(false);
let attemptsError = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ jobs: JobRecord[] }>('/jobs', {
      status: statusFilter || undefined,
      type: typeFilter || undefined,
      ticketId: ticketFilter || undefined,
      limit: 200
    });
    jobs = response.jobs;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void statusFilter;
  void typeFilter;
  void ticketFilter;
  void load();
});

async function openAttempts(job: JobRecord) {
  selected = job;
  attempts = [];
  attemptsError = null;
  attemptsLoading = true;
  try {
    const response = await api.get<{ attempts: JobAttempt[] }>(`/jobs/${job.id}/attempts`);
    attempts = response.attempts;
  } catch (failure) {
    attemptsError = describeApiError(failure);
  } finally {
    attemptsLoading = false;
  }
}

/** True when a job is currently leased by a worker (its lease may still expire). */
function isLeased(job: JobRecord): boolean {
  return job.status === 'leased' && job.leaseExpiresAt !== null;
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Jobs"
    description="Durable queue for processing, agent execution, triggers and cleanup. A lease that expires returns the job to the queue; the attempts drawer records when that happened."
  >
    {#snippet actions()}
      <Button variant="secondary" loading={loading} onclick={load}>Refresh</Button>
    {/snippet}
  </PageHeader>

  <Card class="grid gap-3 sm:grid-cols-3">
    <Select
      label="Status"
      options={[
        { value: '', label: 'Any status' },
        ...['pending', 'leased', 'completed', 'failed', 'dead', 'cancelled'].map((value) => ({
          value,
          label: jobStatusLabel(value)
        }))
      ]}
      bind:value={statusFilter}
    />
    <Input label="Type" bind:value={typeFilter} placeholder="file.process" />
    <Input label="Ticket id" bind:value={ticketFilter} placeholder="Optional" />
  </Card>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if jobs.length === 0}
    <Card>
      <EmptyState
        title="No jobs match"
        description="Jobs appear here when a state entry, a file ingestion or a trigger enqueues durable work. Clear a filter or wait for work to arrive."
      />
    </Card>
  {:else}
    <DataTable
      columns={[
        { key: 'type', label: 'Type' },
        { key: 'status', label: 'Status' },
        { key: 'attempts', label: 'Attempts', align: 'right' },
        { key: 'available', label: 'Available', hideBelow: 'md' },
        { key: 'lease', label: 'Lease', hideBelow: 'lg' },
        { key: 'error', label: 'Last error', hideBelow: 'lg' },
        { key: 'actions', label: '', align: 'right' }
      ]}
      rows={jobs}
      rowKey={(item) => (item as JobRecord).id}
      caption="Durable jobs"
    >
      {#snippet row(item)}
        {@const job = item as JobRecord}
        <td class="px-3 py-2">
          <span class="font-mono text-xs">{job.type}</span>
          <span class="block text-[10px] text-[var(--color-ink-subtle)]" title={formatDateTime(job.createdAt)}>
            created {formatRelative(job.createdAt)}
          </span>
        </td>
        <td class="px-3 py-2">
          <Badge tone={jobStatusTone(job.status)} dot>{jobStatusLabel(job.status)}</Badge>
        </td>
        <td class="px-3 py-2 text-right text-xs">{job.attempts} / {job.maxAttempts}</td>
        <td class="hidden px-3 py-2 text-xs whitespace-nowrap md:table-cell" title={formatDateTime(job.availableAt)}>
          {formatRelative(job.availableAt)}
        </td>
        <td class="hidden px-3 py-2 text-xs lg:table-cell">
          {#if isLeased(job)}
            <span class="font-mono text-[11px]">{job.leasedBy ?? 'worker'}</span>
            <span class="block text-[10px] text-[var(--color-ink-subtle)]">
              expires {formatRelative(job.leaseExpiresAt)}
            </span>
          {:else}
            —
          {/if}
        </td>
        <td class="hidden max-w-xs px-3 py-2 text-[11px] text-[var(--color-danger)] lg:table-cell">
          {job.lastError ?? '—'}
        </td>
        <td class="px-3 py-2">
          <div class="flex justify-end">
            <Button size="sm" variant="secondary" onclick={() => openAttempts(job)}>Attempts</Button>
          </div>
        </td>
      {/snippet}
    </DataTable>
  {/if}
</div>

<Drawer
  open={selected !== null}
  title={selected ? selected.type : 'Job attempts'}
  subtitle={selected ? `attempt ${selected.attempts} of ${selected.maxAttempts}` : undefined}
  width="40rem"
  onclose={() => (selected = null)}
>
  <div class="space-y-4 p-5">
    {#if selected}
      <dl class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Status</dt>
          <dd><Badge tone={jobStatusTone(selected.status)}>{jobStatusLabel(selected.status)}</Badge></dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Queue</dt>
          <dd class="font-mono text-[11px]">{selected.queue}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Available at</dt>
          <dd>{formatDateTime(selected.availableAt)}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Lease holder</dt>
          <dd class="font-mono text-[11px]">{selected.leasedBy ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Lease expires</dt>
          <dd>{selected.leaseExpiresAt ? formatDateTime(selected.leaseExpiresAt) : '—'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Ticket</dt>
          <dd class="font-mono text-[11px]">{selected.ticketId ?? '—'}</dd>
        </div>
      </dl>

      {#if selected.lastError}
        <div class="rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] p-3">
          <p class="text-[11px] font-medium text-[var(--color-danger)]">
            Last error{selected.lastErrorCode ? ` (${selected.lastErrorCode})` : ''}
          </p>
          <p class="mt-1 font-mono text-[11px] whitespace-pre-wrap">{selected.lastError}</p>
        </div>
      {/if}

      {@const job = selected}
      <section class="space-y-2">
        <h3 class="text-xs font-semibold">Attempt history</h3>
        {#if attemptsLoading}
          <Skeleton lines={3} />
        {:else if attemptsError}
          <ErrorState message={attemptsError} onRetry={() => job && openAttempts(job)} />
        {:else if attempts.length === 0}
          <p class="text-xs text-[var(--color-ink-subtle)]">No attempts recorded yet.</p>
        {:else}
          <ul class="space-y-1.5">
            {#each attempts as attempt (attempt.id)}
              <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-3 py-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-mono text-[11px]">#{attempt.attempt}</span>
                  <Badge
                    tone={attempt.status === 'succeeded'
                      ? 'positive'
                      : attempt.status === 'failed'
                        ? 'danger'
                        : attempt.status === 'lease_expired'
                          ? 'caution'
                          : 'accent'}
                  >
                    {attempt.status.replace('_', ' ')}
                  </Badge>
                  <span class="font-mono text-[10px] text-[var(--color-ink-subtle)]">{attempt.workerId}</span>
                  <span class="ml-auto text-[10px] text-[var(--color-ink-subtle)]">
                    {attempt.durationMs !== null ? formatDurationShort(attempt.durationMs) : 'running'}
                  </span>
                </div>
                <p class="mt-1 text-[10px] text-[var(--color-ink-subtle)]">
                  started {formatDateTime(attempt.startedAt)}
                  {#if attempt.finishedAt}· finished {formatDateTime(attempt.finishedAt)}{/if}
                </p>
                {#if attempt.status === 'lease_expired'}
                  <p class="mt-1 text-[11px] text-[var(--color-caution)]">
                    The worker's lease expired before it reported completion, so the job returned to
                    the queue and this attempt was closed.
                  </p>
                {/if}
                {#if attempt.error}
                  <p class="mt-1 font-mono text-[11px] whitespace-pre-wrap text-[var(--color-danger)]">
                    {attempt.error}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
</Drawer>
