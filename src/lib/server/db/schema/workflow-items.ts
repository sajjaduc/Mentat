/**
 * Workflow items: a Record's participation in one Workflow.
 *
 * A WorkflowItem owns everything contextual about *doing work*: the current
 * state, ownership, execution metadata, workflow-overlay field values, work
 * notes, work relationships and history. It never owns durable identity — that
 * lives on the Record (ADR-0021).
 *
 * Multiple WorkflowItems may point at the same Record simultaneously, which is
 * how a Policy can be in a Policy Lifecycle and a Renewal Workflow at once.
 * Transfer and add-participation are distinct operations with distinct history.
 */
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { type ActorType, fieldDefinitions } from './fields';
import { records } from './records';
import { users, workspaces } from './tenancy';
import { workflows } from './workflows';

/** Work dependencies, kept deliberately separate from Record relationships. */
export type WorkRelationshipType =
  | 'parent'
  | 'child'
  | 'related'
  | 'duplicate'
  | 'blocks'
  | 'blocked_by';

export const WORK_INVERSE_RELATIONSHIP: Record<WorkRelationshipType, WorkRelationshipType> = {
  parent: 'child',
  child: 'parent',
  related: 'related',
  duplicate: 'duplicate',
  blocks: 'blocked_by',
  blocked_by: 'blocks'
};

export type WorkflowItemWait = 'human' | 'agent' | 'approval' | 'trigger' | 'none';

/**
 * How this item relates to the Record's other participations.
 *  - `primary`       first/ongoing participation (e.g. lifecycle);
 *  - `additional`    explicitly added alongside existing work;
 *  - `transferred`   created by moving work out of another item.
 */
export type ParticipationKind = 'primary' | 'additional' | 'transferred';

export interface WorkflowItemProvenance {
  sourceType?: string;
  sourceReference?: string;
  sourceLabel?: string;
  triggerId?: string;
  triggerEventId?: string;
  externalRef?: string;
  ingestedAt?: number;
}

export const workflowItems = sqliteTable(
  'workflow_items',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'restrict' }),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    stateId: text('state_id').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    ownerTeamId: text('owner_team_id'),
    /** Optimistic-concurrency guard: every mutation increments this. */
    version: integer('version').notNull().default(1),
    /** Workflow-context values with no field definition. Mirrors Record.structuredData. */
    structuredData: json<Record<string, unknown>>('structured_data'),
    /** Item this one originated from (agent decomposition / intake). */
    originWorkflowItemId: text('origin_workflow_item_id').references(
      (): AnySQLiteColumn => workflowItems.id,
      { onDelete: 'set null' }
    ),
    /** Item this one was transferred from, preserving lineage. */
    sourceWorkflowItemId: text('source_workflow_item_id').references(
      (): AnySQLiteColumn => workflowItems.id,
      { onDelete: 'set null' }
    ),
    participation: text('participation').$type<ParticipationKind>().notNull().default('primary'),
    createdByType: text('created_by_type').$type<ActorType>().notNull().default('user'),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    provenance: json<WorkflowItemProvenance>('provenance'),
    enteredStateAt: epochMs('entered_state_at').notNull(),
    lastActivityAt: epochMs('last_activity_at').notNull(),
    dueAt: epochMs('due_at'),
    slaDueAt: epochMs('sla_due_at'),
    closedAt: epochMs('closed_at'),
    completedAt: epochMs('completed_at'),
    /** Number of automatic executions run against the current state entry. */
    stateRunCount: integer('state_run_count').notNull().default(0),
    waitingOn: text('waiting_on').$type<WorkflowItemWait>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    index('workflow_items_board_idx').on(table.workspaceId, table.workflowId, table.stateId),
    index('workflow_items_record_idx').on(table.workspaceId, table.recordId),
    index('workflow_items_owner_idx').on(table.workspaceId, table.ownerUserId),
    index('workflow_items_state_entered_idx').on(
      table.workspaceId,
      table.stateId,
      table.enteredStateAt
    ),
    index('workflow_items_updated_idx').on(table.workspaceId, table.updatedAt),
    index('workflow_items_waiting_idx').on(table.workspaceId, table.waitingOn)
  ]
);

const workflowItemTypedValueColumns = {
  valueText: text('value_text'),
  valueNumber: real('value_number'),
  valueBool: integer('value_bool', { mode: 'boolean' }),
  valueDate: integer('value_date'),
  valueJson: json<unknown>('value_json'),
  searchText: text('search_text'),
  updatedByType: text('updated_by_type').$type<ActorType>(),
  updatedById: text('updated_by_id'),
  updatedAt: updatedAt()
};

/**
 * Workflow-overlay field values. The definition's `workflow_fields` binding is
 * what marks a field as contextual; these rows keep the value attached to the
 * specific participation so it survives completion/transfer as history.
 */
export const workflowItemFieldValues = sqliteTable(
  'workflow_item_field_values',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowItemId: text('workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    ...workflowItemTypedValueColumns
  },
  (table) => [
    uniqueIndex('workflow_item_field_values_unique').on(
      table.workflowItemId,
      table.fieldDefinitionId
    ),
    index('workflow_item_field_values_text_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueText
    ),
    index('workflow_item_field_values_item_idx').on(table.workspaceId, table.workflowItemId)
  ]
);

export const workflowItemNotes = sqliteTable(
  'workflow_item_notes',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowItemId: text('workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
    authorType: text('author_type').$type<ActorType>().notNull(),
    authorId: text('author_id'),
    authorLabel: text('author_label'),
    body: text('body').notNull(),
    isSystem: bool('is_system'),
    runId: text('run_id'),
    createdAt: createdAt(),
    editedAt: epochMs('edited_at'),
    editedByType: text('edited_by_type').$type<ActorType>(),
    editedById: text('edited_by_id'),
    deletedAt: epochMs('deleted_at')
  },
  (table) => [
    index('workflow_item_notes_item_idx').on(
      table.workspaceId,
      table.workflowItemId,
      table.createdAt
    )
  ]
);

export const workflowItemNoteRevisions = sqliteTable(
  'workflow_item_note_revisions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id').notNull(),
    noteId: text('note_id')
      .notNull()
      .references(() => workflowItemNotes.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    editedByType: text('edited_by_type').$type<ActorType>(),
    editedById: text('edited_by_id'),
    createdAt: createdAt()
  },
  (table) => [index('workflow_item_note_revisions_note_idx').on(table.noteId, table.createdAt)]
);

export const workflowItemRelationships = sqliteTable(
  'workflow_item_relationships',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromWorkflowItemId: text('from_workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
    toWorkflowItemId: text('to_workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
    type: text('type').$type<WorkRelationshipType>().notNull(),
    note: text('note'),
    createdByType: text('created_by_type').$type<ActorType>().notNull(),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    runId: text('run_id'),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('workflow_item_relationships_unique').on(
      table.fromWorkflowItemId,
      table.toWorkflowItemId,
      table.type
    ),
    index('workflow_item_relationships_from_idx').on(table.workspaceId, table.fromWorkflowItemId),
    index('workflow_item_relationships_to_idx').on(table.workspaceId, table.toWorkflowItemId)
  ]
);

/**
 * State intervals. Kept as enteredAt/exitedAt so time-in-state, throughput and
 * funnels read recorded facts rather than inferring them.
 */
export const workflowItemStateHistory = sqliteTable(
  'workflow_item_state_history',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowItemId: text('workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
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
    index('workflow_item_state_history_item_idx').on(
      table.workspaceId,
      table.workflowItemId,
      table.enteredAt
    ),
    index('workflow_item_state_history_state_idx').on(
      table.workspaceId,
      table.stateId,
      table.enteredAt
    ),
    index('workflow_item_state_history_open_idx').on(table.workflowItemId, table.exitedAt)
  ]
);

export type WorkflowMoveKind = 'initial' | 'transfer' | 'add_participation' | 'state_change';

/**
 * Workflow-move lineage. `transfer` and `add_participation` are recorded here so
 * the distinction is never inferred from a mutated foreign key.
 */
export const workflowItemWorkflowHistory = sqliteTable(
  'workflow_item_workflow_history',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowItemId: text('workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<WorkflowMoveKind>().notNull(),
    fromWorkflowId: text('from_workflow_id'),
    fromStateId: text('from_state_id'),
    toWorkflowId: text('to_workflow_id').notNull(),
    toStateId: text('to_state_id').notNull(),
    /** The item participation moved from, when this is a transfer. */
    sourceWorkflowItemId: text('source_workflow_item_id'),
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
    index('workflow_item_workflow_history_item_idx').on(
      table.workspaceId,
      table.workflowItemId,
      table.createdAt
    )
  ]
);

export const workflowItemLabels = sqliteTable(
  'workflow_item_labels',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowItemId: text('workflow_item_id')
      .notNull()
      .references(() => workflowItems.id, { onDelete: 'cascade' }),
    labelId: text('label_id').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('workflow_item_labels_unique').on(table.workflowItemId, table.labelId),
    index('workflow_item_labels_label_idx').on(table.workspaceId, table.labelId)
  ]
);

export type WorkflowItem = typeof workflowItems.$inferSelect;
export type NewWorkflowItem = typeof workflowItems.$inferInsert;
export type WorkflowItemFieldValue = typeof workflowItemFieldValues.$inferSelect;
export type WorkflowItemNote = typeof workflowItemNotes.$inferSelect;
export type WorkflowItemRelationship = typeof workflowItemRelationships.$inferSelect;
export type WorkflowItemStateHistoryRow = typeof workflowItemStateHistory.$inferSelect;
export type WorkflowItemWorkflowHistoryRow = typeof workflowItemWorkflowHistory.$inferSelect;
export type WorkflowItemLabel = typeof workflowItemLabels.$inferSelect;
