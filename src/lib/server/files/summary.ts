/**
 * File summaries.
 *
 * A summary is a *derived* artifact whose value depends on the bytes, the
 * processing run that produced the text, and the model/prompt that wrote it.
 * Reuse therefore requires the whole identity to match; a changed prompt version
 * or a reprocessed document regenerates rather than silently serving stale text.
 * Generated history is kept (`is_current`), so a human edit preserves what the
 * model previously said.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import { type FileSummary, fileSummaries, files } from '../db/schema';
import { getFileExtractionProvider } from './fields';
import * as repo from './repository';

export const DEFAULT_SUMMARY_PROMPT_VERSION = 'v1';
const MAX_SUMMARY_INPUT_CHARS = 16_000;

export interface GenerateSummaryInput {
  fileId: string;
  workflowId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  promptVersion?: string;
  /** Regenerate even when a compatible summary exists. */
  force?: boolean;
}

export interface SummaryResult {
  summaryId: string;
  summary: string;
  reused: boolean;
}

export async function generateSummary(
  actor: ActorContext,
  input: GenerateSummaryInput,
  db?: Executor
): Promise<SummaryResult> {
  assertPermission(actor, Permissions.fileWrite, 'Not permitted to summarise files');
  const executor = requireExecutor(db);
  const file = repo.findFile(executor, actor.workspaceId, input.fileId);
  if (!file) throw errors.notFound('File', input.fileId);
  const content = repo.findLatestExtractedContent(executor, actor.workspaceId, input.fileId);
  if (!content) {
    throw errors.precondition('File has no extracted content to summarise', {
      fileId: input.fileId
    });
  }

  const providerId = input.providerId ?? null;
  const modelId = input.modelId ?? null;
  const promptVersion = input.promptVersion ?? DEFAULT_SUMMARY_PROMPT_VERSION;

  const existing = findCompatibleSummary(executor, {
    workspaceId: actor.workspaceId,
    fileId: input.fileId,
    processingRunId: content.processingRunId,
    providerId,
    modelId,
    promptVersion
  });
  if (existing && !input.force) {
    return { summaryId: existing.id, summary: existing.summary, reused: true };
  }

  const provider = getFileExtractionProvider();
  if (!provider) {
    throw errors.unsupported(
      'No file extraction provider is installed. Register one with setFileExtractionProvider().'
    );
  }
  const result = await provider.generate({
    model: modelId ?? providerId ?? provider.name,
    messages: [
      {
        role: 'system',
        content:
          'You summarise documents for a work-management system. Reply with a concise summary ' +
          'of the key facts, amounts, dates and parties. Do not add commentary.'
      },
      { role: 'user', content: content.text.slice(0, MAX_SUMMARY_INPUT_CHARS) }
    ],
    temperature: 0
  });
  const summary = result.content.trim();
  if (summary.length === 0) {
    throw errors.provider('The model returned an empty summary', { fileId: input.fileId });
  }

  const summaryId = await withTransaction(executor, (tx) => {
    const id = persistSummary(tx, {
      workspaceId: actor.workspaceId,
      fileId: input.fileId,
      summary,
      processingRunId: content.processingRunId,
      providerId,
      modelId,
      promptVersion,
      editedByType: null,
      editedById: null
    });
    writeSummaryAudit(tx, actor, {
      fileId: input.fileId,
      workflowId: input.workflowId ?? file.primaryWorkflowId ?? null,
      summaryId: id,
      providerId,
      modelId,
      promptVersion,
      edited: false
    });
    return id;
  });

  return { summaryId, summary, reused: false };
}

/** Human edit: the previous generated summary stays in history as non-current. */
export async function editFileSummary(
  actor: ActorContext,
  input: { fileId: string; summary: string },
  db?: Executor
): Promise<{ summaryId: string }> {
  assertPermission(actor, Permissions.fileWrite, 'Not permitted to edit file summaries');
  const executor = requireExecutor(db);
  const summary = input.summary.trim();
  if (summary.length === 0) throw errors.validation('Summary must not be empty');
  const file = repo.findFile(executor, actor.workspaceId, input.fileId);
  if (!file) throw errors.notFound('File', input.fileId);

  const current = findCurrentSummary(executor, actor.workspaceId, input.fileId);
  const summaryId = await withTransaction(executor, (tx) => {
    const id = persistSummary(tx, {
      workspaceId: actor.workspaceId,
      fileId: input.fileId,
      summary,
      processingRunId: current?.processingRunId ?? null,
      providerId: null,
      modelId: null,
      promptVersion: 'human',
      editedByType: actor.actorType,
      editedById: actor.actorId
    });
    writeSummaryAudit(tx, actor, {
      fileId: input.fileId,
      workflowId: file.primaryWorkflowId ?? null,
      summaryId: id,
      providerId: null,
      modelId: null,
      promptVersion: 'human',
      edited: true
    });
    return id;
  });

  return { summaryId };
}

export async function listFileSummaries(
  actor: ActorContext,
  fileId: string,
  db?: Executor
): Promise<FileSummary[]> {
  assertPermission(actor, Permissions.fileRead, 'Not permitted to read file summaries');
  const executor = requireExecutor(db);
  const file = repo.findFile(executor, actor.workspaceId, fileId);
  if (!file) throw errors.notFound('File', fileId);
  return executor
    .select()
    .from(fileSummaries)
    .where(and(eq(fileSummaries.workspaceId, actor.workspaceId), eq(fileSummaries.fileId, fileId)))
    .orderBy(desc(fileSummaries.createdAt))
    .all();
}

function persistSummary(
  tx: Executor,
  input: {
    workspaceId: string;
    fileId: string;
    summary: string;
    processingRunId: string | null;
    providerId: string | null;
    modelId: string | null;
    promptVersion: string;
    editedByType: FileSummary['editedByType'];
    editedById: string | null;
  }
): string {
  const now = Date.now();
  tx.update(fileSummaries)
    .set({ isCurrent: false })
    .where(
      and(
        eq(fileSummaries.workspaceId, input.workspaceId),
        eq(fileSummaries.fileId, input.fileId),
        eq(fileSummaries.isCurrent, true)
      )
    )
    .run();

  const row = tx
    .insert(fileSummaries)
    .values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      fileId: input.fileId,
      processingRunId: input.processingRunId,
      summary: input.summary,
      providerId: input.providerId,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      isCurrent: true,
      editedByType: input.editedByType,
      editedById: input.editedById,
      createdAt: now
    })
    .returning({ id: fileSummaries.id })
    .all()[0];
  if (!row) throw errors.internal('Failed to persist file summary');

  tx.update(files)
    .set({ summary: input.summary, version: sql`${files.version} + 1`, updatedAt: now })
    .where(and(eq(files.id, input.fileId), eq(files.workspaceId, input.workspaceId)))
    .run();

  return row.id;
}

function findCompatibleSummary(
  executor: Executor,
  input: {
    workspaceId: string;
    fileId: string;
    processingRunId: string;
    providerId: string | null;
    modelId: string | null;
    promptVersion: string;
  }
): FileSummary | undefined {
  const conditions = [
    eq(fileSummaries.workspaceId, input.workspaceId),
    eq(fileSummaries.fileId, input.fileId),
    eq(fileSummaries.processingRunId, input.processingRunId),
    eq(fileSummaries.promptVersion, input.promptVersion),
    eq(fileSummaries.isCurrent, true),
    isNull(fileSummaries.editedByType),
    input.providerId === null
      ? isNull(fileSummaries.providerId)
      : eq(fileSummaries.providerId, input.providerId),
    input.modelId === null
      ? isNull(fileSummaries.modelId)
      : eq(fileSummaries.modelId, input.modelId)
  ];
  return executor
    .select()
    .from(fileSummaries)
    .where(and(...conditions))
    .orderBy(desc(fileSummaries.createdAt))
    .limit(1)
    .all()[0];
}

function findCurrentSummary(
  executor: Executor,
  workspaceId: string,
  fileId: string
): FileSummary | undefined {
  return executor
    .select()
    .from(fileSummaries)
    .where(
      and(
        eq(fileSummaries.workspaceId, workspaceId),
        eq(fileSummaries.fileId, fileId),
        eq(fileSummaries.isCurrent, true)
      )
    )
    .limit(1)
    .all()[0];
}

function writeSummaryAudit(
  executor: Executor,
  actor: ActorContext,
  input: {
    fileId: string;
    workflowId: string | null;
    summaryId: string;
    providerId: string | null;
    modelId: string | null;
    promptVersion: string;
    edited: boolean;
  }
): void {
  writeAudit(executor, {
    workspaceId: actor.workspaceId,
    action: AuditActions.fileSummaryGenerated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'file',
    entityId: input.fileId,
    fileId: input.fileId,
    workflowId: input.workflowId,
    runId: actor.runId ?? null,
    summary: input.edited ? 'File summary edited' : 'File summary generated',
    data: {
      summaryId: input.summaryId,
      providerId: input.providerId,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      edited: input.edited
    }
  });
}

function requireExecutor(db?: Executor): Executor {
  if (!db) throw errors.internal('File summary operations require a database executor');
  return db;
}
