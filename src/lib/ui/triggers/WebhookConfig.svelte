<script lang="ts">
/**
 * WebhookConfig: everything a webhook trigger owns.
 *
 * The signature secret is referenced by id. Mentat stores secret values encrypted
 * and never returns them, so this form can show only a key, a name and the last
 * four characters — there is deliberately no field that could render a value.
 */

import { api, describeApiError } from '$ui/api';
import CopyButton from '$ui/http/controls/CopyButton.svelte';
import Toggle from '$ui/http/controls/Toggle.svelte';
import type { SecretView } from '$ui/http/types';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import TriggerEventLog from './TriggerEventLog.svelte';
import TriggerMappingEditor from './TriggerMappingEditor.svelte';
import type { TriggerMapping, WorkflowOption } from './types';

interface Props {
  signatureRequired?: boolean;
  signatureHeader?: string;
  signatureSecretId?: string;
  maxPayloadBytes?: string;
  mapping?: TriggerMapping;
  workflows: WorkflowOption[];
  triggerId?: string | null;
  enabled: boolean;
}

let {
  signatureRequired = $bindable(false),
  signatureHeader = $bindable('X-Mentat-Signature'),
  signatureSecretId = $bindable(''),
  maxPayloadBytes = $bindable(''),
  mapping = $bindable({}),
  workflows,
  triggerId = null,
  enabled
}: Props = $props();

let secrets = $state<SecretView[] | null>(null);
let secretsError = $state<string | null>(null);
let secretsLoading = $state(true);

let webhookUrl = $state<string | null>(null);
let urlLoading = $state(true);
let urlError = $state<string | null>(null);

async function loadSecrets() {
  secretsLoading = true;
  secretsError = null;
  try {
    const result = await api.get<{ secrets: SecretView[] }>('/api/secrets');
    secrets = result.secrets;
  } catch (failure) {
    secretsError = describeApiError(failure);
  } finally {
    secretsLoading = false;
  }
}

$effect(() => {
  void loadSecrets();
});

$effect(() => {
  const id = triggerId;
  webhookUrl = null;
  urlError = null;
  if (!id) return;
  let cancelled = false;
  urlLoading = true;
  void api
    .get<{ url: string | null }>(`/api/triggers/${id}/webhook-url`)
    .then((result) => {
      if (!cancelled) webhookUrl = result.url;
    })
    .catch((failure) => {
      if (!cancelled) urlError = describeApiError(failure);
    })
    .finally(() => {
      if (!cancelled) urlLoading = false;
    });
  return () => {
    cancelled = true;
  };
});

function secretLabel(secret: SecretView): string {
  const name = secret.name && secret.name.length > 0 ? ` (${secret.name})` : '';
  const preview = secret.lastFour ? `••••${secret.lastFour}` : 'no preview';
  return `${secret.key}${name} · ${preview}`;
}

const secretOptions = $derived.by(() => {
  const list = (secrets ?? []).map((secret) => ({
    value: secret.id,
    label: secretLabel(secret)
  }));
  if (signatureSecretId.length > 0 && !list.some((option) => option.value === signatureSecretId)) {
    list.unshift({
      value: signatureSecretId,
      label: 'Current secret (no longer listed)'
    });
  }
  return list;
});
</script>

<div class="space-y-5">
  <Toggle
    bind:checked={signatureRequired}
    label="Require a signature"
    hint="Reject a delivery whose signature header does not match the selected secret."
  />

  <div class="grid gap-4 md:grid-cols-2">
    <Input
      label="Signature header"
      value={signatureHeader}
      placeholder="X-Mentat-Signature"
      hint="The request header that carries the HMAC signature."
      oninput={(event) => (signatureHeader = event.currentTarget.value)}
      class="font-mono"
    />
    <Input
      label="Max payload bytes"
      value={maxPayloadBytes}
      placeholder="1048576"
      hint="Optional cap. Deliveries larger than this are rejected."
      inputmode="numeric"
      oninput={(event) => (maxPayloadBytes = event.currentTarget.value)}
      class="font-mono"
    />
  </div>

  <div class="space-y-1.5">
    <Select
      label="Signature secret"
      placeholder="Choose a secret"
      options={secretOptions}
      value={signatureSecretId}
      disabled={secretsLoading}
      hint="The secret is referenced by id. Its value is never displayed again."
      onchange={(event) => (signatureSecretId = event.currentTarget.value)}
    />
    {#if secretsLoading && secrets === null}
      <Skeleton lines={1} />
    {:else if secretsError}
      <ErrorState message={secretsError} onRetry={loadSecrets} />
    {:else if secrets !== null && secrets.length === 0}
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        This workspace has no secrets yet. Create one in settings, then return here to select it.
      </p>
    {/if}
    <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
      Mentat encrypts secret values on write and never returns them. This form shows only the
      key, name and last four characters; to change a value, rotate the secret where secrets
      are managed.
    </p>
  </div>

  <div class="space-y-2 border-t border-[var(--color-border-subtle)] pt-4">
    <p class="text-sm font-semibold text-[var(--color-ink)]">Webhook URL</p>
    {#if !triggerId}
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Save the trigger to mint its public URL. The URL segment is an opaque token, not a
        credential, but anyone who has it can deliver events.
      </p>
    {:else if urlLoading}
      <Skeleton lines={1} />
    {:else if urlError}
      <ErrorState message={urlError} />
    {:else if webhookUrl}
      <div class="flex flex-wrap items-center gap-2">
        <code class="min-w-0 flex-1 truncate rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-2 py-1.5 font-mono text-xs text-[var(--color-ink)]">
          {webhookUrl}
        </code>
        <CopyButton text={webhookUrl} label="Copy URL" />
      </div>
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        External systems POST their payload to this URL. A disabled trigger still has a URL but
        will not accept deliveries.
      </p>
    {:else}
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        No webhook token is present on this trigger.
      </p>
    {/if}
  </div>

  <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
    <div>
      <p class="text-sm font-semibold text-[var(--color-ink)]">Payload mapping</p>
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Decide how an incoming payload becomes a ticket.
      </p>
    </div>
    <TriggerMappingEditor bind:mapping {workflows} />
  </div>

  <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
    <div>
      <p class="text-sm font-semibold text-[var(--color-ink)]">Event log</p>
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Deliveries and how Mentat handled them. {enabled ? '' : 'This trigger is disabled, so new deliveries will be rejected.'}
      </p>
    </div>
    {#if triggerId}
      <TriggerEventLog {triggerId} />
    {:else}
      <p class="text-xs text-[var(--color-ink-subtle)]">Save the trigger to see its deliveries.</p>
    {/if}
  </div>
</div>
