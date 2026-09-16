<script lang="ts">
/**
 * HTTP service detail.
 *
 * Two tabs, matching the two halves of ADR-0014: **Connection** is the transport and
 * policy the runtime reads, **Operations** is the semantic inventory a model sees.
 * Edits are explicit and dirty-tracked — the Connection tab holds a draft so a half-made
 * change is never silently applied to a live integration.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';
import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import {
  type ServiceDraft,
  serviceDraftFromService,
  servicePayload,
  validateServiceDraft
} from '$ui/http/draft';
import OperationsTable from '$ui/http/OperationsTable.svelte';
import RequestLogsPanel from '$ui/http/RequestLogsPanel.svelte';
import ServiceForm from '$ui/http/ServiceForm.svelte';
import type { HttpOperation, HttpRequestLog, HttpService, SecretView } from '$ui/http/types';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import { pushToast } from '$ui/toast';

interface DetailResponse {
  service: HttpService;
  operations: HttpOperation[];
  logs: HttpRequestLog[];
}

let service = $state<HttpService | null>(null);
let operations = $state<HttpOperation[]>([]);
let logs = $state<HttpRequestLog[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let errorCode = $state<string | null>(null);

let secrets = $state<SecretView[]>([]);
let secretsLoading = $state(true);
let secretsError = $state<string | null>(null);

let activeTab = $state<'connection' | 'operations'>('connection');
let draft = $state<ServiceDraft | null>(null);
let snapshot = $state('');
let saving = $state(false);
let archiving = $state(false);

const dirty = $derived(draft !== null && JSON.stringify(draft) !== snapshot);

function codeOf(failure: unknown): string | null {
  return failure instanceof Error && 'code' in failure ? String(failure.code) : null;
}

async function loadSecrets() {
  secretsLoading = true;
  secretsError = null;
  try {
    const response = await api.get<{ secrets: SecretView[] }>('/api/secrets');
    secrets = response.secrets;
  } catch (failure) {
    secretsError = describeApiError(failure);
  } finally {
    secretsLoading = false;
  }
}

async function load() {
  const id = page.params.id;
  if (!id) return;
  loading = true;
  error = null;
  errorCode = null;
  try {
    const detail = await api.get<DetailResponse>(`/api/http/services/${id}`);
    service = detail.service;
    operations = detail.operations;
    logs = detail.logs;
    draft = serviceDraftFromService(detail.service);
    snapshot = JSON.stringify(draft);
  } catch (failure) {
    error = describeApiError(failure);
    errorCode = codeOf(failure);
  } finally {
    loading = false;
  }
  await loadSecrets();
}

void load();

async function reloadLogs() {
  if (!service) return;
  try {
    const response = await api.get<{ logs: HttpRequestLog[] }>('/api/http/logs', {
      serviceId: service.id,
      limit: 50
    });
    logs = response.logs;
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  }
}

async function save() {
  if (!draft || !service) return;
  const problems = validateServiceDraft(draft);
  if (problems.length > 0) {
    pushToast({ tone: 'error', title: problems[0] ?? 'The service is not valid' });
    return;
  }
  saving = true;
  try {
    const response = await api.patch<{ service: HttpService }>(
      `/api/http/services/${service.id}`,
      servicePayload(draft)
    );
    service = response.service;
    draft = serviceDraftFromService(response.service);
    snapshot = JSON.stringify(draft);
    pushToast({ tone: 'success', title: 'Service saved' });
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    saving = false;
  }
}

async function archive() {
  if (!service) return;
  archiving = true;
  try {
    await api.delete(`/api/http/services/${service.id}`);
    pushToast({ tone: 'success', title: `${service.name} archived` });
    await goto('/http-services');
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    archiving = false;
  }
}

function resetDraft() {
  if (service) {
    draft = serviceDraftFromService(service);
    snapshot = JSON.stringify(draft);
  }
}
</script>

<svelte:head><title>{service ? `${service.name} · HTTP Services` : 'HTTP Service'} · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  {#if loading}
    <Skeleton lines={3} height="1.25rem" />
    <div class="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <Skeleton lines={6} height="1rem" />
    </div>
  {:else if error || !service || !draft}
    <PageHeader title="HTTP Service" backHref="/http-services" backLabel="All services" />
    <ErrorState message={error ?? 'The service could not be loaded.'} code={errorCode} onRetry={load} />
  {:else if service && draft}
    <PageHeader
      title={service.name}
      description={service.description ?? `${service.baseUrl} · updated ${formatRelative(service.updatedAt)}`}
      backHref="/http-services"
      backLabel="All services"
    >
      {#snippet actions()}
        <Button
          variant="secondary"
          onclick={() => goto(`/http-services/${page.params.id}/operations/new`)}
        >
          New operation
        </Button>
        <ConfirmButton
          label="Archive"
          confirmLabel="Confirm archive"
          disabled={archiving}
          onconfirm={archive}
        />
      {/snippet}
    </PageHeader>

    <Tabs
      tabs={[
        { id: 'connection', label: 'Connection' },
        { id: 'operations', label: 'Operations', count: operations.length }
      ]}
      active={activeTab}
      onselect={(id) => (activeTab = id as 'connection' | 'operations')}
      class="scrollbar-thin overflow-x-auto"
    />

    {#if activeTab === 'connection'}
      <ServiceForm
        {draft}
        {secrets}
        {secretsLoading}
        {secretsError}
      />
      <div
        class="sticky bottom-4 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-raised)]"
      >
        <p class="text-xs text-[var(--color-ink-subtle)]">
          {dirty ? 'Unsaved changes.' : 'All changes saved.'}
        </p>
        <div class="flex items-center gap-2">
          {#if dirty}
            <Button variant="ghost" size="sm" onclick={resetDraft}>Discard</Button>
          {/if}
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onclick={save}>
            Save changes
          </Button>
        </div>
      </div>
    {:else}
      <Section
        title="Operations"
        description="Each operation is a semantic capability. Exposed operations become tools an agent can be granted."
      >
        {#snippet actions()}
          <Button
            variant="secondary"
            size="sm"
            onclick={() => goto(`/http-services/${page.params.id}/operations/new`)}
          >
            New operation
          </Button>
        {/snippet}
        {#if operations.length === 0}
          <EmptyState
            title="No operations yet"
            description="Add one operation per endpoint you want an agent to be able to call. The editor tests requests against the real API without exposing the credential."
          >
            <Button
              variant="primary"
              onclick={() => goto(`/http-services/${page.params.id}/operations/new`)}
            >
              Create the first operation
            </Button>
          </EmptyState>
        {:else}
          <OperationsTable serviceId={service.id} {operations} />
        {/if}
      </Section>

      <Section
        title="Recent requests"
        description="The last 50 calls against this service, stored with secrets already redacted."
      >
        <RequestLogsPanel
          logs={logs}
          loading={false}
          error={null}
          onRefresh={reloadLogs}
          emptyLabel="No requests have been made against this service yet."
        />
      </Section>
    {/if}
  {/if}
</div>
