<script lang="ts">
/**
 * SettingsSecrets: create, rotate and delete encrypted secrets.
 *
 * The security rules are structural, not advisory:
 *
 *  - a secret's plaintext is sent once, in a POST body, and is never rendered,
 *    logged, put in a URL or echoed back — the API returns metadata only;
 *  - the list shows the key and the last four characters, which is a hint for
 *    recognition, not a value;
 *  - rotation asks for a new value and states that the previous ciphertext stays
 *    readable so history keeps working.
 */

import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import type { SecretRecord, WorkflowSummary } from '$ui/types';

let secrets = $state<SecretRecord[]>([]);
let workflows = $state<WorkflowSummary[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let createOpen = $state(false);
let rotating = $state<SecretRecord | null>(null);
let busy = $state(false);
let createdNotice = $state<string | null>(null);

let key = $state('');
let name = $state('');
let value = $state('');
let description = $state('');
let scope = $state<'workspace' | 'workflow'>('workspace');
let workflowId = $state('');
let rotateValue = $state('');
let formError = $state<string | null>(null);

const workflowName = $derived(new Map(workflows.map((entry) => [entry.id, entry.name])));

async function load() {
  loading = true;
  error = null;
  try {
    const [secretResponse, workflowResponse] = await Promise.all([
      api.get<{ secrets: SecretRecord[] }>('/secrets'),
      api
        .get<{ workflows: WorkflowSummary[] }>('/workflows')
        .catch(() => ({ workflows: [] as WorkflowSummary[] }))
    ]);
    secrets = secretResponse.secrets;
    workflows = workflowResponse.workflows;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

async function create() {
  if (!key.trim()) {
    formError = 'A key is required.';
    return;
  }
  if (value.length === 0) {
    formError = 'A value is required. It is encrypted before it is stored.';
    return;
  }
  busy = true;
  formError = null;
  try {
    const response = await api.post<{ secret: SecretRecord }>('/secrets', {
      key: key.trim(),
      name: name.trim() || undefined,
      value,
      description: description.trim() || null,
      scope,
      workflowId: scope === 'workflow' ? workflowId || null : null
    });
    secrets = [...secrets, response.secret];
    // Clear the plaintext from component state the moment it has been sent.
    value = '';
    createOpen = false;
    createdNotice = response.secret.key;
    pushToast({ tone: 'success', title: `Secret ${response.secret.key} created` });
    key = '';
    name = '';
    description = '';
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

async function rotate() {
  if (!rotating || rotateValue.length === 0) return;
  busy = true;
  formError = null;
  try {
    const response = await api.post<{ secret: SecretRecord }>(`/secrets/${rotating.id}/rotate`, {
      value: rotateValue
    });
    secrets = secrets.map((secret) =>
      secret.id === response.secret.id ? response.secret : secret
    );
    rotateValue = '';
    rotating = null;
    pushToast({
      tone: 'success',
      title: 'Secret rotated',
      description: 'The previous ciphertext stays readable so historic runs can still be replayed.'
    });
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

async function remove(secret: SecretRecord) {
  const previous = secrets;
  secrets = secrets.filter((entry) => entry.id !== secret.id);
  try {
    await api.delete(`/secrets/${secret.id}`);
    pushToast({
      tone: 'success',
      title: `Deleted ${secret.key}`,
      description: 'Soft-deleted so audit history keeps pointing at a real row.'
    });
  } catch (failure) {
    secrets = previous;
    pushToast({ tone: 'error', title: 'Could not delete', description: describeApiError(failure) });
  }
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Secrets"
    description="Encrypted values referenced by key. Plaintext is decrypted only inside execution and never enters model context, logs or the API response."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={() => { formError = null; createOpen = true; }}>New secret</Button>
    {/snippet}
  </PageHeader>

  {#if createdNotice}
    <div
      class="flex items-start gap-2 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--color-positive)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-positive)_8%,var(--color-surface))] p-3"
      role="status"
    >
      <p class="text-xs leading-relaxed">
        <span class="font-medium">{createdNotice}</span> was created. The value will never be shown
        again — Mentat returns only the key and its last four characters. If you lose it, rotate the
        secret with a new value.
      </p>
      <button
        type="button"
        class="ml-auto text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
        onclick={() => (createdNotice = null)}
      >
        Dismiss
      </button>
    </div>
  {/if}

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if secrets.length === 0}
    <Card>
      <EmptyState
        title="No secrets yet"
        description="A secret stores an encrypted value that tools and connectors reference by key. Create one to give an HTTP service or provider its credential."
      >
        <div class="mt-2 flex justify-center">
          <Button variant="primary" onclick={() => (createOpen = true)}>Create a secret</Button>
        </div>
      </EmptyState>
    </Card>
  {:else}
    <DataTable
      columns={[
        { key: 'key', label: 'Key' },
        { key: 'scope', label: 'Scope' },
        { key: 'lastFour', label: 'Last four' },
        { key: 'version', label: 'Version', align: 'right' },
        { key: 'updated', label: 'Updated', align: 'right', hideBelow: 'md' },
        { key: 'actions', label: 'Actions', align: 'right' }
      ]}
      rows={secrets}
      rowKey={(item) => (item as SecretRecord).id}
      caption="Workspace secrets"
    >
      {#snippet row(item)}
        {@const secret = item as SecretRecord}
        <td class="px-3 py-2">
          <span class="block font-mono text-xs font-medium">{secret.key}</span>
          {#if secret.name}<span class="block text-[11px] text-[var(--color-ink-subtle)]">{secret.name}</span>{/if}
        </td>
        <td class="px-3 py-2">
          <Badge tone={secret.scope === 'workspace' ? 'neutral' : 'accent'}>
            {secret.scope === 'workflow'
              ? (workflowName.get(secret.workflowId ?? '') ?? 'workflow')
              : 'workspace'}
          </Badge>
          {#if secret.hasWorkflowOverride}
            <Badge tone="caution">workflow override exists</Badge>
          {/if}
        </td>
        <td class="px-3 py-2 font-mono text-xs">
          {secret.lastFour ? `••••${secret.lastFour}` : '—'}
        </td>
        <td class="px-3 py-2 text-right text-xs">v{secret.version}</td>
        <td class="hidden px-3 py-2 text-right text-xs text-[var(--color-ink-muted)] md:table-cell">
          {formatRelative(secret.rotatedAt ?? secret.updatedAt)}
        </td>
        <td class="px-3 py-2">
          <div class="flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onclick={() => { rotating = secret; rotateValue = ''; formError = null; }}>
              Rotate
            </Button>
            <Button size="sm" variant="ghost" onclick={() => remove(secret)}>Delete</Button>
          </div>
        </td>
      {/snippet}
    </DataTable>

    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      Values are shown only as their last four characters, and only ever on this request. Nothing on
      this page puts a secret value in a URL, and no value is ever rendered back from the server.
    </p>
  {/if}
</div>

<Modal
  open={createOpen}
  title="New secret"
  description="The value is encrypted with the workspace master key before it is stored. It cannot be read back."
  onclose={() => { createOpen = false; value = ''; }}
>
  <div class="space-y-3">
    <Input
      label="Key"
      bind:value={key}
      placeholder="STRIPE_API_KEY"
      hint="Referenced by tools, providers and HTTP services by this name."
    />
    <Input label="Display name" bind:value={name} placeholder="Optional" />
    <Input
      label="Value"
      type="password"
      bind:value={value}
      autocomplete="new-password"
      hint="Sent once in the request body. It will never be shown again."
    />
    <Select
      label="Scope"
      options={[
        { value: 'workspace', label: 'Workspace' },
        { value: 'workflow', label: 'Workflow override' }
      ]}
      bind:value={scope}
    />
    {#if scope === 'workflow'}
      <Select
        label="Workflow"
        options={[{ value: '', label: 'Choose a workflow' }, ...workflows.map((entry) => ({ value: entry.id, label: entry.name }))]}
        bind:value={workflowId}
      />
    {/if}
    <Input label="Description" bind:value={description} placeholder="Optional" />
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => { createOpen = false; value = ''; }}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={create}>Create secret</Button>
    </div>
  </div>
</Modal>

<Modal
  open={rotating !== null}
  title={rotating ? `Rotate ${rotating.key}` : 'Rotate secret'}
  description="Rotation keeps the previous ciphertext readable so historical runs can still be replayed."
  onclose={() => { rotating = null; rotateValue = ''; }}
>
  <div class="space-y-3">
    <Input
      label="New value"
      type="password"
      bind:value={rotateValue}
      autocomplete="new-password"
      hint="Never rendered, logged or placed in a URL."
    />
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => { rotating = null; rotateValue = ''; }}>Cancel</Button>
      <Button variant="primary" loading={busy} disabled={rotateValue.length === 0} onclick={rotate}>
        Rotate secret
      </Button>
    </div>
  </div>
</Modal>
