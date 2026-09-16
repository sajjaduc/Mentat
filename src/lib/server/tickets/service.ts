/**
 * Ticket service.
 *
 * The ticket is the central work object, so this module is the busiest in Mentat.
 * It owns creation, native system fields, typed field writes, notes, labels,
 * relationships, transitions, cross-workflow transfer and file linking — always
 * through shared validation, audit and history.
 *
 * Design notes that matter:
 *  - `createTicketSync` runs inside a caller's transaction, so a trigger can create
 *    a ticket, attach an ingested file and enqueue the first job atomically.
 *  - The public `create` wraps that in its own transaction for callers that have
 *    none.
 *  - Transitions delegate to `execution/state-machine.ts`, the only place a
 *    ticket's state changes; the rules therefore cannot diverge between a human
 *    click, an agent outcome and an approval resumption.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { AuditActions, queryAudit, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, getDb, withTransaction } from '../db/client';
import {
  type ActorType,
  agentRuns,
  approvalRequests,
  counters,
  fieldDefinitions,
  files,
  humanGateDecisions,
  labels,
  type Ticket,
  type TicketPriority,
  type TicketRelationshipType,
  ticketFiles,
  ticketLabels,
  ticketNoteRevisions,
  ticketNotes,
  ticketRelationships,
  ticketStateHistory,
  tickets,
  ticketWorkflowHistory,
  type WorkflowState,
  workflowFields,
  workflowStates,
  workflows,
  workflowTransferRules,
  workflowTransitions
} from '../db/schema';
import { publishRunEvent, RunEventTypes } from '../execution/events';
import {
  applyTransitionSync,
  computeWaitingOn,
  decideHumanGateSync,
  enqueueDestinationStateWork,
  humanGateOf,
  recordInitialStateSync,
  resolveTransition,
  validateTransition
} from '../execution/state-machine';
import { requiredFieldsForState } from '../fields/service';
import type { FilterAst } from '../filters/ast';
import { requireState, requireWorkflow } from '../workflows/service';
import {
  type CreateTicketInput,
  setTicketService,
  type TicketService,
  type TicketSummary
} from './contracts';
import { listTickets, type TicketListRow, type TicketSort } from './query';
import { INVERSE_RELATIONSHIP, type TicketStatusWait } from './types';
import { fieldValuesByKey, ticketFieldHistory, writeTicketFieldValues } from './values';

export interface GateDecisionView {
  id: string;
  outcome: string;
  comment: string | null;
  decidedByLabel: string | null;
  createdAt: number;
}

export interface TicketDetail {
  ticket: Ticket;
  key: string;
  state: WorkflowState;
  workflow: { id: string; name: string; key: string };
  fields: Record<string, unknown>;
  labels: Array<{ id: string; name: string; color: string | null }>;
  notes: Array<{
    id: string;
    authorType: ActorType;
    authorId: string | null;
    authorLabel: string | null;
    body: string;
    isSystem: boolean;
    createdAt: number;
    editedAt: number | null;
  }>;
  relationships: Array<{
    id: string;
    type: TicketRelationshipType;
    direction: 'outgoing' | 'incoming';
    ticket: { id: string; key: string; title: string; stateId: string; stateName: string | null };
    createdAt: number;
  }>;
  files: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    status: string;
    relationship: string;
  }>;
  runs: Array<{
    id: string;
    status: string;
    agentId: string;
    modelKey: string | null;
    attempt: number;
    startedAt: number | null;
    finishedAt: number | null;
    durationMs: number | null;
    error: string | null;
  }>;
  approvals: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    createdAt: number;
    decidedAt: number | null;
  }>;
  availableTransitions: Array<{
    id: string;
    name: string;
    toStateId: string;
    toStateName: string;
    requiresComment: boolean;
    requiredFieldKeys: string[];
    allowed: boolean;
    reason?: string;
  }>;
  humanGate: ReturnType<typeof humanGateOf>;
  gateDecisions: GateDecisionView[];
  historySummary: {
    created: number;
    lastActivityAt: number;
    stateEntries: number;
    transfers: number;
  };
}

function toSummary(ticket: Ticket): TicketSummary {
  return {
    id: ticket.id,
    key: ticket.key,
    number: ticket.number,
    title: ticket.title,
    workflowId: ticket.workflowId,
    stateId: ticket.stateId,
    priority: ticket.priority,
    ownerUserId: ticket.ownerUserId,
    ownerTeamId: ticket.ownerTeamId,
    version: ticket.version,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt
  };
}

export function requireTicketSync(db: Executor, workspaceId: string, ticketId: string): Ticket {
  const rows = db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const ticket = rows[0];
  if (!ticket) throw errors.notFound('Ticket', ticketId);
  return ticket;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function createTicketSync(
  tx: Executor,
  actor: ActorContext,
  input: CreateTicketInput
): TicketSummary {
  assertPermission(actor, Permissions.ticketCreate, 'Not permitted to create tickets');

  const workflow = requireWorkflow(tx, actor.workspaceId, input.workflowId);
  if (workflow.archivedAt) {
    throw errors.precondition('This workflow is archived and cannot accept new tickets');
  }

  const title = input.title.trim();
  if (title.length === 0) throw errors.validation('Ticket title is required');
  if (title.length > 500) throw errors.validation('Ticket title must be at most 500 characters');

  const state = resolveInitialState(tx, actor.workspaceId, workflow, input.stateId ?? null);
  const now = Date.now();
  const number = allocateTicketNumber(tx, actor.workspaceId);
  const ticketId = uuidv7(now);

  const ticket = insertTicket(tx, {
    ticketId,
    actor,
    workflowId: workflow.id,
    workflowKey: workflow.key,
    state,
    number,
    title,
    description: input.description ?? null,
    priority: input.priority ?? 'none',
    ownerUserId: input.ownerUserId ?? null,
    ownerTeamId: input.ownerTeamId ?? null,
    structuredData: input.structuredData ?? null,
    originTicketId: input.originTicketId ?? null,
    provenance: input.provenance
      ? {
          sourceType: input.provenance.sourceType ?? undefined,
          sourceReference: input.provenance.sourceReference ?? undefined,
          sourceLabel: input.provenance.sourceLabel ?? undefined,
          triggerId: input.provenance.triggerId ?? undefined,
          triggerEventId: input.provenance.triggerEventId ?? undefined,
          externalRef: input.provenance.externalRef ?? undefined,
          ingestedAt: now
        }
      : null,
    createdAt: now
  });

  recordInitialStateSync(tx, {
    workspaceId: actor.workspaceId,
    ticket,
    state,
    actor,
    enteredAt: now,
    reason: 'Ticket created'
  });

  if (input.fields && Object.keys(input.fields).length > 0) {
    writeTicketFieldValues(tx, {
      workspaceId: actor.workspaceId,
      ticketId,
      workflowId: workflow.id,
      values: input.fields,
      actor,
      source:
        actor.actorType === 'agent' ? 'agent' : actor.actorType === 'user' ? 'human' : 'system',
      runId: actor.runId ?? null
    });
  }

  if (input.labelIds?.length || input.labelNames?.length) {
    addLabelsSync(tx, actor, ticket, {
      labelIds: input.labelIds ?? [],
      labelNames: input.labelNames ?? []
    });
  }

  const parents = new Set<string>();
  if (input.parentTicketId) parents.add(input.parentTicketId);
  if (input.originTicketId) parents.add(input.originTicketId);
  for (const parentTicketId of parents) {
    linkRelationshipSync(tx, actor, {
      fromTicketId: parentTicketId,
      toTicketId: ticketId,
      type: 'child'
    });
  }
  for (const relationship of input.relationships ?? []) {
    linkRelationshipSync(tx, actor, {
      fromTicketId: ticketId,
      toTicketId: relationship.ticketId,
      type: relationship.type,
      note: relationship.note ?? null
    });
  }

  for (const fileId of input.fileIds ?? []) {
    attachFileSync(tx, actor, { ticketId, fileId, relationship: 'attachment' });
  }

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: input.provenance?.sourceLabel ?? actor.actorLabel,
    entityType: 'ticket',
    entityId: ticketId,
    ticketId,
    workflowId: workflow.id,
    runId: actor.runId ?? null,
    summary: `Ticket ${ticket.key} created in ${workflow.name}`,
    data: {
      key: ticket.key,
      workflow: workflow.name,
      state: state.name,
      source: input.provenance?.sourceType ?? 'manual',
      originTicketId: input.originTicketId ?? null
    },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: actor.workspaceId,
      ticketId,
      runId: actor.runId ?? null,
      type: RunEventTypes.ticketUpdated,
      data: { ticketId, key: ticket.key, created: true }
    },
    now
  );

  // Destination-state work is enqueued inside this transaction, so a ticket can
  // never be created without the work its state implies.
  if (!input.deferExecution) {
    enqueueDestinationStateWork(tx, {
      workspaceId: actor.workspaceId,
      ticket,
      state,
      actor,
      enteredAt: now
    });
  }

  return toSummary(ticket);
}

/**
 * Allocate the next ticket number. A single conditional UPDATE keeps this
 * portable and avoids any dependence on autoincrement behaviour (ADR-0003).
 */
function allocateTicketNumber(tx: Executor, workspaceId: string, name = 'ticket'): number {
  const updated = tx
    .update(counters)
    .set({ value: sql`${counters.value} + 1`, updatedAt: Date.now() })
    .where(and(eq(counters.workspaceId, workspaceId), eq(counters.name, name)))
    .returning({ value: counters.value })
    .all();
  const row = updated[0];
  if (row) return row.value;

  try {
    const inserted = tx
      .insert(counters)
      .values({
        id: `${workspaceId}:${name}`,
        workspaceId,
        name,
        value: 1,
        updatedAt: Date.now()
      })
      .returning({ value: counters.value })
      .all();
    if (inserted[0]) return inserted[0].value;
  } catch {
    const retried = tx
      .update(counters)
      .set({ value: sql`${counters.value} + 1`, updatedAt: Date.now() })
      .where(and(eq(counters.workspaceId, workspaceId), eq(counters.name, name)))
      .returning({ value: counters.value })
      .all();
    if (retried[0]) return retried[0].value;
  }
  throw errors.internal('Failed to allocate ticket number', { workspaceId });
}

function resolveInitialState(
  tx: Executor,
  workspaceId: string,
  workflow: { id: string; defaultStateId: string | null },
  requestedStateId: string | null
): WorkflowState {
  const stateId = requestedStateId ?? workflow.defaultStateId;
  if (stateId) {
    const state = requireState(tx, workspaceId, stateId);
    if (state.workflowId !== workflow.id) {
      throw errors.validation('The requested state does not belong to this workflow');
    }
    return state;
  }
  const rows = tx
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.workflowId, workflow.id))
    .orderBy(workflowStates.position)
    .limit(1)
    .all();
  const fallback = rows[0];
  if (!fallback) throw errors.precondition('This workflow has no states yet');
  return fallback;
}

interface InsertTicketInput {
  ticketId: string;
  actor: ActorContext;
  workflowId: string;
  workflowKey: string;
  state: WorkflowState;
  number: number;
  title: string;
  description: string | null;
  priority: TicketPriority;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  structuredData: Record<string, unknown> | null;
  originTicketId: string | null;
  provenance: Record<string, unknown> | null;
  createdAt: number;
}

function insertTicket(tx: Executor, input: InsertTicketInput): Ticket {
  const inserted = tx
    .insert(tickets)
    .values({
      id: input.ticketId,
      workspaceId: input.actor.workspaceId,
      workflowId: input.workflowId,
      stateId: input.state.id,
      key: `${input.workflowKey}-${input.number}`,
      number: input.number,
      title: input.title,
      description: input.description,
      priority: input.priority,
      ownerUserId: input.ownerUserId,
      ownerTeamId: input.ownerTeamId,
      structuredData: (input.structuredData as never) ?? null,
      version: 1,
      originTicketId: input.originTicketId,
      createdByType: input.actor.actorType,
      createdById: input.actor.actorId,
      createdByLabel: input.actor.actorLabel,
      provenance: (input.provenance as never) ?? null,
      enteredStateAt: input.createdAt,
      lastActivityAt: input.createdAt,
      stateRunCount: 0,
      waitingOn: computeWaitingOn(input.state),
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    })
    .returning()
    .all();
  const ticket = inserted[0];
  if (!ticket) throw errors.internal('Failed to create ticket');
  return ticket;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface TouchTicketInput {
  title?: string;
  description?: string | null;
  priority?: TicketPriority;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  dueAt?: number | null;
  structuredData?: Record<string, unknown> | null;
  expectedVersion?: number;
}

export function touchTicketSync(tx: Executor, ticketId: string, input: TouchTicketInput): Ticket {
  const current = tx.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1).all()[0];
  if (!current) throw errors.notFound('Ticket', ticketId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
    throw errors.versionConflict('Ticket', input.expectedVersion, current.version);
  }

  const now = Date.now();
  const updated = tx
    .update(tickets)
    .set({
      title: input.title ?? current.title,
      description: input.description === undefined ? current.description : input.description,
      priority: input.priority ?? current.priority,
      ownerUserId: input.ownerUserId === undefined ? current.ownerUserId : input.ownerUserId,
      ownerTeamId: input.ownerTeamId === undefined ? current.ownerTeamId : input.ownerTeamId,
      dueAt: input.dueAt === undefined ? current.dueAt : input.dueAt,
      structuredData:
        input.structuredData === undefined
          ? current.structuredData
          : ((input.structuredData as never) ?? null),
      version: sql`${tickets.version} + 1`,
      lastActivityAt: now,
      updatedAt: now
    })
    .where(eq(tickets.id, ticketId))
    .returning()
    .all();
  const ticket = updated[0];
  if (!ticket) throw errors.notFound('Ticket', ticketId);
  return ticket;
}

export interface UpdateTicketInput extends TouchTicketInput {
  ticketId: string;
}

export function updateTicketSync(
  tx: Executor,
  actor: ActorContext,
  input: UpdateTicketInput
): Ticket {
  assertPermission(actor, Permissions.ticketWrite, 'Not permitted to update tickets');
  const before = requireTicketSync(tx, actor.workspaceId, input.ticketId);
  const ticket = touchTicketSync(tx, input.ticketId, input);

  const changed: string[] = [];
  if (input.title !== undefined && input.title !== before.title) changed.push('title');
  if (input.description !== undefined && input.description !== before.description)
    changed.push('description');
  if (input.priority !== undefined && input.priority !== before.priority) changed.push('priority');
  if (input.ownerUserId !== undefined && input.ownerUserId !== before.ownerUserId)
    changed.push('ownerUserId');
  if (input.ownerTeamId !== undefined && input.ownerTeamId !== before.ownerTeamId)
    changed.push('ownerTeamId');
  if (input.dueAt !== undefined && input.dueAt !== before.dueAt) changed.push('dueAt');

  if (changed.length > 0) {
    const action = changed.includes('priority')
      ? AuditActions.ticketPriorityChanged
      : changed.some((key) => key === 'ownerUserId' || key === 'ownerTeamId')
        ? AuditActions.ticketAssigned
        : AuditActions.ticketUpdated;
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'ticket',
      entityId: ticket.id,
      ticketId: ticket.id,
      workflowId: ticket.workflowId,
      runId: actor.runId ?? null,
      summary: `Ticket ${ticket.key} updated`,
      data: {
        changed,
        before: {
          title: before.title,
          priority: before.priority,
          ownerUserId: before.ownerUserId,
          ownerTeamId: before.ownerTeamId
        },
        after: {
          title: ticket.title,
          priority: ticket.priority,
          ownerUserId: ticket.ownerUserId,
          ownerTeamId: ticket.ownerTeamId
        }
      }
    });
  }

  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    ticketId: ticket.id,
    type: RunEventTypes.ticketUpdated,
    data: { ticketId: ticket.id, changed }
  });

  return ticket;
}

export interface NoteView {
  id: string;
  authorType: ActorType;
  authorId: string | null;
  authorLabel: string | null;
  body: string;
  isSystem: boolean;
  createdAt: number;
  editedAt: number | null;
}

export function addNoteSync(
  tx: Executor,
  actor: ActorContext,
  input: {
    ticketId: string;
    body: string;
    isSystem?: boolean;
    runId?: string | null;
    authorLabel?: string;
  }
): NoteView {
  assertPermission(actor, Permissions.ticketWrite, 'Not permitted to comment');
  const ticket = requireTicketSync(tx, actor.workspaceId, input.ticketId);
  const body = input.body.trim();
  if (body.length === 0) throw errors.validation('A note must not be empty');
  if (body.length > 20_000) throw errors.validation('A note must be at most 20,000 characters');

  const now = Date.now();
  const noteId = uuidv7(now);
  tx.insert(ticketNotes)
    .values({
      id: noteId,
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      authorType: actor.actorType,
      authorId: actor.actorId,
      authorLabel: input.authorLabel ?? actor.actorLabel,
      body,
      isSystem: input.isSystem ?? false,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .run();

  touchTicketSync(tx, ticket.id, {});

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketNoteAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: input.authorLabel ?? actor.actorLabel,
    entityType: 'ticket',
    entityId: ticket.id,
    ticketId: ticket.id,
    workflowId: ticket.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: 'Note added',
    // The body is stored once in `ticket_notes`; the ledger keeps only a short
    // preview so the timeline stays readable without duplicating content.
    data: { noteId, preview: body.slice(0, 200) },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      runId: input.runId ?? null,
      type: RunEventTypes.noteAdded,
      data: { noteId, authorLabel: input.authorLabel ?? actor.actorLabel }
    },
    now
  );

  return {
    id: noteId,
    authorType: actor.actorType,
    authorId: actor.actorId,
    authorLabel: input.authorLabel ?? actor.actorLabel,
    body,
    isSystem: input.isSystem ?? false,
    createdAt: now,
    editedAt: null
  };
}

export function editNoteSync(
  tx: Executor,
  actor: ActorContext,
  input: { noteId: string; body: string }
): void {
  const note = tx
    .select()
    .from(ticketNotes)
    .where(and(eq(ticketNotes.id, input.noteId), eq(ticketNotes.workspaceId, actor.workspaceId)))
    .limit(1)
    .all()[0];
  if (!note) throw errors.notFound('Note', input.noteId);
  const isAuthor = note.authorId !== null && note.authorId === actor.actorId;
  if (!isAuthor && !actor.permissions.has(Permissions.workspaceAdmin)) {
    throw errors.forbidden('Only the author can edit this note');
  }
  const body = input.body.trim();
  if (body.length === 0) throw errors.validation('A note must not be empty');

  const now = Date.now();
  tx.insert(ticketNoteRevisions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      noteId: note.id,
      body: note.body,
      editedByType: actor.actorType,
      editedById: actor.actorId,
      createdAt: now
    })
    .run();

  tx.update(ticketNotes)
    .set({ body, editedAt: now, editedByType: actor.actorType, editedById: actor.actorId })
    .where(eq(ticketNotes.id, note.id))
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketNoteEdited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: note.ticketId,
    ticketId: note.ticketId,
    summary: 'Note edited',
    data: { noteId: note.id, previousBody: note.body.slice(0, 500) },
    occurredAt: now
  });
}

export function deleteNoteSync(tx: Executor, actor: ActorContext, noteId: string): void {
  const note = tx
    .select()
    .from(ticketNotes)
    .where(and(eq(ticketNotes.id, noteId), eq(ticketNotes.workspaceId, actor.workspaceId)))
    .limit(1)
    .all()[0];
  if (!note) throw errors.notFound('Note', noteId);
  const isAuthor = note.authorId !== null && note.authorId === actor.actorId;
  if (!isAuthor && !actor.permissions.has(Permissions.workspaceAdmin)) {
    throw errors.forbidden('Only the author can delete this note');
  }
  const now = Date.now();
  tx.update(ticketNotes).set({ deletedAt: now }).where(eq(ticketNotes.id, noteId)).run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketNoteEdited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: note.ticketId,
    ticketId: note.ticketId,
    summary: 'Note deleted',
    data: { noteId, deleted: true },
    occurredAt: now
  });
}

export function addLabelsSync(
  tx: Executor,
  actor: ActorContext,
  ticket: Ticket,
  input: { labelIds?: string[]; labelNames?: string[] }
): void {
  const resolved: string[] = [];
  if (input.labelIds?.length) {
    const rows = tx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.workspaceId, actor.workspaceId), inArray(labels.id, input.labelIds)))
      .all();
    if (rows.length !== input.labelIds.length) {
      throw errors.validation('One or more labels do not exist in this workspace');
    }
    resolved.push(...rows.map((row) => row.id));
  }
  for (const rawName of input.labelNames ?? []) {
    const name = rawName.trim();
    if (name.length === 0) continue;
    const existing = tx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.workspaceId, actor.workspaceId), eq(labels.name, name)))
      .limit(1)
      .all();
    if (existing[0]) {
      resolved.push(existing[0].id);
      continue;
    }
    const id = uuidv7();
    tx.insert(labels)
      .values({
        id,
        workspaceId: actor.workspaceId,
        name,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .run();
    resolved.push(id);
  }

  for (const labelId of new Set(resolved)) {
    tx.insert(ticketLabels)
      .values({
        id: uuidv7(),
        workspaceId: actor.workspaceId,
        ticketId: ticket.id,
        labelId,
        createdAt: Date.now()
      })
      .onConflictDoNothing()
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.ticketLabelAdded,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'ticket',
      entityId: ticket.id,
      ticketId: ticket.id,
      summary: 'Label added',
      data: { labelId }
    });
  }
}

export function removeLabelSync(
  tx: Executor,
  actor: ActorContext,
  ticketId: string,
  labelId: string
): void {
  requireTicketSync(tx, actor.workspaceId, ticketId);
  tx.delete(ticketLabels)
    .where(and(eq(ticketLabels.ticketId, ticketId), eq(ticketLabels.labelId, labelId)))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketLabelRemoved,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: ticketId,
    ticketId,
    summary: 'Label removed',
    data: { labelId }
  });
}

/**
 * Relationships are stored once and interpreted in both directions when read, so a
 * `child` row implies the `parent` view without a second write that could drift.
 */
export function linkRelationshipSync(
  tx: Executor,
  actor: ActorContext,
  input: {
    fromTicketId: string;
    toTicketId: string;
    type: TicketRelationshipType;
    note?: string | null;
    runId?: string | null;
  }
): string {
  if (input.fromTicketId === input.toTicketId) {
    throw errors.validation('A ticket cannot be related to itself');
  }
  const from = requireTicketSync(tx, actor.workspaceId, input.fromTicketId);
  const to = requireTicketSync(tx, actor.workspaceId, input.toTicketId);

  const existing = tx
    .select()
    .from(ticketRelationships)
    .where(
      and(
        eq(ticketRelationships.fromTicketId, input.fromTicketId),
        eq(ticketRelationships.toTicketId, input.toTicketId),
        eq(ticketRelationships.type, input.type)
      )
    )
    .limit(1)
    .all();
  if (existing[0]) return existing[0].id;

  const now = Date.now();
  const id = uuidv7(now);
  tx.insert(ticketRelationships)
    .values({
      id,
      workspaceId: actor.workspaceId,
      fromTicketId: input.fromTicketId,
      toTicketId: input.toTicketId,
      type: input.type,
      note: input.note ?? null,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketRelationshipAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: from.id,
    ticketId: from.id,
    runId: input.runId ?? actor.runId ?? null,
    summary: `${from.key} → ${to.key} (${input.type})`,
    data: { fromTicketId: from.id, toTicketId: to.id, type: input.type, note: input.note ?? null },
    occurredAt: now
  });

  return id;
}

export function unlinkRelationshipSync(
  tx: Executor,
  actor: ActorContext,
  relationshipId: string
): void {
  const relationship = tx
    .select()
    .from(ticketRelationships)
    .where(
      and(
        eq(ticketRelationships.id, relationshipId),
        eq(ticketRelationships.workspaceId, actor.workspaceId)
      )
    )
    .limit(1)
    .all()[0];
  if (!relationship) throw errors.notFound('Ticket relationship', relationshipId);

  tx.delete(ticketRelationships).where(eq(ticketRelationships.id, relationshipId)).run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketRelationshipRemoved,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: relationship.fromTicketId,
    ticketId: relationship.fromTicketId,
    summary: 'Ticket relationship removed',
    data: {
      fromTicketId: relationship.fromTicketId,
      toTicketId: relationship.toTicketId,
      type: relationship.type
    }
  });
}

export function attachFileSync(
  tx: Executor,
  actor: ActorContext,
  input: {
    ticketId: string;
    fileId: string;
    relationship?: 'attachment' | 'reference' | 'output' | 'evidence';
    caption?: string | null;
    runId?: string | null;
  }
): void {
  const ticket = requireTicketSync(tx, actor.workspaceId, input.ticketId);
  const file = tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, input.fileId),
        eq(files.workspaceId, actor.workspaceId),
        isNull(files.deletedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!file) throw errors.notFound('File', input.fileId);

  const now = Date.now();
  tx.insert(ticketFiles)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      fileId: file.id,
      relationship: input.relationship ?? 'attachment',
      caption: input.caption ?? null,
      addedByType: actor.actorType,
      addedById: actor.actorId,
      addedByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .onConflictDoNothing()
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.fileLinkedToTicket,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'file',
    entityId: file.id,
    ticketId: ticket.id,
    fileId: file.id,
    workflowId: ticket.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: `${file.originalFilename} attached to ${ticket.key}`,
    data: { relationship: input.relationship ?? 'attachment' },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      runId: input.runId ?? null,
      type: RunEventTypes.fileAttached,
      data: { fileId: file.id, filename: file.originalFilename }
    },
    now
  );
}

export function setWaitingOnSync(
  tx: Executor,
  actor: ActorContext,
  ticketId: string,
  waitingOn: TicketStatusWait
): void {
  requireTicketSync(tx, actor.workspaceId, ticketId);
  tx.update(tickets)
    .set({ waitingOn, updatedAt: Date.now() })
    .where(eq(tickets.id, ticketId))
    .run();
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface RequestTransitionInput {
  ticketId: string;
  transitionId?: string | null;
  targetStateId?: string | null;
  comment?: string | null;
  fieldValues?: Record<string, unknown>;
  runId?: string | null;
  viaRun?: boolean;
}

export function requestTransitionSync(
  tx: Executor,
  actor: ActorContext,
  input: RequestTransitionInput
): { enteredStateId: string; transitionId: string | null } {
  assertPermission(actor, Permissions.ticketWrite, 'Not permitted to move tickets');
  const ticket = requireTicketSync(tx, actor.workspaceId, input.ticketId);
  const state = requireState(tx, actor.workspaceId, ticket.stateId);
  const gate = humanGateOf(state);

  if (gate && actor.actorType === 'user') {
    // A human leaving a gated state is a gate decision, and is recorded as one.
    const resolution = resolveTransition(tx, {
      workspaceId: actor.workspaceId,
      workflowId: ticket.workflowId,
      fromStateId: ticket.stateId,
      transitionId: input.transitionId,
      targetStateId: input.targetStateId
    });
    const applied = decideHumanGateSync(tx, {
      actor,
      ticket,
      toStateId: resolution.toState.id,
      transitionId: resolution.transition.id,
      comment: input.comment,
      fieldValues: input.fieldValues
    });
    return { enteredStateId: applied.toStateId, transitionId: applied.transitionId };
  }

  if (gate) {
    // Agents cannot choose the gate exit. Refusing with a specific error lets the
    // runner surface "waiting for a human" instead of retrying the job.
    throw errors.humanGate(`"${state.name}" requires a human decision before the ticket can move`, {
      stateId: state.id,
      stateName: state.name,
      gate: true
    });
  }

  const resolution = validateTransition(tx, {
    actor,
    ticket,
    transitionId: input.transitionId,
    targetStateId: input.targetStateId,
    comment: input.comment,
    fieldValues: input.fieldValues,
    runId: input.runId,
    viaRun: input.viaRun
  });

  const applied = applyTransitionSync(tx, {
    actor,
    ticket,
    resolution,
    comment: input.comment,
    fieldValues: input.fieldValues,
    runId: input.runId,
    reason: input.comment ?? resolution.transition.name
  });

  return { enteredStateId: applied.toStateId, transitionId: applied.transitionId };
}

// ---------------------------------------------------------------------------
// Cross-workflow transfer
// ---------------------------------------------------------------------------

export interface TransferPolicy {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  rule: typeof workflowTransferRules.$inferSelect | null;
}

export function evaluateTransferPolicy(
  db: Executor,
  actor: ActorContext,
  input: { ticket: Ticket; targetWorkflowId: string }
): TransferPolicy {
  const rule =
    db
      .select()
      .from(workflowTransferRules)
      .where(
        and(
          eq(workflowTransferRules.workspaceId, actor.workspaceId),
          eq(workflowTransferRules.sourceWorkflowId, input.ticket.workflowId),
          eq(workflowTransferRules.targetWorkflowId, input.targetWorkflowId)
        )
      )
      .limit(1)
      .all()[0] ?? null;

  if (!actor.permissions.has(Permissions.ticketTransfer)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason:
        actor.actorType === 'agent'
          ? 'This agent is not permitted to transfer tickets'
          : 'You do not have permission to transfer tickets',
      rule
    };
  }

  const isHuman = actor.actorType === 'user';

  if (rule) {
    if (isHuman && !rule.allowHumans) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Humans may not transfer out of this workflow',
        rule
      };
    }
    if (!isHuman && !rule.allowAgents) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Agents may not transfer out of this workflow',
        rule
      };
    }
    return { allowed: true, requiresApproval: rule.requiresApproval, rule };
  }

  // No explicit rule: fall back to workflow-level transfer settings, then allow.
  // Allowing by default is what makes the intake → specialist pattern work without
  // configuration; the ticket is still scoped to the workspace and audited.
  const source = db
    .select({ settings: workflows.settings })
    .from(workflows)
    .where(eq(workflows.id, input.ticket.workflowId))
    .limit(1)
    .all()[0];
  const settings = (source?.settings ?? null) as {
    transfer?: {
      allowedTargetWorkflowIds?: string[];
      allowAgents?: boolean;
      allowHumans?: boolean;
      requiresApproval?: boolean;
    };
  } | null;
  const transfer = settings?.transfer;
  if (!transfer) return { allowed: true, requiresApproval: false, rule: null };

  if (
    transfer.allowedTargetWorkflowIds &&
    transfer.allowedTargetWorkflowIds.length > 0 &&
    !transfer.allowedTargetWorkflowIds.includes(input.targetWorkflowId)
  ) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Destination workflow is not an allowed target',
      rule: null
    };
  }
  if (isHuman && transfer.allowHumans === false) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Humans may not transfer out of this workflow',
      rule: null
    };
  }
  if (!isHuman && transfer.allowAgents === false) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Agents may not transfer out of this workflow',
      rule: null
    };
  }
  return { allowed: true, requiresApproval: transfer.requiresApproval ?? false, rule: null };
}

export interface TransferPreview {
  policy: TransferPolicy;
  targetWorkflow: { id: string; name: string; key: string; states: WorkflowState[] };
  defaultTargetStateId: string | null;
  compatible: string[];
  mapped: Array<{ source: string; target: string }>;
  destinationRequired: Array<{ key: string; name: string; satisfied: boolean }>;
  sourceOnly: string[];
}

export function previewTransfer(
  db: Executor,
  actor: ActorContext,
  input: { ticketId: string; targetWorkflowId: string }
): TransferPreview {
  const ticket = requireTicketSync(db, actor.workspaceId, input.ticketId);
  const policy = evaluateTransferPolicy(db, actor, {
    ticket,
    targetWorkflowId: input.targetWorkflowId
  });
  const target = requireWorkflow(db, actor.workspaceId, input.targetWorkflowId);
  const states = db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.workflowId, target.id))
    .orderBy(workflowStates.position)
    .all();

  const mappings = (policy.rule?.fieldMappings as Record<string, string> | null) ?? {};
  const sourceKeys = workflowFieldKeys(db, actor.workspaceId, ticket.workflowId);
  const targetKeys = workflowFieldKeys(db, actor.workspaceId, target.id);
  const values = fieldValuesByKey(db, actor.workspaceId, ticket.id);

  const compatible = sourceKeys.filter(
    (key) => targetKeys.includes(key) && values[key] !== undefined
  );
  const mapped = Object.entries(mappings).map(([source, mappedTarget]) => ({
    source,
    target: mappedTarget
  }));

  const defaultTargetStateId = policy.rule?.defaultTargetStateId ?? target.defaultStateId ?? null;
  const requiredStateId = defaultTargetStateId ?? states[0]?.id ?? '';
  const requiredDefinitions = requiredStateId
    ? requiredFieldsForState(db, actor.workspaceId, target.id, requiredStateId)
    : [];
  const mappedTargets = new Set(Object.values(mappings));
  const destinationRequired = requiredDefinitions.map((definition) => {
    const satisfied =
      values[definition.key] !== undefined ||
      (mappedTargets.has(definition.key) &&
        Object.entries(mappings).some(
          ([source2, mappedTarget]) =>
            mappedTarget === definition.key && values[source2] !== undefined
        ));
    return { key: definition.key, name: definition.name, satisfied };
  });

  const sourceOnly = sourceKeys.filter((key) => !targetKeys.includes(key) && !(key in mappings));

  return {
    policy,
    targetWorkflow: { id: target.id, name: target.name, key: target.key, states },
    defaultTargetStateId,
    compatible,
    mapped,
    destinationRequired,
    sourceOnly
  };
}

export interface TransferInput {
  ticketId: string;
  targetWorkflowId: string;
  targetStateId?: string | null;
  fieldMappings?: Record<string, string>;
  reason?: string | null;
  runId?: string | null;
  /** Set when an approval gate has already been satisfied. */
  approved?: boolean;
}

export interface TransferResult {
  ticketId: string;
  fromWorkflowId: string;
  fromStateId: string;
  toWorkflowId: string;
  toStateId: string;
  mappedFields: Record<string, string>;
}

/**
 * Move a ticket between workflows.
 *
 * Identity, notes, artifacts and lineage are preserved; only the workflow/state
 * changes. The default is move, never copy (ADR-0011).
 */
export function transferTicketSync(
  tx: Executor,
  actor: ActorContext,
  input: TransferInput
): TransferResult {
  const ticket = requireTicketSync(tx, actor.workspaceId, input.ticketId);
  if (ticket.workflowId === input.targetWorkflowId) {
    throw errors.validation('The ticket is already in that workflow');
  }

  const policy = evaluateTransferPolicy(tx, actor, {
    ticket,
    targetWorkflowId: input.targetWorkflowId
  });
  if (!policy.allowed) {
    throw errors.policyDenied(policy.reason ?? 'Transfer is not permitted', {
      targetWorkflowId: input.targetWorkflowId
    });
  }
  if (policy.requiresApproval && !input.approved) {
    throw errors.approvalRequired('This transfer requires approval before it can proceed', {
      targetWorkflowId: input.targetWorkflowId
    });
  }

  const target = requireWorkflow(tx, actor.workspaceId, input.targetWorkflowId);
  if (target.archivedAt) {
    throw errors.precondition('The destination workflow is archived');
  }

  const requestedStateId =
    input.targetStateId ?? policy.rule?.defaultTargetStateId ?? target.defaultStateId;
  if (!requestedStateId) {
    throw errors.precondition('The destination workflow has no default state');
  }
  const toState = requireState(tx, actor.workspaceId, requestedStateId);
  if (toState.workflowId !== target.id) {
    throw errors.validation('The destination state does not belong to the destination workflow');
  }

  const mappings =
    input.fieldMappings ?? (policy.rule?.fieldMappings as Record<string, string> | null) ?? {};
  const sourceValues = fieldValuesByKey(tx, actor.workspaceId, ticket.id);
  const mappedValues: Record<string, unknown> = {};
  for (const [sourceKey, targetKey] of Object.entries(mappings)) {
    if (sourceValues[sourceKey] !== undefined) mappedValues[targetKey] = sourceValues[sourceKey];
  }

  // Shared workspace-level field definitions need no explicit mapping: if the key
  // is active in both workflows, the value travels with the ticket (plan §29).
  const targetFieldKeys = new Set(workflowFieldKeys(tx, actor.workspaceId, target.id));
  for (const key of workflowFieldKeys(tx, actor.workspaceId, ticket.workflowId)) {
    if (
      targetFieldKeys.has(key) &&
      sourceValues[key] !== undefined &&
      mappedValues[key] === undefined
    ) {
      mappedValues[key] = sourceValues[key];
    }
  }

  // Destination requirements are validated *before* any mutation, against the
  // values the ticket will hold after mapping. A failed transfer therefore cannot
  // leave partial state behind, even if a caller forgets to wrap it in a
  // transaction.
  const destinationRequired = requiredFieldsForState(tx, actor.workspaceId, target.id, toState.id);
  if (destinationRequired.length > 0) {
    const projected: Record<string, unknown> = { ...sourceValues, ...mappedValues };
    const missing = destinationRequired.filter((definition) => {
      const value = projected[definition.key];
      return (
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      );
    });
    if (missing.length > 0) {
      throw errors.precondition(
        `The destination requires: ${missing.map((definition) => definition.name).join(', ')}`,
        {
          fieldKeys: missing.map((definition) => definition.key),
          targetWorkflowId: target.id,
          targetStateId: toState.id
        }
      );
    }
  }

  const now = Date.now();
  const fromStateId = ticket.stateId;

  // Close the interval in the source workflow before opening the destination one.
  tx.update(ticketStateHistory)
    .set({ exitedAt: now, durationMs: now - ticket.enteredStateAt })
    .where(and(eq(ticketStateHistory.ticketId, ticket.id), isNull(ticketStateHistory.exitedAt)))
    .run();

  const moved = tx
    .update(tickets)
    .set({
      workflowId: target.id,
      stateId: toState.id,
      enteredStateAt: now,
      lastActivityAt: now,
      stateRunCount: 0,
      waitingOn: computeWaitingOn(toState),
      closedAt: null,
      version: sql`${tickets.version} + 1`,
      updatedAt: now
    })
    .where(eq(tickets.id, ticket.id))
    .returning()
    .all()[0];
  if (!moved) throw errors.internal('Failed to transfer ticket');

  tx.insert(ticketWorkflowHistory)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      fromWorkflowId: ticket.workflowId,
      fromStateId,
      toWorkflowId: target.id,
      toStateId: toState.id,
      reason: input.reason ?? null,
      fieldMappingsApplied: Object.keys(mappings).length > 0 ? (mappings as never) : null,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .run();

  tx.insert(ticketStateHistory)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      workflowId: target.id,
      stateId: toState.id,
      stateName: toState.name,
      stateKind: toState.kind,
      previousStateId: fromStateId,
      enteredAt: now,
      enteredByType: actor.actorType,
      enteredById: actor.actorId,
      enteredByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      reason: input.reason ?? 'Transferred between workflows'
    })
    .run();

  if (Object.keys(mappedValues).length > 0) {
    writeTicketFieldValues(tx, {
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      workflowId: target.id,
      values: mappedValues,
      actor,
      runId: input.runId ?? null,
      source: 'system',
      force: true
    });
  }

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketTransferred,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: ticket.id,
    ticketId: ticket.id,
    workflowId: target.id,
    runId: input.runId ?? actor.runId ?? null,
    summary: `Transferred ${ticket.key} to ${target.name} / ${toState.name}`,
    data: {
      fromWorkflowId: ticket.workflowId,
      toWorkflowId: target.id,
      fromStateId,
      toStateId: toState.id,
      reason: input.reason ?? null,
      mappedFields: mappings
    },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: actor.workspaceId,
      ticketId: ticket.id,
      runId: input.runId ?? null,
      type: RunEventTypes.stateTransition,
      data: {
        transfer: true,
        fromWorkflowId: ticket.workflowId,
        toWorkflowId: target.id,
        toStateId: toState.id,
        toStateName: toState.name
      }
    },
    now
  );

  enqueueDestinationStateWork(tx, {
    workspaceId: actor.workspaceId,
    ticket: moved,
    state: toState,
    actor,
    enteredAt: now
  });

  return {
    ticketId: ticket.id,
    fromWorkflowId: ticket.workflowId,
    fromStateId,
    toWorkflowId: target.id,
    toStateId: toState.id,
    mappedFields: mappings
  };
}

/** Field keys configured on a workflow. */
export function workflowFieldKeys(db: Executor, workspaceId: string, workflowId: string): string[] {
  const rows = db
    .select({ key: fieldDefinitions.key })
    .from(workflowFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowFields.fieldDefinitionId))
    .where(
      and(
        eq(workflowFields.workspaceId, workspaceId),
        eq(workflowFields.workflowId, workflowId),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .all();
  return rows.map((row) => row.key);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTicketDetail(
  db: Executor,
  actor: ActorContext,
  ticketId: string
): Promise<TicketDetail> {
  assertPermission(actor, Permissions.ticketRead);
  const ticket = requireTicketSync(db, actor.workspaceId, ticketId);
  const state = requireState(db, actor.workspaceId, ticket.stateId);
  const workflow = requireWorkflow(db, actor.workspaceId, ticket.workflowId);

  const noteRows = db
    .select()
    .from(ticketNotes)
    .where(
      and(
        eq(ticketNotes.workspaceId, actor.workspaceId),
        eq(ticketNotes.ticketId, ticketId),
        isNull(ticketNotes.deletedAt)
      )
    )
    .orderBy(ticketNotes.createdAt)
    .all();

  const labelRows = db
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(ticketLabels)
    .innerJoin(labels, eq(labels.id, ticketLabels.labelId))
    .where(eq(ticketLabels.ticketId, ticketId))
    .all();

  const relationshipRows = db
    .select()
    .from(ticketRelationships)
    .where(
      and(
        eq(ticketRelationships.workspaceId, actor.workspaceId),
        or(
          eq(ticketRelationships.fromTicketId, ticketId),
          eq(ticketRelationships.toTicketId, ticketId)
        )
      )
    )
    .all();

  const relatedIds = relationshipRows.map((row) =>
    row.fromTicketId === ticketId ? row.toTicketId : row.fromTicketId
  );
  const relatedRows = relatedIds.length
    ? db
        .select({
          id: tickets.id,
          key: tickets.key,
          title: tickets.title,
          stateId: tickets.stateId,
          stateName: workflowStates.name
        })
        .from(tickets)
        .leftJoin(workflowStates, eq(workflowStates.id, tickets.stateId))
        .where(inArray(tickets.id, relatedIds))
        .all()
    : [];
  const relatedById = new Map(relatedRows.map((row) => [row.id, row]));

  const fileRows = db
    .select({
      id: files.id,
      filename: files.originalFilename,
      mimeType: files.mimeType,
      size: files.size,
      status: files.status,
      relationship: ticketFiles.relationship
    })
    .from(ticketFiles)
    .innerJoin(files, eq(files.id, ticketFiles.fileId))
    .where(and(eq(ticketFiles.ticketId, ticketId), isNull(ticketFiles.removedAt)))
    .all();

  const runRows = db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, actor.workspaceId), eq(agentRuns.ticketId, ticketId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(20)
    .all();

  const approvalRows = db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.workspaceId, actor.workspaceId),
        eq(approvalRequests.ticketId, ticketId)
      )
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(20)
    .all();

  const gate = humanGateOf(state);
  const outgoing = db
    .select({ transition: workflowTransitions, toState: workflowStates })
    .from(workflowTransitions)
    .innerJoin(workflowStates, eq(workflowStates.id, workflowTransitions.toStateId))
    .where(
      and(
        eq(workflowTransitions.workspaceId, actor.workspaceId),
        eq(workflowTransitions.workflowId, ticket.workflowId),
        sql`(${workflowTransitions.fromStateId} = ${ticket.stateId} OR ${workflowTransitions.fromStateId} IS NULL)`
      )
    )
    .all();

  const availableTransitions = outgoing.map(({ transition, toState }) => {
    const allowedRoles = transition.allowedRoles as string[] | null;
    const roleOk = !allowedRoles || allowedRoles.length === 0 || allowedRoles.includes(actor.role);
    const gateOk = !gate?.allowedTransitionIds || gate.allowedTransitionIds.includes(transition.id);
    const allowed = roleOk && gateOk;
    return {
      id: transition.id,
      name: transition.name,
      toStateId: toState.id,
      toStateName: toState.name,
      requiresComment: transition.requiresComment,
      requiredFieldKeys: (transition.requiredFieldKeys as string[] | null) ?? [],
      allowed,
      reason: allowed
        ? undefined
        : !roleOk
          ? 'Your role is not permitted to use this transition'
          : 'This transition is not available at the current human gate'
    };
  });

  const stateEntryRows = db
    .select({ count: sql<number>`count(*)` })
    .from(ticketStateHistory)
    .where(eq(ticketStateHistory.ticketId, ticketId))
    .all();
  const transferRows = db
    .select({ count: sql<number>`count(*)` })
    .from(ticketWorkflowHistory)
    .where(eq(ticketWorkflowHistory.ticketId, ticketId))
    .all();
  const decisionRows = db
    .select()
    .from(humanGateDecisions)
    .where(eq(humanGateDecisions.ticketId, ticketId))
    .orderBy(desc(humanGateDecisions.createdAt))
    .limit(10)
    .all();

  return {
    ticket,
    key: ticket.key,
    state,
    workflow: { id: workflow.id, name: workflow.name, key: workflow.key },
    fields: fieldValuesByKey(db, actor.workspaceId, ticketId),
    labels: labelRows,
    notes: noteRows.map((note) => ({
      id: note.id,
      authorType: note.authorType,
      authorId: note.authorId,
      authorLabel: note.authorLabel,
      body: note.body,
      isSystem: note.isSystem,
      createdAt: note.createdAt,
      editedAt: note.editedAt
    })),
    relationships: relationshipRows.map((row) => {
      const outgoingRelation = row.fromTicketId === ticketId;
      const otherId = outgoingRelation ? row.toTicketId : row.fromTicketId;
      const other = relatedById.get(otherId);
      return {
        id: row.id,
        // Reading from the other side returns the inverse type, which is what the UI
        // needs to say "parent of this ticket" without a second stored row.
        type: outgoingRelation ? row.type : INVERSE_RELATIONSHIP[row.type],
        direction: outgoingRelation ? ('outgoing' as const) : ('incoming' as const),
        ticket: {
          id: otherId,
          key: other?.key ?? '—',
          title: other?.title ?? 'Unknown ticket',
          stateId: other?.stateId ?? '',
          stateName: other?.stateName ?? null
        },
        createdAt: row.createdAt
      };
    }),
    files: fileRows,
    runs: runRows.map((run) => ({
      id: run.id,
      status: run.status,
      agentId: run.agentId,
      modelKey: run.modelKey,
      attempt: run.attempt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      error: run.error
    })),
    approvals: approvalRows.map((approval) => ({
      id: approval.id,
      kind: approval.kind,
      title: approval.title,
      status: approval.status,
      createdAt: approval.createdAt,
      decidedAt: approval.decidedAt
    })),
    availableTransitions,
    humanGate: gate,
    gateDecisions: decisionRows.map((decision) => ({
      id: decision.id,
      outcome: decision.outcome,
      comment: decision.comment,
      decidedByLabel: decision.decidedByLabel,
      createdAt: decision.createdAt
    })),
    historySummary: {
      created: ticket.createdAt,
      lastActivityAt: ticket.lastActivityAt,
      stateEntries: stateEntryRows[0]?.count ?? 0,
      transfers: transferRows[0]?.count ?? 0
    }
  };
}

export interface TicketSearchOptions {
  workflowId?: string | null;
  /** Restrict to specific states (used by the board's per-column query). */
  stateIds?: string[];
  filter?: FilterAst | null;
  sort?: TicketSort[];
  limit?: number;
  cursor?: string | null;
  search?: string | null;
}

export async function searchTickets(
  db: Executor,
  actor: ActorContext,
  options: TicketSearchOptions
): Promise<{ rows: TicketListRow[]; nextCursor: string | null; total: number }> {
  assertPermission(actor, Permissions.ticketRead);
  return listTickets(db, { ...options, workspaceId: actor.workspaceId });
}

export interface MyWorkView {
  assigned: TicketListRow[];
  waitingForMe: TicketListRow[];
  waitingForAgent: TicketListRow[];
  waitingForApproval: TicketListRow[];
  needsAttention: TicketListRow[];
  createdByMe: TicketListRow[];
}

/**
 * The "My Work" surface. Each bucket is a real query over persisted state, so the
 * counts can never drift from what the board and ticket drawer show.
 */
export async function myWork(
  db: Executor,
  actor: ActorContext,
  options: { limit?: number } = {}
): Promise<MyWorkView> {
  assertPermission(actor, Permissions.ticketRead);
  const workspaceId = actor.workspaceId;
  const limit = options.limit ?? 50;
  const base = { workspaceId, limit };

  const assigned = actor.actorId
    ? await listTickets(db, {
        ...base,
        filter: {
          type: 'condition',
          kind: 'owner',
          key: 'ownerUserId',
          operator: 'eq',
          value: actor.actorId
        }
      })
    : { rows: [], total: 0, nextCursor: null };

  const waitingForMe = await listTickets(db, {
    ...base,
    filter: { type: 'condition', kind: 'system', key: 'waitingOn', operator: 'eq', value: 'human' }
  });

  const waitingForAgent = await listTickets(db, {
    ...base,
    filter: { type: 'condition', kind: 'system', key: 'waitingOn', operator: 'eq', value: 'agent' }
  });

  const waitingForApproval = await listTickets(db, {
    ...base,
    filter: { type: 'condition', kind: 'approval', key: 'status', operator: 'eq', value: 'pending' }
  });

  const needsAttention = await listTickets(db, {
    ...base,
    filter: {
      type: 'group',
      op: 'or',
      children: [
        { type: 'condition', kind: 'run', key: 'status', operator: 'eq', value: 'failed' },
        { type: 'condition', kind: 'system', key: 'waitingOn', operator: 'eq', value: 'trigger' }
      ]
    }
  });

  const createdByMe = actor.actorId
    ? await listTickets(db, {
        ...base,
        filter: {
          type: 'condition',
          kind: 'system',
          key: 'key',
          operator: 'is_not_empty'
        }
      })
    : { rows: [], total: 0, nextCursor: null };

  return {
    assigned: assigned.rows,
    waitingForMe: waitingForMe.rows,
    waitingForAgent: waitingForAgent.rows,
    waitingForApproval: waitingForApproval.rows,
    needsAttention: needsAttention.rows,
    createdByMe: createdByMe.rows
  };
}

export type TimelineFilter = 'all' | 'human' | 'agents' | 'fields' | 'states' | 'tools' | 'files';

export async function ticketTimeline(
  db: Executor,
  actor: ActorContext,
  ticketId: string,
  options: { limit?: number; cursor?: number; filter?: TimelineFilter } = {}
) {
  assertPermission(actor, Permissions.ticketRead);
  requireTicketSync(db, actor.workspaceId, ticketId);
  const events = await queryAudit(db, {
    workspaceId: actor.workspaceId,
    ticketId,
    limit: options.limit ?? 200,
    cursor: options.cursor,
    order: 'desc'
  });
  const filter = options.filter ?? 'all';
  return filter === 'all'
    ? events
    : events.filter((event) => matchesTimelineFilter(event.action, filter));
}

export function matchesTimelineFilter(action: string, filter: TimelineFilter): boolean {
  switch (filter) {
    case 'human':
      return (
        action.startsWith('ticket.') ||
        action.startsWith('approval.') ||
        action.startsWith('workspace.')
      );
    case 'agents':
      return action.startsWith('agent.') || action.startsWith('job.');
    case 'fields':
      return action.startsWith('ticket.field') || action.startsWith('file.field');
    case 'states':
      return action.startsWith('ticket.state') || action.startsWith('ticket.transferred');
    case 'tools':
      return action.startsWith('tool.') || action.startsWith('http.');
    case 'files':
      return action.startsWith('file.');
    default:
      return true;
  }
}

export async function ticketFieldChanges(db: Executor, actor: ActorContext, ticketId: string) {
  assertPermission(actor, Permissions.ticketRead);
  return ticketFieldHistory(db, actor.workspaceId, ticketId);
}

// ---------------------------------------------------------------------------
// Service installation
// ---------------------------------------------------------------------------

export function installTicketService(dbFactory: () => Executor = getDb): TicketService {
  const resolveDb = dbFactory;
  const service: TicketService = {
    async create(actor, input, db) {
      if (db) return createTicketSync(db, actor, input);
      return withTransaction(resolveDb(), (tx) => createTicketSync(tx as Executor, actor, input));
    },
    async requireTicket(actor, ticketId, db) {
      return toSummary(requireTicketSync(db ?? resolveDb(), actor.workspaceId, ticketId));
    },
    async addNote(actor, input, db) {
      const run = (tx: Executor) => addNoteSync(tx, actor, input);
      if (db) return { noteId: run(db).id };
      const note = await withTransaction(resolveDb(), (tx) => run(tx as Executor));
      return { noteId: note.id };
    },
    async setFields(actor, input, db) {
      const run = (tx: Executor) => {
        const ticket = requireTicketSync(tx, actor.workspaceId, input.ticketId);
        const changed = writeTicketFieldValues(tx, {
          workspaceId: actor.workspaceId,
          ticketId: ticket.id,
          workflowId: ticket.workflowId,
          values: input.values,
          actor,
          runId: input.runId ?? null,
          source: input.source,
          force: input.force
        });
        touchTicketSync(tx, ticket.id, {});
        return { changed };
      };
      if (db) return run(db);
      return withTransaction(resolveDb(), (tx) => run(tx as Executor));
    },
    async requestTransition(actor, ticketId, request, db) {
      const run = (tx: Executor) =>
        requestTransitionSync(tx, actor, {
          ticketId,
          transitionId: request.transitionId ?? null,
          targetStateId: request.targetStateId ?? null,
          comment: request.comment ?? null,
          runId: request.runId ?? null,
          viaRun: true
        });
      if (db) return run(db);
      return withTransaction(resolveDb(), (tx) => run(tx as Executor));
    },
    async transfer(actor, ticketId, input, db) {
      const run = (tx: Executor) => {
        const result = transferTicketSync(tx, actor, {
          ticketId,
          targetWorkflowId: input.targetWorkflowId,
          targetStateId: input.targetStateId ?? null,
          fieldMappings: input.fieldMappings,
          reason: input.reason ?? null,
          runId: input.runId ?? null
        });
        return {
          ticketId: result.ticketId,
          workflowId: result.toWorkflowId,
          stateId: result.toStateId
        };
      };
      if (db) return run(db);
      return withTransaction(resolveDb(), (tx) => run(tx as Executor));
    },
    async attachFile(actor, input, db) {
      const run = (tx: Executor) => attachFileSync(tx, actor, input);
      if (db) {
        run(db);
        return;
      }
      await withTransaction(resolveDb(), (tx) => run(tx as Executor));
    },
    async linkRelationship(actor, input, db) {
      const run = (tx: Executor) => linkRelationshipSync(tx, actor, input);
      if (db) {
        run(db);
        return;
      }
      await withTransaction(resolveDb(), (tx) => run(tx as Executor));
    },
    async setWaitingOn(actor, ticketId, waitingOn, db) {
      const run = (tx: Executor) => setWaitingOnSync(tx, actor, ticketId, waitingOn);
      if (db) {
        run(db);
        return;
      }
      await withTransaction(resolveDb(), (tx) => run(tx as Executor));
    }
  };
  setTicketService(service);
  return service;
}
