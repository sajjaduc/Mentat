/**
 * FileService implementation.
 *
 * Ingestion is the security-critical path in this module, so the ordering is
 * deliberate: hash the bytes before any expensive work, resolve storage from
 * workspace configuration, write the physical object *outside* any transaction
 * (ADR-0004 forbids I/O inside one), then create the logical file, its
 * provenance, its work-item/record links and its processing job in a single
 * transaction. That is what makes `deduplicated` trustworthy and what guarantees
 * a file is never created without provenance.
 */
import { AuditActions, writeAudit } from '../audit/ledger';
import { fileMaxBytes } from '../config/env';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { sha256Hex } from '../core/hash';
import { uuidv7 } from '../core/ids';
import { type Executor, getDb, withTransaction } from '../db/client';
import type { Blob, FileKind, FileLinkRelationship, FileRecord } from '../db/schema';
import { type BlobStore, blobKeyFor } from '../storage/blob-store';
import { readWorkspaceStorageSettings, resolveBlobStore } from '../storage/index';
import {
  type FileService,
  type FileSummaryView,
  type IngestFileInput,
  type IngestFileResult,
  setFileService
} from './contracts';
import { sanitizeFilename } from './filenames';
import { detectMimeType, normalizeMimeType } from './mime';
import * as repo from './repository';
import { fileSummaryView } from './views';

export type {
  FileService,
  FileSummaryView,
  IngestFileInput,
  IngestFileResult
} from './contracts';

export interface FileServiceOptions {
  /** Default executor when a method is called without one. */
  db?: Executor;
  /** Test/bootstrap override; skips per-workspace storage resolution. */
  blobStore?: BlobStore;
}

export class DefaultFileService implements FileService {
  private readonly defaultDb: Executor | null;
  private readonly blobStore: BlobStore | null;

  constructor(options: FileServiceOptions = {}) {
    this.defaultDb = options.db ?? null;
    this.blobStore = options.blobStore ?? null;
  }

  async ingest(
    actor: ActorContext,
    input: IngestFileInput,
    db?: Executor
  ): Promise<IngestFileResult> {
    assertPermission(actor, Permissions.fileWrite, 'Not permitted to ingest files');
    if (input.workflowItemId) {
      assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to link files to work');
    }
    if (input.recordId) {
      assertPermission(actor, Permissions.recordWrite, 'Not permitted to link files to records');
    }

    const executor = this.executor(db);
    const filename = sanitizeFilename(input.filename);
    const bytes = input.bytes;
    if (bytes.length === 0) throw errors.validation('File must not be empty');

    const settings = readWorkspaceStorageSettings(executor, actor.workspaceId);
    const limit = settings.maxFileBytes > 0 ? settings.maxFileBytes : fileMaxBytes();
    if (bytes.length > limit) {
      throw errors.validation(`File exceeds the ${limit} byte limit for this workspace`, {
        size: bytes.length,
        limit
      });
    }

    const declaredMime = normalizeMimeType(input.mimeType);
    const detectedMime = detectMimeType(filename, bytes);
    const mimeType = declaredMime ?? detectedMime;

    // Hash before any expensive work: dedupe is decided on bytes, not metadata.
    const contentHash = await sha256Hex(bytes);
    const kind: FileKind = input.kind ?? 'upload';
    const primaryWorkflowId = input.workflowId ?? null;
    const occurredAt = input.source.occurredAt ?? Date.now();
    const runId = input.runId ?? actor.runId ?? null;
    const linkWorkflowItemId = input.workflowItemId ?? input.source.workflowItemId ?? null;
    const linkRecordId = input.recordId ?? input.source.recordId ?? null;
    const relationship: FileLinkRelationship = input.relationship ?? 'attachment';

    // Physical write happens before the transaction (ADR-0004 forbids I/O inside
    // one); the blob *row* is created inside the same transaction as the file so a
    // failed link cannot leave a dangling file. A tombstoned (orphaned) row is
    // treated as absent: its bytes were reclaimed, so they must be stored again.
    const found = repo.findBlobByHash(executor, actor.workspaceId, contentHash);
    const preexisting = found && found.orphanedAt === null ? found : undefined;
    let storageKey: string | null = null;
    let storeKind: 'local' | 'gcs' =
      preexisting?.storageProvider ?? found?.storageProvider ?? 'local';
    if (!preexisting) {
      const store = await this.store(executor, actor.workspaceId);
      storageKey = found?.storageKey ?? blobKeyFor(actor.workspaceId, contentHash);
      storeKind = store.kind === 'gcs' ? 'gcs' : 'local';
      await store.put(storageKey, bytes, {
        contentHash,
        contentType: mimeType
      });
    }

    const result = await withTransaction(executor, (tx) => {
      const { blob, deduplicated } = ensureBlobRow(tx, actor.workspaceId, {
        contentHash,
        size: bytes.length,
        mimeType,
        storeKind,
        storageKey
      });

      // Validate requested links inside the transaction so a bad id rolls the
      // whole ingest back instead of leaving a file without its link.
      if (linkWorkflowItemId) {
        repo.assertWorkflowItemInWorkspace(tx, actor.workspaceId, linkWorkflowItemId);
      }
      if (linkRecordId) repo.assertRecordInWorkspace(tx, actor.workspaceId, linkRecordId);
      if (primaryWorkflowId) {
        repo.assertWorkflowInWorkspace(tx, actor.workspaceId, primaryWorkflowId);
      }

      const compatible = repo.findCompatibleFile(tx, {
        workspaceId: actor.workspaceId,
        blobId: blob.id,
        filename,
        kind,
        primaryWorkflowId,
        sourceType: input.source.type
      });
      const reusedFile = Boolean(compatible);
      const file =
        compatible ??
        repo.insertFile(tx, {
          id: uuidv7(),
          workspaceId: actor.workspaceId,
          blobId: blob.id,
          originalFilename: filename,
          mimeType,
          size: bytes.length,
          kind,
          status: 'pending',
          primaryWorkflowId,
          createdByType: actor.actorType,
          createdById: actor.actorId,
          createdByLabel: actor.actorLabel,
          runId,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });

      repo.insertFileSource(tx, {
        id: uuidv7(),
        workspaceId: actor.workspaceId,
        fileId: file.id,
        sourceType: input.source.type,
        sourceReference: input.source.reference ?? null,
        sourceLabel: input.source.label ?? null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        runId,
        toolCallId: actor.toolCallId ?? null,
        triggerEventId: input.source.triggerEventId ?? null,
        deduplicated,
        observedContentHash: contentHash,
        detail: input.source.detail ?? null,
        occurredAt,
        createdAt: Date.now()
      });

      writeIngestLinks(tx, actor, {
        fileId: file.id,
        relationship,
        runId,
        workflowItemId: linkWorkflowItemId,
        recordId: linkRecordId,
        workflowId: primaryWorkflowId
      });

      writeAudit(tx, {
        workspaceId: actor.workspaceId,
        action: AuditActions.fileIngested,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'file',
        entityId: file.id,
        fileId: file.id,
        workflowItemId: linkWorkflowItemId,
        recordId: linkRecordId,
        workflowId: primaryWorkflowId,
        runId,
        summary: `File "${filename}" ingested`,
        data: {
          filename,
          mimeType,
          detectedMime,
          size: bytes.length,
          contentHash,
          sourceType: input.source.type,
          deduplicated,
          reusedFile
        }
      });
      if (deduplicated) {
        writeAudit(tx, {
          workspaceId: actor.workspaceId,
          action: AuditActions.fileBlobDeduplicated,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          entityType: 'blob',
          entityId: blob.id,
          fileId: file.id,
          workflowId: primaryWorkflowId,
          summary: 'Existing blob reused for identical bytes',
          data: { contentHash, blobId: blob.id }
        });
      }

      let processingQueued = false;
      if (input.process !== false) {
        const job = repo.enqueueJobSync(tx, {
          workspaceId: actor.workspaceId,
          type: 'file.process',
          payload: {
            fileId: file.id,
            workflowId: primaryWorkflowId,
            force: input.forceReprocess ?? false
          },
          // Duplicate ingests while processing is active must not queue twice;
          // an explicit reprocess is allowed to queue a fresh run.
          dedupeKey: input.forceReprocess ? null : `file.process:${file.id}`,
          workflowItemId: linkWorkflowItemId,
          recordId: linkRecordId,
          runId
        });
        processingQueued = true;
        writeAudit(tx, {
          workspaceId: actor.workspaceId,
          action: AuditActions.fileProcessingQueued,
          actorType: actor.actorType,
          actorId: actor.actorId,
          entityType: 'file',
          entityId: file.id,
          fileId: file.id,
          workflowId: primaryWorkflowId,
          jobId: job.id,
          runId,
          summary: 'File processing queued',
          data: { fileId: file.id, jobId: job.id, force: input.forceReprocess ?? false }
        });
      }

      return { blob, file, reusedFile, processingQueued, deduplicated };
    });

    return {
      fileId: result.file.id,
      blobId: result.blob.id,
      contentHash,
      size: bytes.length,
      deduplicated: result.deduplicated,
      reusedFile: result.reusedFile,
      processingQueued: result.processingQueued
    };
  }

  async requireFile(actor: ActorContext, fileId: string, db?: Executor): Promise<FileSummaryView> {
    assertPermission(actor, Permissions.fileRead, 'Not permitted to read files');
    const executor = this.executor(db);
    const file = repo.findFile(executor, actor.workspaceId, fileId);
    if (!file) throw errors.notFound('File', fileId);
    return this.toView(executor, file);
  }

  async listForWorkflowItem(
    actor: ActorContext,
    workflowItemId: string,
    db?: Executor
  ): Promise<FileSummaryView[]> {
    assertPermission(actor, Permissions.fileRead, 'Not permitted to read files');
    const executor = this.executor(db);
    const links = repo.listFileWorkflowItemLinksForWorkflowItem(
      executor,
      actor.workspaceId,
      workflowItemId
    );
    const views: FileSummaryView[] = [];
    for (const link of links) {
      const file = repo.findFile(executor, actor.workspaceId, link.fileId);
      if (file) views.push(this.toView(executor, file));
    }
    return views;
  }

  async listForRecord(
    actor: ActorContext,
    recordId: string,
    db?: Executor
  ): Promise<FileSummaryView[]> {
    assertPermission(actor, Permissions.fileRead, 'Not permitted to read files');
    const executor = this.executor(db);
    const links = repo.listFileRecordLinksForRecord(executor, actor.workspaceId, recordId);
    const views: FileSummaryView[] = [];
    for (const link of links) {
      const file = repo.findFile(executor, actor.workspaceId, link.fileId);
      if (file) views.push(this.toView(executor, file));
    }
    return views;
  }

  async linkToWorkflowItem(
    actor: ActorContext,
    input: {
      fileId: string;
      workflowItemId: string;
      relationship?: FileLinkRelationship;
      caption?: string | null;
      runId?: string | null;
    },
    db?: Executor
  ): Promise<void> {
    assertPermission(actor, Permissions.fileWrite, 'Not permitted to link files');
    assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to link files to work');
    const executor = this.executor(db);
    const runId = input.runId ?? actor.runId ?? null;

    await withTransaction(executor, (tx) => {
      const file = repo.findFile(tx, actor.workspaceId, input.fileId);
      if (!file) throw errors.notFound('File', input.fileId);
      repo.assertWorkflowItemInWorkspace(tx, actor.workspaceId, input.workflowItemId);
      repo.upsertFileWorkflowItemLink(tx, {
        workspaceId: actor.workspaceId,
        workflowItemId: input.workflowItemId,
        fileId: input.fileId,
        relationship: input.relationship ?? 'attachment',
        caption: input.caption ?? null,
        addedByType: actor.actorType,
        addedById: actor.actorId,
        addedByLabel: actor.actorLabel,
        runId
      });
      writeAudit(tx, {
        workspaceId: actor.workspaceId,
        action: AuditActions.workflowItemFileLinked,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'file',
        entityId: input.fileId,
        fileId: input.fileId,
        workflowItemId: input.workflowItemId,
        runId,
        summary: `File linked to work item ${input.workflowItemId}`,
        data: { relationship: input.relationship ?? 'attachment' }
      });
    });
  }

  async linkToRecord(
    actor: ActorContext,
    input: {
      fileId: string;
      recordId: string;
      relationship?: FileLinkRelationship;
      caption?: string | null;
      runId?: string | null;
    },
    db?: Executor
  ): Promise<void> {
    assertPermission(actor, Permissions.fileWrite, 'Not permitted to link files');
    assertPermission(actor, Permissions.recordWrite, 'Not permitted to link files to records');
    const executor = this.executor(db);
    const runId = input.runId ?? actor.runId ?? null;

    await withTransaction(executor, (tx) => {
      const file = repo.findFile(tx, actor.workspaceId, input.fileId);
      if (!file) throw errors.notFound('File', input.fileId);
      repo.assertRecordInWorkspace(tx, actor.workspaceId, input.recordId);
      repo.upsertFileRecordLink(tx, {
        workspaceId: actor.workspaceId,
        recordId: input.recordId,
        fileId: input.fileId,
        relationship: input.relationship ?? 'attachment',
        caption: input.caption ?? null,
        addedByType: actor.actorType,
        addedById: actor.actorId,
        addedByLabel: actor.actorLabel,
        runId
      });
      writeAudit(tx, {
        workspaceId: actor.workspaceId,
        action: AuditActions.recordFileLinked,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'file',
        entityId: input.fileId,
        fileId: input.fileId,
        recordId: input.recordId,
        runId,
        summary: `File linked to record ${input.recordId}`,
        data: { relationship: input.relationship ?? 'attachment' }
      });
    });
  }

  async addWorkflowContext(
    actor: ActorContext,
    input: { fileId: string; workflowId: string; contextLabel?: string | null },
    db?: Executor
  ): Promise<void> {
    assertPermission(actor, Permissions.fileWrite, 'Not permitted to change file context');
    const executor = this.executor(db);
    await withTransaction(executor, (tx) => {
      const file = repo.findFile(tx, actor.workspaceId, input.fileId);
      if (!file) throw errors.notFound('File', input.fileId);
      repo.assertWorkflowInWorkspace(tx, actor.workspaceId, input.workflowId);
      repo.upsertWorkflowFile(tx, {
        workspaceId: actor.workspaceId,
        workflowId: input.workflowId,
        fileId: input.fileId,
        contextLabel: input.contextLabel ?? null,
        addedByType: actor.actorType,
        addedById: actor.actorId
      });
      writeAudit(tx, {
        workspaceId: actor.workspaceId,
        action: AuditActions.fileContextAdded,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'file',
        entityId: input.fileId,
        fileId: input.fileId,
        workflowId: input.workflowId,
        runId: actor.runId ?? null,
        summary: 'File added to workflow context',
        data: { contextLabel: input.contextLabel ?? null }
      });
    });
  }

  async getExtractedText(
    actor: ActorContext,
    fileId: string,
    db?: Executor
  ): Promise<{ text: string; pageCount: number | null; createdAt: number } | null> {
    assertPermission(actor, Permissions.fileRead, 'Not permitted to read file content');
    const executor = this.executor(db);
    const file = repo.findFile(executor, actor.workspaceId, fileId);
    if (!file) throw errors.notFound('File', fileId);
    const content = repo.findLatestExtractedContent(executor, actor.workspaceId, fileId);
    if (!content) return null;
    return { text: content.text, pageCount: content.pageCount, createdAt: content.createdAt };
  }

  async queueProcessing(
    actor: ActorContext,
    input: { fileId: string; workflowId?: string | null; force?: boolean },
    db?: Executor
  ): Promise<void> {
    assertPermission(actor, Permissions.fileWrite, 'Not permitted to process files');
    const executor = this.executor(db);
    await withTransaction(executor, (tx) => {
      const file = repo.findFile(tx, actor.workspaceId, input.fileId);
      if (!file) throw errors.notFound('File', input.fileId);
      const workflowId = input.workflowId ?? file.primaryWorkflowId ?? null;
      if (workflowId) repo.assertWorkflowInWorkspace(tx, actor.workspaceId, workflowId);
      const job = repo.enqueueJobSync(tx, {
        workspaceId: actor.workspaceId,
        type: 'file.process',
        payload: { fileId: input.fileId, workflowId, force: input.force ?? false },
        dedupeKey: input.force ? null : `file.process:${input.fileId}`,
        runId: actor.runId ?? null
      });
      writeAudit(tx, {
        workspaceId: actor.workspaceId,
        action: AuditActions.fileProcessingQueued,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'file',
        entityId: input.fileId,
        fileId: input.fileId,
        workflowId,
        jobId: job.id,
        runId: actor.runId ?? null,
        summary: 'File processing queued',
        data: { fileId: input.fileId, force: input.force ?? false }
      });
    });
  }

  /** Build the read model shared by `requireFile`, `listForWorkflowItem` and `listForRecord`. */
  private toView(executor: Executor, file: FileRecord): FileSummaryView {
    return fileSummaryView(executor, file);
  }

  private executor(db?: Executor): Executor {
    const resolved = db ?? this.defaultDb;
    if (!resolved) {
      throw errors.internal('FileService requires a database executor');
    }
    return resolved;
  }

  private async store(executor: Executor, workspaceId: string): Promise<BlobStore> {
    if (this.blobStore) return this.blobStore;
    return resolveBlobStore(executor, workspaceId);
  }
}

/**
 * Resolve the blob row for ingested bytes: reuse a live row, revive a tombstone
 * (its bytes were just re-stored), or insert one while tolerating a concurrent
 * writer that won the unique `(workspaceId, contentHash)` race.
 */
function ensureBlobRow(
  tx: Executor,
  workspaceId: string,
  input: {
    contentHash: string;
    size: number;
    mimeType: string;
    storeKind: 'local' | 'gcs';
    storageKey: string | null;
  }
): { blob: Blob; deduplicated: boolean } {
  const existing = repo.findBlobByHash(tx, workspaceId, input.contentHash);
  if (existing && existing.orphanedAt === null) {
    return { blob: existing, deduplicated: true };
  }
  if (existing) {
    const revived = repo.updateBlob(tx, existing.id, {
      orphanedAt: null,
      verifiedAt: null,
      updatedAt: Date.now()
    });
    if (revived) return { blob: revived, deduplicated: false };
  }
  const key = input.storageKey ?? blobKeyFor(workspaceId, input.contentHash);
  const inserted = repo.insertBlobIfAbsent(tx, {
    id: uuidv7(),
    workspaceId,
    contentHash: input.contentHash,
    size: input.size,
    mimeType: input.mimeType,
    storageProvider: input.storeKind,
    storageKey: key,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  if (inserted) return { blob: inserted, deduplicated: false };
  const raced = repo.findBlobByHash(tx, workspaceId, input.contentHash);
  if (!raced) {
    throw errors.internal('Blob row disappeared during ingest', { contentHash: input.contentHash });
  }
  return { blob: raced, deduplicated: true };
}

/**
 * Persist every requested file link inside the ingest transaction. A link to a
 * missing work item/record/workflow has already been asserted by the caller.
 */
function writeIngestLinks(
  tx: Executor,
  actor: ActorContext,
  input: {
    fileId: string;
    relationship: FileLinkRelationship;
    runId: string | null;
    workflowItemId: string | null;
    recordId: string | null;
    workflowId: string | null;
  }
): void {
  if (input.workflowItemId) {
    repo.upsertFileWorkflowItemLink(tx, {
      workspaceId: actor.workspaceId,
      workflowItemId: input.workflowItemId,
      fileId: input.fileId,
      relationship: input.relationship,
      addedByType: actor.actorType,
      addedById: actor.actorId,
      addedByLabel: actor.actorLabel,
      runId: input.runId
    });
  }
  if (input.recordId) {
    repo.upsertFileRecordLink(tx, {
      workspaceId: actor.workspaceId,
      recordId: input.recordId,
      fileId: input.fileId,
      relationship: input.relationship,
      addedByType: actor.actorType,
      addedById: actor.actorId,
      addedByLabel: actor.actorLabel,
      runId: input.runId
    });
  }
  if (input.workflowId) {
    repo.upsertWorkflowFile(tx, {
      workspaceId: actor.workspaceId,
      workflowId: input.workflowId,
      fileId: input.fileId,
      addedByType: actor.actorType,
      addedById: actor.actorId
    });
  }
}

/** Create a FileService bound to an optional default executor. */
export function createFileService(options: FileServiceOptions = {}): FileService {
  return new DefaultFileService(options);
}

/**
 * Install the process-wide service. Called once at bootstrap; tests call it with
 * their own handle so the locator never points at a stale database.
 */
export function installFileService(options: FileServiceOptions = {}): FileService {
  const service = createFileService(options);
  setFileService(service);
  return service;
}

export function resetFileService(): void {
  setFileService(null);
}

/** Convenience for callers that only have the process-wide handle. */
export function installFileServiceFromEnv(): FileService {
  return installFileService({ db: getDb() });
}
