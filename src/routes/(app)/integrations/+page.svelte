<script lang="ts">
/**
 * Integrations: the three doors work moves through.
 *
 * Providers let Mentat reach models. HTTP services let agents call the outside
 * world. Triggers let the outside world start work inside Mentat. This page is the
 * honest summary: it shows live health and counts, links to the pages that own each
 * object, and embeds the trigger list so schedules and webhooks can be managed
 * without a second surface.
 */

import { formatRelative, pluralize } from '$shared/format';
import {
  type CheckHealthResult,
  PROVIDER_TYPE_LABELS,
  type Provider,
  type ProviderHealth
} from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import StatusBadge from '$ui/http/controls/StatusBadge.svelte';
import type { HttpOperation, HttpService } from '$ui/http/types';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import TriggerList from '$ui/triggers/TriggerList.svelte';

let providers = $state<Provider[] | null>(null);
let providersError = $state<string | null>(null);
let providersLoading = $state(true);
let healthBusy = $state<string | null>(null);
let healthDetail = $state<Record<string, ProviderHealth>>({});
let healthErrors = $state<Record<string, string>>({});

let services = $state<HttpService[] | null>(null);
let operations = $state<HttpOperation[] | null>(null);
let httpError = $state<string | null>(null);
let httpLoading = $state(true);

async function loadProviders() {
  providersLoading = true;
  providersError = null;
  try {
    const result = await api.get<{ providers: Provider[] }>('/api/providers');
    providers = result.providers;
  } catch (failure) {
    providersError = describeApiError(failure);
  } finally {
    providersLoading = false;
  }
}

async function loadHttp() {
  httpLoading = true;
  httpError = null;
  try {
    const [serviceResult, operationResult] = await Promise.all([
      api.get<{ services: HttpService[] }>('/api/http/services'),
      api.get<{ operations: HttpOperation[] }>('/api/http/operations')
    ]);
    services = serviceResult.services;
    operations = operationResult.operations;
  } catch (failure) {
    httpError = describeApiError(failure);
  } finally {
    httpLoading = false;
  }
}

async function checkHealth(provider: Provider) {
  healthBusy = provider.id;
  const nextErrors = { ...healthErrors };
  delete nextErrors[provider.id];
  healthErrors = nextErrors;
  try {
    const result = await api.post<CheckHealthResult>(`/api/providers/${provider.id}/health`);
    providers = (providers ?? []).map((row) =>
      row.id === result.provider.id ? result.provider : row
    );
    healthDetail = { ...healthDetail, [provider.id]: result.health };
  } catch (failure) {
    healthErrors = { ...healthErrors, [provider.id]: describeApiError(failure) };
  } finally {
    healthBusy = null;
  }
}

function operationCount(serviceId: string): number {
  return (operations ?? []).filter((operation) => operation.serviceId === serviceId).length;
}

$effect(() => {
  void loadProviders();
  void loadHttp();
});

const linkClass =
  'inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3.5 text-sm text-[var(--color-ink)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]';
</script>

<svelte:head><title>Integrations · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Integrations"
    description="Providers, HTTP services and triggers are the three ways work enters or leaves Mentat. Each has one owning page; this overview shows their live state."
  />

  <Section
    title="How work moves"
    description="Models come in through providers. Agents reach the outside world through HTTP services. Outside events — and people or API callers — start work through triggers."
  >
    <div class="grid gap-3 md:grid-cols-3">
      <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <p class="text-sm font-medium text-[var(--color-ink)]">Providers → models</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          A provider is one reachable inference endpoint. It decides which models agents can use.
        </p>
        <a class={linkClass} href="/models">Manage providers and models</a>
      </div>
      <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <p class="text-sm font-medium text-[var(--color-ink)]">HTTP services → outbound calls</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          A service bundles a base URL and auth; its operations are the exact calls an agent may
          make.
        </p>
        <a class={linkClass} href="/http-services">Manage HTTP services</a>
      </div>
      <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <p class="text-sm font-medium text-[var(--color-ink)]">Triggers → inbound work</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Webhooks, schedules and on-demand fires normalize a signal into a work item.
        </p>
        <a class={linkClass} href="#triggers">Jump to triggers</a>
      </div>
    </div>
  </Section>

  <Section
    title="Providers"
    description="Inference endpoints Mentat can reach. Health is recorded per check."
  >
    {#snippet actions()}
      <a class={linkClass} href="/models">Open models</a>
    {/snippet}

    {#if providersLoading && providers === null}
      <Skeleton lines={2} height="2.5rem" />
    {:else if providersError}
      <ErrorState message={providersError} onRetry={loadProviders} />
    {:else if providers === null || providers.length === 0}
      <EmptyState
        title="No providers yet"
        description="Register an Ollama, OpenAI-compatible or Anthropic endpoint so agents have a model to run."
      >
        <a class={linkClass} href="/models">Add a provider</a>
      </EmptyState>
    {:else}
      <ul class="space-y-3">
        {#each providers as provider (provider.id)}
          {@const health = healthDetail[provider.id]}
          <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <p class="truncate text-sm font-medium text-[var(--color-ink)]">{provider.name}</p>
                  <Badge tone="neutral">{PROVIDER_TYPE_LABELS[provider.type]}</Badge>
                  <StatusBadge status={provider.healthStatus} dot />
                </div>
                <p class="truncate font-mono text-[11px] text-[var(--color-ink-subtle)]">
                  {provider.baseUrl ?? 'No base URL'}
                </p>
                {#if provider.healthMessage}
                  <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
                    {provider.healthMessage}
                  </p>
                {/if}
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  {provider.healthCheckedAt === null
                    ? 'Never checked'
                    : `Checked ${formatRelative(provider.healthCheckedAt)}`}
                  {#if health?.latencyMs !== undefined}
                    · {health.latencyMs} ms
                  {/if}
                  {#if health?.modelCount !== undefined}
                    · {pluralize(health.modelCount, 'model')}
                  {/if}
                </p>
                {#if healthErrors[provider.id]}
                  <p class="text-xs text-[var(--color-danger)]">{healthErrors[provider.id]}</p>
                {/if}
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={healthBusy === provider.id}
                onclick={() => checkHealth(provider)}
              >
                Check health
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Section>

  <Section
    title="HTTP services"
    description="Named outbound integrations. Operation counts come from the operations collection."
  >
    {#snippet actions()}
      <a class={linkClass} href="/http-services">Open HTTP services</a>
    {/snippet}

    {#if httpLoading && services === null}
      <Skeleton lines={2} height="2.5rem" />
    {:else if httpError}
      <ErrorState message={httpError} onRetry={loadHttp} />
    {:else if services === null || services.length === 0}
      <EmptyState
        title="No HTTP services yet"
        description="Add a service so agents can call an external API through a reviewed, logged operation instead of free-form requests."
      >
        <a class={linkClass} href="/http-services">Add a service</a>
      </EmptyState>
    {:else}
      <ul class="space-y-3">
        {#each services as service (service.id)}
          <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <p class="truncate text-sm font-medium text-[var(--color-ink)]">{service.name}</p>
                  <Badge tone="neutral">{pluralize(operationCount(service.id), 'operation')}</Badge>
                </div>
                {#if service.description}
                  <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">{service.description}</p>
                {/if}
                <p class="truncate font-mono text-[11px] text-[var(--color-ink-subtle)]">
                  {service.baseUrl}
                </p>
              </div>
              <a class={linkClass} href={`/http-services/${service.id}`}>Open service</a>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Section>

  <div id="triggers">
    <Section
      title="Triggers"
      description="Schedules and webhooks run on their own; manual and API triggers wait for a caller."
    >
      <TriggerList />
    </Section>
  </div>
</div>
