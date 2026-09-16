<script lang="ts">
/**
 * A single board card.
 *
 * Both input paths are first-class: the card is draggable with the native HTML5
 * API, and the same moves are listed in the card menu so the board is fully
 * usable from the keyboard. An optimistic move that the server refused renders its
 * reason on the card rather than in a toast that disappears.
 */
import Avatar from '$ui/primitives/Avatar.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import FieldValue from '$ui/work/FieldValue.svelte';
import { priorityLabel, priorityTone } from '$ui/work/format';
import type {
  MemberOption,
  TeamOption,
  TicketListRow,
  WorkflowFieldView,
  WorkflowTransition
} from '$ui/work/types';

interface Props {
  row: TicketListRow;
  fields: WorkflowFieldView[];
  transitions: WorkflowTransition[];
  members?: MemberOption[];
  teams?: TeamOption[];
  dragging?: boolean;
  pending?: boolean;
  errorMessage?: string | null;
  onOpen: () => void;
  onMove: (targetStateId: string, transitionId: string) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
}

let {
  row,
  fields,
  transitions,
  members = [],
  teams = [],
  dragging = false,
  pending = false,
  errorMessage = null,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd
}: Props = $props();

const moveTargets = $derived(
  transitions.map((transition) => ({
    id: transition.id,
    toStateId: transition.toStateId,
    label: transition.name
  }))
);
</script>

<div
  role="listitem"
  aria-label="{row.ticket.key} {row.ticket.title}"
  class="group relative rounded-[var(--radius-md)] border bg-[var(--color-surface)] p-2.5 shadow-[var(--shadow-card)] transition-[border-color,box-shadow,opacity] duration-150
    {dragging ? 'opacity-50' : ''}
    {errorMessage
    ? 'border-[var(--color-danger)]'
    : 'border-[var(--color-border-subtle)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-raised)]'}"
  draggable="true"
  ondragstart={onDragStart}
  ondragend={onDragEnd}
  data-testid="board-card"
>
  <div class="flex items-start gap-1.5">
    <button
      type="button"
      class="min-w-0 flex-1 rounded-[var(--radius-sm)] text-left"
      onclick={onOpen}
    >
      <span class="font-mono text-[10px] text-[var(--color-ink-subtle)]">{row.ticket.key}</span>
      <span class="mt-0.5 block text-sm leading-snug font-medium">{row.ticket.title}</span>
    </button>

    <details class="relative shrink-0">
      <summary
        class="flex h-6 w-6 cursor-pointer list-none items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-subtle)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
        aria-label="Card actions"
        title="Card actions"
      >
        ⋯
      </summary>
      <div
        class="animate-pop-in absolute right-0 z-30 mt-1 w-52 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-overlay)]"
      >
        <button
          type="button"
          class="block w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
          onclick={onOpen}
        >
          Open ticket
        </button>
        <p class="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
          Move to…
        </p>
        {#each moveTargets as target (target.id)}
          <button
            type="button"
            class="block w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
            onclick={() => onMove(target.toStateId, target.id)}
          >
            {target.label}
          </button>
        {/each}
        {#if moveTargets.length === 0}
          <p class="px-2 py-1.5 text-[11px] text-[var(--color-ink-subtle)]">
            No transitions available from this state.
          </p>
        {/if}
      </div>
    </details>
  </div>

  <div class="mt-2 flex flex-wrap items-center gap-1.5">
    {#if row.ticket.priority !== 'none'}
      <Badge tone={priorityTone(row.ticket.priority)} dot={true}
        >{priorityLabel(row.ticket.priority)}</Badge
      >
    {/if}
    {#if row.ticket.ownerUserId}
      <Avatar
        id={row.ticket.ownerUserId}
        name={row.ownerName ?? 'Owner'}
        size="xs"
        class="ml-auto"
      />
    {:else if row.ticket.ownerTeamId}
      <Badge tone="muted">{teams.find((team) => team.id === row.ticket.ownerTeamId)?.name ?? 'Team'}</Badge>
    {/if}
    {#if pending}
      <span
        class="ml-auto h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-ink-subtle)] border-t-transparent"
        aria-label="Saving"
      ></span>
    {/if}
  </div>

  {#if row.labels.length > 0}
    <div class="mt-1.5 flex flex-wrap gap-1">
      {#each row.labels as label (label.id)}
        <span
          class="rounded-full border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-muted)]"
        >
          {label.name}
        </span>
      {/each}
    </div>
  {/if}

  {#if fields.length > 0}
    <dl class="mt-2 space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
      {#each fields as view (view.id)}
        <div class="flex items-center justify-between gap-2">
          <dt class="truncate text-[10px] text-[var(--color-ink-subtle)]">{view.definition.name}</dt>
          <dd class="shrink-0">
            <FieldValue
              type={view.definition.type}
              options={view.definition.options}
              value={row.fields[view.definition.key]}
              {members}
              {teams}
              compact={true}
            />
          </dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#if errorMessage}
    <p class="mt-2 flex items-start gap-1 text-[11px] text-[var(--color-danger)]" role="alert">
      <span aria-hidden="true">⚠</span>
      {errorMessage}
    </p>
  {/if}
</div>
