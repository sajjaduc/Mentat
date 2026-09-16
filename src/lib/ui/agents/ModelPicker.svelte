<script lang="ts">
/**
 * ModelPicker: choose the provider and model an agent runs on.
 *
 * Both catalogues are fetched here rather than in the page because the picker is
 * their only consumer and the identity tab mounts it lazily. The model list is
 * scoped to the selected provider, so an agent cannot be pointed at a model its
 * provider cannot serve. Both values may stay empty, which means "provider
 * default" — the runner resolves that when the run starts.
 */
import { formatNumber } from '$shared/format';
import {
  CAPABILITY_KEYS,
  type Model,
  PROVIDER_TYPE_LABELS,
  type Provider,
  REASONING_EFFORT_LABELS,
  supportedReasoningEffortsFor
} from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import Section from '$ui/http/controls/Section.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';

interface Props {
  providerId?: string | null;
  modelId?: string | null;
}

let {
  providerId = $bindable<string | null>(null),
  modelId = $bindable<string | null>(null)
}: Props = $props();

let providers = $state<Provider[]>([]);
let models = $state<Model[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const [providerResult, modelResult] = await Promise.all([
      api.get<{ providers: Provider[] }>('/api/providers'),
      api.get<{ models: Model[] }>('/api/models')
    ]);
    providers = providerResult.providers;
    models = modelResult.models;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

const providerOptions = $derived([
  { value: '', label: 'Workspace default provider' },
  ...providers.map((provider) => ({
    value: provider.id,
    label: `${provider.name} (${PROVIDER_TYPE_LABELS[provider.type]})`,
    disabled: !provider.enabled
  }))
]);

const providerModels = $derived(
  providerId === null ? [] : models.filter((model) => model.providerId === providerId)
);

const modelOptions = $derived([
  { value: '', label: 'Provider default model' },
  ...providerModels.map((model) => ({
    value: model.id,
    label:
      model.displayName === model.modelKey
        ? model.modelKey
        : `${model.displayName} (${model.modelKey})`,
    disabled: !model.enabled
  }))
]);

const selectedModel = $derived(models.find((model) => model.id === modelId) ?? null);

const enabledCapabilities = $derived(
  selectedModel === null
    ? []
    : CAPABILITY_KEYS.filter((entry) => selectedModel.capabilities?.[entry.key] === true)
);

function onProviderChange(event: Event) {
  const select = event.currentTarget as HTMLSelectElement;
  providerId = select.value === '' ? null : select.value;
  modelId = null;
}

function onModelChange(event: Event) {
  const select = event.currentTarget as HTMLSelectElement;
  modelId = select.value === '' ? null : select.value;
}
</script>

<Section
  title="Model"
  description="Which provider and model this agent runs on. Leave both on their defaults to use the workspace's default provider and its default model."
>
  {#if loading}
    <Skeleton lines={2} height="2.25rem" />
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else}
    {#if providers.length === 0}
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        No providers are configured yet. Add one under Models, then come back to choose it here.
      </p>
    {/if}
    <div class="grid gap-4 md:grid-cols-2">
      <Select
        label="Provider"
        options={providerOptions}
        value={providerId ?? ''}
        onchange={onProviderChange}
      />
      <Select
        label="Model"
        options={modelOptions}
        value={modelId ?? ''}
        onchange={onModelChange}
        disabled={providerId === null || providerModels.length === 0}
        hint={providerId !== null && providerModels.length === 0
          ? 'No models have been discovered for this provider yet.'
          : undefined}
      />
    </div>

    {#if selectedModel !== null}
      <div
        class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-3"
      >
        <p class="font-mono text-xs text-[var(--color-ink)]">{selectedModel.modelKey}</p>
        <div class="flex flex-wrap items-center gap-1.5">
          {#each enabledCapabilities as capability (capability.key)}
            <Badge tone="accent">{capability.label}</Badge>
          {/each}
          {#if enabledCapabilities.length === 0}
            <span class="text-[11px] text-[var(--color-ink-subtle)]">
              No capabilities declared for this model.
            </span>
          {/if}
        </div>
        <p class="text-[11px] text-[var(--color-ink-subtle)]">
          Context {formatNumber(selectedModel.contextWindow)} · max output {formatNumber(
            selectedModel.maxOutputTokens
          )}
        </p>
        {#if selectedModel.capabilities?.reasoning === true}
          <p class="text-[11px] text-[var(--color-ink-subtle)]">
            Reasoning levels: {supportedReasoningEffortsFor(selectedModel.capabilities)
              .map((effort) => REASONING_EFFORT_LABELS[effort])
              .join(', ')}
          </p>
        {/if}
      </div>
    {:else if providerId !== null && providerModels.length > 0}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        Using this provider's default model.
      </p>
    {/if}
  {/if}
</Section>
