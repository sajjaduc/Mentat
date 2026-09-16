<script lang="ts">
/**
 * ModelCard: one selectable model with its metadata, optimistic toggles and overrides.
 *
 * Favourite and enabled are perceived as instant, so they flip locally and roll back
 * with a toast if the write fails. Capability and default edits open the inline editor,
 * which refetches after saving because the API confirms only `{ok: true}`.
 */

import { formatNumber } from '$shared/format';
import type { Model } from '$ui/agents/types';
import { CAPABILITY_KEYS } from '$ui/agents/types';
import { api, describeApiError, mutateOptimistic } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import { pushToast } from '$ui/toast';
import ModelInlineEditor from './ModelInlineEditor.svelte';
import Switch from './Switch.svelte';

interface Props {
  model: Model;
  onreplace: (model: Model) => void;
  onremoved: (modelId: string) => void;
  onrefresh: () => void;
}

let { model, onreplace, onremoved, onrefresh }: Props = $props();

let expanded = $state(false);
let actionError = $state<string | null>(null);

const declared = $derived(
  CAPABILITY_KEYS.filter((capability) => model.capabilities?.[capability.key] === true)
);
const meta = $derived(
  [model.family, model.parameterSize, model.quantization]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ')
);
const contextText = $derived(
  model.contextWindow === null ? 'not declared' : `${formatNumber(model.contextWindow)} tokens`
);

async function toggleFavorite() {
  const next = !model.isFavorite;
  const snapshot = model;
  await mutateOptimistic(
    () => api.patch<{ ok: true }>(`/api/models/${model.id}`, { isFavorite: next }),
    {
      optimistic: () => {
        onreplace({ ...snapshot, isFavorite: next });
        return () => onreplace(snapshot);
      },
      onError: (failure) =>
        pushToast({
          tone: 'error',
          title: 'Could not update favourite',
          description: describeApiError(failure)
        })
    }
  );
}

async function setEnabled(next: boolean) {
  const snapshot = model;
  await mutateOptimistic(
    () => api.patch<{ ok: true }>(`/api/models/${model.id}`, { enabled: next }),
    {
      optimistic: () => {
        onreplace({ ...snapshot, enabled: next });
        return () => onreplace(snapshot);
      },
      onError: (failure) =>
        pushToast({
          tone: 'error',
          title: 'Could not enable or disable the model',
          description: describeApiError(failure)
        })
    }
  );
}

async function remove() {
  actionError = null;
  try {
    await api.delete(`/api/models/${model.id}`);
    pushToast({ tone: 'success', title: `Model “${model.displayName}” deleted` });
    onremoved(model.id);
  } catch (failure) {
    const message = describeApiError(failure);
    actionError = message;
    pushToast({ tone: 'error', title: 'Could not delete model', description: message });
  }
}

function onSaved() {
  expanded = false;
  onrefresh();
}
</script>

<div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex min-w-0 items-start gap-2">
      <button
        type="button"
        class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)] transition-colors {model.isFavorite
          ? 'text-[var(--color-caution)]'
          : 'text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]'}"
        aria-pressed={model.isFavorite}
        aria-label={model.isFavorite
          ? `Remove ${model.displayName} from favourites`
          : `Add ${model.displayName} to favourites`}
        title={model.isFavorite ? 'Favourite' : 'Add to favourites'}
        onclick={toggleFavorite}
      >
        <svg
          viewBox="0 0 24 24"
          class="h-4 w-4"
          fill={model.isFavorite ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <path
            d="M12 4l2.4 5 5.6.7-4 3.9.9 5.4-4.9-2.6-4.9 2.6.9-5.4-4-3.9 5.6-.7z"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-sm font-medium text-[var(--color-ink)]">{model.displayName}</p>
          <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{model.modelKey}</span>
          <Badge tone={model.discovered ? 'muted' : 'accent'}>
            {model.discovered ? 'Discovered' : 'Hand-registered'}
          </Badge>
          {#if !model.enabled}<Badge tone="muted">Disabled</Badge>{/if}
        </div>
        <p class="text-[11px] text-[var(--color-ink-subtle)]">
          {meta.length > 0 ? meta : 'No family metadata'}
        </p>
        <div class="flex flex-wrap items-center gap-1.5">
          {#each declared as capability (capability.key)}
            <Badge tone="neutral">{capability.label}</Badge>
          {/each}
          {#if declared.length === 0}
            <span class="text-[11px] text-[var(--color-ink-subtle)]">
              No capabilities declared — the runner will refuse tool calls it cannot confirm.
            </span>
          {/if}
        </div>
      </div>
    </div>

    <Switch checked={model.enabled} label="Enabled" onchange={setEnabled} />
  </div>

  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-[11px] text-[var(--color-ink-subtle)]">Context window: {contextText}</p>
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onclick={() => (expanded = !expanded)}>
        {expanded ? 'Hide overrides' : 'Edit overrides'}
      </Button>
      <ConfirmButton label="Delete" confirmLabel="Delete model" onconfirm={remove} />
    </div>
  </div>

  {#if actionError}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{actionError}</p>
  {/if}

  {#if expanded}
    <ModelInlineEditor model={model} onclose={() => (expanded = false)} onsaved={onSaved} />
  {/if}
</div>
