<script lang="ts">
/**
 * A board column.
 *
 * The header carries everything a planner needs to read the workflow at a glance:
 * the state's colour, its kind (human gate or bound agent), the WIP limit and the
 * true ticket count. The inline create form is optimistic — the card appears in the
 * column before the server assigns a key.
 */

import TicketCard from '$ui/board/TicketCard.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import type { BoardColumn } from '$ui/work/rows';
import type {
  MemberOption,
  TeamOption,
  WorkflowFieldView,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  column: BoardColumn;
  fields: WorkflowFieldView[];
  transitions: WorkflowTransition[];
  agentName: string | null;
  members?: MemberOption[];
  teams?: TeamOption[];
  draggingTicketId: string | null;
  dropActive: boolean;
  pendingIds: string[];
  errors: Record<string, string>;
  creating: boolean;
  onOpenTicket: (ticketId: string) => void;
  onMoveTicket: (ticketId: string, targetStateId: string, transitionId: string) => void;
  onCardDragStart: (event: DragEvent, ticketId: string, fromStateId: string) => void;
  onCardDragEnd: () => void;
  onDragOver: (event: DragEvent, stateId: string) => void;
  onDragLeave: (stateId: string) => void;
  onDrop: (event: DragEvent, stateId: string) => void;
  onCreateTicket: (stateId: string, title: string) => Promise<boolean>;
}

let {
  column,
  fields,
  transitions,
  agentName,
  members = [],
  teams = [],
  draggingTicketId,
  dropActive,
  pendingIds,
  errors,
  creating,
  onOpenTicket,
  onMoveTicket,
  onCardDragStart,
  onCardDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onCreateTicket
}: Props = $props();

let adding = $state(false);
let title = $state('');
let submitError = $state<string | null>(null);
let submitting = $state(false);

const gate = $derived(column.state.humanGate?.enabled === true);
const wipLimit = $derived(column.state.config?.wipLimit ?? 0);
const overLimit = $derived(wipLimit > 0 && column.total > wipLimit);
const hidden = $derived(Math.max(0, column.total - column.tickets.length));

async function submit() {
  const value = title.trim();
  if (value === '') return;
  submitting = true;
  submitError = null;
  const ok = await onCreateTicket(column.state.id, value);
  submitting = false;
  if (ok) {
    title = '';
    adding = false;
  } else {
    submitError = 'Could not create the ticket. Check the title and try again.';
  }
}
</script>

<section
  class="flex w-72 shrink-0 flex-col rounded-[var(--radius-lg)] border bg-[var(--color-surface-muted)]/40 transition-colors
    {dropActive
    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40'
    : 'border-[var(--color-border-subtle)]'}"
  ondragover={(event) => onDragOver(event, column.state.id)}
  ondragleave={() => onDragLeave(column.state.id)}
  ondrop={(event) => onDrop(event, column.state.id)}
  data-testid="board-column"
  data-state-id={column.state.id}
>
  <header class="flex flex-col gap-1.5 px-3 pt-3 pb-2">
    <div class="flex items-center gap-2">
      <span
        class="h-2.5 w-2.5 shrink-0 rounded-full"
        style="background-color: {column.state.color ?? 'var(--color-border-strong)'}"
        aria-hidden="true"
      ></span>
      <h3 class="truncate text-sm font-semibold">{column.state.name}</h3>
      <span class="ml-auto font-mono text-[11px] text-[var(--color-ink-subtle)]">
        {column.total}{#if wipLimit > 0}<span class:text-[var(--color-danger)]={overLimit}
            >/{wipLimit}</span
          >{/if}
      </span>
      <button
        type="button"
        class="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs text-[var(--color-ink-subtle)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
        aria-label="Add ticket to {column.state.name}"
        title="Add ticket"
        onclick={() => {
          adding = !adding;
          submitError = null;
        }}
      >
        +
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-1">
      {#if gate}
        <Badge tone="caution" dot={true}>Human gate</Badge>
      {/if}
      {#if column.state.kind === 'agent'}
        <Badge tone="accent">{agentName ? `Agent · ${agentName}` : 'Agent · unbound'}</Badge>
      {:else if column.state.kind === 'system'}
        <Badge tone="muted">System</Badge>
      {:else if column.state.kind === 'terminal'}
        <Badge tone="positive">Terminal</Badge>
      {/if}
      {#if overLimit}
        <Badge tone="danger">Over WIP limit</Badge>
      {/if}
      {#if hidden > 0}
        <span class="text-[10px] text-[var(--color-ink-subtle)]">+{hidden} more</span>
      {/if}
    </div>
  </header>

  {#if adding}
    <form
      class="space-y-1.5 px-3 pb-2"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        value={title} oninput={(event) => (title = (event.currentTarget as HTMLInputElement).value)}
        size="sm"
        placeholder="Ticket title"
        aria-label="New ticket title"
        error={submitError}
      />
      <div class="flex items-center gap-1.5">
        <Button size="sm" variant="primary" type="submit" loading={submitting || creating}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
      </div>
    </form>
  {/if}

  <div class="scrollbar-thin flex max-h-[calc(100vh-16rem)] min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
    {#each column.tickets as row (row.ticket.id)}
      <TicketCard
        {row}
        {fields}
        {transitions}
        {members}
        {teams}
        dragging={draggingTicketId === row.ticket.id}
        pending={pendingIds.includes(row.ticket.id)}
        errorMessage={errors[row.ticket.id] ?? null}
        onOpen={() => onOpenTicket(row.ticket.id)}
        onMove={(targetStateId, transitionId) =>
          onMoveTicket(row.ticket.id, targetStateId, transitionId)}
        onDragStart={(event) => onCardDragStart(event, row.ticket.id, column.state.id)}
        onDragEnd={onCardDragEnd}
      />
    {/each}

    {#if column.tickets.length === 0}
      <p class="px-2 py-6 text-center text-xs text-[var(--color-ink-subtle)]">
        {dropActive ? 'Drop here to move the ticket' : 'No tickets in this state'}
      </p>
    {/if}
  </div>
</section>
