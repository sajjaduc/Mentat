/**
 * Native cache and structured collections.
 *
 * Both are first-class platform primitives that agents can use directly, and both
 * reuse the same storage the durable job queue uses: no Redis, no external queue
 * (ADR-0016).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { workspaces } from './tenancy';

export const cacheEntries = sqliteTable(
  'cache_entries',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull().default('default'),
    key: text('key').notNull(),
    /**
     * Identity component describing *who* the cached value belongs to (auth/tenant
     * scope). Cache hits must never cross workspace or credential boundaries.
     */
    authScope: text('auth_scope').notNull().default(''),
    value: json<unknown>('value').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    tags: json<string[]>('tags'),
    hits: integer('hits').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastAccessedAt: epochMs('last_accessed_at'),
    expiresAt: epochMs('expires_at')
  },
  (table) => [
    uniqueIndex('cache_entries_unique').on(
      table.workspaceId,
      table.namespace,
      table.authScope,
      table.key
    ),
    index('cache_entries_expiry_idx').on(table.expiresAt),
    index('cache_entries_ns_idx').on(table.workspaceId, table.namespace)
  ]
);

/** Short-lived advisory lock enabling stampede protection around computation. */
export const cacheLocks = sqliteTable(
  'cache_locks',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    authScope: text('auth_scope').notNull().default(''),
    key: text('key').notNull(),
    holder: text('holder').notNull(),
    acquiredAt: integer('acquired_at').notNull(),
    expiresAt: integer('expires_at').notNull()
  },
  (table) => [
    uniqueIndex('cache_locks_unique').on(
      table.workspaceId,
      table.namespace,
      table.authScope,
      table.key
    ),
    index('cache_locks_expiry_idx').on(table.expiresAt)
  ]
);

/**
 * Structured collections: workflow-authored document stores such as `customers` or
 * `research_results`. Persistence is portable JSON documents in V1; the repository
 * interface hides that so a PostgreSQL jsonb/GIN implementation can replace it.
 */
export const collections = sqliteTable(
  'collections',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Optional JSON-schema-ish descriptor used to validate records. */
    schema: json<unknown>('schema'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('collections_key_unique').on(table.workspaceId, table.workflowId, table.key),
    index('collections_workspace_idx').on(table.workspaceId)
  ]
);

export const collectionRecords = sqliteTable(
  'collection_records',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** Optional caller-supplied external key for upserts. */
    externalKey: text('external_key'),
    data: json<Record<string, unknown>>('data').notNull(),
    /** Lowercase projection of searchable values, for portable text filters. */
    searchText: text('search_text'),
    version: integer('version').notNull().default(1),
    createdByType: text('created_by_type'),
    createdById: text('created_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: epochMs('deleted_at')
  },
  (table) => [
    index('collection_records_collection_idx').on(
      table.workspaceId,
      table.collectionId,
      table.createdAt
    ),
    uniqueIndex('collection_records_external_unique').on(table.collectionId, table.externalKey)
  ]
);

export type CacheEntry = typeof cacheEntries.$inferSelect;
export type CacheLock = typeof cacheLocks.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type CollectionRecord = typeof collectionRecords.$inferSelect;
