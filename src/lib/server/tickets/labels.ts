/**
 * Label management.
 *
 * Labels are workspace-scoped vocabulary that tickets share. Creation is
 * idempotent by name (the unique index does the work), which is what lets a
 * trigger or an agent ask for `urgent` without first checking whether it exists.
 */
import { and, asc, eq } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import { type Label, labels, ticketLabels, tickets } from '../db/schema';
import { addLabelsSync, removeLabelSync, requireTicketSync } from './service';

export interface CreateLabelInput {
  name: string;
  color?: string | null;
  description?: string | null;
}

export function createLabel(db: Executor, actor: ActorContext, input: CreateLabelInput): Label {
  assertPermission(actor, Permissions.ticketWrite, 'Not permitted to create labels');
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Label name is required');
  if (name.length > 60) throw errors.validation('Label name must be at most 60 characters');

  const existing = db
    .select()
    .from(labels)
    .where(and(eq(labels.workspaceId, actor.workspaceId), eq(labels.name, name)))
    .limit(1)
    .all()[0];
  if (existing) return existing;

  const now = Date.now();
  const inserted = db
    .insert(labels)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      name,
      color: input.color ?? null,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.conflict(`A label named "${name}" already exists`);

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.ticketLabelAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'label',
    entityId: inserted.id,
    summary: `Label ${name} created`
  });

  return inserted;
}

export function listLabels(
  db: Executor,
  actor: ActorContext
): Array<Label & { ticketCount: number }> {
  assertPermission(actor, Permissions.ticketRead);
  const rows = db
    .select()
    .from(labels)
    .where(eq(labels.workspaceId, actor.workspaceId))
    .orderBy(asc(labels.name))
    .all();

  const usage = db
    .select({ labelId: ticketLabels.labelId, ticketId: ticketLabels.ticketId })
    .from(ticketLabels)
    .where(eq(ticketLabels.workspaceId, actor.workspaceId))
    .all();
  const counts = new Map<string, number>();
  for (const row of usage) {
    counts.set(row.labelId, (counts.get(row.labelId) ?? 0) + 1);
  }
  return rows.map((label) => ({ ...label, ticketCount: counts.get(label.id) ?? 0 }));
}

export function addLabelsToTicket(
  db: Executor,
  actor: ActorContext,
  ticketId: string,
  input: { labelIds?: string[]; labelNames?: string[] }
): void {
  const ticket = requireTicketSync(db, actor.workspaceId, ticketId);
  addLabelsSync(db, actor, ticket, input);
}

export function removeLabelFromTicket(
  db: Executor,
  actor: ActorContext,
  ticketId: string,
  labelId: string
): void {
  removeLabelSync(db, actor, ticketId, labelId);
}

/** Tickets carrying a label, for the label drill-down. */
export function ticketsWithLabel(db: Executor, workspaceId: string, labelId: string): string[] {
  return db
    .select({ ticketId: ticketLabels.ticketId })
    .from(ticketLabels)
    .innerJoin(tickets, eq(tickets.id, ticketLabels.ticketId))
    .where(and(eq(ticketLabels.workspaceId, workspaceId), eq(ticketLabels.labelId, labelId)))
    .all()
    .map((row) => row.ticketId);
}
