/**
 * Tickets, their journal and their immutable history.
 *
 * A ticket is the central work object. It carries a native system-field surface
 * (title, description, state, priority, ownership) plus typed custom field values,
 * notes, artifacts and a coherent chronological history that survives
 * cross-workflow transfers (ADR-0011, ADR-0013).
 *
 * Two history tables are deliberate:
 *  - `ticket_state_history` records *intervals* (enteredAt/exitedAt) which is what
 *    time-in-state, throughput and funnel analytics actually need;
 *  - `ticket_workflow_history` records workflow moves so lineage is never inferred.
 */
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import type { ActorType } from './fields';
import { users, workspaces } from './tenancy';
import { workflows } from './workflows';

export type TicketPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface TicketProvenance {
  sourceType?: string;
  sourceReference?: string;
  sourceLabel?: string;
  triggerId?: string;
  triggerEventId?: string;
  externalRef?: string;
  ingestedAt?: number;
}

export const tickets = sqliteTable(
  'tickets',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'restrict' }),
    stateId: text('state_id').notNull(),
    /** Human-facing key, e.g. `CLAIM-42`; stable for the lifetime of the ticket. */
    key: text('key').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    priority: text('priority').$type<TicketPriority>().notNull().default('none'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    ownerTeamId: text('owner_team_id'),
    /** Free-form document payload for values without a field definition. */
    structuredData: json<Record<string, unknown>>('structured_data'),
    /** Optimistic-concurrency guard: every mutation increments this. */
    version: integer('version').notNull().default(1),
    /** Ticket this one originated from (agent decomposition / intake). */
    originTicketId: text('origin_ticket_id').references((): AnySQLiteColumn => tickets.id, {
      onDelete: 'set null'
    }),
    createdByType: text('created_by_type').$type<ActorType>().notNull().default('user'),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    provenance: json<TicketProvenance>('provenance'),
    enteredStateAt: epochMs('entered_state_at').notNull(),
    lastActivityAt: epochMs('last_activity_at').notNull(),
    dueAt: epochMs('due_at'),
    slaDueAt: epochMs('sla_due_at'),
    closedAt: epochMs('closed_at'),
    /** Number of automatic executions that have run against the current entry. */
    stateRunCount: integer('state_run_count').notNull().default(0),
    waitingOn: text('waiting_on').$type<'human' | 'agent' | 'approval' | 'trigger' | 'none'>(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('tickets_key_unique').on(table.workspaceId, table.key),
    uniqueIndex('tickets_number_unique').on(table.workspaceId, table.number),
    index('tickets_board_idx').on(table.workspaceId, table.workflowId, table.stateId),
    index('tickets_owner_idx').on(table.workspaceId, table.ownerUserId),
    index('tickets_state_entered_idx').on(table.workspaceId, table.stateId, table.enteredStateAt),
    index('tickets_updated_idx').on(table.workspaceId, table.updatedAt),
    index('tickets_waiting_idx').on(table.workspaceId, table.waitingOn)
  ]
);

export const ticketLabels = sqliteTable(
  'ticket_labels',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    labelId: text('label_id').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('ticket_labels_unique').on(table.ticketId, table.labelId),
    index('ticket_labels_label_idx').on(table.workspaceId, table.labelId)
  ]
);

export const ticketNotes = sqliteTable(
  'ticket_notes',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorType: text('author_type').$type<ActorType>().notNull(),
    authorId: text('author_id'),
    authorLabel: text('author_label'),
    body: text('body').notNull(),
    /** Marks machine-generated journal entries (agent summaries, ingest notes). */
    isSystem: bool('is_system'),
    runId: text('run_id'),
    createdAt: createdAt(),
    editedAt: epochMs('edited_at'),
    editedByType: text('edited_by_type').$type<ActorType>(),
    editedById: text('edited_by_id'),
    deletedAt: epochMs('deleted_at')
  },
  (table) => [
    index('ticket_notes_ticket_idx').on(table.workspaceId, table.ticketId, table.createdAt)
  ]
);

export const ticketNoteRevisions = sqliteTable(
  'ticket_note_revisions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id').notNull(),
    noteId: text('note_id')
      .notNull()
      .references(() => ticketNotes.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    editedByType: text('edited_by_type').$type<ActorType>(),
    editedById: text('edited_by_id'),
    createdAt: createdAt()
  },
  (table) => [index('ticket_note_revisions_note_idx').on(table.noteId, table.createdAt)]
);

export type TicketRelationshipType =
  | 'parent'
  | 'child'
  | 'related'
  | 'duplicate'
  | 'blocks'
  | 'blocked_by';

/**
 * First-class ticket relationships. `child`/`parent` are stored from the child's
 * perspective with the inverse row implied, so decomposition is queryable in both
 * directions without recursion.
 */
export const ticketRelationships = sqliteTable(
  'ticket_relationships',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromTicketId: text('from_ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    toTicketId: text('to_ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    type: text('type').$type<TicketRelationshipType>().notNull(),
    note: text('note'),
    createdByType: text('created_by_type').$type<ActorType>().notNull(),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    runId: text('run_id'),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('ticket_relationships_unique').on(table.fromTicketId, table.toTicketId, table.type),
    index('ticket_relationships_from_idx').on(table.workspaceId, table.fromTicketId),
    index('ticket_relationships_to_idx').on(table.workspaceId, table.toTicketId)
  ]
);

export const ticketStateHistory = sqliteTable(
  'ticket_state_history',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    stateId: text('state_id').notNull(),
    stateName: text('state_name').notNull(),
    stateKind: text('state_kind').notNull(),
    previousStateId: text('previous_state_id'),
    enteredAt: integer('entered_at').notNull(),
    exitedAt: integer('exited_at'),
    durationMs: integer('duration_ms'),
    enteredByType: text('entered_by_type').$type<ActorType>().notNull(),
    enteredById: text('entered_by_id'),
    enteredByLabel: text('entered_by_label'),
    runId: text('run_id'),
    transitionId: text('transition_id'),
    reason: text('reason')
  },
  (table) => [
    index('ticket_state_history_ticket_idx').on(table.workspaceId, table.ticketId, table.enteredAt),
    index('ticket_state_history_state_idx').on(table.workspaceId, table.stateId, table.enteredAt),
    index('ticket_state_history_open_idx').on(table.ticketId, table.exitedAt)
  ]
);

export const ticketWorkflowHistory = sqliteTable(
  'ticket_workflow_history',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    fromWorkflowId: text('from_workflow_id'),
    fromStateId: text('from_state_id'),
    toWorkflowId: text('to_workflow_id').notNull(),
    toStateId: text('to_state_id').notNull(),
    reason: text('reason'),
    fieldMappingsApplied: json<Record<string, string>>('field_mappings_applied'),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    runId: text('run_id'),
    approvalRequestId: text('approval_request_id'),
    createdAt: createdAt()
  },
  (table) => [
    index('ticket_workflow_history_ticket_idx').on(
      table.workspaceId,
      table.ticketId,
      table.createdAt
    )
  ]
);

/**
 * Explicit human-gate decisions. A gate is *not* an approval: it stops automatic
 * progression and requires a permitted human to choose an allowed outgoing
 * transition. Recording the decision separately keeps the audit trail unambiguous
 * about who decided what, and why.
 */
export const humanGateDecisions = sqliteTable(
  'human_gate_decisions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    stateId: text('state_id').notNull(),
    transitionId: text('transition_id').notNull(),
    toStateId: text('to_state_id').notNull(),
    outcome: text('outcome').$type<'approved' | 'rework' | 'rejected' | 'custom'>().notNull(),
    comment: text('comment'),
    decidedByUserId: text('decided_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedByLabel: text('decided_by_label'),
    createdAt: createdAt()
  },
  (table) => [
    index('human_gate_decisions_ticket_idx').on(table.workspaceId, table.ticketId, table.createdAt)
  ]
);

export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type TicketNote = typeof ticketNotes.$inferSelect;
export type TicketRelationship = typeof ticketRelationships.$inferSelect;
export type TicketStateHistoryRow = typeof ticketStateHistory.$inferSelect;
export type TicketWorkflowHistoryRow = typeof ticketWorkflowHistory.$inferSelect;
export type HumanGateDecision = typeof humanGateDecisions.$inferSelect;
export type TicketLabel = typeof ticketLabels.$inferSelect;
