/**
 * File-domain data access.
 *
 * Repositories own queries and row shapes; services own policy (permissions,
 * dedupe decisions, transactions). Keeping every blob/file/provenance/link query
 * here means tenant scoping is applied in one place, and services never assemble
 * ad-hoc SQL that could forget a `workspaceId` predicate.
 *
 * The functions are synchronous on purpose: `bun:sqlite`/Drizzle commit
 * transaction callbacks synchronously (ADR-0004), so a repository that returned
 * promises from inside a transaction would invite the exact early-commit bug that
 * `withTransaction` exists to prevent.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  type Blob,
  blobs,
  type FileExtractedContent,
  type FileLinkRelationship,
  type FileProcessingRun,
  type FileRecord,
  type FileRecordLink,
  type FileSource,
  type FileSourceType,
  type FileWorkflowItemLink,
  fileExtractedContent,
  fileProcessingRuns,
  fileRecords,
  fileSources,
  files,
  fileWorkflowItems,
  type Job,
  jobs,
  type NewBlob,
  type NewFileRecord,
  type ProcessingStatus,
  records,
  type WorkflowFile,
  workflowFiles,
  workflowItems,
  workflows
} from '../db/schema';

/**
 * Tenant-scoped existence checks used inside the ingest transaction.
 *
 * They run *inside* the transaction on purpose: if a caller supplies a work item
 * or record id that does not exist in this workspace, the whole ingest (file,
 * provenance, blob row) must roll back rather than leave an orphaned logical file.
 */
export function assertWorkflowItemInWorkspace(
  db: Executor,
  workspaceId: string,
  workflowItemId: string
): void {
  const found = db
    .select({ id: workflowItems.id })
    .from(workflowItems)
    .where(and(eq(workflowItems.workspaceId, workspaceId), eq(workflowItems.id, workflowItemId)))
    .limit(1)
    .all()[0];
  if (!found) throw errors.notFound('Workflow item', workflowItemId);
}

export function assertRecordInWorkspace(db: Executor, workspaceId: string, recordId: string): void {
  const found = db
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.workspaceId, workspaceId), eq(records.id, recordId)))
    .limit(1)
    .all()[0];
  if (!found) throw errors.notFound('Record', recordId);
}

export function assertWorkflowInWorkspace(
  db: Executor,
  workspaceId: string,
  workflowId: string
): void {
  const found = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.id, workflowId)))
    .limit(1)
    .all()[0];
  if (!found) throw errors.notFound('Workflow', workflowId);
}

export function findBlobByHash(
  db: Executor,
  workspaceId: string,
  contentHash: string
): Blob | undefined {
  return db
    .select()
    .from(blobs)
    .where(and(eq(blobs.workspaceId, workspaceId), eq(blobs.contentHash, contentHash)))
    .limit(1)
    .all()[0];
}

export function findBlobById(db: Executor, workspaceId: string, blobId: string): Blob | undefined {
  return db
    .select()
    .from(blobs)
    .where(and(eq(blobs.workspaceId, workspaceId), eq(blobs.id, blobId)))
    .limit(1)
    .all()[0];
}

export function insertBlob(db: Executor, values: NewBlob): Blob {
  const row = db.insert(blobs).values(values).returning().all()[0];
  if (!row) throw errors.internal('Failed to insert blob', { workspaceId: values.workspaceId });
  return row;
}

/**
 * Insert a blob row, tolerating a concurrent writer that inserted the same
 * `(workspaceId, contentHash)` first. Returns undefined on conflict so the caller
 * can re-read the winner's row and treat the ingest as deduplicated.
 */
export function insertBlobIfAbsent(db: Executor, values: NewBlob): Blob | undefined {
  return db.insert(blobs).values(values).onConflictDoNothing().returning().all()[0];
}

export function updateBlob(
  db: Executor,
  blobId: string,
  patch: Partial<{ orphanedAt: number | null; verifiedAt: number | null; updatedAt: number }>
): Blob | undefined {
  return db.update(blobs).set(patch).where(eq(blobs.id, blobId)).returning().all()[0];
}

export function findFile(
  db: Executor,
  workspaceId: string,
  fileId: string,
  options: { includeDeleted?: boolean } = {}
): FileRecord | undefined {
  const conditions = [eq(files.workspaceId, workspaceId), eq(files.id, fileId)];
  if (!options.includeDeleted) conditions.push(isNull(files.deletedAt));
  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .limit(1)
    .all()[0];
}

export interface CompatibleFileQuery {
  workspaceId: string;
  blobId: string;
  filename: string;
  kind: FileRecord['kind'];
  primaryWorkflowId: string | null;
  sourceType: FileSourceType;
}

/**
 * Find a logical file that the incoming bytes can extend rather than duplicate.
 *
 * Reuse requires identical content *and* identical logical identity (filename,
 * kind, primary workflow and source channel). Two different source channels for
 * the same bytes are genuinely distinct provenance, so they get distinct logical
 * files over one shared blob — which is exactly what ADR-0009 permits.
 */
export function findCompatibleFile(
  db: Executor,
  query: CompatibleFileQuery
): FileRecord | undefined {
  const conditions = [
    eq(files.workspaceId, query.workspaceId),
    eq(files.blobId, query.blobId),
    eq(files.originalFilename, query.filename),
    eq(files.kind, query.kind),
    isNull(files.deletedAt)
  ];
  conditions.push(
    query.primaryWorkflowId === null
      ? isNull(files.primaryWorkflowId)
      : eq(files.primaryWorkflowId, query.primaryWorkflowId)
  );

  const candidates = db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(asc(files.createdAt))
    .all();

  for (const candidate of candidates) {
    if (hasFileSourceOfType(db, candidate.id, query.sourceType)) return candidate;
  }
  return undefined;
}

function hasFileSourceOfType(db: Executor, fileId: string, sourceType: FileSourceType): boolean {
  return (
    db
      .select({ id: fileSources.id })
      .from(fileSources)
      .where(and(eq(fileSources.fileId, fileId), eq(fileSources.sourceType, sourceType)))
      .limit(1)
      .all().length > 0
  );
}

export function insertFile(db: Executor, values: NewFileRecord): FileRecord {
  const row = db.insert(files).values(values).returning().all()[0];
  if (!row) throw errors.internal('Failed to insert file', { workspaceId: values.workspaceId });
  return row;
}

export type NewFileSource = typeof fileSources.$inferInsert;

export function insertFileSource(db: Executor, values: NewFileSource): FileSource {
  const row = db.insert(fileSources).values(values).returning().all()[0];
  if (!row) throw errors.internal('Failed to insert file source', { fileId: values.fileId });
  return row;
}

export function listFileSources(db: Executor, workspaceId: string, fileId: string): FileSource[] {
  return db
    .select()
    .from(fileSources)
    .where(and(eq(fileSources.workspaceId, workspaceId), eq(fileSources.fileId, fileId)))
    .orderBy(desc(fileSources.createdAt))
    .all();
}

export function listWorkflowFilesForFile(
  db: Executor,
  workspaceId: string,
  fileId: string,
  options: { includeRemoved?: boolean } = {}
): WorkflowFile[] {
  const conditions = [eq(workflowFiles.workspaceId, workspaceId), eq(workflowFiles.fileId, fileId)];
  if (!options.includeRemoved) conditions.push(isNull(workflowFiles.removedAt));
  return db
    .select()
    .from(workflowFiles)
    .where(and(...conditions))
    .all();
}

export function listFileWorkflowItemLinksForFile(
  db: Executor,
  workspaceId: string,
  fileId: string,
  options: { includeRemoved?: boolean } = {}
): FileWorkflowItemLink[] {
  const conditions = [
    eq(fileWorkflowItems.workspaceId, workspaceId),
    eq(fileWorkflowItems.fileId, fileId)
  ];
  if (!options.includeRemoved) conditions.push(isNull(fileWorkflowItems.removedAt));
  return db
    .select()
    .from(fileWorkflowItems)
    .where(and(...conditions))
    .all();
}

export function listFileWorkflowItemLinksForWorkflowItem(
  db: Executor,
  workspaceId: string,
  workflowItemId: string,
  options: { includeRemoved?: boolean } = {}
): FileWorkflowItemLink[] {
  const conditions = [
    eq(fileWorkflowItems.workspaceId, workspaceId),
    eq(fileWorkflowItems.workflowItemId, workflowItemId)
  ];
  if (!options.includeRemoved) conditions.push(isNull(fileWorkflowItems.removedAt));
  return db
    .select()
    .from(fileWorkflowItems)
    .where(and(...conditions))
    .orderBy(desc(fileWorkflowItems.createdAt))
    .all();
}

export function listFileRecordLinksForFile(
  db: Executor,
  workspaceId: string,
  fileId: string,
  options: { includeRemoved?: boolean } = {}
): FileRecordLink[] {
  const conditions = [eq(fileRecords.workspaceId, workspaceId), eq(fileRecords.fileId, fileId)];
  if (!options.includeRemoved) conditions.push(isNull(fileRecords.removedAt));
  return db
    .select()
    .from(fileRecords)
    .where(and(...conditions))
    .all();
}

export function listFileRecordLinksForRecord(
  db: Executor,
  workspaceId: string,
  recordId: string,
  options: { includeRemoved?: boolean } = {}
): FileRecordLink[] {
  const conditions = [eq(fileRecords.workspaceId, workspaceId), eq(fileRecords.recordId, recordId)];
  if (!options.includeRemoved) conditions.push(isNull(fileRecords.removedAt));
  return db
    .select()
    .from(fileRecords)
    .where(and(...conditions))
    .orderBy(desc(fileRecords.createdAt))
    .all();
}

export type UpsertFileWorkflowItemLinkInput = {
  workspaceId: string;
  workflowItemId: string;
  fileId: string;
  relationship: FileLinkRelationship;
  caption?: string | null;
  addedByType?: FileWorkflowItemLink['addedByType'];
  addedById?: string | null;
  addedByLabel?: string | null;
  runId?: string | null;
};

/**
 * Link a file to a WorkflowItem. The unique key is
 * `(fileId, workflowItemId, relationship)`, so re-linking a previously removed
 * relationship clears `removedAt` instead of creating a second row — which keeps
 * "is this file still attached" a single-row question.
 */
export function upsertFileWorkflowItemLink(
  db: Executor,
  input: UpsertFileWorkflowItemLinkInput
): FileWorkflowItemLink {
  const now = Date.now();
  const existing = db
    .select()
    .from(fileWorkflowItems)
    .where(
      and(
        eq(fileWorkflowItems.workflowItemId, input.workflowItemId),
        eq(fileWorkflowItems.fileId, input.fileId),
        eq(fileWorkflowItems.relationship, input.relationship)
      )
    )
    .limit(1)
    .all()[0];

  if (existing) {
    const updated = db
      .update(fileWorkflowItems)
      .set({
        removedAt: null,
        caption: input.caption ?? existing.caption,
        runId: input.runId ?? null
      })
      .where(eq(fileWorkflowItems.id, existing.id))
      .returning()
      .all()[0];
    if (!updated)
      throw errors.internal('Failed to re-link workflow item file', { fileId: input.fileId });
    return updated;
  }

  const row = db
    .insert(fileWorkflowItems)
    .values({
      workspaceId: input.workspaceId,
      workflowItemId: input.workflowItemId,
      fileId: input.fileId,
      relationship: input.relationship,
      caption: input.caption ?? null,
      addedByType: input.addedByType ?? null,
      addedById: input.addedById ?? null,
      addedByLabel: input.addedByLabel ?? null,
      runId: input.runId ?? null,
      createdAt: now
    })
    .returning()
    .all()[0];
  if (!row) throw errors.internal('Failed to link workflow item file', { fileId: input.fileId });
  return row;
}

export type UpsertFileRecordLinkInput = {
  workspaceId: string;
  recordId: string;
  fileId: string;
  relationship: FileLinkRelationship;
  caption?: string | null;
  addedByType?: FileRecordLink['addedByType'];
  addedById?: string | null;
  addedByLabel?: string | null;
  runId?: string | null;
};

/** Link a file to a Record as durable evidence; same re-link semantics as work. */
export function upsertFileRecordLink(
  db: Executor,
  input: UpsertFileRecordLinkInput
): FileRecordLink {
  const now = Date.now();
  const existing = db
    .select()
    .from(fileRecords)
    .where(
      and(
        eq(fileRecords.recordId, input.recordId),
        eq(fileRecords.fileId, input.fileId),
        eq(fileRecords.relationship, input.relationship)
      )
    )
    .limit(1)
    .all()[0];

  if (existing) {
    const updated = db
      .update(fileRecords)
      .set({
        removedAt: null,
        caption: input.caption ?? existing.caption,
        runId: input.runId ?? null
      })
      .where(eq(fileRecords.id, existing.id))
      .returning()
      .all()[0];
    if (!updated) throw errors.internal('Failed to re-link record file', { fileId: input.fileId });
    return updated;
  }

  const row = db
    .insert(fileRecords)
    .values({
      workspaceId: input.workspaceId,
      recordId: input.recordId,
      fileId: input.fileId,
      relationship: input.relationship,
      caption: input.caption ?? null,
      addedByType: input.addedByType ?? null,
      addedById: input.addedById ?? null,
      addedByLabel: input.addedByLabel ?? null,
      runId: input.runId ?? null,
      createdAt: now
    })
    .returning()
    .all()[0];
  if (!row) throw errors.internal('Failed to link record file', { fileId: input.fileId });
  return row;
}

export function upsertWorkflowFile(
  db: Executor,
  input: {
    workspaceId: string;
    workflowId: string;
    fileId: string;
    contextLabel?: string | null;
    addedByType?: WorkflowFile['addedByType'];
    addedById?: string | null;
  }
): WorkflowFile {
  const existing = db
    .select()
    .from(workflowFiles)
    .where(
      and(eq(workflowFiles.workflowId, input.workflowId), eq(workflowFiles.fileId, input.fileId))
    )
    .limit(1)
    .all()[0];

  if (existing) {
    const updated = db
      .update(workflowFiles)
      .set({
        removedAt: null,
        contextLabel: input.contextLabel ?? existing.contextLabel,
        addedByType: input.addedByType ?? existing.addedByType,
        addedById: input.addedById ?? existing.addedById
      })
      .where(eq(workflowFiles.id, existing.id))
      .returning()
      .all()[0];
    if (!updated)
      throw errors.internal('Failed to re-add workflow context', { fileId: input.fileId });
    return updated;
  }

  const row = db
    .insert(workflowFiles)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      fileId: input.fileId,
      contextLabel: input.contextLabel ?? null,
      addedByType: input.addedByType ?? null,
      addedById: input.addedById ?? null,
      createdAt: Date.now()
    })
    .returning()
    .all()[0];
  if (!row) throw errors.internal('Failed to add workflow context', { fileId: input.fileId });
  return row;
}

export function findProcessingRunByKey(
  db: Executor,
  fileId: string,
  processingKey: string
): FileProcessingRun | undefined {
  return db
    .select()
    .from(fileProcessingRuns)
    .where(
      and(
        eq(fileProcessingRuns.fileId, fileId),
        eq(fileProcessingRuns.processingKey, processingKey)
      )
    )
    .limit(1)
    .all()[0];
}

export type NewProcessingRun = typeof fileProcessingRuns.$inferInsert;

export function insertProcessingRun(db: Executor, values: NewProcessingRun): FileProcessingRun {
  const row = db.insert(fileProcessingRuns).values(values).returning().all()[0];
  if (!row) throw errors.internal('Failed to create processing run', { fileId: values.fileId });
  return row;
}

export function updateProcessingRun(
  db: Executor,
  runId: string,
  patch: Partial<{
    status: ProcessingStatus;
    attempt: number;
    jobId: string | null;
    providerId: string | null;
    modelId: string | null;
    resultSummary: string | null;
    error: string | null;
    errorCode: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    durationMs: number | null;
  }>
): FileProcessingRun | undefined {
  return db
    .update(fileProcessingRuns)
    .set(patch)
    .where(eq(fileProcessingRuns.id, runId))
    .returning()
    .all()[0];
}

export function findExtractedContentForRun(
  db: Executor,
  runId: string
): FileExtractedContent | undefined {
  return db
    .select()
    .from(fileExtractedContent)
    .where(eq(fileExtractedContent.processingRunId, runId))
    .limit(1)
    .all()[0];
}

export function findLatestExtractedContent(
  db: Executor,
  workspaceId: string,
  fileId: string
): FileExtractedContent | undefined {
  return db
    .select()
    .from(fileExtractedContent)
    .where(
      and(
        eq(fileExtractedContent.workspaceId, workspaceId),
        eq(fileExtractedContent.fileId, fileId)
      )
    )
    .orderBy(desc(fileExtractedContent.createdAt))
    .limit(1)
    .all()[0];
}

export type NewExtractedContent = typeof fileExtractedContent.$inferInsert;

/** Replace the content row for a run so retries cannot accumulate duplicates. */
export function replaceExtractedContentForRun(
  db: Executor,
  runId: string,
  values: NewExtractedContent
): FileExtractedContent {
  db.delete(fileExtractedContent).where(eq(fileExtractedContent.processingRunId, runId)).run();
  const row = db.insert(fileExtractedContent).values(values).returning().all()[0];
  if (!row) throw errors.internal('Failed to persist extracted content', { runId });
  return row;
}

export function countRetainedFilesForBlob(db: Executor, blobId: string): number {
  const rows = db
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(eq(files.blobId, blobId), isNull(files.deletedAt)))
    .all();
  return rows[0]?.count ?? 0;
}

export type SyncJobInput = {
  workspaceId: string;
  type: Job['type'];
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  workflowItemId?: string | null;
  recordId?: string | null;
  runId?: string | null;
};

/**
 * Enqueue a durable job synchronously, inside the caller's transaction.
 *
 * `SqliteJobQueue.enqueue` is `async`, and the first `await` suspends it to a
 * microtask even though the driver is synchronous — so calling it inside a
 * `withTransaction` callback would defer the insert until after the commit
 * (ADR-0004). Rather than give up atomicity ("file linked but processing never
 * queued"), or make the queue's public contract synchronous, this focused helper
 * performs the same insert + `job.enqueued` audit inline for file processing.
 */
export function enqueueJobSync(db: Executor, input: SyncJobInput): Job {
  const now = Date.now();
  if (input.dedupeKey) {
    const active = db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, input.workspaceId),
          eq(jobs.dedupeKey, input.dedupeKey),
          inArray(jobs.status, ['pending', 'leased'])
        )
      )
      .limit(1)
      .all()[0];
    if (active) return active;
  }

  const row = db
    .insert(jobs)
    .values({
      workspaceId: input.workspaceId,
      type: input.type,
      queue: 'default',
      payload: input.payload as never,
      status: 'pending',
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      availableAt: now,
      dedupeKey: input.dedupeKey ?? null,
      workflowItemId: input.workflowItemId ?? null,
      recordId: input.recordId ?? null,
      runId: input.runId ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!row) throw errors.internal('Failed to enqueue job', { type: input.type });

  writeAudit(db, {
    workspaceId: input.workspaceId,
    action: AuditActions.jobEnqueued,
    entityType: 'job',
    entityId: row.id,
    jobId: row.id,
    workflowItemId: row.workflowItemId,
    recordId: row.recordId,
    runId: row.runId,
    summary: `Job ${input.type} enqueued`,
    data: { type: input.type, dedupeKey: input.dedupeKey ?? null }
  });
  return row;
}
