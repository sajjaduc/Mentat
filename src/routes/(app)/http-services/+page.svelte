<script lang="ts">
/**
 * HTTP services index.
 *
 * The list answers four questions at a glance: what the service is, where it points,
 * how it authenticates, and whether its requests are succeeding. Because the services
 * endpoint returns rows without counts, operation counts and the last request status are
 * derived from the operations and logs the page already needs.
 */
import { goto } from '$app/navigation';
import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import SelectField from '$ui/http/controls/SelectField.svelte';
import StatusBadge from '$ui/http/controls/StatusBadge.svelte';
import TextAreaField from '$ui/http/controls/TextAreaField.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import type { HttpAuthType, HttpOperation, HttpRequestLog, HttpService } from '$ui/http/types';
import { AUTH_TYPE_LABELS } from '$ui/http/types';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';

interface ServicesResponse {
  services: HttpService[];
}
interface OperationsResponse {
  operations: HttpOperation[];
}
interface LogsResponse {
  logs: HttpRequestLog[];
}

let services = $state<HttpService[]>([]);
let operations = $state<HttpOperation[]>([]);
let logs = $state<HttpRequestLog[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let errorCode = $state<string | null>(null);
let search = $state('');

let createOpen = $state(false);
let creating = $state(false);
let createError = $state<string | null>(null);

let newName = $state('');
let newDescription = $state('');
let newBaseUrl = $state('');
let newAuthType = $state<HttpAuthType>('none');

const authOptions = (Object.keys(AUTH_TYPE_LABELS) as HttpAuthType[]).map((type) => ({
  value: type,
  label: AUTH_TYPE_LABELS[type]
}));

const operationCounts = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    counts.set(operation.serviceId, (counts.get(operation.serviceId) ?? 0) + 1);
  }
  return counts;
});

const lastLogs = $derived.by(() => {
  const latest = new Map<string, HttpRequestLog>();
  for (const log of logs) {
    if (!latest.has(log.serviceId)) latest.set(log.serviceId, log);
  }
  return latest;
});

const filtered = $derived.by(() => {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return services;
  return services.filter(
    (service) =>
      service.name.toLowerCase().includes(needle) || service.baseUrl.toLowerCase().includes(needle)
  );
});

async function load() {
  loading = true;
  error = null;
  errorCode = null;
  try {
    const [serviceResponse, operationResponse, logResponse] = await Promise.all([
      api.get<ServicesResponse>('/api/http/services'),
      api.get<OperationsResponse>('/api/http/operations'),
      api.get<LogsResponse>('/api/http/logs', { limit: 200 })
    ]);
    services = serviceResponse.services;
    operations = operationResponse.operations;
    logs = logResponse.logs;
  } catch (failure) {
    error = describeApiError(failure);
    errorCode = failure instanceof Error && 'code' in failure ? String(failure.code) : null;
  } finally {
    loading = false;
  }
}

void load();

function openCreate() {
  newName = '';
  newDescription = '';
  newBaseUrl = '';
  newAuthType = 'none';
  createError = null;
  createOpen = true;
}

async function createService() {
  if (newName.trim().length === 0 || newBaseUrl.trim().length === 0) {
    createError = 'A name and a base URL are required.';
    return;
  }
  creating = true;
  createError = null;
  try {
    const created = await api.post<{ service: HttpService }>('/api/http/services', {
      name: newName.trim(),
      description: newDescription,
      baseUrl: newBaseUrl.trim(),
      authType: newAuthType
    });
    createOpen = false;
    pushToast({ tone: 'success', title: `Created ${created.service.name}` });
    await goto(`/http-services/${created.service.id}`);
  } catch (failure) {
    createError = describeApiError(failure);
  } finally {
    creating = false;
  }
}
</script>

<svelte:head><title>HTTP Services · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="HTTP Services"
    description="Reusable connections to third-party APIs. A service owns the base URL, credentials and limits; its operations are the semantic, model-facing tools built on top."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={openCreate}>New service</Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <div class="space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <Skeleton lines={4} height="1rem" />
    </div>
  {:else if error}
    <ErrorState message={error} code={errorCode} onRetry={load} />
  {:else if services.length === 0}
    <div class="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
      <EmptyState
        title="No HTTP services yet"
        description="Create a service, point it at an API and add an operation. Each operation becomes a tool an agent can be granted, without exposing the credential."
      >
        <Button variant="primary" onclick={openCreate}>Create the first service</Button>
      </EmptyState>
    </div>
  {:else}
    <TextField
      value={search}
      placeholder="Search by name or base URL…"
      onchange={(next) => (search = next)}
      id="http-service-search"
    />

    {#if filtered.length === 0}
      <p class="text-xs text-[var(--color-ink-subtle)]">No service matches “{search}”.</p>
    {:else}
      <div class="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
        <table class="w-full min-w-[52rem] border-collapse text-sm">
          <thead>
            <tr class="border-b border-[var(--color-border-subtle)] text-left text-[11px] tracking-wide text-[var(--color-ink-subtle)] uppercase">
              <th class="px-4 py-3 font-medium">Service</th>
              <th class="px-4 py-3 font-medium">Base URL</th>
              <th class="px-4 py-3 font-medium">Auth</th>
              <th class="px-4 py-3 font-medium">Operations</th>
              <th class="px-4 py-3 font-medium">Last request</th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as service (service.id)}
              {@const lastLog = lastLogs.get(service.id)}
              <tr class="border-b border-[var(--color-border-subtle)] last:border-0 hover:bg-[var(--color-surface-muted)]">
                <td class="px-4 py-3">
                  <a
                    class="font-medium text-[var(--color-ink)] hover:text-[var(--color-accent-ink)]"
                    href={`/http-services/${service.id}`}
                  >
                    {service.name}
                  </a>
                  {#if service.workflowId}
                    <p class="text-[11px] text-[var(--color-ink-subtle)]">workflow-scoped</p>
                  {/if}
                </td>
                <td class="max-w-[18rem] truncate px-4 py-3 font-mono text-xs text-[var(--color-ink-muted)]" title={service.baseUrl}>
                  {service.baseUrl}
                </td>
                <td class="px-4 py-3">
                  <Badge tone={service.authType === 'none' ? 'muted' : 'accent'}>
                    {AUTH_TYPE_LABELS[service.authType]}
                  </Badge>
                </td>
                <td class="px-4 py-3 text-xs text-[var(--color-ink-muted)]">
                  {operationCounts.get(service.id) ?? 0}
                </td>
                <td class="px-4 py-3">
                  {#if lastLog}
                    <span class="flex items-center gap-2">
                      <StatusBadge status={lastLog.responseStatus} label={lastLog.error ? 'failed' : undefined} />
                      <span class="text-[11px] text-[var(--color-ink-subtle)]">
                        {formatRelative(lastLog.createdAt)}
                      </span>
                    </span>
                  {:else}
                    <span class="text-xs text-[var(--color-ink-subtle)]">No requests yet</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<Modal
  open={createOpen}
  title="New HTTP service"
  description="Start with the connection details. Authentication and policy defaults are edited on the service page."
  onclose={() => (createOpen = false)}
>
  <div class="space-y-4">
    <TextField label="Name" value={newName} required placeholder="HubSpot" onchange={(next) => (newName = next)} />
    <TextField
      label="Base URL"
      type="url"
      value={newBaseUrl}
      required
      placeholder="https://api.hubapi.com"
      onchange={(next) => (newBaseUrl = next)}
    />
    <TextAreaField
      label="Description"
      value={newDescription}
      rows={2}
      onchange={(next) => (newDescription = next)}
    />
    <SelectField
      label="Authentication"
      options={authOptions}
      value={newAuthType}
      hint="Pick the mechanism now; the secret reference is chosen on the service page."
      onchange={(next) => (newAuthType = next as HttpAuthType)}
    />
    {#if createError}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{createError}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
    <Button variant="primary" loading={creating} onclick={createService}>Create service</Button>
  {/snippet}
</Modal>
