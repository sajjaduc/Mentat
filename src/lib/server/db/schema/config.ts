/**
 * Configuration: secrets, environment values, overrides and storage settings.
 *
 * Resolution order is always `Workflow override > Workspace value`. The
 * `workspace_overrides` table records *provenance* for every bindable resource so
 * the UI can always answer "where does this effective value come from" without
 * guessing (ADR-0006).
 *
 * Secret ciphertext is written and read only through this module; nothing else in
 * the codebase touches the encrypted columns.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  type BindableResourceType,
  bool,
  createdAt,
  epochMs,
  json,
  primaryId,
  type ResourceBindingMode,
  updatedAt
} from './_helpers';
import { users, workspaces } from './tenancy';

export const secrets = sqliteTable(
  'secrets',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Workflow scope means "a workflow-local override of a workspace secret". */
    scope: text('scope').$type<'workspace' | 'workflow'>().notNull().default('workspace'),
    workflowId: text('workflow_id'),
    sourceSecretId: text('source_secret_id'),
    bindingMode: text('binding_mode').$type<ResourceBindingMode>().notNull().default('use_asis'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    algorithm: text('algorithm').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    /** Non-sensitive hint so a human can recognise the credential. */
    lastFour: text('last_four'),
    valueLength: integer('value_length'),
    version: integer('version').notNull().default(1),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rotatedAt: epochMs('rotated_at'),
    /** Soft delete keeps historical runs auditable. */
    deletedAt: epochMs('deleted_at')
  },
  (table) => [
    uniqueIndex('secrets_key_unique').on(table.workspaceId, table.workflowId, table.key),
    index('secrets_workspace_idx').on(table.workspaceId, table.deletedAt)
  ]
);

export const environmentVariables = sqliteTable(
  'environment_variables',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<'workspace' | 'workflow'>().notNull().default('workspace'),
    workflowId: text('workflow_id'),
    sourceVariableId: text('source_variable_id'),
    bindingMode: text('binding_mode').$type<ResourceBindingMode>().notNull().default('use_asis'),
    key: text('key').notNull(),
    /** Null when the variable is backed by a secret reference instead of plaintext. */
    value: text('value'),
    secretId: text('secret_id').references(() => secrets.id, { onDelete: 'set null' }),
    isSecret: bool('is_secret'),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('environment_variables_unique').on(table.workspaceId, table.workflowId, table.key),
    index('environment_variables_workspace_idx').on(table.workspaceId)
  ]
);

/**
 * Uniform binding/provenance record for resources that support
 * Use as-is / Override / Fork. The resource itself stays in its own table; this
 * row explains the relationship (ADR-0006).
 */
export const workspaceOverrides = sqliteTable(
  'workspace_overrides',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    resourceType: text('resource_type').$type<BindableResourceType>().notNull(),
    resourceId: text('resource_id').notNull(),
    sourceResourceId: text('source_resource_id'),
    mode: text('mode').$type<ResourceBindingMode>().notNull(),
    /** Fields changed relative to the source resource; drives the diff UI. */
    overriddenFields: json<string[]>('overridden_fields'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('workspace_overrides_unique').on(
      table.workspaceId,
      table.workflowId,
      table.resourceType,
      table.resourceId
    ),
    index('workspace_overrides_lookup_idx').on(table.workspaceId, table.resourceType)
  ]
);

export const workspaceStorageConfig = sqliteTable(
  'workspace_storage_config',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'local' | 'gcs'>().notNull().default('local'),
    bucket: text('bucket'),
    /** Key prefix, e.g. `workspaces/{workspaceId}/`. */
    prefix: text('prefix'),
    credentialsSecretId: text('credentials_secret_id').references(() => secrets.id, {
      onDelete: 'set null'
    }),
    /** Local filesystem root when provider is `local`. */
    localRoot: text('local_root'),
    config: json<Record<string, unknown>>('config'),
    maxFileBytes: integer('max_file_bytes').notNull().default(52_428_800),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex('workspace_storage_config_unique').on(table.workspaceId)]
);

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type EnvironmentVariable = typeof environmentVariables.$inferSelect;
export type WorkspaceOverride = typeof workspaceOverrides.$inferSelect;
export type WorkspaceStorageConfig = typeof workspaceStorageConfig.$inferSelect;
