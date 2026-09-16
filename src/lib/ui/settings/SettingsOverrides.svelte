<script lang="ts">
/**
 * SettingsOverrides: the effective-configuration view (ADR-0006).
 *
 * Overrides are provenance rows, not polymorphism: each resource type keeps its own
 * table and one `workspace_overrides` row records the *binding* — which workspace
 * resource a workflow-scoped resource derives from, how (Use as-is / Override /
 * Fork), and which fields changed. Removing that row resumes inheritance, so
 * nothing here is soft-deleted.
 *
 * One API fact is stated in the UI rather than hidden: `GET /api/overrides` returns
 * the *bindings*, so a workflow with no explicit binding reports no groups. The
 * counts therefore describe bound resources, and an unbound resource is inherited
 * with no row to list. The panel says so instead of implying otherwise.
 */
import { untrack } from 'svelte';
import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import { bindingModeLabel } from '$ui/format';
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
import type {
  BindableResourceType,
  BindingMode,
  BindingResolution,
  EffectiveConfiguration,
  WorkflowSummary
} from '$ui/types';

const RESOURCE_TYPES: BindableResourceType[] = [
  'agent',
  'skill',
  'tool',
  'http_service',
  'http_operation',
  'field_definition',
  'collection',
  'provider',
  'model',
  'secret',
  'environment_variable'
];

let workflows = $state<WorkflowSummary[]>([]);
/** Deep link support: `/settings/overrides?workflowId=` selects a workflow directly. */
let workflowId = $state(page.url.searchParams.get('workflowId') ?? '');
let configuration = $state<EffectiveConfiguration | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let bindOpen = $state(false);
let binding = $state<BindingResolution | null>(null);
let busy = $state(false);
let formError = $state<string | null>(null);

let resourceType = $state<BindableResourceType>('agent');
let resourceId = $state('');
let sourceResourceId = $state('');
let mode = $state<BindingMode>('use_asis');
let overriddenFields = $state('');

const selectedWorkflow = $derived(workflows.find((entry) => entry.id === workflowId) ?? null);

async function load() {
  loading = true;
  error = null;
  try {
    if (workflows.length === 0) {
      const response = await api.get<{ workflows: WorkflowSummary[] }>('/workflows');
      workflows = response.workflows;
      if (!workflowId && workflows[0]) workflowId = workflows[0].id;
    }
    if (!workflowId) {
      loading = false;
      return;
    }
    const response = await api.get<EffectiveConfiguration>('/overrides', { workflowId });
    configuration = response;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

// Keyed on `workflowId` only; the loader also reads/writes `workflows` to pick a
// default, which must not become a dependency.
$effect(() => {
  void workflowId;
  untrack(() => void load());
});

function openBind(resolution: BindingResolution | null) {
  binding = resolution;
  resourceType = resolution?.resourceType ?? 'agent';
  resourceId = resolution?.resourceId ?? '';
  sourceResourceId = resolution?.sourceResourceId ?? '';
  mode = resolution?.mode ?? 'use_asis';
  overriddenFields = (resolution?.overriddenFields ?? []).join(', ');
  formError = null;
  bindOpen = true;
}

async function saveBinding() {
  if (!resourceId.trim()) {
    formError = 'A resource id is required.';
    return;
  }
  if (mode === 'override' && !sourceResourceId.trim()) {
    formError = 'An override must name the workspace resource it derives from.';
    return;
  }
  busy = true;
  formError = null;
  try {
    await api.put('/overrides', {
      workflowId,
      resourceType,
      resourceId: resourceId.trim(),
      sourceResourceId: sourceResourceId.trim() || null,
      mode,
      overriddenFields: overriddenFields
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    });
    pushToast({
      tone: 'success',
      title: 'Binding saved',
      description: `Mode: ${bindingModeLabel(mode)}`
    });
    bindOpen = false;
    await load();
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

async function removeBinding(resolution: BindingResolution) {
  busy = true;
  try {
    // The delete route takes the override row's id; the effective view does not
    // carry it, so resolve it from the flat list first.
    const list = await api.get<{
      overrides?: Array<{
        id: string;
        resourceId: string;
        resourceType: string;
        workflowId: string | null;
      }>;
    }>('/overrides');
    const match = (list.overrides ?? []).find(
      (row) =>
        row.resourceId === resolution.resourceId &&
        row.resourceType === resolution.resourceType &&
        row.workflowId === workflowId
    );
    if (!match) {
      pushToast({
        tone: 'error',
        title: 'No explicit binding row',
        description: 'This resource already inherits; there is nothing to remove.'
      });
      return;
    }
    await api.delete(`/overrides/${match.id}`);
    pushToast({
      tone: 'success',
      title: 'Binding removed',
      description: 'The resource resumes inheritance from the workspace definition.'
    });
    await load();
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not remove binding',
      description: describeApiError(failure)
    });
  } finally {
    busy = false;
  }
}

function modeTone(resolution: BindingResolution) {
  if (resolution.local) return 'neutral';
  if (resolution.mode === 'override') return 'caution';
  if (resolution.mode === 'fork') return 'accent';
  return 'positive';
}

function modeLabel(resolution: BindingResolution): string {
  if (resolution.local) return 'Local';
  return bindingModeLabel(resolution.mode);
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Overrides"
    description="Where every workflow-scoped resource comes from: used as-is from the workspace, overridden, forked, or local to the workflow. Bindings are provenance rows, so removing one resumes inheritance."
  >
    {#snippet actions()}
      <Button variant="primary" disabled={!workflowId} onclick={() => openBind(null)}>Bind a resource</Button>
    {/snippet}
  </PageHeader>

  <Card class="space-y-3">
    <Select
      label="Workflow"
      options={[
        { value: '', label: 'Choose a workflow' },
        ...workflows.map((entry) => ({ value: entry.id, label: entry.name }))
      ]}
      bind:value={workflowId}
      hint="Overrides are workflow-scoped by definition; the effective view is per workflow."
    />
    {#if configuration}
      <div class="flex flex-wrap gap-2">
        <Badge tone="accent">Inherited {configuration.totals.inherited}</Badge>
        <Badge tone="caution">Overridden {configuration.totals.overridden}</Badge>
        <Badge tone="accent">Forked {configuration.totals.forked}</Badge>
        <Badge tone="neutral">Local {configuration.totals.local}</Badge>
      </div>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        Counts describe resources that have an explicit binding row in this workflow. A resource with
        no binding row is inherited with no provenance row to list, which is what the API returns —
        it is not omitted by the interface.
      </p>
    {/if}
  </Card>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if !workflowId}
    <Card>
      <EmptyState title="Choose a workflow" description="Effective configuration is resolved per workflow, because that is the scope a binding belongs to." />
    </Card>
  {:else if !configuration || configuration.groups.length === 0}
    <Card>
      <EmptyState
        title="No explicit bindings in {selectedWorkflow?.name ?? 'this workflow'}"
        description="Everything this workflow uses is inherited from its workspace-level definition. Bind a resource to record Use as-is, Override or Fork explicitly."
      >
        <div class="mt-2 flex justify-center">
          <Button variant="primary" onclick={() => openBind(null)}>Bind a resource</Button>
        </div>
      </EmptyState>
    </Card>
  {:else}
    {#each configuration.groups as group (group.resourceType)}
      <Card class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-sm font-semibold">{group.resourceType.replace('_', ' ')}</h2>
          <Badge tone="accent">Inherited {group.counts.inherited}</Badge>
          <Badge tone="caution">Overridden {group.counts.overridden}</Badge>
          <Badge tone="accent">Forked {group.counts.forked}</Badge>
          <Badge tone="neutral">Local {group.counts.local}</Badge>
        </div>
        <DataTable
          columns={[
            { key: 'resource', label: 'Resource' },
            { key: 'mode', label: 'Mode' },
            { key: 'source', label: 'Derives from', hideBelow: 'md' },
            { key: 'fields', label: 'Overridden fields', hideBelow: 'lg' },
            { key: 'actions', label: 'Actions', align: 'right' }
          ]}
          rows={group.bindings}
          rowKey={(item) => (item as BindingResolution).resourceId}
        >
          {#snippet row(item)}
            {@const resolution = item as BindingResolution}
            <td class="px-3 py-2">
              <span class="font-mono text-xs">{resolution.resourceId}</span>
              {#if !resolution.exists}
                <span class="block text-[10px] text-[var(--color-ink-subtle)]">no binding row</span>
              {/if}
            </td>
            <td class="px-3 py-2">
              <Badge tone={modeTone(resolution)}>{modeLabel(resolution)}</Badge>
            </td>
            <td class="hidden px-3 py-2 font-mono text-[11px] md:table-cell">
              {resolution.sourceResourceId ?? '—'}
            </td>
            <td class="hidden px-3 py-2 text-[11px] lg:table-cell">
              {resolution.overriddenFields.length > 0 ? resolution.overriddenFields.join(', ') : '—'}
            </td>
            <td class="px-3 py-2">
              <div class="flex justify-end gap-1.5">
                <Button size="sm" variant="secondary" onclick={() => openBind(resolution)}>Rebind</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !resolution.exists}
                  title={resolution.exists ? 'Remove this binding so inheritance resumes' : 'No binding to remove'}
                  onclick={() => removeBinding(resolution)}
                >
                  Remove
                </Button>
              </div>
            </td>
          {/snippet}
        </DataTable>
      </Card>
    {/each}
  {/if}
</div>

<Modal
  open={bindOpen}
  title={binding ? `Rebind ${binding.resourceId}` : 'Bind a resource'}
  description="A binding records how a workflow-scoped resource relates to a workspace-level one."
  onclose={() => (bindOpen = false)}
>
  <div class="space-y-3">
    <Select
      label="Resource type"
      options={RESOURCE_TYPES.map((value) => ({ value, label: value.replace('_', ' ') }))}
      bind:value={resourceType}
    />
    <Input label="Workflow-scoped resource id" bind:value={resourceId} />
    <Select
      label="Mode"
      options={[
        { value: 'use_asis', label: 'Use as-is' },
        { value: 'override', label: 'Override' },
        { value: 'fork', label: 'Fork' }
      ]}
      bind:value={mode}
    />
    <Input
      label="Workspace source resource id"
      bind:value={sourceResourceId}
      hint={mode === 'override' ? 'Required for an override.' : 'Optional; empty means local to the workflow.'}
    />
    <Input
      label="Overridden fields (comma separated)"
      bind:value={overriddenFields}
      hint="The field names this override replaces; the workspace definition supplies the rest."
    />
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (bindOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={saveBinding}>Save binding</Button>
    </div>
  </div>
</Modal>
