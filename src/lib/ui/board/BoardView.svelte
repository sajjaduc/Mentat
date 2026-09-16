<script lang="ts">
/**
 * Kanban board.
 *
 * The board is the live workbench: moves are applied locally before the server is
 * asked, rolled back with the server's reason when refused, and re-read quietly
 * afterwards so counts and side effects catch up. Ambiguous drops (two transitions
 * to the same state) ask which one instead of guessing.
 */
import { ApiError, api, describeApiError } from '$ui/api';
import BoardColumn from '$ui/board/BoardColumn.svelte';
import FilterBar from '$ui/board/FilterBar.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import { type FilterState, filterStateToQuery, isFilterActive } from '$ui/work/filters';
import {
  type BoardColumn as BoardColumnData,
  moveRow,
  optimisticTicketRow,
  reconcileRow
} from '$ui/work/rows';
import type {
  AppliedSavedView,
  Label,
  MemberOption,
  TeamOption,
  Ticket,
  TicketListRow,
  Workflow,
  WorkflowFieldView,
  WorkflowState,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  workflow: Workflow;
  states: WorkflowState[];
  fieldConfig: WorkflowFieldView[];
  filter: FilterState;
  members: MemberOption[];
  teams: TeamOption[];
  labels: Label[];
  agentNames: Record<string, string>;
  /** Bumped by the parent to force a re-read after an external change (a transfer). */
  refreshKey?: number;
  onFilterChange: (filter: FilterState) => void;
  onApplyView: (view: AppliedSavedView) => void;
  onOpenTicket: (ticketId: string) => void;
  onConfigure: () => void;
}

let {
  workflow,
  states,
  fieldConfig,
  filter,
  members,
  teams,
  labels,
  agentNames,
  refreshKey = 0,
  onFilterChange,
  onApplyView,
  onOpenTicket,
  onConfigure
}: Props = $props();

let columns = $state<BoardColumnData[] | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let dragging = $state<{ ticketId: string; fromStateId: string } | null>(null);
let dropStateId = $state<string | null>(null);
let pendingIds = $state<string[]>([]);
let moveErrors = $state<Record<string, string>>({});
let creatingFor = $state<string | null>(null);
let transitions = $state<Record<string, WorkflowTransition[]>>({});
let ambiguous = $state<{
  ticketId: string;
  fromStateId: string;
  toStateId: string;
  options: WorkflowTransition[];
} | null>(null);

const cardFields = $derived(fieldConfig.filter((view) => view.showOnCard && view.visible));
const filterQuery = $derived(filterStateToQuery(filter));

async function load(query: string | null, options: { silent?: boolean } = {}) {
  if (!options.silent) loading = true;
  error = null;
  try {
    const response = await api.get<{ columns: BoardColumnData[]; unresolvedFields: string[] }>(
      `/api/workflows/${workflow.id}/board`,
      { filter: query, limit: 50 }
    );
    columns = response.columns;
    // Fetch each column's outgoing transitions as soon as the board renders. Without
    // this the card's "Move to…" menu is empty until a card has been dragged, so the
    // keyboard-accessible move path silently does nothing.
    await Promise.all(response.columns.map((column) => ensureTransitions(column.state.id)));
  } catch (failure) {
    if (!options.silent) error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

const boardRequest = $derived({ query: filterQuery, refreshKey });

$effect(() => {
  void load(boardRequest.query);
});

async function ensureTransitions(stateId: string): Promise<WorkflowTransition[]> {
  const cached = transitions[stateId];
  if (cached) return cached;
  try {
    const response = await api.get<{ transitions: WorkflowTransition[] }>(
      `/api/states/${stateId}/transitions`
    );
    transitions = { ...transitions, [stateId]: response.transitions };
    return response.transitions;
  } catch {
    // A failed lookup must not block the move: the server still validates it.
    return [];
  }
}

function setMoveError(ticketId: string, message: string) {
  moveErrors = { ...moveErrors, [ticketId]: message };
}

function clearMoveError(ticketId: string) {
  if (!moveErrors[ticketId]) return;
  const next = { ...moveErrors };
  delete next[ticketId];
  moveErrors = next;
}

function refusalMessage(failure: unknown, fromStateId: string): string {
  if (failure instanceof ApiError) {
    if (failure.code === 'human_gate' || failure.details.gate === true) {
      const stateName = states.find((state) => state.id === fromStateId)?.name ?? 'This state';
      return `${stateName} requires a human decision`;
    }
    return describeApiError(failure);
  }
  return describeApiError(failure);
}

async function performMove(
  ticketId: string,
  fromStateId: string,
  toStateId: string,
  transitionId?: string
) {
  const previous = columns;
  if (!previous) return;
  columns = moveRow(previous, ticketId, toStateId);
  pendingIds = [...pendingIds, ticketId];
  clearMoveError(ticketId);
  try {
    await api.post(
      `/api/tickets/${ticketId}/transitions`,
      transitionId ? { transitionId } : { targetStateId: toStateId }
    );
    pendingIds = pendingIds.filter((id) => id !== ticketId);
    void load(filterQuery, { silent: true });
  } catch (failure) {
    columns = previous;
    pendingIds = pendingIds.filter((id) => id !== ticketId);
    setMoveError(ticketId, refusalMessage(failure, fromStateId));
  }
}

function onCardDragStart(event: DragEvent, ticketId: string, fromStateId: string) {
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ticketId);
  }
  dragging = { ticketId, fromStateId };
  void ensureTransitions(fromStateId);
}

function onCardDragEnd() {
  dragging = null;
  dropStateId = null;
}

function onDragOver(event: DragEvent, stateId: string) {
  if (!dragging) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropStateId = stateId;
}

function onDragLeave(stateId: string) {
  if (dropStateId === stateId) dropStateId = null;
}

async function onDrop(event: DragEvent, toStateId: string) {
  event.preventDefault();
  dropStateId = null;
  const source = dragging;
  dragging = null;
  if (!source || source.fromStateId === toStateId) return;
  const options = (await ensureTransitions(source.fromStateId)).filter(
    (transition) => transition.toStateId === toStateId
  );
  if (options.length > 1) {
    ambiguous = {
      ticketId: source.ticketId,
      fromStateId: source.fromStateId,
      toStateId,
      options
    };
    return;
  }
  const chosen = options[0];
  await performMove(source.ticketId, source.fromStateId, toStateId, chosen?.id);
}

async function createTicket(stateId: string, title: string): Promise<boolean> {
  const state = states.find((entry) => entry.id === stateId);
  const previous = columns;
  if (!state || !previous) return false;
  const tempId = `optimistic-${Math.random().toString(36).slice(2)}`;
  const optimistic = optimisticTicketRow({
    id: tempId,
    workflowId: workflow.id,
    stateId,
    stateName: state.name,
    stateKind: state.kind,
    stateCategory: state.category,
    title
  });
  columns = previous.map((column) =>
    column.state.id === stateId
      ? { ...column, tickets: [optimistic, ...column.tickets], total: column.total + 1 }
      : column
  );
  creatingFor = stateId;
  try {
    const response = await api.post<{ ticket: Ticket }>('/api/tickets', {
      workflowId: workflow.id,
      stateId,
      title
    });
    columns = (columns ?? []).map((column) =>
      column.state.id === stateId
        ? {
            ...column,
            tickets: column.tickets.map(
              (row): TicketListRow =>
                row.ticket.id === tempId ? reconcileRow(row, response.ticket) : row
            )
          }
        : column
    );
    return true;
  } catch (failure) {
    columns = previous;
    pushToast({
      tone: 'error',
      title: 'Could not create ticket',
      description: describeApiError(failure)
    });
    return false;
  } finally {
    creatingFor = null;
  }
}

const isEmpty = $derived(columns?.every((column) => column.total === 0));
const hasStates = $derived(states.length > 0);
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="border-b border-[var(--color-border-subtle)] px-4 py-3">
    <FilterBar
      {filter}
      {states}
      {members}
      {labels}
      workflowId={workflow.id}
      onchange={onFilterChange}
      onApplyView={onApplyView}
    />
  </div>

  <div class="min-h-0 flex-1 overflow-x-auto p-4">
    {#if loading && columns === null}
      <div class="flex gap-3">
        {#each [0, 1, 2, 3] as index (index)}
          <div
            class="h-64 w-72 shrink-0 space-y-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] p-3"
          >
            <Skeleton lines={2} />
            <Skeleton lines={3} height="2.5rem" />
          </div>
        {/each}
      </div>
    {:else if error}
      <ErrorState message={error} onRetry={() => load(filterQuery)} />
    {:else if !hasStates}
      <EmptyState
        title="No states configured"
        description="A workflow is a state machine: add states in Configuration before tickets can move through it."
      >
        <Button variant="primary" onclick={onConfigure}>Open configuration</Button>
      </EmptyState>
    {:else if columns}
      <!-- Columns always render, including when they hold no tickets: an empty board
           with visible columns is how a first ticket gets created (the + is on the
           column), and it keeps the state machine legible from the start. The empty
           hint appears above the columns rather than replacing them. -->
      {#if isEmpty}
        <div
          class="mb-3 flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2"
        >
          <p class="text-xs text-[var(--color-ink-muted)]">
            {isFilterActive(filter)
              ? 'Filters hide every ticket in this workflow.'
              : 'No tickets yet. Use the + on any column to create the first one, or send one in through a trigger.'}
          </p>
          {#if isFilterActive(filter)}
            <Button
              variant="secondary"
              size="sm"
              onclick={() =>
                onFilterChange({
                  stateIds: [],
                  priorities: [],
                  ownerUserId: '',
                  labelIds: [],
                  search: ''
                })}>Clear filters</Button
            >
          {/if}
        </div>
      {/if}
      <div class="flex h-full min-h-0 items-start gap-3">
        {#each columns as column (column.state.id)}
          <BoardColumn
            {column}
            fields={cardFields}
            transitions={transitions[column.state.id] ?? []}
            agentName={column.state.agentId ? (agentNames[column.state.agentId] ?? null) : null}
            {members}
            {teams}
            draggingTicketId={dragging?.ticketId ?? null}
            dropActive={dropStateId === column.state.id}
            {pendingIds}
            errors={moveErrors}
            creating={creatingFor === column.state.id}
            onOpenTicket={(ticketId) => {
              clearMoveError(ticketId);
              onOpenTicket(ticketId);
            }}
            onMoveTicket={(ticketId, targetStateId, transitionId) => {
              const owner = columns?.find((entry) =>
                entry.tickets.some((row) => row.ticket.id === ticketId)
              );
              if (!owner) return;
              void performMove(ticketId, owner.state.id, targetStateId, transitionId);
            }}
            onCardDragStart={onCardDragStart}
            onCardDragEnd={onCardDragEnd}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onCreateTicket={createTicket}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>

<Modal
  open={ambiguous !== null}
  title="Which transition?"
  description="More than one transition leads to that state. Choose the one that applies."
  onclose={() => (ambiguous = null)}
>
  <div class="space-y-1.5">
    {#each ambiguous?.options ?? [] as option (option.id)}
      <button
        type="button"
        class="block w-full rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-3 py-2 text-left text-sm hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
        onclick={() => {
          const pending = ambiguous;
          ambiguous = null;
          if (pending) {
            void performMove(pending.ticketId, pending.fromStateId, pending.toStateId, option.id);
          }
        }}
      >
        {option.name}
      </button>
    {/each}
  </div>
</Modal>
