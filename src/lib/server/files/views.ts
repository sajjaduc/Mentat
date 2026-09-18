/**
 * File read models.
 *
 * The Files UI and agent tools both need the same projection: identity, blob
 * hash, latest provenance, workflow contexts and the work/record links. Building
 * it in one place keeps `requireFile`, `listForWorkflowItem` and `findFiles` from
 * drifting into three subtly different shapes.
 */
import type { Executor } from '../db/client';
import type { FileRecord } from '../db/schema';
import type { FileSummaryView } from './contracts';
import * as repo from './repository';

export function fileSummaryView(executor: Executor, file: FileRecord): FileSummaryView {
  const blob = repo.findBlobById(executor, file.workspaceId, file.blobId);
  const sources = repo.listFileSources(executor, file.workspaceId, file.id);
  const workflowIds = repo
    .listWorkflowFilesForFile(executor, file.workspaceId, file.id)
    .map((row) => row.workflowId);
  const workflowItemIds = repo
    .listFileWorkflowItemLinksForFile(executor, file.workspaceId, file.id)
    .map((row) => row.workflowItemId);
  const recordIds = repo
    .listFileRecordLinksForFile(executor, file.workspaceId, file.id)
    .map((row) => row.recordId);
  const latest = sources[0];
  return {
    id: file.id,
    filename: file.originalFilename,
    mimeType: file.mimeType,
    size: file.size,
    status: file.status,
    summary: file.summary,
    contentHash: blob?.contentHash ?? '',
    createdAt: file.createdAt,
    provenance: latest ? { sourceType: latest.sourceType, sourceLabel: latest.sourceLabel } : null,
    workflowIds,
    workflowItemIds,
    recordIds
  };
}

export function fileSummaryViews(executor: Executor, fileRows: FileRecord[]): FileSummaryView[] {
  return fileRows.map((file) => fileSummaryView(executor, file));
}
