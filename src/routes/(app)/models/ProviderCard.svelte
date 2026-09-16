<script lang="ts">
/**
 * ProviderCard: one provider row with its health, discovery and lifecycle actions.
 *
 * A provider being down is an operational state, not a failure: an unreachable probe
 * renders calmly with the raw message instead of an error banner. Health and refresh
 * are explicit actions because both make network calls the operator chose to spend.
 */

import { formatRelative, pluralize } from '$shared/format';
import type {
  CheckHealthResult,
  Provider,
  ProviderHealth,
  RefreshModelsResult
} from '$ui/agents/types';
import { PROVIDER_TYPE_LABELS } from '$ui/agents/types';
import { api, describeApiError, mutateOptimistic } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import StatusBadge from '$ui/http/controls/StatusBadge.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import { pushToast } from '$ui/toast';
import Switch from './Switch.svelte';

interface Props {
  provider: Provider;
  modelCount: number;
  onreplace: (provider: Provider) => void;
  onremoved: (providerId: string) => void;
  onedit: () => void;
  onmodelschanged: () => void;
}

let { provider, modelCount, onreplace, onremoved, onedit, onmodelschanged }: Props = $props();

let checking = $state(false);
let refreshing = $state(false);
let health = $state<ProviderHealth | null>(null);
let actionError = $state<string | null>(null);

const latencyMs = $derived(health?.latencyMs ?? null);

async function check() {
  checking = true;
  actionError = null;
  try {
    const result = await api.post<CheckHealthResult>(`/api/providers/${provider.id}/health`);
    health = result.health;
    onreplace(result.provider);
    pushToast({
      tone: result.health.status === 'unreachable' ? 'info' : 'success',
      title: `${provider.name}: ${result.health.status}`,
      description: result.health.message
    });
  } catch (failure) {
    actionError = describeApiError(failure);
  } finally {
    checking = false;
  }
}

async function refresh() {
  refreshing = true;
  actionError = null;
  try {
    const result = await api.post<RefreshModelsResult>(
      `/api/providers/${provider.id}/refresh-models`
    );
    pushToast({
      tone: 'success',
      title: `Discovered ${pluralize(result.added, 'model')} on ${provider.name}`,
      description: `${result.updated} updated · ${result.removed} disabled by disappearance`
    });
    onmodelschanged();
  } catch (failure) {
    actionError = describeApiError(failure);
  } finally {
    refreshing = false;
  }
}

async function setEnabled(next: boolean) {
  const snapshot = provider;
  await mutateOptimistic(
    () => api.patch<{ provider: Provider }>(`/api/providers/${provider.id}`, { enabled: next }),
    {
      optimistic: () => {
        onreplace({ ...snapshot, enabled: next });
        return () => onreplace(snapshot);
      },
      onSuccess: (result) => onreplace(result.provider),
      onError: (failure) =>
        pushToast({
          tone: 'error',
          title: 'Could not update provider',
          description: describeApiError(failure)
        })
    }
  );
}

async function setDefault(next: boolean) {
  const snapshot = provider;
  await mutateOptimistic(
    () => api.patch<{ provider: Provider }>(`/api/providers/${provider.id}`, { isDefault: next }),
    {
      optimistic: () => {
        onreplace({ ...snapshot, isDefault: next });
        return () => onreplace(snapshot);
      },
      onSuccess: (result) => onreplace(result.provider),
      onError: (failure) =>
        pushToast({
          tone: 'error',
          title: 'Could not change the default provider',
          description: describeApiError(failure)
        })
    }
  );
}

async function remove() {
  actionError = null;
  try {
    await api.delete(`/api/providers/${provider.id}`);
    pushToast({ tone: 'success', title: `Provider “${provider.name}” deleted` });
    onremoved(provider.id);
  } catch (failure) {
    const message = describeApiError(failure);
    actionError = message;
    pushToast({ tone: 'error', title: 'Could not delete provider', description: message });
  }
}
</script>

<div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold text-[var(--color-ink)]">{provider.name}</h3>
        <Badge tone="neutral">{PROVIDER_TYPE_LABELS[provider.type]}</Badge>
        {#if provider.isDefault}<Badge tone="accent">Default</Badge>{/if}
        {#if !provider.enabled}<Badge tone="muted">Disabled</Badge>{/if}
        {#if provider.apiKeySecretId}<Badge tone="muted">Key reference</Badge>{/if}
      </div>
      <p class="font-mono text-[11px] break-all text-[var(--color-ink-subtle)]">
        {provider.baseUrl ?? 'No base URL configured'}
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-4">
      <Switch checked={provider.enabled} label="Enabled" onchange={setEnabled} />
      <Switch checked={provider.isDefault} label="Make default" onchange={setDefault} />
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-[var(--color-ink-subtle)]">
    <span class="inline-flex items-center gap-1.5">
      <StatusBadge status={provider.healthStatus} dot />
      <span>health</span>
    </span>
    {#if latencyMs !== null}
      <span class="font-mono">{latencyMs} ms</span>
    {/if}
    <span>
      {provider.healthCheckedAt === null
        ? 'Never checked'
        : `Checked ${formatRelative(provider.healthCheckedAt)}`}
    </span>
    <span>{pluralize(modelCount, 'model')}</span>
  </div>

  {#if provider.healthMessage}
    <p
      class="rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--color-ink-muted)]"
    >
      {provider.healthMessage}
    </p>
  {/if}

  {#if actionError}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{actionError}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <Button size="sm" onclick={check} loading={checking}>Check health</Button>
    <Button size="sm" onclick={refresh} loading={refreshing}>Refresh models</Button>
    <Button size="sm" variant="ghost" onclick={onedit}>Edit</Button>
    <ConfirmButton label="Delete" confirmLabel="Delete provider" onconfirm={remove} />
  </div>
</div>
