<script lang="ts">
/**
 * ModelInlineEditor: capability overrides and inference defaults for one model.
 *
 * `PATCH /api/models/:id` answers with `{ok: true}` only, so the caller refetches the
 * list after a successful save rather than trying to reconcile a partial response.
 */
import { untrack } from 'svelte';
import type { Model, ModelCapabilities, ModelInferenceDefaults } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import Button from '$ui/primitives/Button.svelte';
import { pushToast } from '$ui/toast';
import CapabilityCheckboxes from './CapabilityCheckboxes.svelte';
import InferenceDefaultsFields from './InferenceDefaultsFields.svelte';

interface Props {
  model: Model;
  onclose: () => void;
  onsaved: () => void;
}

let { model, onclose, onsaved }: Props = $props();

// The editor deliberately snapshots the row once: it is a draft, not a mirror, and it
// closes on save so a refetched model can never fight the operator's typing.
const initialCapabilities = untrack(() => ({ ...(model.capabilities ?? {}) }));
const initialDefaults = untrack(() => ({ ...(model.inferenceDefaults ?? {}) }));

let capabilities = $state<ModelCapabilities>(initialCapabilities);
let defaults = $state<ModelInferenceDefaults>(initialDefaults);
let saving = $state(false);
let error = $state<string | null>(null);

async function save() {
  saving = true;
  error = null;
  try {
    await api.patch<{ ok: true }>(`/api/models/${model.id}`, {
      capabilities,
      inferenceDefaults: defaults
    });
    pushToast({ tone: 'success', title: `Defaults saved for “${model.displayName}”` });
    onsaved();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    saving = false;
  }
}
</script>

<div
  class="space-y-4 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] p-4"
>
  <div class="space-y-2">
    <div class="space-y-0.5">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Capabilities</p>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        {model.discovered
          ? 'Discovered from the provider, so these are heuristics — correct them when the guess is wrong.'
          : 'Hand-registered capabilities are kept exactly as set here.'}
      </p>
    </div>
    <CapabilityCheckboxes
      value={capabilities}
      disabled={saving}
      onchange={(next) => (capabilities = next)}
    />
  </div>

  <div class="space-y-2">
    <div class="space-y-0.5">
      <p class="text-xs font-medium text-[var(--color-ink-muted)]">Inference defaults</p>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        Used when an agent or an explicit request does not override them. Empty fields are left
        unset.
      </p>
    </div>
    <InferenceDefaultsFields bind:value={defaults} {capabilities} disabled={saving} />
  </div>

  {#if error}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
  {/if}

  <div class="flex items-center justify-end gap-2">
    <Button variant="ghost" size="sm" onclick={onclose} disabled={saving}>Cancel</Button>
    <Button variant="primary" size="sm" onclick={save} loading={saving}>Save overrides</Button>
  </div>
</div>
