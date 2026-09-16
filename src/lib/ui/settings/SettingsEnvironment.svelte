<script lang="ts">
/**
 * SettingsEnvironment: effective variables with provenance.
 *
 * Resolution is always **workflow override > workspace value**, and every row
 * states which it is using — Inherited, Override or Local. Setting a workflow
 * value on top of a workspace key produces *Override*; deleting the workflow row
 * resumes inheritance, which the UI states before the click.
 *
 * Secret-backed variables are references, not values: the row shows the secret key
 * and its last four characters and never a plaintext, matching ADR-0020.
 */
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import { provenanceTone } from '$ui/format';
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
import type { EffectiveEnvironmentEntry, SecretRecord, WorkflowSummary } from '$ui/types';

let workflows = $state<WorkflowSummary[]>([]);
let workflowId = $state('');
let entries = $state<EffectiveEnvironmentEntry[]>([]);
let secrets = $state<SecretRecord[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let editOpen = $state(false);
let editing = $state<EffectiveEnvironmentEntry | null>(null);
let busy = $state(false);
let provenanceKey = $state<string | null>(null);

let key = $state('');
let value = $state('');
let description = $state('');
let scope = $state<'workspace' | 'workflow'>('workspace');
let formError = $state<string | null>(null);

const secretName = $derived(new Map(secrets.map((secret) => [secret.id, secret.key])));
const selectedWorkflow = $derived(workflows.find((entry) => entry.id === workflowId) ?? null);
const provenanceEntry = $derived(entries.find((entry) => entry.key === provenanceKey) ?? null);

async function load() {
  loading = true;
  error = null;
  try {
    const [environment, secretResponse, workflowResponse] = await Promise.all([
      api.get<{ variables: EffectiveEnvironmentEntry[] }>('/environment', {
        workflowId: workflowId || undefined
      }),
      api
        .get<{ secrets: SecretRecord[] }>('/secrets')
        .catch(() => ({ secrets: [] as SecretRecord[] })),
      workflows.length > 0
        ? Promise.resolve({ workflows })
        : api
            .get<{ workflows: WorkflowSummary[] }>('/workflows')
            .catch(() => ({ workflows: [] as WorkflowSummary[] }))
    ]);
    entries = environment.variables;
    secrets = secretResponse.secrets;
    workflows = workflowResponse.workflows;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void workflowId;
  void load();
});

function openSet(entry: EffectiveEnvironmentEntry | null) {
  editing = entry;
  key = entry?.key ?? '';
  value = entry?.value ?? '';
  description = '';
  scope = entry?.workflowVariableId ? 'workflow' : 'workspace';
  formError = null;
  editOpen = true;
}

async function save() {
  if (!key.trim()) {
    formError = 'A key is required.';
    return;
  }
  busy = true;
  formError = null;
  try {
    await api.put('/environment', {
      key: key.trim(),
      value,
      description: description.trim() || null,
      workflowId: scope === 'workflow' ? workflowId || null : null
    });
    pushToast({ tone: 'success', title: `Saved ${key.trim()}` });
    editOpen = false;
    await load();
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

/**
 * Deleting the variable row that currently wins makes the other scope effective
 * again. Removing a workflow row therefore *resumes inheritance*, which is what the
 * button says.
 */
async function removeEntry(entry: EffectiveEnvironmentEntry, which: 'workspace' | 'workflow') {
  const id = which === 'workflow' ? entry.workflowVariableId : entry.workspaceVariableId;
  if (!id) return;
  busy = true;
  try {
    await api.delete(`/environment/${id}`);
    pushToast({
      tone: 'success',
      title:
        which === 'workflow'
          ? `Removed workflow override for ${entry.key}; inheritance resumed`
          : `Deleted ${entry.key}`
    });
    await load();
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not delete', description: describeApiError(failure) });
  } finally {
    busy = false;
  }
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Environment"
    description="Effective variables per workflow. Resolution is workflow override > workspace value, and every row states where its value comes from."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={() => openSet(null)}>Set variable</Button>
    {/snippet}
  </PageHeader>

  <Card class="space-y-3">
    <Select
      label="View as workflow"
      options={[
        { value: '', label: 'Workspace only' },
        ...workflows.map((entry) => ({ value: entry.id, label: entry.name }))
      ]}
      bind:value={workflowId}
      hint="An empty selection shows workspace values only; choosing a workflow shows effective values with provenance."
    />
    <ul class="flex flex-wrap gap-2 text-[11px]">
      <li class="inline-flex items-center gap-1.5"><Badge tone="accent">Inherited</Badge> workspace value, unchanged</li>
      <li class="inline-flex items-center gap-1.5"><Badge tone="caution">Override</Badge> workflow row replaces a workspace key</li>
      <li class="inline-flex items-center gap-1.5"><Badge tone="neutral">Local</Badge> exists only at this scope</li>
    </ul>
  </Card>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if entries.length === 0}
    <Card>
      <EmptyState
        title="No environment variables"
        description="Set a variable at workspace scope to share it everywhere, or at workflow scope to override just one workflow."
      />
    </Card>
  {:else}
    <DataTable
      columns={[
        { key: 'key', label: 'Key' },
        { key: 'value', label: 'Effective value' },
        { key: 'state', label: 'Provenance' },
        { key: 'actions', label: 'Actions', align: 'right' }
      ]}
      rows={entries}
      rowKey={(item) => (item as EffectiveEnvironmentEntry).key}
      caption="Effective environment"
    >
      {#snippet row(item)}
        {@const entry = item as EffectiveEnvironmentEntry}
        <td class="px-3 py-2">
          <button
            type="button"
            class="font-mono text-xs font-medium hover:underline"
            onclick={() => (provenanceKey = provenanceKey === entry.key ? null : entry.key)}
          >
            {entry.key}
          </button>
        </td>
        <td class="px-3 py-2">
          {#if entry.isSecret}
            <span class="text-xs text-[var(--color-ink-muted)]">
              Secret reference
              <span class="ml-1 font-mono">
                {entry.secretId ? (secretName.get(entry.secretId) ?? entry.secretId.slice(0, 8)) : '—'}
                {entry.lastFour ? ` · ••••${entry.lastFour}` : ''}
              </span>
            </span>
          {:else if entry.value === null}
            <span class="text-xs text-[var(--color-ink-subtle)]">Not set</span>
          {:else}
            <span class="font-mono text-xs">{entry.value}</span>
          {/if}
        </td>
        <td class="px-3 py-2">
          <Badge tone={provenanceTone(entry.state)}>
            {entry.state === 'overridden' ? 'Override' : entry.state === 'inherited' ? 'Inherited' : 'Local'}
          </Badge>
        </td>
        <td class="px-3 py-2">
          <div class="flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onclick={() => openSet(entry)}>Set</Button>
            {#if entry.workflowVariableId}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onclick={() => removeEntry(entry, 'workflow')}
                title="Removing this workflow row resumes inheritance"
              >
                Remove override
              </Button>
            {:else if entry.workspaceVariableId}
              <Button size="sm" variant="ghost" disabled={busy} onclick={() => removeEntry(entry, 'workspace')}>
                Delete
              </Button>
            {/if}
          </div>
        </td>
      {/snippet}
    </DataTable>
  {/if}

  {#if provenanceEntry}
    <Card class="space-y-2">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">Provenance: {provenanceEntry.key}</h2>
        <Button size="sm" variant="ghost" onclick={() => (provenanceKey = null)}>Close</Button>
      </div>
      <dl class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Effective source</dt>
          <dd>{provenanceEntry.source === 'workflow' ? 'Workflow override' : 'Workspace value'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Relative to {selectedWorkflow?.name ?? 'this workflow'}</dt>
          <dd>{provenanceEntry.state}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Workspace row</dt>
          <dd class="font-mono text-[11px]">{provenanceEntry.workspaceVariableId ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-[var(--color-ink-subtle)]">Workflow row</dt>
          <dd class="font-mono text-[11px]">{provenanceEntry.workflowVariableId ?? '—'}</dd>
        </div>
      </dl>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        Resolution order is workflow override, then workspace value. A value backed by a secret never
        resolves to plaintext here; execution decrypts it only inside the run that needs it.
      </p>
    </Card>
  {/if}
</div>

<Modal
  open={editOpen}
  title={editing ? `Set ${editing.key}` : 'Set environment variable'}
  description="Values are stored per scope. A workflow value replaces the workspace value for that workflow only."
  onclose={() => (editOpen = false)}
>
  <div class="space-y-3">
    <Input label="Key" bind:value={key} placeholder="HUBSPOT_REGION" />
    <Input label="Value" bind:value={value} />
    <Select
      label="Scope"
      options={[
        { value: 'workspace', label: 'Workspace' },
        { value: 'workflow', label: `Workflow${selectedWorkflow ? `: ${selectedWorkflow.name}` : ''}` }
      ]}
      bind:value={scope}
    />
    {#if scope === 'workflow' && !workflowId}
      <p class="text-xs text-[var(--color-caution)]">
        Choose a workflow above first; a workflow-scoped variable needs one.
      </p>
    {/if}
    <Input label="Description" bind:value={description} placeholder="Optional" />
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      This form sets a plaintext value. The variable endpoint does not accept a `secretId` from the
      client yet, so a variable that should be secret-backed cannot be created here; a secret with
      the same key is resolved by the execution path instead. Nothing on this page ever renders a
      secret value — a secret-backed row shows its key and last four characters only.
    </p>}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (editOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={save}>Save variable</Button>
    </div>
  </div>
</Modal>
