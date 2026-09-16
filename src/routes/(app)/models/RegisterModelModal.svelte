<script lang="ts">
/**
 * RegisterModelModal: add a model by hand when discovery cannot know about it.
 *
 * Hand-registered models carry explicit capabilities, so a later discovery refresh
 * never overwrites them. That is the reason to use this form for a proxy alias, a
 * custom checkpoint or a hosted model the provider cannot enumerate.
 */

import type { Model, ModelCapabilities, ModelInferenceDefaults, Provider } from '$ui/agents/types';
import { PROVIDER_TYPE_LABELS } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import type { Option } from '$ui/primitives';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import { pushToast } from '$ui/toast';
import CapabilityCheckboxes from './CapabilityCheckboxes.svelte';
import InferenceDefaultsFields from './InferenceDefaultsFields.svelte';

interface Props {
  open: boolean;
  providers: Provider[];
  presetProviderId: string | null;
  onclose: () => void;
  oncreated: () => void;
}

let { open, providers, presetProviderId, onclose, oncreated }: Props = $props();

let providerId = $state('');
let modelKey = $state('');
let displayName = $state('');
let capabilities = $state<ModelCapabilities>({});
let contextWindow = $state('');
let maxOutputTokens = $state('');
let defaults = $state<ModelInferenceDefaults>({});
let saving = $state(false);
let touched = $state(false);
let error = $state<string | null>(null);

const providerOptions = $derived<Option[]>(
  providers.map((provider) => ({
    value: provider.id,
    label: `${provider.name} · ${PROVIDER_TYPE_LABELS[provider.type]}`
  }))
);

const modelKeyError = $derived(modelKey.trim().length === 0 ? 'Required' : null);
const providerError = $derived(providerId === '' ? 'Choose a provider' : null);

function reset() {
  providerId = presetProviderId ?? providers[0]?.id ?? '';
  modelKey = '';
  displayName = '';
  capabilities = {};
  contextWindow = '';
  maxOutputTokens = '';
  defaults = {};
  saving = false;
  touched = false;
  error = null;
}

function toOptionalInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function save() {
  touched = true;
  if (providerError !== null || modelKeyError !== null) return;
  saving = true;
  error = null;
  try {
    const body: Record<string, unknown> = {
      providerId,
      modelKey: modelKey.trim(),
      capabilities,
      inferenceDefaults: defaults
    };
    if (displayName.trim().length > 0) body.displayName = displayName.trim();
    const context = toOptionalInt(contextWindow);
    if (context !== undefined) body.contextWindow = context;
    const maxOutput = toOptionalInt(maxOutputTokens);
    if (maxOutput !== undefined) body.maxOutputTokens = maxOutput;

    const result = await api.post<{ model: Model }>('/api/models', body);
    pushToast({
      tone: 'success',
      title: `Model “${result.model.displayName}” registered`,
      description: 'Its capabilities are explicit and a discovery refresh will not overwrite them.'
    });
    oncreated();
    onclose();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    saving = false;
  }
}

$effect(() => {
  if (open) reset();
});
</script>

<Modal
  {open}
  title="Register a model by hand"
  description="Use this for a model discovery cannot see. The capabilities you set are treated as authoritative."
  width="36rem"
  onclose={onclose}
>
  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" onclick={save} loading={saving}>Register model</Button>
  {/snippet}

  <div class="space-y-4">
    <Select
      label="Provider"
      options={providerOptions}
      value={providerId}
      error={touched ? providerError : null}
      onchange={(event) => (providerId = event.currentTarget.value)}
    />
    <Input
      label="Model key"
      value={modelKey}
      error={touched ? modelKeyError : null}
      placeholder="my-fine-tune:latest"
      hint="The exact identifier the provider expects. It must be unique per provider."
      oninput={(event) => (modelKey = event.currentTarget.value)}
    />
    <Input
      label="Display name"
      value={displayName}
      placeholder="My fine-tune"
      hint="Optional. Defaults to the model key."
      oninput={(event) => (displayName = event.currentTarget.value)}
    />
    <div class="grid gap-3 sm:grid-cols-2">
      <Input
        label="Context window"
        type="number"
        step="1"
        min="0"
        value={contextWindow}
        placeholder="8192"
        oninput={(event) => (contextWindow = event.currentTarget.value)}
      />
      <Input
        label="Max output tokens"
        type="number"
        step="1"
        min="0"
        value={maxOutputTokens}
        placeholder="2048"
        oninput={(event) => (maxOutputTokens = event.currentTarget.value)}
      />
    </div>

    <div class="space-y-2">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Capabilities</p>
      <CapabilityCheckboxes
        value={capabilities}
        disabled={saving}
        onchange={(next) => (capabilities = next)}
      />
    </div>

    <div class="space-y-2">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Inference defaults</p>
      <InferenceDefaultsFields bind:value={defaults} disabled={saving} />
    </div>

    {#if error}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
    {/if}
  </div>
</Modal>
