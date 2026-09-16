/**
 * First-class typed fields.
 *
 * `structuredData` alone cannot support reliable filtering, indexing, history or
 * analytics, so ticket and file metadata use explicit field definitions plus
 * typed, normalized value records (ADR-0005).
 *
 * Values are stored in one of four typed columns (`valueText`, `valueNumber`,
 * `valueDate`, `valueBool`) with `valueJson` reserved for multi-value and object
 * fields. `searchText` holds a normalized lowercase projection of the value so
 * text filters stay dialect-independent (`LIKE` today, `ILIKE`/GIN later).
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, json, primaryId, updatedAt } from './_helpers';
import { users, workspaces } from './tenancy';

export type FieldType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'user'
  | 'team'
  | 'url'
  | 'email'
  | 'phone'
  | 'json';

export type FieldScope = 'ticket' | 'file';

export interface FieldChoice {
  value: string;
  label: string;
  color?: string;
}

export interface FieldOptions {
  choices?: FieldChoice[];
  currency?: string;
  precision?: number;
  rows?: number;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
}

export interface FieldDisplay {
  format?: string;
  width?: 'compact' | 'normal' | 'wide';
  placeholder?: string;
  prefix?: string;
  suffix?: string;
}

export const fieldDefinitions = sqliteTable(
  'field_definitions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').$type<FieldType>().notNull(),
    scope: text('scope').$type<FieldScope>().notNull(),
    options: json<FieldOptions>('options'),
    defaultValue: json<unknown>('default_value'),
    validation: json<FieldValidation>('validation'),
    display: json<FieldDisplay>('display'),
    /** Seeded fields shipped with a fresh workspace; editable but not deletable. */
    isSystem: bool('is_system'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: integer('archived_at')
  },
  (table) => [
    uniqueIndex('field_definitions_unique').on(table.workspaceId, table.scope, table.key),
    index('field_definitions_scope_idx').on(table.workspaceId, table.scope)
  ]
);

/**
 * Which fields a workflow uses and how. `requiredInStates` enforces
 * state-specific requirements (for example a reviewer outcome before leaving a
 * human-gated state).
 */
export const workflowFields = sqliteTable(
  'workflow_fields',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    required: bool('required'),
    visible: bool('visible', true),
    editable: bool('editable', true),
    defaultValue: json<unknown>('default_value'),
    requiredInStates: json<string[]>('required_in_states'),
    showOnCard: bool('show_on_card'),
    showInList: bool('show_in_list', true),
    filterable: bool('filterable', true),
    requiredForTransfer: bool('required_for_transfer'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('workflow_fields_unique').on(table.workflowId, table.fieldDefinitionId),
    index('workflow_fields_workspace_idx').on(table.workspaceId, table.workflowId)
  ]
);

const typedValueColumns = {
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

export type ActorType = 'user' | 'agent' | 'system' | 'api' | 'extraction';

export const ticketFieldValues = sqliteTable(
  'ticket_field_values',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id').notNull(),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    ...typedValueColumns
  },
  (table) => [
    uniqueIndex('ticket_field_values_unique').on(table.ticketId, table.fieldDefinitionId),
    index('ticket_field_values_text_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueText
    ),
    index('ticket_field_values_number_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueNumber
    ),
    index('ticket_field_values_date_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueDate
    ),
    index('ticket_field_values_ticket_idx').on(table.workspaceId, table.ticketId)
  ]
);

export const fileFieldValues = sqliteTable(
  'file_field_values',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull(),
    /** Workflow-specific interpretation of the same file (see ADR-0010). */
    workflowId: text('workflow_id'),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    confidence: real('confidence'),
    sourcePage: integer('source_page'),
    sourceSpan: text('source_span'),
    ...typedValueColumns
  },
  (table) => [
    uniqueIndex('file_field_values_unique').on(
      table.fileId,
      table.workflowId,
      table.fieldDefinitionId
    ),
    index('file_field_values_text_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueText
    ),
    index('file_field_values_file_idx').on(table.workspaceId, table.fileId)
  ]
);

/**
 * Immutable field-change history. Never overwritten: a current value change always
 * appends a row here so ticket/file timelines and analytics can answer
 * "what did this look like before, and who changed it".
 */
export const fieldValueHistory = sqliteTable(
  'field_value_history',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerType: text('owner_type').$type<'ticket' | 'file'>().notNull(),
    ownerId: text('owner_id').notNull(),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    previousValue: json<unknown>('previous_value'),
    newValue: json<unknown>('new_value'),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    runId: text('run_id'),
    source: text('source').$type<'human' | 'agent' | 'system' | 'extraction'>(),
    createdAt: createdAt()
  },
  (table) => [
    index('field_value_history_owner_idx').on(table.workspaceId, table.ownerType, table.ownerId),
    index('field_value_history_field_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.createdAt
    )
  ]
);

export type FieldDefinition = typeof fieldDefinitions.$inferSelect;
export type NewFieldDefinition = typeof fieldDefinitions.$inferInsert;
export type WorkflowField = typeof workflowFields.$inferSelect;
export type TicketFieldValue = typeof ticketFieldValues.$inferSelect;
export type FileFieldValue = typeof fileFieldValues.$inferSelect;
export type FieldValueHistory = typeof fieldValueHistory.$inferSelect;
