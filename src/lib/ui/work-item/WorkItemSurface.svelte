<script lang="ts">
/**
 * The workItem surface.
 *
 * One component owns the workItem's data and every mutation, so optimistic updates,
 * rollbacks and validation messages behave identically whether the workItem is shown
 * in the drawer or on its own page. Tabs are rendered exclusively, which keeps a
 * single live event stream open at a time.
 */
import { goto } from '$app/navigation';
import { ApiError, api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import type { ObjectTypeFieldView } from '$ui/records/types';
import { pushToast } from '$ui/toast';
import { priorityLabel, priorityTone, stateKindLabel, stateKindTone } from '$ui/work/format';
import { normalizeWorkItemDetail, type RawWorkItemDetail } from '$ui/work/rows';
import type {
  Label,
  MemberOption,
  TeamOption,
  WorkflowFieldView,
  WorkflowTransition,
  WorkItem,
  WorkItemDetail,
  WorkItemFieldConfig,
  WorkItemLabelRef
} from '$ui/work/types';
import ActivityTab from '$ui/work-item/ActivityTab.svelte';
import AgentWorkTab from '$ui/work-item/AgentWorkTab.svelte';
import ArtifactsTab from '$ui/work-item/ArtifactsTab.svelte';
import type { TransitionRequest, WorkItemActions } from '$ui/work-item/actions';
import OverviewTab from '$ui/work-item/OverviewTab.svelte';
import TransferDialog from '$ui/work-item/TransferDialog.svelte';

interface Props {
  workflowItemId: string;
  variant: 'drawer' | 'page';
  workspaceId?: string;
  initialTab?: string;
  onOpenWorkItem?: (workflowItemId: string) => void;
  onTransferred?: () => void;
}

let {
  workflowItemId,
  variant,
  workspaceId = '',
  initialTab = 'overview',
  onOpenWorkItem,
  onTransferred
}: Props = $props();

let detail = $state<WorkItemDetail | null>(null);
let config = $state<WorkItemFieldConfig[]>([]);
let values = $state<Record<string, unknown>>({});
let fieldErrors = $state<Record<string, string>>({});
let labels = $state<Label[]>([]);
let members = $state<MemberOption[]>([]);
let teams = $state<TeamOption[]>([]);
let transitionNames = $state<Record<string, string>>({});
let loading = $state(true);
let error = $state<string | null>(null);
let pending = $state(false);
let transitionError = $state<string | null>(null);
let transferOpen = $state(false);
let tab = $state('overview');

const tabs = $derived([
  { id: 'overview', label: 'Overview' },
  { id: 'agent-work', label: 'Agent Work', count: detail?.runs.length ?? 0 },
  { id: 'activity', label: 'Activity' },
  { id: 'artifacts', label: 'Artifacts', count: detail?.files.length ?? 0 }
]);

async function load(id: string) {
  loading = true;
  error = null;
  transitionError = null;
  try {
    const raw = await api.get<RawWorkItemDetail>(`/api/workflow-items/${id}`);
    detail = normalizeWorkItemDetail(raw);
    values = detail.fields ?? {};
    config = detail.fieldConfig ?? [];
    if (config.length === 0) {
      config = await loadEffectiveFieldConfig(
        detail.workflow.id,
        detail.workItem.record.objectTypeId
      );
    }
    fieldErrors = {};
    void loadResources(detail.workflow.id);
  } catch (failure) {
    error = describeApiError(failure);
    detail = null;
  } finally {
    loading = false;
  }
}

/**
 * The form shows Object Type base fields plus the Workflow's overlay. The base
 * schema comes from the Record's Object Type; the overlay from the Workflow.
 */
async function loadEffectiveFieldConfig(
  workflowId: string,
  objectTypeId: string
): Promise<WorkItemFieldConfig[]> {
  const [base, overlay] = await Promise.all([
    objectTypeId === ''
      ? Promise.resolve<ObjectTypeFieldView[]>([])
      : api
          .get<{ fields: ObjectTypeFieldView[] }>(`/api/object-types/${objectTypeId}/fields`)
          .then((response) => response.fields)
          .catch(() => []),
    api
      .get<{ fields: WorkflowFieldView[] }>(`/api/workflows/${workflowId}/fields`)
      .then((response) => response.fields)
      .catch(() => [])
  ]);
  const merged = new Map<string, WorkItemFieldConfig>();
  for (const field of base) {
    merged.set(field.key, {
      key: field.key,
      name: field.name,
      type: field.type,
      required: field.required,
      editable: true,
      visible: true,
      showOnCard: field.showOnCard,
      showInList: field.showInList,
      requiredInStates: null,
      options: field.options
    });
  }
  for (const view of overlay) {
    merged.set(view.definition.key, {
      key: view.definition.key,
      name: view.definition.name,
      type: view.definition.type,
      required: view.required,
      editable: view.editable,
      visible: view.visible,
      showOnCard: view.showOnCard,
      showInList: view.showInList,
      requiredInStates: view.requiredInStates,
      options: view.definition.options
    });
  }
  return [...merged.values()];
}

async function loadResources(workflowId: string) {
  if (labels.length === 0) {
    void api
      .get<{ labels: Label[] }>('/api/labels')
      .then((response) => (labels = response.labels))
      .catch(() => undefined);
  }
  if (members.length === 0 && workspaceId !== '') {
    void api
      .get<{ members: MemberOption[] }>(`/api/workspaces/${workspaceId}/members`)
      .then((response) => (members = response.members))
      .catch(() => undefined);
  }
  if (teams.length === 0) {
    void api
      .get<{ teams: TeamOption[] }>('/api/teams')
      .then((response) => (teams = response.teams))
      .catch(() => undefined);
  }
  try {
    const response = await api.get<{ transitions: WorkflowTransition[] }>(
      `/api/workflows/${workflowId}/transitions`
    );
    transitionNames = Object.fromEntries(
      response.transitions.map((transition) => [transition.id, transition.name])
    );
  } catch {
    // Transition names are a nicety; ids still render.
  }
}

$effect(() => {
  const id = workflowItemId;
  tab = initialTab;
  void load(id);
});

async function refresh() {
  const current = detail;
  if (!current) return;
  try {
    const raw = await api.get<RawWorkItemDetail>(`/api/workflow-items/${current.workItem.id}`);
    detail = normalizeWorkItemDetail(raw);
    values = detail.fields ?? {};
    if (config.length === 0) {
      config = await loadEffectiveFieldConfig(
        detail.workflow.id,
        detail.workItem.record.objectTypeId
      );
    }
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not refresh workItem',
      description: describeApiError(failure)
    });
  }
}

const actions: WorkItemActions = {
  async patchWorkItem(patch) {
    const current = detail;
    if (!current) return false;
    const previous = current;
    detail = { ...current, workItem: { ...current.workItem, ...(patch as Partial<WorkItem>) } };
    try {
      const response = await api.patch<{ workItem: WorkItem }>(
        `/api/workflow-items/${current.workItem.id}`,
        patch
      );
      const latest = detail;
      if (latest) detail = { ...latest, workItem: response.workItem };
      return true;
    } catch (failure) {
      detail = previous;
      pushToast({
        tone: 'error',
        title: 'Could not update the workItem',
        description: describeApiError(failure)
      });
      return false;
    }
  },

  async transition(request: TransitionRequest) {
    const current = detail;
    if (!current) return 'The work item is not loaded yet';
    pending = true;
    transitionError = null;
    try {
      await api.post(`/api/workflow-items/${current.workItem.id}/transitions`, request);
      await refresh();
      return null;
    } catch (failure) {
      const message =
        failure instanceof ApiError &&
        (failure.code === 'human_gate' || failure.details.gate === true)
          ? `${current.state.name} requires a human decision`
          : describeApiError(failure);
      transitionError = message;
      return message;
    } finally {
      pending = false;
    }
  },

  async setField(key, value) {
    const current = detail;
    if (!current) return;
    const previousValues = values;
    const previousErrors = fieldErrors;
    values = { ...values, [key]: value };
    const cleared = { ...fieldErrors };
    delete cleared[key];
    fieldErrors = cleared;
    try {
      await api.patch(`/api/workflow-items/${current.workItem.id}/fields`, {
        values: { [key]: value }
      });
    } catch (failure) {
      values = previousValues;
      fieldErrors = { ...previousErrors, [key]: describeApiError(failure) };
    }
  },

  async addLabel(input) {
    const current = detail;
    if (!current) return;
    const optimistic: WorkItemLabelRef = input.labelId
      ? (labels.find((label) => label.id === input.labelId) ?? {
          id: input.labelId,
          name: input.labelId,
          color: null
        })
      : {
          id: `pending-${Math.random().toString(36).slice(2)}`,
          name: input.name ?? '',
          color: null
        };
    const previous = current.labels;
    detail = { ...current, labels: [...current.labels, optimistic] };
    try {
      await api.post(
        `/api/workflow-items/${current.workItem.id}/labels`,
        input.labelId ? { labelIds: [input.labelId] } : { labelNames: [input.name] }
      );
      const response = await api.get<{ labels: Label[] }>('/api/labels');
      labels = response.labels;
      await refresh();
    } catch (failure) {
      detail = { ...current, labels: previous };
      pushToast({
        tone: 'error',
        title: 'Could not add the label',
        description: describeApiError(failure)
      });
    }
  },

  async removeLabel(labelId) {
    const current = detail;
    if (!current) return;
    const previous = current.labels;
    detail = { ...current, labels: current.labels.filter((label) => label.id !== labelId) };
    try {
      await api.delete(`/api/workflow-items/${current.workItem.id}/labels/${labelId}`);
    } catch (failure) {
      detail = { ...current, labels: previous };
      pushToast({
        tone: 'error',
        title: 'Could not remove the label',
        description: describeApiError(failure)
      });
    }
  },

  async addNote(body) {
    const current = detail;
    if (!current) return;
    try {
      await api.post(`/api/workflow-items/${current.workItem.id}/notes`, { body });
      await refresh();
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not add the note',
        description: describeApiError(failure)
      });
    }
  },

  async linkRelationship(toWorkItemId, type, note) {
    const current = detail;
    if (!current) return;
    void note;
    try {
      await api.post(`/api/workflow-items/${current.workItem.id}/relationships`, {
        toWorkItemId,
        type,
        note
      });
      await refresh();
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not link the workItem',
        description: describeApiError(failure)
      });
    }
  },

  async unlinkRelationship(relationshipId) {
    const current = detail;
    if (!current) return;
    const previous = current.relationships;
    detail = {
      ...current,
      relationships: current.relationships.filter((entry) => entry.id !== relationshipId)
    };
    try {
      await api.delete(`/api/relationships/${relationshipId}`);
    } catch (failure) {
      detail = { ...current, relationships: previous };
      pushToast({
        tone: 'error',
        title: 'Could not remove the link',
        description: describeApiError(failure)
      });
    }
  },

  async attachFile(input) {
    const current = detail;
    if (!current) return;
    try {
      await api.post(`/api/workflow-items/${current.workItem.id}/files`, input);
      await refresh();
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not attach the file',
        description: describeApiError(failure)
      });
    }
  },

  async unlinkFile(fileId) {
    const current = detail;
    if (!current) return;
    const previous = current.files;
    detail = { ...current, files: current.files.filter((file) => file.id !== fileId) };
    try {
      await api.delete(`/api/workflow-items/${current.workItem.id}/files/${fileId}`);
    } catch (failure) {
      detail = { ...current, files: previous };
      pushToast({
        tone: 'error',
        title: 'Could not unlink the file',
        description: describeApiError(failure)
      });
    }
  },

  async transfer(input) {
    const current = detail;
    if (!current) return;
    await api.post(`/api/workflow-items/${current.workItem.id}/transfer`, input);
    await refresh();
    onTransferred?.();
  },

  async dispatch(stateId) {
    const current = detail;
    if (!current) return;
    try {
      await api.post(
        `/api/workflow-items/${current.workItem.id}/dispatch`,
        stateId ? { stateId } : {}
      );
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not queue a run',
        description: describeApiError(failure)
      });
    }
  },

  async cancelRun(runId) {
    try {
      await api.post(`/api/runs/${runId}/cancel`);
      pushToast({ tone: 'success', title: 'Run cancelled' });
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not cancel the run',
        description: describeApiError(failure)
      });
    }
  },

  refresh
};
</script>

<div class="flex min-h-0 flex-1 flex-col">
  {#if loading && detail === null}
    <div class="space-y-3 p-4">
      <Skeleton lines={2} />
      <Skeleton lines={4} height="1.5rem" />
      <Skeleton lines={6} height="1.5rem" />
    </div>
  {:else if error}
    <div class="p-4"><ErrorState message={error} onRetry={() => load(workflowItemId)} /></div>
  {:else if detail}
    <header class="space-y-2 border-b border-[var(--color-border-subtle)] px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="font-mono text-xs text-[var(--color-ink-subtle)]"
          >{detail.workItem.record.key ?? detail.key}</span
        >
        <Badge tone={stateKindTone(detail.state.kind)}>{detail.state.name}</Badge>
        <Badge tone={priorityTone(detail.workItem.priority)}>{priorityLabel(detail.workItem.priority)}</Badge>
        <span class="truncate text-[11px] text-[var(--color-ink-subtle)]">
          {detail.workflow.name} · {stateKindLabel(detail.state.kind)}
        </span>
        {#if variant === 'page'}
          <span class="ml-auto"><a class="text-xs text-[var(--color-accent)]" href="/workflows">All workflows</a></span>
        {/if}
      </div>
      <h2 class="text-base font-semibold">{detail.workItem.record.displayName}</h2>
      <Tabs {tabs} active={tab} onselect={(id) => (tab = id)} />
    </header>

    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      {#if tab === 'overview'}
        <OverviewTab
          {detail}
          {config}
          {values}
          {fieldErrors}
          {labels}
          {members}
          {teams}
          {pending}
          {transitionError}
          {actions}
          onOpenWorkItem={(id) => {
            if (onOpenWorkItem) onOpenWorkItem(id);
            else void goto(`/work-items/${id}`);
          }}
          onOpenTransfer={() => (transferOpen = true)}
        />
      {:else if tab === 'agent-work'}
        <AgentWorkTab
          workflowItemId={detail.workItem.id}
          currentStateId={detail.state.id}
          {transitionNames}
          {actions}
        />
      {:else if tab === 'activity'}
        <ActivityTab workflowItemId={detail.workItem.id} />
      {:else}
        <ArtifactsTab workflowItemId={detail.workItem.id} files={detail.files} {actions} />
      {/if}
    </div>
  {/if}
</div>

{#if detail}
  <TransferDialog
    open={transferOpen}
    workflowItemId={detail.workItem.id}
    currentWorkflowId={detail.workflow.id}
    onclose={() => (transferOpen = false)}
    onTransfer={(input) => actions.transfer(input)}
  />
{/if}
