<script lang="ts">
/**
 * The ticket surface.
 *
 * One component owns the ticket's data and every mutation, so optimistic updates,
 * rollbacks and validation messages behave identically whether the ticket is shown
 * in the drawer or on its own page. Tabs are rendered exclusively, which keeps a
 * single live event stream open at a time.
 */
import { goto } from '$app/navigation';
import { ApiError, api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import ActivityTab from '$ui/ticket/ActivityTab.svelte';
import AgentWorkTab from '$ui/ticket/AgentWorkTab.svelte';
import ArtifactsTab from '$ui/ticket/ArtifactsTab.svelte';
import type { TicketActions, TransitionRequest } from '$ui/ticket/actions';
import OverviewTab from '$ui/ticket/OverviewTab.svelte';
import TransferDialog from '$ui/ticket/TransferDialog.svelte';
import { pushToast } from '$ui/toast';
import { priorityLabel, priorityTone, stateKindLabel, stateKindTone } from '$ui/work/format';
import type {
  Label,
  MemberOption,
  TeamOption,
  Ticket,
  TicketDetail,
  TicketFieldConfig,
  TicketLabelRef,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  ticketId: string;
  variant: 'drawer' | 'page';
  workspaceId?: string;
  initialTab?: string;
  onOpenTicket?: (ticketId: string) => void;
  onTransferred?: () => void;
}

let {
  ticketId,
  variant,
  workspaceId = '',
  initialTab = 'overview',
  onOpenTicket,
  onTransferred
}: Props = $props();

let detail = $state<TicketDetail | null>(null);
let config = $state<TicketFieldConfig[]>([]);
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
    const [ticketResponse, fieldResponse] = await Promise.all([
      api.get<TicketDetail>(`/api/tickets/${id}`),
      api.get<{ fields: Record<string, unknown>; config: TicketFieldConfig[] }>(
        `/api/tickets/${id}/fields`
      )
    ]);
    detail = ticketResponse;
    config = fieldResponse.config;
    values = fieldResponse.fields;
    fieldErrors = {};
    void loadResources(ticketResponse.workflow.id);
  } catch (failure) {
    error = describeApiError(failure);
    detail = null;
  } finally {
    loading = false;
  }
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
  const id = ticketId;
  tab = initialTab;
  void load(id);
});

async function refresh() {
  const current = detail;
  if (!current) return;
  try {
    const [ticketResponse, fieldResponse] = await Promise.all([
      api.get<TicketDetail>(`/api/tickets/${current.ticket.id}`),
      api.get<{ fields: Record<string, unknown>; config: TicketFieldConfig[] }>(
        `/api/tickets/${current.ticket.id}/fields`
      )
    ]);
    detail = ticketResponse;
    config = fieldResponse.config;
    values = fieldResponse.fields;
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not refresh ticket',
      description: describeApiError(failure)
    });
  }
}

const actions: TicketActions = {
  async patchTicket(patch) {
    const current = detail;
    if (!current) return false;
    const previous = current;
    detail = { ...current, ticket: { ...current.ticket, ...(patch as Partial<Ticket>) } };
    try {
      const response = await api.patch<{ ticket: Ticket }>(
        `/api/tickets/${current.ticket.id}`,
        patch
      );
      const latest = detail;
      if (latest) detail = { ...latest, ticket: response.ticket };
      return true;
    } catch (failure) {
      detail = previous;
      pushToast({
        tone: 'error',
        title: 'Could not update the ticket',
        description: describeApiError(failure)
      });
      return false;
    }
  },

  async transition(request: TransitionRequest) {
    const current = detail;
    if (!current) return 'The ticket is not loaded yet';
    pending = true;
    transitionError = null;
    try {
      await api.post(`/api/tickets/${current.ticket.id}/transitions`, request);
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
      await api.put(`/api/tickets/${current.ticket.id}/fields`, { values: { [key]: value } });
    } catch (failure) {
      values = previousValues;
      fieldErrors = { ...previousErrors, [key]: describeApiError(failure) };
    }
  },

  async addLabel(input) {
    const current = detail;
    if (!current) return;
    const optimistic: TicketLabelRef = input.labelId
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
        `/api/tickets/${current.ticket.id}/labels`,
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
      await api.delete(`/api/tickets/${current.ticket.id}/labels/${labelId}`);
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
      await api.post(`/api/tickets/${current.ticket.id}/notes`, { body });
      await refresh();
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not add the note',
        description: describeApiError(failure)
      });
    }
  },

  async linkRelationship(toTicketId, type, note) {
    const current = detail;
    if (!current) return;
    try {
      await api.post(`/api/tickets/${current.ticket.id}/relationships`, { toTicketId, type, note });
      await refresh();
      return true;
    } catch (failure) {
      pushToast({
        tone: 'error',
        title: 'Could not link the ticket',
        description: describeApiError(failure)
      });
      return false;
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
      await api.post(`/api/tickets/${current.ticket.id}/files`, input);
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
      await api.delete(`/api/tickets/${current.ticket.id}/files/${fileId}`);
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
    await api.post(`/api/tickets/${current.ticket.id}/transfer`, input);
    await refresh();
    onTransferred?.();
  },

  async dispatch(stateId) {
    const current = detail;
    if (!current) return;
    try {
      await api.post(`/api/tickets/${current.ticket.id}/dispatch`, stateId ? { stateId } : {});
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
    <div class="p-4"><ErrorState message={error} onRetry={() => load(ticketId)} /></div>
  {:else if detail}
    <header class="space-y-2 border-b border-[var(--color-border-subtle)] px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="font-mono text-xs text-[var(--color-ink-subtle)]">{detail.key}</span>
        <Badge tone={stateKindTone(detail.state.kind)}>{detail.state.name}</Badge>
        <Badge tone={priorityTone(detail.ticket.priority)}>{priorityLabel(detail.ticket.priority)}</Badge>
        <span class="truncate text-[11px] text-[var(--color-ink-subtle)]">
          {detail.workflow.name} · {stateKindLabel(detail.state.kind)}
        </span>
        {#if variant === 'page'}
          <span class="ml-auto"><a class="text-xs text-[var(--color-accent)]" href="/workflows">All workflows</a></span>
        {/if}
      </div>
      <h2 class="text-base font-semibold">{detail.ticket.title}</h2>
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
          onOpenTicket={(id) => {
            if (onOpenTicket) onOpenTicket(id);
            else void goto(`/tickets/${id}`);
          }}
          onOpenTransfer={() => (transferOpen = true)}
        />
      {:else if tab === 'agent-work'}
        <AgentWorkTab
          ticketId={detail.ticket.id}
          currentStateId={detail.state.id}
          {transitionNames}
          {actions}
        />
      {:else if tab === 'activity'}
        <ActivityTab ticketId={detail.ticket.id} />
      {:else}
        <ArtifactsTab ticketId={detail.ticket.id} files={detail.files} {actions} />
      {/if}
    </div>
  {/if}
</div>

{#if detail}
  <TransferDialog
    open={transferOpen}
    ticketId={detail.ticket.id}
    currentWorkflowId={detail.workflow.id}
    onclose={() => (transferOpen = false)}
    onTransfer={(input) => actions.transfer(input)}
  />
{/if}
