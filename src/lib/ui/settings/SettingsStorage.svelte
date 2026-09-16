<script lang="ts">
/**
 * SettingsStorage: where raw bytes live.
 *
 * The separation is the point: the database holds file identity, blob references,
 * extracted metadata, fields, relationships and processing history; the BlobStore
 * holds the bytes. Nothing here ever returns credential material — a credential is
 * a secret reference plus its last four characters.
 */

import { formatBytes } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/common/PageHeader.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import type { SecretRecord, StorageConfig } from '$ui/types';

let storage = $state<StorageConfig | null>(null);
let secrets = $state<SecretRecord[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let saving = $state(false);

let provider = $state<'local' | 'gcs'>('local');
let bucket = $state('');
let prefix = $state('');
let credentialsSecretId = $state('');
let localRoot = $state('');
let maxFileBytes = $state(0);

async function load() {
  loading = true;
  error = null;
  try {
    const [storageResponse, secretResponse] = await Promise.all([
      api.get<{ storage: StorageConfig }>('/storage'),
      api
        .get<{ secrets: SecretRecord[] }>('/secrets')
        .catch(() => ({ secrets: [] as SecretRecord[] }))
    ]);
    storage = storageResponse.storage;
    secrets = secretResponse.secrets;
    provider = storage.provider;
    bucket = storage.bucket ?? '';
    prefix = storage.prefix ?? '';
    credentialsSecretId = storage.credentialsSecretId ?? '';
    localRoot = storage.localRoot ?? '';
    maxFileBytes = storage.maxFileBytes;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

async function save() {
  saving = true;
  try {
    const response = await api.put<{ storage: StorageConfig }>('/storage', {
      provider,
      bucket: provider === 'gcs' ? bucket.trim() || null : null,
      prefix: prefix.trim() || null,
      credentialsSecretId: provider === 'gcs' ? credentialsSecretId || null : null,
      localRoot: provider === 'local' ? localRoot.trim() || null : null,
      maxFileBytes
    });
    storage = response.storage;
    pushToast({
      tone: 'success',
      title: 'Storage configuration saved',
      description: 'New uploads use this provider; existing blobs keep their recorded provider.'
    });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not save storage',
      description: describeApiError(failure)
    });
  } finally {
    saving = false;
  }
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Storage"
    description="Blobs are content-addressed by SHA-256 and stored outside the database. The database holds file identity, references, extracted content and history."
  />

  {#if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if storage}
    <Card class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-sm font-semibold">Current provider</h2>
        <Badge tone={storage.provider === 'gcs' ? 'accent' : 'neutral'}>
          {storage.provider === 'gcs' ? 'Google Cloud Storage' : 'Local filesystem'}
        </Badge>
        {#if storage.isDefault}<Badge tone="muted">default configuration</Badge>{/if}
      </div>
      <dl class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Bucket</dt>
          <dd>{storage.bucket ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Prefix</dt>
          <dd class="font-mono text-[11px]">{storage.prefix ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Credentials</dt>
          <dd>
            {#if storage.credentialsSecretId}
              <span class="font-mono text-[11px]">
                secret · {storage.credentialsLastFour ? `••••${storage.credentialsLastFour}` : 'no hint'}
              </span>
              <span class="block text-[10px] text-[var(--color-ink-subtle)]">
                the credential material is never returned
              </span>
            {:else}
              —
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Local root</dt>
          <dd class="font-mono text-[11px]">{storage.localRoot ?? 'default ./data/blobs'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Max file size</dt>
          <dd>{formatBytes(storage.maxFileBytes)} ({storage.maxFileBytes.toLocaleString()} bytes)</dd>
        </div>
      </dl>
    </Card>

    <Card class="space-y-4">
      <h2 class="text-sm font-semibold">Configure</h2>
      <Select
        label="Provider"
        options={[
          { value: 'local', label: 'Local filesystem' },
          { value: 'gcs', label: 'Google Cloud Storage' }
        ]}
        bind:value={provider}
      />
      {#if provider === 'gcs'}
        <div class="grid gap-3 sm:grid-cols-2">
          <Input label="Bucket" bind:value={bucket} placeholder="mentat-production" />
          <Input label="Prefix" bind:value={prefix} placeholder="workspaces/&lt;workspaceId&gt;/" />
        </div>
        <Select
          label="Credentials secret"
          options={[
            { value: '', label: 'Choose a secret' },
            ...secrets.map((secret) => ({
              value: secret.id,
              label: `${secret.key}${secret.lastFour ? ` (••••${secret.lastFour})` : ''}`
            }))
          ]}
          bind:value={credentialsSecretId}
          hint="The reference is stored; the credential itself is never returned by the API."
        />
      {:else}
        <Input
          label="Local root"
          bind:value={localRoot}
          placeholder="./data/blobs"
          hint="Leave empty to use the configured default."
        />
      {/if}
      <Input
        label="Maximum file size (bytes)"
        type="number"
        min="1"
        bind:value={maxFileBytes}
        hint="Enforced at ingestion, before hashing."
      />
      <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-[11px] leading-relaxed">
        Raw bytes live in the BlobStore, never in a database table. The database holds the blob's
        hash, size, MIME type and storage key, plus everything derived from the file. Credentials are
        resolved from the secret subsystem at the moment of use and are never rendered here.
      </p>
      <div class="flex justify-end">
        <Button variant="primary" loading={saving} onclick={save}>Save storage configuration</Button>
      </div>
    </Card>
  {/if}
</div>
