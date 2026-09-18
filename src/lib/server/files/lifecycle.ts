/**
 * File lifecycle and safe deletion.
 *
 * Removing a file from work, removing a durable record link, removing a
 * workflow's interpretation of it and deleting the logical file are four
 * *different* operations. Collapsing them is how attachment-style systems lose
 * shared content, so each is explicit here:
 *
 *  - unlink only clears the work-item or record ↔file relationship;
 *  - removing workflow context only clears `workflow_files.removedAt`;
 *  - deleting a logical file soft-deletes it, clears its links and its content
 *    index, and leaves the blob alone;
 *  - deleting a blob is a separate, guarded operation that refuses while any
 *    retained `files` row still references it.
 *
 * Every destructive action is audited, and the physical object is removed only
 * after the database no longer claims it — orphaned bytes are recoverable, a
 * dangling database reference to deleted bytes is not.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { moduleLogger } from '../core/logger';
import { type Executor, withTransaction } from '../db/client';
import { blobs, fileRecords, files, fileWorkflowItems, workflowFiles } from '../db/schema';
import { resolveBlobStore } from '../storage/index';
import * as repo from './repository';
import { removeFileContentIndex } from './retrieval';

const log = moduleLogger('files.lifecycle');

export async function unlinkFromWorkflowItem(
  actor: ActorContext,
  input: { fileId: string; workflowItemId: string },
  db?: Executor
): Promise<void> {
  assertPermission(actor, Permissions.fileWrite, 'Not permitted to unlink files');
  const executor = requireExecutor(db);
  await withTransaction(executor, (tx) => {
    const file = repo.findFile(tx, actor.workspaceId, input.fileId);
    if (!file) throw errors.notFound('File', input.fileId);
    const now = Date.now();
    tx.update(fileWorkflowItems)
      .set({ removedAt: now })
      .where(
        and(
          eq(fileWorkflowItems.workspaceId, actor.workspaceId),
          eq(fileWorkflowItems.fileId, input.fileId),
          eq(fileWorkflowItems.workflowItemId, input.workflowItemId),
          isNull(fileWorkflowItems.removedAt)
        )
      )
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.workflowItemFileUnlinked,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'file',
      entityId: input.fileId,
      fileId: input.fileId,
      workflowItemId: input.workflowItemId,
      runId: actor.runId ?? null,
      summary: `File unlinked from work item ${input.workflowItemId}`,
      data: {}
    });
  });
}

/**
 * Remove a durable Record↔file link. The file stays; only this evidence
 * association is cleared.
 */
export async function unlinkFromRecord(
  actor: ActorContext,
  input: { fileId: string; recordId: string },
  db?: Executor
): Promise<void> {
  assertPermission(actor, Permissions.fileWrite, 'Not permitted to unlink files');
  const executor = requireExecutor(db);
  await withTransaction(executor, (tx) => {
    const file = repo.findFile(tx, actor.workspaceId, input.fileId);
    if (!file) throw errors.notFound('File', input.fileId);
    const now = Date.now();
    tx.update(fileRecords)
      .set({ removedAt: now })
      .where(
        and(
          eq(fileRecords.workspaceId, actor.workspaceId),
          eq(fileRecords.fileId, input.fileId),
          eq(fileRecords.recordId, input.recordId),
          isNull(fileRecords.removedAt)
        )
      )
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.recordFileUnlinked,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'file',
      entityId: input.fileId,
      fileId: input.fileId,
      recordId: input.recordId,
      runId: actor.runId ?? null,
      summary: `File unlinked from record ${input.recordId}`,
      data: {}
    });
  });
}

export async function removeWorkflowContext(
  actor: ActorContext,
  input: { fileId: string; workflowId: string },
  db?: Executor
): Promise<void> {
  assertPermission(actor, Permissions.fileWrite, 'Not permitted to remove file context');
  const executor = requireExecutor(db);
  await withTransaction(executor, (tx) => {
    const file = repo.findFile(tx, actor.workspaceId, input.fileId);
    if (!file) throw errors.notFound('File', input.fileId);
    const now = Date.now();
    tx.update(workflowFiles)
      .set({ removedAt: now })
      .where(
        and(
          eq(workflowFiles.workspaceId, actor.workspaceId),
          eq(workflowFiles.fileId, input.fileId),
          eq(workflowFiles.workflowId, input.workflowId),
          isNull(workflowFiles.removedAt)
        )
      )
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'file.context.removed',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'file',
      entityId: input.fileId,
      fileId: input.fileId,
      workflowId: input.workflowId,
      runId: actor.runId ?? null,
      summary: 'File removed from workflow context',
      data: {}
    });
  });
}

/**
 * Soft-delete a logical file. The blob survives: another logical file (or a
 * future reprocessing decision) may still need the bytes.
 */
export async function deleteFile(
  actor: ActorContext,
  fileId: string,
  db?: Executor
): Promise<void> {
  assertPermission(actor, Permissions.fileDelete, 'Not permitted to delete files');
  const executor = requireExecutor(db);
  await withTransaction(executor, (tx) => {
    const file = repo.findFile(tx, actor.workspaceId, fileId);
    if (!file) throw errors.notFound('File', fileId);
    const now = Date.now();
    tx.update(files)
      .set({ deletedAt: now, updatedAt: now, version: sql`${files.version} + 1` })
      .where(and(eq(files.id, fileId), eq(files.workspaceId, actor.workspaceId)))
      .run();
    tx.update(fileWorkflowItems)
      .set({ removedAt: now })
      .where(
        and(
          eq(fileWorkflowItems.workspaceId, actor.workspaceId),
          eq(fileWorkflowItems.fileId, fileId),
          isNull(fileWorkflowItems.removedAt)
        )
      )
      .run();
    tx.update(fileRecords)
      .set({ removedAt: now })
      .where(
        and(
          eq(fileRecords.workspaceId, actor.workspaceId),
          eq(fileRecords.fileId, fileId),
          isNull(fileRecords.removedAt)
        )
      )
      .run();
    tx.update(workflowFiles)
      .set({ removedAt: now })
      .where(
        and(
          eq(workflowFiles.workspaceId, actor.workspaceId),
          eq(workflowFiles.fileId, fileId),
          isNull(workflowFiles.removedAt)
        )
      )
      .run();
    removeFileContentIndex(tx, fileId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.fileDeleted,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'file',
      entityId: fileId,
      fileId,
      runId: actor.runId ?? null,
      summary: `File "${file.originalFilename}" deleted`,
      data: { blobId: file.blobId, filename: file.originalFilename }
    });
  });
}

/** True while any non-deleted logical file still requires these bytes. */
export function isBlobReferenced(executor: Executor, blobId: string): boolean {
  return repo.countRetainedFilesForBlob(executor, blobId) > 0;
}

/**
 * Reclaim a blob's bytes. Refuses while a retained file references it; the check
 * runs inside the transaction that marks the row orphaned, so a concurrent ingest
 * cannot slip in between.
 *
 * The row is tombstoned (`orphanedAt`) rather than deleted: soft-deleted files
 * still carry a foreign key to it, and keeping the row preserves the audit trail.
 * A later ingest of the same bytes revives the row and re-stores the object.
 */
export async function deleteBlob(
  actor: ActorContext,
  input: { blobId: string },
  db?: Executor
): Promise<void> {
  assertPermission(actor, Permissions.fileDelete, 'Not permitted to delete blobs');
  const executor = requireExecutor(db);
  const blob = repo.findBlobById(executor, actor.workspaceId, input.blobId);
  if (!blob) throw errors.notFound('Blob', input.blobId);
  if (blob.orphanedAt !== null) {
    throw errors.precondition('Blob bytes have already been reclaimed', { blobId: input.blobId });
  }

  await withTransaction(executor, (tx) => {
    if (isBlobReferenced(tx, input.blobId)) {
      throw errors.precondition(
        'Blob is still referenced by retained files and cannot be deleted',
        { blobId: input.blobId }
      );
    }
    const now = Date.now();
    tx.update(blobs)
      .set({ orphanedAt: now, updatedAt: now })
      .where(and(eq(blobs.id, input.blobId), eq(blobs.workspaceId, actor.workspaceId)))
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.blobDeleted,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'blob',
      entityId: input.blobId,
      runId: actor.runId ?? null,
      summary: 'Blob bytes reclaimed',
      data: { contentHash: blob.contentHash, size: blob.size }
    });
  });

  // The row is authoritative; a failed physical delete leaves reclaimable
  // orphaned bytes rather than a live blob row pointing at missing bytes.
  try {
    const store = await resolveBlobStore(executor, actor.workspaceId);
    await store.delete(blob.storageKey);
  } catch (error) {
    log.warn('blob tombstoned but physical object removal failed', {
      blobId: input.blobId,
      error
    });
  }
}

function requireExecutor(db?: Executor): Executor {
  if (!db) throw errors.internal('File lifecycle operations require a database executor');
  return db;
}
