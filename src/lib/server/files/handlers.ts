/**
 * Durable file job handlers.
 *
 * Registration is explicit and idempotent so bootstrap can call
 * `registerFileJobHandlers()` once without caring whether another module already
 * did. The handler resolves the workspace's BlobStore at execution time (never at
 * enqueue time), which is what lets storage configuration change between the
 * enqueue and the run without stranding the job.
 */
import { errors } from '../core/errors';
import { getJobHandler, payloadOf, registerJobHandler } from '../jobs/handlers';
import { resolveBlobStore } from '../storage/index';
import { type ProcessingOutcome, runProcessing } from './processing/pipeline';

export interface FileProcessPayload {
  fileId: string;
  workflowId?: string | null;
  force?: boolean;
}

export function registerFileJobHandlers(): void {
  // Registration is intentionally idempotent: bootstrap and tests may both call it.
  if (getJobHandler('file.process')) return;

  registerJobHandler('file.process', async (context) => {
    const payload = payloadOf<Partial<FileProcessPayload>>(context.job);
    if (typeof payload.fileId !== 'string' || payload.fileId.length === 0) {
      throw errors.validation('file.process payload requires fileId');
    }
    const blobStore = await resolveBlobStore(context.db, context.job.workspaceId);
    const outcome: ProcessingOutcome = await runProcessing(
      {
        db: context.db,
        blobStore,
        workspaceId: context.job.workspaceId,
        jobId: context.job.id,
        actorType: 'system',
        actorLabel: 'file worker'
      },
      {
        fileId: payload.fileId,
        workflowId: payload.workflowId ?? null,
        force: payload.force ?? false
      }
    );
    // A reused run means a previous delivery already completed the work; the job
    // is still a success, it simply did nothing new.
    return { result: outcome };
  });
}
