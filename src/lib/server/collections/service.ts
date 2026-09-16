/**
 * Structured collections: workflow-authored document stores such as `customers` or
 * `research_results`, plus the records inside them.
 *
 * V1 persists records as portable JSON documents in `collection_records`. Filtering
 * therefore happens in the service: the indexed identity columns and a `search_text`
 * LIKE prefilter narrow the candidate set, then the narrow predicate compiler in
 * `filter.ts` decides. The repository interface hides that so a PostgreSQL
 * jsonb/GIN implementation can replace it without changing callers.
 *
 * ## Invariants
 *
 *  - Every query filters by `workspaceId`; a cross-tenant id returns `notFound`,
 *    never `forbidden`, so probing cannot confirm existence.
 *  - `updateRecord` and `deleteRecord` are optimistic: `expectedVersion` (and the
 *    soft-delete flag) are checked in the same transaction as the write.
 *  - Deletes are soft, so audit and history keep pointing at a real row, and an
 *    `external_key` can be revived by a later upsert.
 *  - Every record mutation audits `collection.record.changed`; collection creation
 *    audits `collection.created`. The frozen `AuditActions` list has no
 *    `collection.updated`/`collection.archived`, and inventing one is forbidden, so
 *    metadata edits (`updateCollection`, `archiveCollection`) are deliberately not
 *    audited rather than misfiled under `collection.record.changed`.
 *  - `search_text` is maintained on every mutation: the lowercased concatenation of
 *    all scalar values (including the external key), used only as a coarse prefilter.
 */
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import { type Collection, collectionRecords, collections } from '../db/schema';
import {
  compileRecordPredicate,
  parseRecordFilter,
  type RecordFilter,
  type RecordSort,
  readRecordField,
  recordSortSchema
} from './filter';
import { assertRecordData, parseRecordSchema, type RecordSchema } from './schema-validation';

export const MAX_COLLECTION_KEY_LENGTH = 64;
export const MAX_EXTERNAL_KEY_LENGTH = 256;
export const MAX_RECORD_BYTES = 1024 * 1024;
/** Upper bound on the in-process scan for a single find; keeps JSON filtering bounded. */
export const MAX_FIND_SCAN = 5000;
const MAX_FIND_LIMIT = 200;
const DEFAULT_FIND_LIMIT = 50;

export interface CollectionView {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  key: string;
  name: string;
  description: string | null;
  schema: RecordSchema | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCollectionInput {
  key: string;
  name: string;
  description?: string | null;
  schema?: unknown;
  workflowId?: string | null;
}

export interface CollectionRecordView {
  id: string;
  workspaceId: string;
  collectionId: string;
  externalKey: string | null;
  data: Record<string, unknown>;
  searchText: string;
  version: number;
  createdByType: string | null;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface InsertRecordInput {
  collectionId: string;
  data: Record<string, unknown>;
  externalKey?: string | null;
}

export interface UpdateRecordInput {
  recordId: string;
  data: Record<string, unknown>;
  /** When supplied, the stored version must match exactly. */
  expectedVersion?: number;
  /** Replace the document instead of merging `data` into the existing fields. */
  replace?: boolean;
}

export interface FindRecordsInput {
  collectionId: string;
  filter?: unknown;
  sort?: unknown;
  limit?: number;
  cursor?: string | null;
  includeDeleted?: boolean;
}

export interface FindRecordsResult {
  records: CollectionRecordView[];
  nextCursor: string | null;
  /** True when the bounded scan hit its cap and more matches may exist. */
  truncated: boolean;
}

/** Create a workflow-scoped (`workflowId`) or workspace-level collection. */
export async function createCollection(
  db: Executor,
  actor: ActorContext,
  input: CreateCollectionInput
): Promise<CollectionView> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to create collections');
  const key = assertCollectionKey(input.key);
  const name = assertCollectionName(input.name);
  const workflowId = input.workflowId ?? '';
  const schema = parseRecordSchema(input.schema ?? null);

  const existing = db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.workspaceId, actor.workspaceId),
        eq(collections.workflowId, workflowId),
        eq(collections.key, key),
        isNull(collections.archivedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (existing) {
    throw errors.conflict(`A collection with key "${key}" already exists in this scope`, {
      key,
      workflowId: workflowId || null
    });
  }

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const row = tx
      .insert(collections)
      .values({
        workspaceId: actor.workspaceId,
        workflowId,
        key,
        name,
        description: input.description ?? null,
        schema: (schema as never) ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all()[0];
    if (!row) throw errors.internal('Failed to create collection');

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.collectionCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'collection',
      entityId: row.id,
      workflowId: workflowId || null,
      runId: actor.runId ?? null,
      summary: `Collection "${row.name}" created`,
      data: { key: row.key, name: row.name, workflowId: workflowId || null }
    });
    return toCollectionView(row);
  });
}

export function getCollection(
  db: Executor,
  actor: ActorContext,
  collectionId: string
): CollectionView {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read collections');
  return toCollectionView(requireCollectionRow(db, actor.workspaceId, collectionId, false));
}

export function listCollections(
  db: Executor,
  actor: ActorContext,
  options: { workflowId?: string | null; includeArchived?: boolean } = {}
): CollectionView[] {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read collections');
  const conditions: SQL[] = [eq(collections.workspaceId, actor.workspaceId)];
  if (options.workflowId !== undefined) {
    conditions.push(eq(collections.workflowId, options.workflowId ?? ''));
  }
  if (!options.includeArchived) conditions.push(isNull(collections.archivedAt));
  return db
    .select()
    .from(collections)
    .where(and(...conditions))
    .orderBy(collections.key)
    .all()
    .map(toCollectionView);
}

/** Resolve by id, or by `key` + optional `workflowId`, for tool/UI convenience. */
export function resolveCollection(
  db: Executor,
  actor: ActorContext,
  reference: { collectionId?: string; key?: string; workflowId?: string | null }
): CollectionView {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read collections');
  if (reference.collectionId) {
    return toCollectionView(
      requireCollectionRow(db, actor.workspaceId, reference.collectionId, false)
    );
  }
  if (!reference.key) {
    throw errors.validation('A collection reference requires either collectionId or key');
  }
  const row = db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.workspaceId, actor.workspaceId),
        eq(collections.workflowId, reference.workflowId ?? ''),
        eq(collections.key, reference.key),
        isNull(collections.archivedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Collection', reference.key);
  return toCollectionView(row);
}

/** Rename/re-describe a collection or replace its record schema. */
export async function updateCollection(
  db: Executor,
  actor: ActorContext,
  collectionId: string,
  input: { name?: string; description?: string | null; schema?: unknown }
): Promise<CollectionView> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to update collections');
  const now = Date.now();
  const schema = input.schema === undefined ? undefined : parseRecordSchema(input.schema);
  return withTransaction(db, (tx) => {
    const current = tx
      .select()
      .from(collections)
      .where(
        and(
          eq(collections.id, collectionId),
          eq(collections.workspaceId, actor.workspaceId),
          isNull(collections.archivedAt)
        )
      )
      .limit(1)
      .all()[0];
    if (!current) throw errors.notFound('Collection', collectionId);
    const row = tx
      .update(collections)
      .set({
        name: input.name === undefined ? current.name : assertCollectionName(input.name),
        description: input.description === undefined ? current.description : input.description,
        schema: schema === undefined ? current.schema : ((schema as never) ?? null),
        updatedAt: now
      })
      .where(eq(collections.id, collectionId))
      .returning()
      .all()[0];
    if (!row) throw errors.internal('Failed to update collection');
    return toCollectionView(row);
  });
}

/** Archive a collection (soft delete). Records are left untouched for audit history. */
export async function archiveCollection(
  db: Executor,
  actor: ActorContext,
  collectionId: string
): Promise<CollectionView> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to archive collections');
  const now = Date.now();
  return withTransaction(db, (tx) => {
    const row = tx
      .update(collections)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(
          eq(collections.id, collectionId),
          eq(collections.workspaceId, actor.workspaceId),
          isNull(collections.archivedAt)
        )
      )
      .returning()
      .all()[0];
    if (!row) throw errors.notFound('Collection', collectionId);
    return toCollectionView(row);
  });
}

/**
 * Insert a record. Supplying `externalKey` makes the operation idempotent: an
 * existing live record with that key is a conflict, and a soft-deleted one is
 * revived with the new document instead of failing the unique index.
 */
export async function insertRecord(
  db: Executor,
  actor: ActorContext,
  input: InsertRecordInput
): Promise<CollectionRecordView> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to insert records');
  const collection = requireCollectionRow(db, actor.workspaceId, input.collectionId, false);
  const data = assertRecordObject(input.data);
  assertRecordData(collectionSchemaOf(collection), data);
  const externalKey = normalizeExternalKey(input.externalKey);
  const now = Date.now();
  const searchText = buildSearchText(data, externalKey);

  return withTransaction(db, (tx) => {
    if (externalKey !== null) {
      const existing = tx
        .select()
        .from(collectionRecords)
        .where(
          and(
            eq(collectionRecords.collectionId, collection.id),
            eq(collectionRecords.externalKey, externalKey)
          )
        )
        .limit(1)
        .all()[0];
      if (existing && existing.deletedAt === null) {
        throw errors.conflict(
          `A record with external key "${externalKey}" already exists in this collection`,
          { externalKey, recordId: existing.id }
        );
      }
      if (existing) {
        const revived = reviveRecord(tx, existing.id, data, searchText, now);
        auditRecordChange(
          tx,
          actor,
          collection,
          revived.id,
          'insert',
          revived.version,
          externalKey
        );
        return revived;
      }
    }

    const row = tx
      .insert(collectionRecords)
      .values({
        workspaceId: actor.workspaceId,
        collectionId: collection.id,
        externalKey,
        data: data as never,
        searchText,
        version: 1,
        createdByType: actor.actorType,
        createdById: actor.actorId,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all()[0];
    if (!row) throw errors.internal('Failed to insert collection record');
    auditRecordChange(tx, actor, collection, row.id, 'insert', row.version, externalKey);
    return toRecordView(row);
  });
}

/** Merge (default) or replace a record's document with optimistic concurrency. */
export async function updateRecord(
  db: Executor,
  actor: ActorContext,
  input: UpdateRecordInput
): Promise<CollectionRecordView> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to update records');
  const patch = assertRecordObject(input.data);
  const now = Date.now();

  return withTransaction(db, (tx) => {
    const current = tx
      .select()
      .from(collectionRecords)
      .where(
        and(
          eq(collectionRecords.id, input.recordId),
          eq(collectionRecords.workspaceId, actor.workspaceId),
          isNull(collectionRecords.deletedAt)
        )
      )
      .limit(1)
      .all()[0];
    if (!current) throw errors.notFound('Collection record', input.recordId);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw errors.versionConflict('Collection record', input.expectedVersion, current.version);
    }

    const collection = tx
      .select()
      .from(collections)
      .where(eq(collections.id, current.collectionId))
      .limit(1)
      .all()[0];
    const nextData = input.replace ? patch : { ...current.data, ...patch };
    assertRecordData(collectionSchemaOf(collection), nextData);
    const searchText = buildSearchText(nextData, current.externalKey);

    const row = tx
      .update(collectionRecords)
      .set({
        data: nextData as never,
        searchText,
        version: sql`${collectionRecords.version} + 1`,
        updatedAt: now
      })
      .where(
        and(
          eq(collectionRecords.id, current.id),
          eq(collectionRecords.workspaceId, actor.workspaceId),
          eq(collectionRecords.version, current.version)
        )
      )
      .returning()
      .all()[0];
    if (!row) {
      throw errors.versionConflict('Collection record', current.version, current.version + 1);
    }
    if (collection) {
      auditRecordChange(tx, actor, collection, row.id, 'update', row.version, row.externalKey);
    }
    return toRecordView(row);
  });
}

/**
 * Insert-or-update addressed by `externalKey`. Idempotent: repeating the same call
 * converges on one record with the same document.
 */
export async function upsertByExternalKey(
  db: Executor,
  actor: ActorContext,
  input: { collectionId: string; externalKey: string; data: Record<string, unknown> }
): Promise<CollectionRecordView> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to upsert records');
  const collection = requireCollectionRow(db, actor.workspaceId, input.collectionId, false);
  const data = assertRecordObject(input.data);
  assertRecordData(collectionSchemaOf(collection), data);
  const externalKey = normalizeExternalKey(input.externalKey);
  if (externalKey === null) {
    throw errors.validation('upsertByExternalKey requires a non-empty externalKey');
  }
  const now = Date.now();
  const searchText = buildSearchText(data, externalKey);

  return withTransaction(db, (tx) => {
    const existing = tx
      .select()
      .from(collectionRecords)
      .where(
        and(
          eq(collectionRecords.collectionId, collection.id),
          eq(collectionRecords.externalKey, externalKey)
        )
      )
      .limit(1)
      .all()[0];

    if (existing) {
      const row = tx
        .update(collectionRecords)
        .set({
          data: data as never,
          searchText,
          version: sql`${collectionRecords.version} + 1`,
          deletedAt: null,
          updatedAt: now
        })
        .where(eq(collectionRecords.id, existing.id))
        .returning()
        .all()[0];
      if (!row) throw errors.internal('Failed to upsert collection record');
      auditRecordChange(tx, actor, collection, row.id, 'upsert', row.version, externalKey);
      return toRecordView(row);
    }

    const row = tx
      .insert(collectionRecords)
      .values({
        workspaceId: actor.workspaceId,
        collectionId: collection.id,
        externalKey,
        data: data as never,
        searchText,
        version: 1,
        createdByType: actor.actorType,
        createdById: actor.actorId,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all()[0];
    if (!row) throw errors.internal('Failed to upsert collection record');
    auditRecordChange(tx, actor, collection, row.id, 'insert', row.version, externalKey);
    return toRecordView(row);
  });
}

export function getRecord(
  db: Executor,
  actor: ActorContext,
  recordId: string
): CollectionRecordView {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read records');
  const row = db
    .select()
    .from(collectionRecords)
    .where(
      and(
        eq(collectionRecords.id, recordId),
        eq(collectionRecords.workspaceId, actor.workspaceId),
        isNull(collectionRecords.deletedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Collection record', recordId);
  return toRecordView(row);
}

/** Soft delete. Idempotent: deleting an already-deleted record returns `false`. */
export async function deleteRecord(
  db: Executor,
  actor: ActorContext,
  input: { recordId: string }
): Promise<{ id: string; deleted: boolean }> {
  assertPermission(actor, Permissions.dataWrite, 'Not permitted to delete records');
  const now = Date.now();
  return withTransaction(db, (tx) => {
    const current = tx
      .select()
      .from(collectionRecords)
      .where(
        and(
          eq(collectionRecords.id, input.recordId),
          eq(collectionRecords.workspaceId, actor.workspaceId)
        )
      )
      .limit(1)
      .all()[0];
    if (!current) throw errors.notFound('Collection record', input.recordId);
    if (current.deletedAt !== null) return { id: current.id, deleted: false };

    tx.update(collectionRecords)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(collectionRecords.id, current.id))
      .run();

    const collection = tx
      .select()
      .from(collections)
      .where(eq(collections.id, current.collectionId))
      .limit(1)
      .all()[0];
    if (collection) {
      auditRecordChange(
        tx,
        actor,
        collection,
        current.id,
        'delete',
        current.version,
        current.externalKey
      );
    }
    return { id: current.id, deleted: true };
  });
}

/**
 * Find records with a flat AND filter, optional sort and offset-cursor pagination.
 *
 * Filtering is in-process over a bounded scan (identity-indexed plus a `search_text`
 * prefilter), because JSON fields have no portable SQL operator here. Sorting on a
 * JSON field therefore cannot use a keyset; the cursor is an opaque offset over the
 * matched set instead.
 */
export function findRecords(
  db: Executor,
  actor: ActorContext,
  input: FindRecordsInput
): FindRecordsResult {
  assertPermission(actor, Permissions.dataRead, 'Not permitted to read records');
  const collection = requireCollectionRow(db, actor.workspaceId, input.collectionId, false);
  const filter = parseRecordFilter(input.filter) as RecordFilter | undefined;
  const predicate = compileRecordPredicate(filter);
  const sorts = parseSort(input.sort);

  const conditions: SQL[] = [
    eq(collectionRecords.workspaceId, actor.workspaceId),
    eq(collectionRecords.collectionId, collection.id)
  ];
  if (!input.includeDeleted) conditions.push(isNull(collectionRecords.deletedAt));
  conditions.push(...coarseTextPrefilter(filter));

  const rows = db
    .select()
    .from(collectionRecords)
    .where(and(...conditions))
    .orderBy(sql`${collectionRecords.createdAt} DESC`, sql`${collectionRecords.id} DESC`)
    .limit(MAX_FIND_SCAN)
    .all();

  const matched = rows.filter(predicate).map(toRecordView);
  matched.sort((a, b) => compareRecords(a, b, sorts));

  const offset = decodeCursor(input.cursor);
  const limit = clampFindLimit(input.limit);
  const page = matched.slice(offset, offset + limit);
  const hasMore = offset + limit < matched.length;
  return {
    records: page,
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    truncated: rows.length >= MAX_FIND_SCAN
  };
}

function reviveRecord(
  tx: Executor,
  recordId: string,
  data: Record<string, unknown>,
  searchText: string,
  now: number
): CollectionRecordView {
  const row = tx
    .update(collectionRecords)
    .set({
      data: data as never,
      searchText,
      version: sql`${collectionRecords.version} + 1`,
      deletedAt: null,
      updatedAt: now
    })
    .where(eq(collectionRecords.id, recordId))
    .returning()
    .all()[0];
  if (!row) throw errors.internal('Failed to revive collection record');
  return toRecordView(row);
}

function auditRecordChange(
  tx: Executor,
  actor: ActorContext,
  collection: Collection,
  recordId: string,
  operation: 'insert' | 'update' | 'delete' | 'upsert',
  version: number,
  externalKey: string | null
): void {
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.collectionRecordChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'collection_record',
    entityId: recordId,
    workflowId: collection.workflowId || null,
    runId: actor.runId ?? null,
    summary: `Collection record ${operation} in "${collection.key}"`,
    data: {
      operation,
      collectionId: collection.id,
      collectionKey: collection.key,
      externalKey,
      version
    }
  });
}

function requireCollectionRow(
  db: Executor,
  workspaceId: string,
  collectionId: string,
  includeArchived: boolean
): Collection {
  const conditions: SQL[] = [
    eq(collections.id, collectionId),
    eq(collections.workspaceId, workspaceId)
  ];
  if (!includeArchived) conditions.push(isNull(collections.archivedAt));
  const row = db
    .select()
    .from(collections)
    .where(and(...conditions))
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Collection', collectionId);
  return row;
}

function collectionSchemaOf(collection: Collection | null | undefined): RecordSchema | null {
  if (!collection || collection.schema === null || collection.schema === undefined) return null;
  return collection.schema as RecordSchema;
}

function toCollectionView(row: Collection): CollectionView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId === null || row.workflowId === '' ? null : row.workflowId,
    key: row.key,
    name: row.name,
    description: row.description,
    schema: collectionSchemaOf(row),
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toRecordView(row: {
  id: string;
  workspaceId: string;
  collectionId: string;
  externalKey: string | null;
  data: Record<string, unknown>;
  searchText: string | null;
  version: number;
  createdByType: string | null;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}): CollectionRecordView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    collectionId: row.collectionId,
    externalKey: row.externalKey,
    data: row.data,
    searchText: row.searchText ?? '',
    version: row.version,
    createdByType: row.createdByType,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null
  };
}

function assertCollectionKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw errors.validation('Collection key must be a non-empty string');
  }
  const trimmed = key.trim();
  if (trimmed.length > MAX_COLLECTION_KEY_LENGTH) {
    throw errors.validation(
      `Collection key must be ${MAX_COLLECTION_KEY_LENGTH} characters or fewer`
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed)) {
    throw errors.validation(
      'Collection key must start with a letter or digit and contain only letters, digits, "_", "." or "-"'
    );
  }
  return trimmed;
}

function assertCollectionName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw errors.validation('Collection name must be a non-empty string');
  }
  return name.trim();
}

function assertRecordObject(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw errors.validation('Record data must be a JSON object');
  }
  const record = data as Record<string, unknown>;
  const sizeBytes = new TextEncoder().encode(JSON.stringify(record)).length;
  if (sizeBytes > MAX_RECORD_BYTES) {
    throw errors.validation(
      `Record data exceeds the ${MAX_RECORD_BYTES} byte limit (got ${sizeBytes})`,
      { sizeBytes, limit: MAX_RECORD_BYTES }
    );
  }
  return record;
}

function normalizeExternalKey(externalKey: string | null | undefined): string | null {
  if (externalKey === null || externalKey === undefined) return null;
  const trimmed = externalKey.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_EXTERNAL_KEY_LENGTH) {
    throw errors.validation(`externalKey must be ${MAX_EXTERNAL_KEY_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/** Lowercased concatenation of every scalar value plus the external key. */
export function buildSearchText(
  data: Record<string, unknown>,
  externalKey?: string | null
): string {
  const parts: string[] = [];
  collectScalars(data, parts);
  if (externalKey) parts.push(externalKey);
  return parts.join(' ').toLowerCase().slice(0, 8000);
}

function collectScalars(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, out);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectScalars(item, out);
  }
}

function coarseTextPrefilter(filter: RecordFilter | undefined): SQL[] {
  const clauses: SQL[] = [];
  for (const condition of filter ?? []) {
    if (
      condition.op !== 'contains' &&
      condition.op !== 'starts_with' &&
      condition.op !== 'ends_with'
    ) {
      continue;
    }
    if (typeof condition.value !== 'string' || condition.value.length === 0) continue;
    const needle = condition.value.toLowerCase();
    clauses.push(
      sql`${collectionRecords.searchText} LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\'`
    );
  }
  return clauses;
}

function parseSort(sort: unknown): RecordSort[] {
  if (sort === undefined || sort === null) {
    return [{ field: 'createdAt', direction: 'desc' }];
  }
  if (!Array.isArray(sort) || sort.length === 0) {
    throw errors.validation('sort must be a non-empty array of { field, direction } objects');
  }
  return sort.map((entry) => {
    const result = recordSortSchema.safeParse(entry);
    if (!result.success) {
      throw errors.validation('Invalid sort entry', {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      });
    }
    return result.data;
  });
}

function compareRecords(
  a: CollectionRecordView,
  b: CollectionRecordView,
  sorts: RecordSort[]
): number {
  for (const sort of sorts) {
    const left = readRecordField(a, sort.field);
    const right = readRecordField(b, sort.field);
    const delta = compareValues(left, right);
    if (delta !== 0) return sort.direction === 'desc' ? -delta : delta;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  const nullOrder = nullishOrder(left, right);
  if (nullOrder !== null) return nullOrder;
  if (typeof left === 'number' && typeof right === 'number') return numericOrder(left, right);
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : left ? 1 : -1;
  }
  return lexicographic(left, right);
}

function nullishOrder(left: unknown, right: unknown): number | null {
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return null;
}

function lexicographic(left: unknown, right: unknown): number {
  const leftText = String(left);
  const rightText = String(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

function numericOrder(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function clampFindLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_FIND_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_FIND_LIMIT;
  return Math.min(Math.floor(limit), MAX_FIND_LIMIT);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      o?: unknown;
    };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) {
      return parsed.o;
    }
  } catch {
    // fall through to the validation error below
  }
  throw errors.validation('Invalid record cursor');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
