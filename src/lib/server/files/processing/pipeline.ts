/**
 * Durable processing pipeline (ADR-0010).
 *
 * `runProcessing` is the only place that turns raw bytes into persisted extracted
 * content. The ordering mirrors ingestion: claim a versioned run row, do the CPU
 * and I/O work outside any transaction, then persist content, generic metadata,
 * the search index and audit in one transaction. A failed attempt records why on
 * the run row so a retry is observable rather than mysterious, and duplicate job
 * delivery reuses the successful run instead of re-extracting.
 *
 * Processing identity (`contentHash + processorType + processorVersion +
 * configurationFingerprint`) lives in `./identity` and is re-exported here.
 */
import { sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../../audit/ledger';
import { errors, toAppError } from '../../core/errors';
import { uuidv7 } from '../../core/ids';
import { type Executor, withTransaction } from '../../db/client';
import type { ActorType, FileMetadata, FileProcessingRun, ProcessingStatus } from '../../db/schema';
import { files } from '../../db/schema';
import type { BlobStore } from '../../storage/blob-store';
import * as repo from '../repository';
import { writeFileContentIndex } from '../retrieval';
import {
  type ProcessingContext,
  type ProcessorRegistry,
  type ProcessorResult,
  unsupported
} from './contracts';
import { configurationFingerprintFor, processingKeyFor } from './identity';
import { defaultProcessorRegistry } from './registry';

export {
  configurationFingerprintFor,
  type ProcessingIdentity,
  processingKeyFor
} from './identity';

export interface ProcessingRunContext {
  db: Executor;
  blobStore: BlobStore;
  workspaceId: string;
  jobId?: string | null;
  actorType?: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  /** Injection seam for tests; defaults to the built-in processors. */
  registry?: ProcessorRegistry;
  /** Options that participate in the configuration fingerprint. */
  configuration?: Record<string, unknown>;
}

export interface RunProcessingOptions {
  fileId: string;
  workflowId?: string | null;
  force?: boolean;
}

export interface ProcessingOutcome {
  fileId: string;
  runId: string;
  processingKey: string;
  processorType: string;
  processorVersion: string;
  status: ProcessingStatus;
  /** True when a compatible successful run already existed. */
  reused: boolean;
  /** True when text was extracted (false for an explicit unsupported outcome). */
  extracted: boolean;
}

export async function runProcessing(
  ctx: ProcessingRunContext,
  options: RunProcessingOptions
): Promise<ProcessingOutcome> {
  const file = repo.findFile(ctx.db, ctx.workspaceId, options.fileId);
  if (!file) throw errors.notFound('File', options.fileId);
  const blob = repo.findBlobById(ctx.db, ctx.workspaceId, file.blobId);
  if (!blob) throw errors.notFound('Blob', file.blobId);

  const registry = ctx.registry ?? defaultProcessorRegistry();
  const resolution = registry.resolve(file.mimeType || blob.mimeType);

  const processorType =
    resolution.outcome === 'resolved' ? resolution.processor.type : 'unsupported';
  const processorVersion = resolution.outcome === 'resolved' ? resolution.processor.version : '1';
  const configurationFingerprint = await configurationFingerprintFor(
    { type: processorType, version: processorVersion },
    ctx.configuration ?? {}
  );
  const processingKey = processingKeyFor({
    contentHash: blob.contentHash,
    processorType,
    processorVersion,
    configurationFingerprint
  });

  const existing = repo.findProcessingRunByKey(ctx.db, options.fileId, processingKey);
  if (!options.force && existing?.status === 'succeeded') {
    return {
      fileId: options.fileId,
      runId: existing.id,
      processingKey,
      processorType: existing.processorType,
      processorVersion: existing.processorVersion,
      status: 'succeeded',
      reused: true,
      extracted: true
    };
  }

  const run = await claimRun(ctx, {
    fileId: options.fileId,
    workflowId: options.workflowId ?? null,
    processingKey,
    processorType,
    processorVersion,
    configurationFingerprint
  });

  try {
    const bytes = await ctx.blobStore.get(blob.storageKey);
    const processContext: ProcessingContext = {
      bytes,
      mimeType: file.mimeType || blob.mimeType,
      filename: file.originalFilename,
      metadata: { size: blob.size, contentHash: blob.contentHash }
    };
    const result =
      resolution.outcome === 'resolved'
        ? await resolution.processor.process(processContext)
        : unsupported(resolution.reason);

    await withTransaction(ctx.db, (tx) => {
      persistResult(tx, {
        ctx,
        run,
        fileId: options.fileId,
        blobMime: blob.mimeType,
        existingMetadata: file.metadata ?? {},
        result,
        processorType,
        processorVersion
      });
      // Keep the portable content index in step with the latest extraction.
      if (result.outcome === 'extracted') {
        writeFileContentIndex(tx, {
          fileId: options.fileId,
          workspaceId: ctx.workspaceId,
          text: result.text
        });
      }
    });

    return {
      fileId: options.fileId,
      runId: run.id,
      processingKey,
      processorType,
      processorVersion,
      status: result.outcome === 'extracted' ? 'succeeded' : 'skipped',
      reused: false,
      extracted: result.outcome === 'extracted'
    };
  } catch (error) {
    await markRunFailed(ctx, {
      run,
      fileId: options.fileId,
      processorType,
      processorVersion,
      error
    });
    throw error;
  }
}

function persistResult(
  tx: Executor,
  input: {
    ctx: ProcessingRunContext;
    run: FileProcessingRun;
    fileId: string;
    blobMime: string;
    existingMetadata: FileMetadata;
    result: ProcessorResult;
    processorType: string;
    processorVersion: string;
  }
): void {
  const { result } = input;
  const now = Date.now();
  const charCount = result.text.length;

  if (result.outcome === 'extracted') {
    repo.replaceExtractedContentForRun(tx, input.run.id, {
      id: uuidv7(),
      workspaceId: input.ctx.workspaceId,
      fileId: input.fileId,
      processingRunId: input.run.id,
      contentKind: result.contentKind,
      text: result.text,
      charCount,
      pageCount: result.pageCount,
      language: result.language,
      segments: result.segments,
      truncated: result.truncated,
      createdAt: now
    });
  }

  const metadata = mergeMetadata(input.existingMetadata, input.blobMime, result);
  tx.update(files)
    .set({
      metadata,
      status: 'ready',
      version: sql`${files.version} + 1`,
      updatedAt: now
    })
    .where(sql`${files.id} = ${input.fileId}`)
    .run();

  repo.updateProcessingRun(tx, input.run.id, {
    status: result.outcome === 'extracted' ? 'succeeded' : 'skipped',
    finishedAt: now,
    durationMs: now - (input.run.startedAt ?? now),
    resultSummary: summarize(input.processorType, input.processorVersion, result)
  });

  writeAudit(tx, {
    workspaceId: input.ctx.workspaceId,
    action: AuditActions.fileProcessingCompleted,
    actorType: input.ctx.actorType ?? 'system',
    actorId: input.ctx.actorId ?? null,
    actorLabel: input.ctx.actorLabel ?? null,
    entityType: 'file',
    entityId: input.fileId,
    fileId: input.fileId,
    jobId: input.ctx.jobId ?? null,
    workflowId: input.run.workflowId,
    summary:
      result.outcome === 'extracted'
        ? `File processing completed (${input.processorType})`
        : `File processing skipped: ${result.reason ?? 'unsupported'}`,
    data: {
      processorType: input.processorType,
      processorVersion: input.processorVersion,
      contentKind: result.contentKind,
      charCount,
      pageCount: result.pageCount,
      truncated: result.truncated,
      outcome: result.outcome,
      reason: result.reason ?? null
    }
  });
}

async function markRunFailed(
  ctx: ProcessingRunContext,
  input: {
    run: FileProcessingRun;
    fileId: string;
    processorType: string;
    processorVersion: string;
    error: unknown;
  }
): Promise<void> {
  const appError = toAppError(input.error);
  const now = Date.now();
  await withTransaction(ctx.db, (tx) => {
    repo.updateProcessingRun(tx, input.run.id, {
      status: 'failed',
      error: appError.message.slice(0, 1000),
      errorCode: appError.code,
      finishedAt: now,
      durationMs: now - (input.run.startedAt ?? now)
    });
    tx.update(files)
      .set({ status: 'failed', updatedAt: now })
      .where(sql`${files.id} = ${input.fileId}`)
      .run();
    writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      action: AuditActions.fileProcessingFailed,
      actorType: ctx.actorType ?? 'system',
      actorId: ctx.actorId ?? null,
      actorLabel: ctx.actorLabel ?? null,
      entityType: 'file',
      entityId: input.fileId,
      fileId: input.fileId,
      jobId: ctx.jobId ?? null,
      summary: `File processing failed (${input.processorType})`,
      data: {
        processorType: input.processorType,
        processorVersion: input.processorVersion,
        error: appError.message,
        errorCode: appError.code,
        retryable: appError.retryable
      }
    });
  });
}

async function claimRun(
  ctx: ProcessingRunContext,
  input: {
    fileId: string;
    workflowId: string | null;
    processingKey: string;
    processorType: string;
    processorVersion: string;
    configurationFingerprint: string;
  }
): Promise<FileProcessingRun> {
  const now = Date.now();
  return withTransaction(ctx.db, (tx) => {
    const existing = repo.findProcessingRunByKey(tx, input.fileId, input.processingKey);
    if (existing) {
      const updated = repo.updateProcessingRun(tx, existing.id, {
        status: 'running',
        attempt: existing.attempt + 1,
        jobId: ctx.jobId ?? null,
        startedAt: now,
        finishedAt: null,
        error: null,
        errorCode: null,
        resultSummary: null
      });
      if (!updated) throw errors.internal('Failed to claim processing run', { id: existing.id });
      return updated;
    }
    return repo.insertProcessingRun(tx, {
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      fileId: input.fileId,
      workflowId: input.workflowId,
      processorType: input.processorType,
      processorVersion: input.processorVersion,
      configurationFingerprint: input.configurationFingerprint,
      processingKey: input.processingKey,
      status: 'running',
      attempt: 1,
      jobId: ctx.jobId ?? null,
      startedAt: now,
      createdAt: now
    });
  });
}

function mergeMetadata(
  existing: FileMetadata,
  detectedMime: string,
  result: ProcessorResult
): FileMetadata {
  const known = new Set(['wordCount', 'charCount', 'imageWidth', 'imageHeight']);
  const extra: Record<string, unknown> = { ...(existing.extra ?? {}) };
  for (const [key, value] of Object.entries(result.genericMetadata)) {
    if (!known.has(key)) extra[key] = value;
  }
  const metadata: FileMetadata = {
    ...existing,
    detectedMime,
    checksumVerified: true,
    extra
  };
  if (result.pageCount !== null) metadata.pageCount = result.pageCount;
  if (result.language) metadata.language = result.language;
  const { wordCount, charCount, imageWidth, imageHeight } = result.genericMetadata;
  if (typeof wordCount === 'number') metadata.wordCount = wordCount;
  if (typeof charCount === 'number') metadata.charCount = charCount;
  if (typeof imageWidth === 'number') metadata.imageWidth = imageWidth;
  if (typeof imageHeight === 'number') metadata.imageHeight = imageHeight;
  return metadata;
}

function summarize(
  processorType: string,
  processorVersion: string,
  result: ProcessorResult
): string {
  if (result.outcome === 'unsupported') {
    return `${processorType}@${processorVersion}: unsupported (${result.reason ?? 'no reason given'})`;
  }
  return `${processorType}@${processorVersion}: ${result.text.length} chars, ${result.pageCount ?? 'n/a'} pages`;
}
