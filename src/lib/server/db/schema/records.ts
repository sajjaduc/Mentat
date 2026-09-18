/**
 * Records: durable domain knowledge of any Object Type.
 *
 * This is the universal "thing the work is about" primitive (ADR-0021). A Record
 * is *not* a work item and never carries workflow/state/ownership: those belong to
 * a WorkflowItem. A Record may participate in zero, one or many Workflows.
 *
 * The tables here are deliberately general:
 *  - `object_types` + `object_type_fields` describe a kind of thing and which
 *    workspace field definitions make up its schema;
 *  - `records` is the durable instance (identity, display cache, provenance);
 *  - `record_field_values` stores typed base-field values through the one field
 *    engine;
 *  - `record_relationship_definitions` / `record_relationships` model domain
 *    relationships (Business HAS_POLICY Policy), kept separate from work
 *    relationships;
 *  - `record_external_ids` gives deterministic integration identity;
 *  - `record_notes` is durable knowledge about the thing.
 *
 * Storage uses the same conservative column types as the rest of Mentat so the
 * PostgreSQL port stays a declaration swap.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { type ActorType, fieldDefinitions } from './fields';
import { users, workspaces } from './tenancy';

export interface ObjectTypeSettings {
  /** Allocate a human-facing key/number for each record (e.g. `POL-42`). */
  numbered?: boolean;
  /** Prefix used with numbering, e.g. `POL`. Defaults to the upper-cased key. */
  keyPrefix?: string;
  /** Start value for numbering; defaults to 1. */
  numberStart?: number;
  /** Free-form guidance surfaced in the record editor. */
  descriptionTemplate?: string;
  /**
   * The authoritative Zod contract, authored as source (ADR-0023). When present
   * the record is validated against it verbatim; the bound field definitions are a
   * projection of it for lists, filters, history and analytics.
   */
  zodSchema?: string;
}

export const objectTypes = sqliteTable(
  'object_types',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Stable machine key, e.g. `business`, `policy`, `ticket`. */
    key: text('key').notNull(),
    /** Singular display name, e.g. `Policy`. Drives UI nouns. */
    name: text('name').notNull(),
    /** Plural display name, e.g. `Policies`. Defaults to name + 's'. */
    pluralName: text('plural_name').notNull(),
    description: text('description'),
    icon: text('icon'),
    color: text('color'),
    settings: json<ObjectTypeSettings>('settings'),
    /** Seeded/system object types (Ticket, Person, Business) are protected. */
    isSystem: bool('is_system'),
    position: integer('position').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('object_types_key_unique').on(table.workspaceId, table.key),
    index('object_types_workspace_idx').on(table.workspaceId, table.archivedAt)
  ]
);

/**
 * Binds a workspace field definition into an Object Type's schema. The binding
 * carries layout/identity flags so the same field definition can appear in
 * several object types with different behaviour.
 */
export const objectTypeFields = sqliteTable(
  'object_type_fields',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectTypeId: text('object_type_id')
      .notNull()
      .references(() => objectTypes.id, { onDelete: 'cascade' }),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    required: bool('required'),
    /** Part of the deterministic identity/uniqueness rule for the object type. */
    isIdentity: bool('is_identity'),
    /** The field whose value becomes `records.displayName`. Exactly one expected. */
    isPrimaryDisplay: bool('is_primary_display'),
    isSecondaryDisplay: bool('is_secondary_display'),
    showInList: bool('show_in_list', true),
    showOnCard: bool('show_on_card'),
    filterable: bool('filterable', true),
    defaultValue: json<unknown>('default_value'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('object_type_fields_unique').on(table.objectTypeId, table.fieldDefinitionId),
    index('object_type_fields_object_idx').on(table.workspaceId, table.objectTypeId, table.position)
  ]
);

export interface RecordProvenance {
  sourceType?: string;
  sourceReference?: string;
  sourceLabel?: string;
  triggerId?: string;
  triggerEventId?: string;
  externalRef?: string;
  ingestedAt?: number;
}

export const records = sqliteTable(
  'records',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectTypeId: text('object_type_id')
      .notNull()
      .references(() => objectTypes.id, { onDelete: 'restrict' }),
    /** Cached primary display value so lists/search never require a join. */
    displayName: text('display_name').notNull(),
    /** Human-facing key, e.g. `POL-42`; null for unnumbered object types. */
    key: text('key'),
    number: integer('number'),
    /** Optimistic-concurrency guard: every durable mutation increments this. */
    version: integer('version').notNull().default(1),
    createdByType: text('created_by_type').$type<ActorType>().notNull().default('user'),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    provenance: json<RecordProvenance>('provenance'),
    /** Free-form document payload for values without a field definition. */
    structuredData: json<Record<string, unknown>>('structured_data'),
    lastActivityAt: epochMs('last_activity_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at'),
    archivedByType: text('archived_by_type').$type<ActorType>(),
    archivedById: text('archived_by_id')
  },
  (table) => [
    uniqueIndex('records_key_unique').on(table.workspaceId, table.objectTypeId, table.key),
    uniqueIndex('records_number_unique').on(table.workspaceId, table.objectTypeId, table.number),
    index('records_object_idx').on(table.workspaceId, table.objectTypeId, table.archivedAt),
    index('records_display_idx').on(table.workspaceId, table.objectTypeId, table.displayName),
    index('records_updated_idx').on(table.workspaceId, table.updatedAt)
  ]
);

/**
 * Typed base-field values for a record. The column shape mirrors the ticket/file
 * field stores so one normalization/validation engine serves all three.
 */
const recordTypedValueColumns = {
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

export const recordFieldValues = sqliteTable(
  'record_field_values',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => fieldDefinitions.id, { onDelete: 'cascade' }),
    ...recordTypedValueColumns
  },
  (table) => [
    uniqueIndex('record_field_values_unique').on(table.recordId, table.fieldDefinitionId),
    index('record_field_values_text_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueText
    ),
    index('record_field_values_number_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueNumber
    ),
    index('record_field_values_date_idx').on(
      table.workspaceId,
      table.fieldDefinitionId,
      table.valueDate
    ),
    index('record_field_values_record_idx').on(table.workspaceId, table.recordId)
  ]
);

export type RelationshipCardinality = 'one_to_one' | 'one_to_many' | 'many_to_many';

/**
 * Declares a domain relationship an Object Type may have to another. Inverse name
 * is stored so navigation works in both directions without recursion.
 */
export const recordRelationshipDefinitions = sqliteTable(
  'record_relationship_definitions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceObjectTypeId: text('source_object_type_id')
      .notNull()
      .references(() => objectTypes.id, { onDelete: 'cascade' }),
    /** Null means "any object type" — used sparingly for generic links. */
    targetObjectTypeId: text('target_object_type_id').references(() => objectTypes.id, {
      onDelete: 'cascade'
    }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    inverseName: text('inverse_name').notNull(),
    cardinality: text('cardinality')
      .$type<RelationshipCardinality>()
      .notNull()
      .default('many_to_many'),
    description: text('description'),
    isSystem: bool('is_system'),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('record_relationship_definitions_unique').on(
      table.workspaceId,
      table.sourceObjectTypeId,
      table.key
    ),
    index('record_relationship_definitions_source_idx').on(
      table.workspaceId,
      table.sourceObjectTypeId
    )
  ]
);

export const recordRelationships = sqliteTable(
  'record_relationships',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    definitionId: text('definition_id')
      .notNull()
      .references(() => recordRelationshipDefinitions.id, { onDelete: 'cascade' }),
    fromRecordId: text('from_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    toRecordId: text('to_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    note: text('note'),
    metadata: json<Record<string, unknown>>('metadata'),
    createdByType: text('created_by_type').$type<ActorType>().notNull(),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    runId: text('run_id'),
    createdAt: createdAt(),
    removedAt: epochMs('removed_at')
  },
  (table) => [
    uniqueIndex('record_relationships_unique').on(
      table.fromRecordId,
      table.toRecordId,
      table.definitionId
    ),
    index('record_relationships_from_idx').on(table.workspaceId, table.fromRecordId),
    index('record_relationships_to_idx').on(table.workspaceId, table.toRecordId)
  ]
);

/**
 * First-class external identity. Webhooks and integrations resolve through this
 * rather than repeated fuzzy name matching. Uniqueness is per workspace + system.
 */
export const recordExternalIds = sqliteTable(
  'record_external_ids',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    /** Integration/system name, e.g. `hubspot`, `salesforce`, `xero`. */
    system: text('system').notNull(),
    externalId: text('external_id').notNull(),
    label: text('label'),
    url: text('url'),
    metadata: json<Record<string, unknown>>('metadata'),
    createdByType: text('created_by_type').$type<ActorType>(),
    createdById: text('created_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('record_external_ids_unique').on(table.workspaceId, table.system, table.externalId),
    index('record_external_ids_record_idx').on(table.workspaceId, table.recordId)
  ]
);

export const recordNotes = sqliteTable(
  'record_notes',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recordId: text('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
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
    index('record_notes_record_idx').on(table.workspaceId, table.recordId, table.createdAt)
  ]
);

export const recordNoteRevisions = sqliteTable(
  'record_note_revisions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id').notNull(),
    noteId: text('note_id')
      .notNull()
      .references(() => recordNotes.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    editedByType: text('edited_by_type').$type<ActorType>(),
    editedById: text('edited_by_id'),
    createdAt: createdAt()
  },
  (table) => [index('record_note_revisions_note_idx').on(table.noteId, table.createdAt)]
);

export interface RecordLayoutSection {
  key: string;
  title: string;
  fieldKeys: string[];
  columns?: 1 | 2 | 3;
}

/** Object-type-controlled record detail layout. Deliberately constrained. */
export const recordLayouts = sqliteTable(
  'record_layouts',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectTypeId: text('object_type_id')
      .notNull()
      .references(() => objectTypes.id, { onDelete: 'cascade' }),
    sections: json<RecordLayoutSection[]>('sections'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex('record_layouts_unique').on(table.objectTypeId)]
);

export type ObjectType = typeof objectTypes.$inferSelect;
export type NewObjectType = typeof objectTypes.$inferInsert;
export type ObjectTypeField = typeof objectTypeFields.$inferSelect;
export type RecordRow = typeof records.$inferSelect;
export type NewRecord = typeof records.$inferInsert;
export type RecordFieldValue = typeof recordFieldValues.$inferSelect;
export type RecordRelationshipDefinition = typeof recordRelationshipDefinitions.$inferSelect;
export type RecordRelationship = typeof recordRelationships.$inferSelect;
export type RecordExternalId = typeof recordExternalIds.$inferSelect;
export type RecordNote = typeof recordNotes.$inferSelect;
export type RecordLayout = typeof recordLayouts.$inferSelect;
