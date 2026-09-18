<script lang="ts">
/**
 * SettingsAudit: the append-only ledger.
 *
 * Audit rows are written inside the same transaction as the domain change they
 * describe and are redacted before persistence, so what this screen shows is
 * already safe to display. The detail panel says that explicitly rather than
 * implying the interface is doing the redacting.
 *
 * Honesty note on date filtering: the ledger query accepts `since`/`cursor` as
 * sequence ordinals, not timestamps, so a date range is applied in the interface
 * over the loaded page and labelled as such.
 */

import { formatDateTime, formatRelative, truncate } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import Drawer from '$ui/primitives/Drawer.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import type { AuditEventRecord } from '$ui/types';

let events = $state<AuditEventRecord[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let actionFilter = $state('');
let workItemFilter = $state('');
let entityTypeFilter = $state('');
let entityIdFilter = $state('');
let summaryFilter = $state('');
let fromDate = $state('');
let toDate = $state('');
let selected = $state<AuditEventRecord | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ events: AuditEventRecord[] }>('/audit', {
      action: actionFilter || undefined,
      workflowItemId: workItemFilter || undefined,
      entityType: entityTypeFilter || undefined,
      entityId: entityIdFilter || undefined,
      limit: 200
    });
    events = response.events;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void actionFilter;
  void workItemFilter;
  void entityTypeFilter;
  void entityIdFilter;
  void load();
});

const filtered = $derived.by(() => {
  const from = fromDate ? Date.parse(`${fromDate}T00:00:00.000Z`) : null;
  const to = toDate ? Date.parse(`${toDate}T23:59:59.999Z`) : null;
  const needle = summaryFilter.trim().toLowerCase();
  return events.filter((event) => {
    if (from !== null && event.occurredAt < from) return false;
    if (to !== null && event.occurredAt > to) return false;
    if (needle.length > 0) {
      const haystack =
        `${event.action} ${event.summary ?? ''} ${event.actorLabel ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
});

/** Action names observed in the loaded page, offered as filter suggestions. */
const actionOptions = $derived.by(() => {
  const unique = [...new Set(events.map((event) => event.action))].sort();
  return [{ value: '', label: 'Any action' }, ...unique.map((value) => ({ value, label: value }))];
});

function payloadJson(data: unknown): string {
  if (data === null || data === undefined) return 'null';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function hasPayload(data: unknown): boolean {
  return (
    data !== null &&
    data !== undefined &&
    !(typeof data === 'object' && Object.keys(data as object).length === 0)
  );
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Audit"
    description="The append-only ledger. Every mutation writes its audit row inside the same transaction, redacted before it is persisted."
  >
    {#snippet actions()}
      <Button variant="secondary" loading={loading} onclick={load}>Refresh</Button>
    {/snippet}
  </PageHeader>

  <Card class="space-y-3">
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Select label="Action" options={actionOptions} bind:value={actionFilter} />
      <Input label="Work item id" bind:value={workItemFilter} placeholder="Optional" />
      <Input label="Entity type" bind:value={entityTypeFilter} placeholder="work item, file, job…" />
      <Input label="Entity id" bind:value={entityIdFilter} placeholder="Optional" />
      <Input label="Summary contains" bind:value={summaryFilter} placeholder="Client-side over loaded rows" />
      <div class="grid grid-cols-2 gap-2">
        <Input label="From" type="date" bind:value={fromDate} />
        <Input label="To" type="date" bind:value={toDate} />
      </div>
    </div>
    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      Action, work item, entity and the row limit are applied by the ledger query. Date range and summary
      text are applied in the interface over the loaded page, because the query takes sequence
      ordinals rather than timestamps.
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <Badge tone="neutral">{filtered.length} of {events.length} loaded rows</Badge>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => {
          actionFilter = '';
          workItemFilter = '';
          entityTypeFilter = '';
          entityIdFilter = '';
          summaryFilter = '';
          fromDate = '';
          toDate = '';
        }}
      >
        Reset filters
      </Button>
    </div>
  </Card>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if filtered.length === 0}
    <Card>
      <EmptyState
        title="No audit entries match"
        description="The ledger records workspace, work item, file, job, secret, configuration and analytics changes. Clear a filter to see more."
      />
    </Card>
  {:else}
    <DataTable
      columns={[
        { key: 'seq', label: 'Seq', align: 'right' },
        { key: 'action', label: 'Action' },
        { key: 'summary', label: 'Summary' },
        { key: 'actor', label: 'Actor', hideBelow: 'md' },
        { key: 'entity', label: 'Entity', hideBelow: 'lg' },
        { key: 'when', label: 'When', align: 'right' }
      ]}
      rows={filtered}
      rowKey={(item) => String((item as AuditEventRecord).seq)}
      caption="Audit ledger"
    >
      {#snippet row(item)}
        {@const event = item as AuditEventRecord}
        <td class="px-3 py-2 text-right font-mono text-[11px]">{event.seq}</td>
        <td class="px-3 py-2">
          <button
            type="button"
            class="rounded-[var(--radius-xs)] font-mono text-[11px] hover:underline"
            onclick={() => (selected = event)}
          >
            {event.action}
          </button>
        </td>
        <td class="max-w-md px-3 py-2 text-xs">{truncate(event.summary ?? '—', 120)}</td>
        <td class="hidden px-3 py-2 text-[11px] md:table-cell">
          {event.actorType}
          {#if event.actorLabel}<span class="block text-[10px] text-[var(--color-ink-subtle)]">{event.actorLabel}</span>{/if}
        </td>
        <td class="hidden px-3 py-2 font-mono text-[10px] lg:table-cell">
          {event.entityType ?? '—'}
          {#if event.entityId}<span class="block">{event.entityId.slice(0, 12)}</span>{/if}
        </td>
        <td class="px-3 py-2 text-right text-[11px] whitespace-nowrap" title={formatDateTime(event.occurredAt)}>
          {formatRelative(event.occurredAt)}
        </td>
      {/snippet}
    </DataTable>
  {/if}
</div>

<Drawer
  open={selected !== null}
  title={selected ? selected.action : 'Audit entry'}
  subtitle={selected ? `seq ${selected.seq}` : undefined}
  width="42rem"
  onclose={() => (selected = null)}
>
  <div class="space-y-4 p-5">
    {#if selected}
      <p class="text-xs text-[var(--color-ink-muted)]">{selected.summary ?? 'No summary recorded.'}</p>

      <dl class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Occurred</dt>
          <dd>{formatDateTime(selected.occurredAt)}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Actor</dt>
          <dd>{selected.actorType}{selected.actorLabel ? ` · ${selected.actorLabel}` : ''}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Entity</dt>
          <dd class="font-mono text-[11px]">{selected.entityType ?? '—'} {selected.entityId ?? ''}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Actor id</dt>
          <dd class="font-mono text-[11px]">{selected.actorId ?? '—'}</dd>
        </div>
        {#if selected.workflowItemId}
          <div>
            <dt class="text-[var(--color-ink-subtle)]">Work item</dt>
            <dd class="font-mono text-[11px]">{selected.workflowItemId}</dd>
          </div>
        {/if}
        {#if selected.fileId}
          <div>
            <dt class="text-[var(--color-ink-subtle)]">File</dt>
            <dd class="font-mono text-[11px]">{selected.fileId}</dd>
          </div>
        {/if}
        {#if selected.runId}
          <div>
            <dt class="text-[var(--color-ink-subtle)]">Run</dt>
            <dd class="font-mono text-[11px]">{selected.runId}</dd>
          </div>
        {/if}
        {#if selected.jobId}
          <div>
            <dt class="text-[var(--color-ink-subtle)]">Job</dt>
            <dd class="font-mono text-[11px]">{selected.jobId}</dd>
          </div>
        {/if}
      </dl>

      <section class="space-y-2">
        <div class="flex items-center gap-2">
          <h3 class="text-xs font-semibold">Data payload</h3>
          {#if hasPayload(selected.data)}
            <Badge tone="positive">redacted before storage</Badge>
          {:else}
            <Badge tone="muted">empty</Badge>
          {/if}
        </div>
        <pre class="scrollbar-thin max-h-96 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{payloadJson(selected.data)}</pre>
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          The ledger redacts summary and data before persisting the row, using structural rules plus
          the process-wide secret registry. This view renders what was stored; it is not performing a
          second redaction pass.
        </p>
      </section>
    {/if}
  </div>
</Drawer>
