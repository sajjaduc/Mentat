<script lang="ts">
/**
 * Models & providers.
 *
 * One surface for the whole inference stack: connect a provider, test it, discover
 * its models, then decide which are usable and with what capabilities. Discovery is
 * treated as a starting point rather than the truth — a discovered model's
 * capabilities are heuristics, so overriding them is expected, and a hand-registered
 * model keeps whatever the operator declared.
 */
import { browser } from '$app/environment';
import { pluralize } from '$shared/format';
import type { Model, Provider } from '$ui/agents/types';
import { PROVIDER_TYPE_LABELS } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import type { SecretView } from '$ui/http/types';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import ModelCard from './ModelCard.svelte';
import ProviderCard from './ProviderCard.svelte';
import ProviderModal from './ProviderModal.svelte';
import RegisterModelModal from './RegisterModelModal.svelte';

let providers = $state<Provider[]>([]);
let models = $state<Model[]>([]);
let secrets = $state<SecretView[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

let providerModalOpen = $state(false);
let editingProvider = $state<Provider | null>(null);
let registerModalOpen = $state(false);
let registerProviderId = $state<string | null>(null);

const groups = $derived(
  providers.map((provider) => ({
    provider,
    models: models.filter((model) => model.providerId === provider.id)
  }))
);

async function load() {
  loading = true;
  error = null;
  try {
    const [providerResult, modelResult, secretResult] = await Promise.all([
      api.get<{ providers: Provider[] }>('/api/providers'),
      api.get<{ models: Model[] }>('/api/models', { all: true }),
      api
        .get<{ secrets: SecretView[] }>('/api/secrets')
        .catch(() => ({ secrets: [] as SecretView[] }))
    ]);
    providers = providerResult.providers;
    models = modelResult.models;
    secrets = secretResult.secrets;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function reloadModels() {
  try {
    models = (await api.get<{ models: Model[] }>('/api/models', { all: true })).models;
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not reload models',
      description: describeApiError(failure)
    });
  }
}

function replaceProvider(provider: Provider) {
  providers = providers.map((entry) => (entry.id === provider.id ? provider : entry));
}

function removeProvider(providerId: string) {
  providers = providers.filter((entry) => entry.id !== providerId);
  models = models.filter((model) => model.providerId !== providerId);
}

function replaceModel(model: Model) {
  models = models.map((entry) => (entry.id === model.id ? model : entry));
}

function removeModel(modelId: string) {
  models = models.filter((entry) => entry.id !== modelId);
}

function onProviderUpdate(provider: Provider, created: boolean) {
  if (created) {
    providers = [...providers, provider].sort((a, b) => a.name.localeCompare(b.name));
    return;
  }
  replaceProvider(provider);
}

function openCreateProvider() {
  editingProvider = null;
  providerModalOpen = true;
}

function openEditProvider(provider: Provider) {
  editingProvider = provider;
  providerModalOpen = true;
}

function openRegisterModel(providerId: string | null) {
  registerProviderId = providerId;
  registerModalOpen = true;
}

if (browser) void load();
</script>

<svelte:head><title>Models &amp; providers · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Models & providers"
    description="Connect model servers, discover what they serve, and decide which models agents may use."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={openCreateProvider}>Add provider</Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <div class="space-y-5">
      <Skeleton lines={2} />
      <div
        class="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4"
      >
        <Skeleton lines={5} />
      </div>
    </div>
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else}
    <Section
      title="Providers"
      description="A provider is a model server. Health is an operational state, so an unreachable probe is reported calmly with the raw message from the server."
    >
      {#if providers.length === 0}
        <EmptyState
          title="No models yet"
          description="Connect a provider, confirm Mentat can reach it, then discover the models it serves. Nothing here is required to be reachable before you save it."
        >
          <ol class="mx-auto max-w-md space-y-2 text-left text-xs leading-relaxed text-[var(--color-ink-muted)]">
            <li>1. Connect a provider with <strong>Add provider</strong>.</li>
            <li>2. Test the connection to confirm Mentat can reach it.</li>
            <li>3. Refresh models to discover what the provider serves.</li>
            <li>
              4. Pick a model under <a class="underline hover:text-[var(--color-ink)]" href="/models"
                >/models</a
              > and tune its capabilities and defaults.
            </li>
            <li>
              5. Use it in an agent under <a class="underline hover:text-[var(--color-ink)]" href="/agents"
                >/agents</a
              >.
            </li>
          </ol>
          <div class="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" size="sm" onclick={openCreateProvider}>
              Connect a provider
            </Button>
            <a
              class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]"
              href="/agents">Open Agents</a
            >
          </div>
        </EmptyState>
      {:else}
        <div class="space-y-3">
          {#each providers as provider (provider.id)}
            <ProviderCard
              {provider}
              modelCount={models.filter((model) => model.providerId === provider.id).length}
              onreplace={replaceProvider}
              onremoved={removeProvider}
              onedit={() => openEditProvider(provider)}
              onmodelschanged={reloadModels}
            />
          {/each}
        </div>
      {/if}
    </Section>

    <Section
      title="Models"
      description="A discovered model's capabilities are heuristics, so treat them as guesses and override them when wrong. A hand-registered model keeps its explicit capabilities: a refresh never overwrites them, and models that disappear are disabled rather than deleted so run history stays intact."
    >
      {#snippet actions()}
        <Button
          size="sm"
          disabled={providers.length === 0}
          onclick={() => openRegisterModel(providers[0]?.id ?? null)}>Register a model</Button
        >
      {/snippet}

      {#if providers.length === 0}
        <EmptyState
          title="No models yet"
          description="Models appear after a provider discovers them, or when you register one by hand."
        />
      {:else if models.length === 0}
        <EmptyState
          title="No models discovered yet"
          description="Run Refresh models on a provider above, or register one by hand when discovery cannot know about it."
        >
          <Button size="sm" onclick={() => openRegisterModel(providers[0]?.id ?? null)}>
            Register a model by hand
          </Button>
        </EmptyState>
      {:else}
        <div class="space-y-5">
          {#each groups as group (group.provider.id)}
            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="text-sm font-semibold text-[var(--color-ink)]">
                    {group.provider.name}
                  </h3>
                  <span class="text-[11px] text-[var(--color-ink-subtle)]">
                    {PROVIDER_TYPE_LABELS[group.provider.type]} ·
                    {pluralize(group.models.length, 'model')}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => openRegisterModel(group.provider.id)}
                >
                  Register a model
                </Button>
              </div>

              {#if group.models.length === 0}
                <p
                  class="rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border-subtle)] px-3 py-2 text-xs text-[var(--color-ink-subtle)]"
                >
                  Nothing discovered for this provider yet. Refresh its models, or register one by
                  hand.
                </p>
              {:else}
                <div class="space-y-3">
                  {#each group.models as model (model.id)}
                    <ModelCard
                      {model}
                      onreplace={replaceModel}
                      onremoved={removeModel}
                      onrefresh={reloadModels}
                    />
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Section>
  {/if}
</div>

<ProviderModal
  open={providerModalOpen}
  provider={editingProvider}
  {secrets}
  onclose={() => (providerModalOpen = false)}
  onupdate={onProviderUpdate}
/>

<RegisterModelModal
  open={registerModalOpen}
  {providers}
  presetProviderId={registerProviderId}
  onclose={() => (registerModalOpen = false)}
  oncreated={reloadModels}
/>
