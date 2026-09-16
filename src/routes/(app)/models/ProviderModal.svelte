<script lang="ts">
/**
 * ProviderModal: create or edit a provider, then optionally test it.
 *
 * Creation is a two-step flow because the health probe needs an id: step one saves the
 * provider, step two offers the test and a "Continue" affordance. The test result is
 * never a gate — a provider that is down can still be configured and fixed later.
 * Editing keeps the same form and tests inline without leaving the sheet.
 */

import { pluralize } from '$shared/format';
import type { CheckHealthResult, Provider, ProviderHealth, ProviderType } from '$ui/agents/types';
import { PROVIDER_TYPE_LABELS } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import StatusBadge from '$ui/http/controls/StatusBadge.svelte';
import Toggle from '$ui/http/controls/Toggle.svelte';
import type { SecretView } from '$ui/http/types';
import type { Option } from '$ui/primitives';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import { pushToast } from '$ui/toast';

interface Props {
  open: boolean;
  provider: Provider | null;
  secrets: SecretView[];
  onclose: () => void;
  onupdate: (provider: Provider, created: boolean) => void;
}

let { open, provider, secrets, onclose, onupdate }: Props = $props();

const PROVIDER_TYPES: ProviderType[] = [
  'ollama',
  'openai',
  'openai_compatible',
  'anthropic',
  'fake'
];
const TYPE_OPTIONS: Option[] = PROVIDER_TYPES.map((value) => ({
  value,
  label: PROVIDER_TYPE_LABELS[value]
}));

let name = $state('');
let type = $state<ProviderType>('ollama');
let baseUrl = $state('');
let apiKeySecretId = $state('');
let keepAlive = $state('');
let enabled = $state(true);
let isDefault = $state(false);

let step = $state<'form' | 'test'>('form');
let created = $state<Provider | null>(null);
let health = $state<ProviderHealth | null>(null);
let testing = $state(false);
let saving = $state(false);
let touched = $state(false);
let formError = $state<string | null>(null);
let suggestError = $state<string | null>(null);

const secretOptions = $derived(
  secrets.map((secret) => ({ value: secret.id, label: secretLabel(secret) }))
);
const nameError = $derived(name.trim().length === 0 ? 'Required' : null);
const baseUrlError = $derived(
  baseUrl.trim().length > 0 && !/^https?:\/\//.test(baseUrl.trim())
    ? 'Must start with http:// or https://'
    : null
);

function secretLabel(secret: SecretView): string {
  const suffix = secret.lastFour ? ` ····${secret.lastFour}` : '';
  return `${secret.key} · ${secret.name}${suffix}`;
}

function reset() {
  name = provider?.name ?? '';
  type = provider?.type ?? 'ollama';
  baseUrl = provider?.baseUrl ?? '';
  apiKeySecretId = provider?.apiKeySecretId ?? '';
  keepAlive = provider?.config?.keepAlive ?? '';
  enabled = provider?.enabled ?? true;
  isDefault = provider?.isDefault ?? false;
  step = 'form';
  created = null;
  health = null;
  testing = false;
  saving = false;
  touched = false;
  formError = null;
  suggestError = null;
  if (!provider) void suggest(type);
}

async function suggest(next: ProviderType) {
  if (next === 'fake') {
    baseUrl = '';
    return;
  }
  try {
    const result = await api.post<{ baseUrl: string | null }>('/api/providers/suggest', {
      type: next
    });
    if (type !== next) return;
    if (result.baseUrl !== null) baseUrl = result.baseUrl;
  } catch (failure) {
    suggestError = describeApiError(failure);
  }
}

function onTypeChange(next: ProviderType) {
  type = next;
  suggestError = null;
  void suggest(next);
}

function buildConfig(): Provider['config'] {
  const config = { ...(provider?.config ?? {}) };
  const keepAliveValue = keepAlive.trim();
  if (keepAliveValue.length > 0) config.keepAlive = keepAliveValue;
  else delete config.keepAlive;
  return Object.keys(config).length > 0 ? config : null;
}

async function save() {
  touched = true;
  if (nameError !== null || baseUrlError !== null) return;
  saving = true;
  formError = null;
  try {
    if (provider) {
      const result = await api.patch<{ provider: Provider }>(`/api/providers/${provider.id}`, {
        name: name.trim(),
        baseUrl: baseUrl.trim() || null,
        apiKeySecretId: apiKeySecretId || null,
        config: buildConfig(),
        enabled,
        isDefault
      });
      onupdate(result.provider, false);
      pushToast({ tone: 'success', title: `Provider “${result.provider.name}” updated` });
      onclose();
    } else {
      const result = await api.post<{ provider: Provider }>('/api/providers', {
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim() || null,
        apiKeySecretId: apiKeySecretId || null,
        config: buildConfig(),
        isDefault
      });
      created = result.provider;
      onupdate(result.provider, true);
      step = 'test';
      pushToast({ tone: 'success', title: `Provider “${result.provider.name}” created` });
    }
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    saving = false;
  }
}

async function test() {
  const id = provider?.id ?? created?.id;
  if (!id) return;
  testing = true;
  formError = null;
  try {
    const result = await api.post<CheckHealthResult>(`/api/providers/${id}/health`);
    health = result.health;
    onupdate(result.provider, false);
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    testing = false;
  }
}

$effect(() => {
  if (open) reset();
});
</script>

{#snippet healthPanel()}
  {#if health}
    <div
      class="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-3"
    >
      <div class="flex flex-wrap items-center gap-2">
        <StatusBadge status={health.status} dot />
        <span class="text-xs text-[var(--color-ink)]">
          {health.status === 'unreachable' ? 'Unreachable' : 'Reachable'}
        </span>
        {#if health.latencyMs !== undefined}
          <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]">
            {health.latencyMs} ms
          </span>
        {/if}
      </div>
      {#if health.modelCount !== undefined}
        <p class="text-[11px] text-[var(--color-ink-subtle)]">
          {pluralize(health.modelCount, 'model')} available
        </p>
      {/if}
      {#if health.message}
        <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">{health.message}</p>
      {/if}
    </div>
  {/if}
{/snippet}

<Modal
  {open}
  title={provider ? 'Edit provider' : 'Connect a provider'}
  description={provider
    ? 'Change how Mentat reaches this provider. Health is checked separately.'
    : 'A provider is a model server. Ollama runs locally; OpenAI-compatible endpoints cover most hosted and self-hosted gateways.'}
  width="34rem"
  onclose={onclose}
>
  {#snippet footer()}
    {#if step === 'form'}
      <Button variant="ghost" onclick={onclose}>Cancel</Button>
      {#if provider}
        <Button variant="secondary" onclick={test} loading={testing}>Test connection</Button>
      {/if}
      <Button variant="primary" onclick={save} loading={saving}>
        {provider ? 'Save changes' : 'Create provider'}
      </Button>
    {:else}
      <Button variant="secondary" onclick={test} loading={testing}>Test connection</Button>
      <Button variant="primary" onclick={onclose}>Continue</Button>
    {/if}
  {/snippet}

  {#if step === 'test' && created}
    <div class="space-y-4">
      <div
        class="space-y-0.5 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-positive)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-positive)_8%,var(--color-surface))] p-3"
      >
        <p class="text-sm font-medium text-[var(--color-ink)]">
          {created.name} created
        </p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Test the connection now if you like. This does not block anything — you can test and
          refresh models from the provider list at any time.
        </p>
      </div>
      {@render healthPanel()}
      {#if health === null}
        <p class="text-xs text-[var(--color-ink-subtle)]">
          No connection test has run yet.
        </p>
      {/if}
      {#if formError}
        <p class="text-xs text-[var(--color-danger)]" role="alert">{formError}</p>
      {/if}
    </div>
  {:else}
    <div class="space-y-4">
      {#if provider}
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-[var(--color-ink-muted)]">Type</span>
          <Badge tone="neutral">{PROVIDER_TYPE_LABELS[provider.type]}</Badge>
          <span class="text-[11px] text-[var(--color-ink-subtle)]">
            The type is fixed once a provider exists.
          </span>
        </div>
      {:else}
        <Select
          label="Type"
          options={TYPE_OPTIONS}
          value={type}
          hint="Changing the type loads this deployment's suggested base URL."
          onchange={(event) => onTypeChange(event.currentTarget.value as ProviderType)}
        />
      {/if}

      <Input
        label="Name"
        value={name}
        error={touched ? nameError : null}
        placeholder="Local Ollama"
        oninput={(event) => (name = event.currentTarget.value)}
      />

      <Input
        label="Base URL"
        value={baseUrl}
        error={touched ? baseUrlError : null}
        placeholder="http://localhost:11434"
        oninput={(event) => (baseUrl = event.currentTarget.value)}
      />
      {#if suggestError}
        <p class="text-xs text-[var(--color-ink-muted)]" role="status">{suggestError}</p>
      {/if}

      <Select
        label="API key secret"
        options={secretOptions}
        placeholder="No API key"
        value={apiKeySecretId}
        hint="A reference only. Mentat never displays the key's value."
        onchange={(event) => (apiKeySecretId = event.currentTarget.value)}
      />
      {#if secrets.length === 0}
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          No secrets are stored yet. Add one under <a
            class="underline hover:text-[var(--color-ink)]"
            href="/settings">Settings</a
          > if this provider needs an API key.
        </p>
      {/if}

      <Input
        label="Keep-alive"
        value={keepAlive}
        placeholder="5m"
        hint="Ollama only: how long a model stays loaded between requests."
        oninput={(event) => (keepAlive = event.currentTarget.value)}
      />

      <div class="flex flex-wrap items-start gap-6">
        <Toggle
          bind:checked={enabled}
          label="Enabled"
          hint="Disabled providers are hidden from agent model pickers."
        />
        <Toggle
          bind:checked={isDefault}
          label="Default provider"
          hint="Used when an agent does not name one."
        />
      </div>

      {#if formError}
        <p class="text-xs text-[var(--color-danger)]" role="alert">{formError}</p>
      {/if}

      {#if provider}
        {@render healthPanel()}
      {/if}
    </div>
  {/if}
</Modal>
