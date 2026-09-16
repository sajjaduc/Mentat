<script lang="ts">
/**
 * Ticket overview.
 *
 * Everything a person needs to understand and steer the ticket: an inline-editable
 * title and description, the allowed transitions as buttons, ownership, labels and
 * the typed field editor. Field and label writes are optimistic; the gate panel and
 * relationships are delegated so this panel stays readable.
 */
import { formatDate, formatDateTime, formatRelative } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import type { TicketActions, TransitionRequest } from '$ui/ticket/actions';
import HumanGatePanel from '$ui/ticket/HumanGatePanel.svelte';
import RelationshipsPanel from '$ui/ticket/RelationshipsPanel.svelte';
import FieldInput from '$ui/work/FieldInput.svelte';
import { PRIORITIES } from '$ui/work/filters';
import { priorityLabel } from '$ui/work/format';
import type {
  Label,
  MemberOption,
  TeamOption,
  TicketDetail,
  TicketFieldConfig
} from '$ui/work/types';

interface Props {
  detail: TicketDetail;
  config: TicketFieldConfig[];
  values: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  labels: Label[];
  members: MemberOption[];
  teams: TeamOption[];
  pending: boolean;
  transitionError: string | null;
  actions: TicketActions;
  onOpenTicket: (ticketId: string) => void;
  onOpenTransfer: () => void;
}

let {
  detail,
  config,
  values,
  fieldErrors,
  labels,
  members,
  teams,
  pending,
  transitionError,
  actions,
  onOpenTicket,
  onOpenTransfer
}: Props = $props();

let titleDraft = $state(detail.ticket.title);
let descriptionDraft = $state(detail.ticket.description ?? '');
let noteDraft = $state('');
let noteSaving = $state(false);
let labelChoice = $state('');
let newLabel = $state('');
let ownerSaving = $state(false);

$effect(() => {
  titleDraft = detail.ticket.title;
  descriptionDraft = detail.ticket.description ?? '';
});

const visibleConfig = $derived(config.filter((entry) => entry.visible));
const openTransitions = $derived(
  detail.availableTransitions.filter((transition) => transition.allowed)
);
const appliedLabelIds = $derived(new Set(detail.labels.map((label) => label.id)));
const availableLabels = $derived(labels.filter((label) => !appliedLabelIds.has(label.id)));
const gate = $derived(detail.humanGate);

const ownerValue = $derived(
  detail.ticket.ownerUserId
    ? `user:${detail.ticket.ownerUserId}`
    : detail.ticket.ownerTeamId
      ? `team:${detail.ticket.ownerTeamId}`
      : ''
);

async function commitTitle() {
  const next = titleDraft.trim();
  if (next === '' || next === detail.ticket.title) {
    titleDraft = detail.ticket.title;
    return;
  }
  const ok = await actions.patchTicket({ title: next });
  if (!ok) titleDraft = detail.ticket.title;
}

async function commitDescription() {
  const next = descriptionDraft === '' ? null : descriptionDraft;
  if (next === detail.ticket.description) return;
  await actions.patchTicket({ description: next });
}

async function changeOwner(value: string) {
  ownerSaving = true;
  const [kind, id] = value.split(':');
  await actions.patchTicket({
    ownerUserId: kind === 'user' ? (id ?? null) : null,
    ownerTeamId: kind === 'team' ? (id ?? null) : null
  });
  ownerSaving = false;
}

async function changeDue(value: string) {
  if (value === '') {
    await actions.patchTicket({ dueAt: null });
    return;
  }
  await actions.patchTicket({ dueAt: new Date(`${value}T00:00:00`).getTime() });
}

async function submitNote() {
  const body = noteDraft.trim();
  if (body === '') return;
  noteSaving = true;
  await actions.addNote(body);
  noteSaving = false;
  noteDraft = '';
}

function submitTransition(request: TransitionRequest) {
  void actions.transition(request);
}
</script>

<div class="space-y-5 p-4">
  <section class="space-y-2">
    <Input
      value={titleDraft}
      oninput={(event) => (titleDraft = (event.currentTarget as HTMLInputElement).value)}
      aria-label="Ticket title"
      class="!text-base !font-semibold"
      onblur={commitTitle}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          (event.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
    <Textarea
      value={descriptionDraft} oninput={(event) => (descriptionDraft = (event.currentTarget as HTMLTextAreaElement).value)}
      aria-label="Ticket description"
      rows={4}
      placeholder="Add a description… (markdown-ish plain text)"
      onblur={commitDescription}
    />
    <p class="text-[11px] text-[var(--color-ink-subtle)]">
      Created {formatDateTime(detail.historySummary.created)} · {detail.historySummary.stateEntries}
      state entries · {detail.historySummary.transfers} transfers
    </p>
  </section>

  <section class="space-y-2">
    <div class="flex items-center gap-2">
      <span class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
        >State</span
      >
      <Badge tone="accent">{detail.state.name}</Badge>
      {#if detail.ticket.waitingOn && detail.ticket.waitingOn !== 'none'}
        <Badge tone="caution">Waiting on {detail.ticket.waitingOn}</Badge>
      {/if}
    </div>
    {#if openTransitions.length > 0}
      <div class="flex flex-wrap gap-1.5">
        {#each openTransitions as transition (transition.id)}
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onclick={() => submitTransition({ transitionId: transition.id })}
          >
            {transition.name}
          </Button>
        {/each}
      </div>
    {:else if !gate}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        No transitions are available from this state for your role.
      </p>
    {/if}
    {#if transitionError}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{transitionError}</p>
    {/if}
  </section>

  {#if gate}
    <HumanGatePanel
      {gate}
      current={detail.state}
      transitions={detail.availableTransitions}
      fieldConfig={config}
      {values}
      decisions={detail.gateDecisions}
      {members}
      {teams}
      {pending}
      error={transitionError}
      onDecide={submitTransition}
    />
  {/if}

  <section class="grid gap-3 sm:grid-cols-3">
    <div>
      <Select
        label="Priority"
        value={detail.ticket.priority}
        options={PRIORITIES.map((priority) => ({ value: priority, label: priorityLabel(priority) }))}
        onchange={(event) =>
          actions.patchTicket({ priority: (event.currentTarget as HTMLSelectElement).value })}
      />
    </div>
    <div>
      <Select
        label="Owner"
        value={ownerValue}
        disabled={ownerSaving}
        options={[
          { value: '', label: 'Unassigned' },
          ...members.map((member) => ({ value: `user:${member.userId}`, label: member.name })),
          ...teams.map((team) => ({ value: `team:${team.id}`, label: `Team · ${team.name}` }))
        ]}
        onchange={(event) => changeOwner((event.currentTarget as HTMLSelectElement).value)}
      />
    </div>
    <div>
      <Input
        type="date"
        label="Due date"
        value={detail.ticket.dueAt ? new Date(detail.ticket.dueAt).toISOString().slice(0, 10) : ''}
        onchange={(event) => changeDue((event.currentTarget as HTMLInputElement).value)}
      />
    </div>
  </section>

  <section class="space-y-2">
    <span class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
      >Labels</span
    >
    <div class="flex flex-wrap items-center gap-1.5">
      {#each detail.labels as label (label.id)}
        <span
          class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px]"
        >
          {label.name}
          <button
            type="button"
            class="text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
            aria-label="Remove label {label.name}"
            onclick={() => actions.removeLabel(label.id)}
          >
            ✕
          </button>
        </span>
      {/each}
      {#if detail.labels.length === 0}
        <span class="text-xs text-[var(--color-ink-subtle)]">No labels</span>
      {/if}
    </div>
    <div class="flex flex-wrap items-end gap-2">
      <div class="w-44">
        <Select
          aria-label="Add existing label"
          placeholder="Add label…"
          value={labelChoice}
          options={availableLabels.map((label) => ({ value: label.id, label: label.name }))}
          onchange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            labelChoice = '';
            if (value) void actions.addLabel({ labelId: value });
          }}
        />
      </div>
      <div class="flex items-end gap-1.5">
        <Input value={newLabel} oninput={(event) => (newLabel = (event.currentTarget as HTMLInputElement).value)} size="sm" placeholder="New label name" aria-label="New label name" />
        <Button
          size="sm"
          variant="secondary"
          disabled={newLabel.trim() === ''}
          onclick={() => {
            const name = newLabel.trim();
            newLabel = '';
            if (name) void actions.addLabel({ name });
          }}
        >
          Create
        </Button>
      </div>
    </div>
  </section>

  {#if visibleConfig.length > 0}
    <section class="space-y-3">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Fields
      </h3>
      <div class="grid gap-3 sm:grid-cols-2">
        {#each visibleConfig as field (field.key)}
          <FieldInput
            config={field}
            value={values[field.key] ?? null}
            {members}
            {teams}
            error={fieldErrors[field.key] ?? null}
            onchange={(value) => actions.setField(field.key, value)}
          />
        {/each}
      </div>
    </section>
  {/if}

  <RelationshipsPanel
    ticketId={detail.ticket.id}
    relationships={detail.relationships}
    onAdd={(toTicketId, type, note) => actions.linkRelationship(toTicketId, type, note)}
    onRemove={(relationshipId) => actions.unlinkRelationship(relationshipId)}
    {onOpenTicket}
  />

  <section class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
        Journal
      </h3>
      <Button size="sm" variant="ghost" onclick={onOpenTransfer}>Transfer ticket</Button>
    </div>
    <Textarea value={noteDraft} oninput={(event) => (noteDraft = (event.currentTarget as HTMLTextAreaElement).value)} rows={2} placeholder="Add a note…" aria-label="New note" />
    <div class="flex justify-end">
      <Button size="sm" variant="primary" loading={noteSaving} disabled={noteDraft.trim() === ''} onclick={submitNote}>
        Add note
      </Button>
    </div>
    {#if detail.notes.length === 0}
      <p class="text-xs text-[var(--color-ink-subtle)]">No notes yet.</p>
    {:else}
      <ul class="space-y-2">
        {#each [...detail.notes].reverse() as note (note.id)}
          <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2">
            <div class="flex items-center gap-2 text-[11px] text-[var(--color-ink-subtle)]">
              <span class="font-medium text-[var(--color-ink-muted)]"
                >{note.authorLabel ?? note.authorType}</span
              >
              <span>{formatRelative(note.createdAt)}</span>
              {#if note.isSystem}<Badge tone="muted">System</Badge>{/if}
              {#if note.editedAt}<span>edited {formatRelative(note.editedAt)}</span>{/if}
            </div>
            <p class="mt-1 text-xs whitespace-pre-wrap">{note.body}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <p class="text-[11px] text-[var(--color-ink-subtle)]">
    Last activity {formatRelative(detail.historySummary.lastActivityAt)} · due
    {formatDate(detail.ticket.dueAt)}
  </p>
</div>
