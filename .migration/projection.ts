/**
 * Ticket → universal projection (ADR-0021 migration bridge).
 *
 * The mature Ticket tables remain the compatibility surface for the board, list,
 * analytics and agent execution. Every ticket write is projected into the
 * canonical `records` + `workflow_items` model so the universal API, agent tools
 * and future UI see the same work.
 *
 * This is deliberately one-way (Ticket → universal) and idempotent. Once the
 * ticket surfaces are migrated onto the universal services, the projection and the
 * bridge columns are removed; there is never a second source of truth for a
 * non-Ticket Object Type.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { systemActor } from '../core/context';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  fileRecords,
  fileWorkflowItems,
  records,
  ticketFiles,
  ticketNotes,
  ticketRelationships,
  ticketStateHistory,
  tickets,
  workflowItemNotes,
  workflowItemRelationships,
  workflowItemStateHistory,
  workflowItems,
  workspaces
} from '../db/schema';
import { ticketObjectType } from './object-types';
import { writeRecordFieldValues } from './values';

export interface TicketProjection {
  recordId: string;
  workflowItemId: string;
}

/**
 * Create or refresh the Record + WorkflowItem backing a ticket. Safe to call after
 * any ticket mutation; it reads current ticket state and converges the projection.
 */
export function syncTicketProjectionSync(
  tx: Executor,
  workspaceId: string,
  ticketId: string
): TicketProjection | null {
  const ticket = tx
    .select()
    .from(tickets)
    .where(and(eq(tickets.workspaceId, workspaceId), eq(tickets.id, ticketId)))
    .all()[0];
  if (!ticket) return null;
  const objectType = ticketObjectType(tx, workspaceId);
  const now = Date.now();
  const actor = systemActor(workspaceId, 'ticket-projection');
  const completedAt = ticket.closedAt ?? null;

  const recordId = ticket.recordId ?? uuidv7(now);
  if (!ticket.recordId) {
    tx.insert(records)
      .values({
        id: recordId,
        workspaceId,
        objectTypeId: objectType.id,
        displayName: ticket.title,
        key: ticket.key,
        number: ticket.number,
        version: ticket.version,
        createdByType: ticket.createdByType,
        createdById: ticket.createdById,
        createdByLabel: ticket.createdByLabel,
        provenance: (ticket.provenance as never) ?? null,
        structuredData: (ticket.structuredData as never) ?? null,
        lastActivityAt: ticket.lastActivityAt,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt
      })
      .onConflictDoNothing()
      .run();
  } else {
    tx.update(records)
      .set({
        displayName: ticket.title,
        key: ticket.key,
        number: ticket.number,
        version: ticket.version,
        provenance: (ticket.provenance as never) ?? null,
        structuredData: (ticket.structuredData as never) ?? null,
        lastActivityAt: ticket.lastActivityAt,
        updatedAt: ticket.updatedAt
      })
      .where(eq(records.id, recordId))
      .run();
  }
  writeRecordFieldValues(tx, {
    workspaceId,
    recordId,
    objectTypeId: objectType.id,
    values: {
      title: ticket.title,
      description: ticket.description ?? null,
      priority: ticket.priority
    },
    actor,
    source: 'system',
    audit: false
  });

  const workflowItemId = ticket.workflowItemId ?? uuidv7(now);
  if (!ticket.workflowItemId) {
    tx.insert(workflowItems)
      .values({
        id: workflowItemId,
        workspaceId,
        workflowId: ticket.workflowId,
        recordId,
        stateId: ticket.stateId,
        ownerUserId: ticket.ownerUserId,
        ownerTeamId: ticket.ownerTeamId,
        version: ticket.version,
        structuredData: (ticket.structuredData as never) ?? null,
        participation: 'primary',
        createdByType: ticket.createdByType,
        createdById: ticket.createdById,
        createdByLabel: ticket.createdByLabel,
        provenance: (ticket.provenance as never) ?? null,
        enteredStateAt: ticket.enteredStateAt,
        lastActivityAt: ticket.lastActivityAt,
        dueAt: ticket.dueAt,
        slaDueAt: ticket.slaDueAt,
        closedAt: ticket.closedAt,
        completedAt,
        stateRunCount: ticket.stateRunCount,
        waitingOn: ticket.waitingOn,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt
      })
      .onConflictDoNothing()
      .run();
  } else {
    tx.update(workflowItems)
      .set({
        workflowId: ticket.workflowId,
        recordId,
        stateId: ticket.stateId,
        ownerUserId: ticket.ownerUserId,
        ownerTeamId: ticket.ownerTeamId,
        version: ticket.version,
        enteredStateAt: ticket.enteredStateAt,
        lastActivityAt: ticket.lastActivityAt,
        dueAt: ticket.dueAt,
        slaDueAt: ticket.slaDueAt,
        closedAt: ticket.closedAt,
        completedAt,
        stateRunCount: ticket.stateRunCount,
        waitingOn: ticket.waitingOn,
        updatedAt: ticket.updatedAt
      })
      .where(eq(workflowItems.id, workflowItemId))
      .run();
  }

  if (ticket.recordId !== recordId || ticket.workflowItemId !== workflowItemId) {
    tx.update(tickets).set({ recordId, workflowItemId }).where(eq(tickets.id, ticket.id)).run();
  }
  return { recordId, workflowItemId };
}

/**
 * Idempotent backfill of the universal model from existing ticket data. Runs once
 * from `runMigrations`; safe to re-run because each family is only copied when the
 * destination has no rows for that item.
 */
export function runUniversalBackfillSync(db: Executor): void {
  // Every workspace gets its system Object Types, even before it has any tickets.
  const allWorkspaces = db.select({ id: workspaces.id }).from(workspaces).all();
  for (const workspace of allWorkspaces) {
    ticketObjectType(db, workspace.id);
  }

  const pending = db
    .select({ id: tickets.id, workspaceId: tickets.workspaceId })
    .from(tickets)
    .where(isNull(tickets.recordId))
    .all();
  for (const ticket of pending) {
    syncTicketProjectionSync(db, ticket.workspaceId, ticket.id);
    const item = db
      .select({ id: tickets.workflowItemId, recordId: tickets.recordId })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .all()[0];
    if (!item?.id || !item.recordId) continue;
    backfillHistorySync(db, ticket.workspaceId, ticket.id, item.id);
    backfillNotesSync(db, ticket.workspaceId, ticket.id, item.id);
    backfillRelationshipsSync(db, ticket.workspaceId, ticket.id, item.id);
    backfillFilesSync(db, ticket.workspaceId, ticket.id, item.recordId, item.id);
  }
}

function backfillHistorySync(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  workflowItemId: string
): void {
  const existing = db
    .select({ id: workflowItemStateHistory.id })
    .from(workflowItemStateHistory)
    .where(eq(workflowItemStateHistory.workflowItemId, workflowItemId))
    .all();
  if (existing.length > 0) return;
  const intervals = db
    .select()
    .from(ticketStateHistory)
    .where(eq(ticketStateHistory.ticketId, ticketId))
    .orderBy(asc(ticketStateHistory.enteredAt))
    .all();
  for (const interval of intervals) {
    db.insert(workflowItemStateHistory)
      .values({
        id: uuidv7(interval.enteredAt),
        workspaceId,
        workflowItemId,
        workflowId: interval.workflowId,
        stateId: interval.stateId,
        stateName: interval.stateName,
        stateKind: interval.stateKind,
        previousStateId: interval.previousStateId,
        enteredAt: interval.enteredAt,
        exitedAt: interval.exitedAt,
        durationMs: interval.durationMs,
        enteredByType: interval.enteredByType,
        enteredById: interval.enteredById,
        enteredByLabel: interval.enteredByLabel,
        runId: interval.runId,
        transitionId: interval.transitionId,
        reason: interval.reason
      })
      .onConflictDoNothing()
      .run();
  }
}

function backfillNotesSync(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  workflowItemId: string
): void {
  const existing = db
    .select({ id: workflowItemNotes.id })
    .from(workflowItemNotes)
    .where(eq(workflowItemNotes.workflowItemId, workflowItemId))
    .all();
  if (existing.length > 0) return;
  const notes = db.select().from(ticketNotes).where(eq(ticketNotes.ticketId, ticketId)).all();
  for (const note of notes) {
    db.insert(workflowItemNotes)
      .values({
        id: note.id,
        workspaceId,
        workflowItemId,
        authorType: note.authorType,
        authorId: note.authorId,
        authorLabel: note.authorLabel,
        body: note.body,
        isSystem: note.isSystem,
        runId: note.runId,
        createdAt: note.createdAt,
        editedAt: note.editedAt,
        editedByType: note.editedByType,
        editedById: note.editedById,
        deletedAt: note.deletedAt
      })
      .onConflictDoNothing()
      .run();
  }
}

function backfillRelationshipsSync(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  workflowItemId: string
): void {
  const existing = db
    .select({ id: workflowItemRelationships.id })
    .from(workflowItemRelationships)
    .where(eq(workflowItemRelationships.fromWorkflowItemId, workflowItemId))
    .all();
  if (existing.length > 0) return;
  const relationships = db
    .select()
    .from(ticketRelationships)
    .where(eq(ticketRelationships.fromTicketId, ticketId))
    .all();
  for (const relationship of relationships) {
    const counterpart = db
      .select({ workflowItemId: tickets.workflowItemId })
      .from(tickets)
      .where(eq(tickets.id, relationship.toTicketId))
      .all()[0]?.workflowItemId;
    if (!counterpart) continue;
    db.insert(workflowItemRelationships)
      .values({
        id: relationship.id,
        workspaceId,
        fromWorkflowItemId: workflowItemId,
        toWorkflowItemId: counterpart,
        type: relationship.type,
        note: relationship.note,
        createdByType: relationship.createdByType,
        createdById: relationship.createdById,
        createdByLabel: relationship.createdByLabel,
        runId: relationship.runId,
        createdAt: relationship.createdAt
      })
      .onConflictDoNothing()
      .run();
  }
}

function backfillFilesSync(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  recordId: string,
  workflowItemId: string
): void {
  const links = db
    .select()
    .from(ticketFiles)
    .where(and(eq(ticketFiles.ticketId, ticketId), isNull(ticketFiles.removedAt)))
    .all();
  for (const link of links) {
    db.insert(fileRecords)
      .values({
        id: uuidv7(link.createdAt),
        workspaceId,
        fileId: link.fileId,
        recordId,
        relationship: link.relationship,
        caption: link.caption,
        addedByType: link.addedByType,
        addedById: link.addedById,
        addedByLabel: link.addedByLabel,
        runId: link.runId,
        createdAt: link.createdAt
      })
      .onConflictDoNothing()
      .run();
    db.insert(fileWorkflowItems)
      .values({
        id: uuidv7(link.createdAt + 1),
        workspaceId,
        fileId: link.fileId,
        workflowItemId,
        relationship: link.relationship,
        caption: link.caption,
        addedByType: link.addedByType,
        addedById: link.addedById,
        addedByLabel: link.addedByLabel,
        runId: link.runId,
        createdAt: link.createdAt
      })
      .onConflictDoNothing()
      .run();
  }
}
