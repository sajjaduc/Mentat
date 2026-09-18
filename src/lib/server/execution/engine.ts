/**
 * Execution engine.
 *
 * Work-item state entries are executed by `workflow-items/dispatch.ts`, which owns
 * the single `workflow_item.enter` path for WorkflowItems of any Object Type
 * (ADR-0021/ADR-0024). This module owns the parts of execution that are not tied to
 * a particular state entry:
 *
 *  - resuming a run after an approval decision (`approval.resume`),
 *  - cancelling a run and its pending approvals,
 *  - the periodic maintenance job (`maintenance.reap`).
 *
 * Idempotency is enforced by the dispatcher: the job carries the `enteredAt`
 * timestamp of the state entry it belongs to (so a stale job for a superseded entry
 * is skipped), and `workflow_items.stateRunCount` counts executions within the
 * current entry so an explicit re-run is possible without double-running the
 * automatic path.
 */
import { and, eq, sql } from 'drizzle-orm';
import { requireApproval } from '../approvals/service';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, systemActor } from '../core/context';
import { errors } from '../core/errors';
import { moduleLogger } from '../core/logger';
import { createRedactor } from '../core/redaction';
import type { Executor } from '../db/client';
import { agentRuns, approvalRequests } from '../db/schema';
import { getJobHandler, type JobHandlerContext, registerJobHandler } from '../jobs/handlers';
import { enqueueJobSync } from '../jobs/queue';
import { registerWorkflowItemEntryHandler } from '../workflow-items/dispatch';
import {
  addWorkflowItemNoteSync,
  requestWorkflowItemTransitionSync,
  transferWorkflowItemSync
} from '../workflow-items/service';
import { publishRunEvent, RunEventTypes } from './events';
import { executeAgentRun } from './runner';

const log = moduleLogger('execution.engine');

/**
 * Resume a run after an approval decision.
 *
 * The decision was already persisted; this handler performs the work that was
 * gated. Rejected tool calls are reported back to the model rather than failing the
 * run, so the agent can choose another path.
 */
export async function handleApprovalResume(
  db: Executor,
  approvalId: string,
  context: {
    jobId?: string | null;
    workerId?: string;
    heartbeat?: () => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<{ outcome: 'resumed' | 'rejected' | 'skipped'; detail?: string }> {
  const approval = requireApproval(db, await workspaceOfApproval(db, approvalId), approvalId);

  if (approval.status === 'pending') {
    return { outcome: 'skipped', detail: 'still_pending' };
  }
  if (approval.status === 'expired' || approval.status === 'cancelled') {
    return { outcome: 'skipped', detail: approval.status };
  }

  if (approval.kind === 'tool_call' && approval.runId) {
    const run = db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, approval.runId))
      .limit(1)
      .all()[0];
    if (!run) return { outcome: 'skipped', detail: 'run_missing' };
    // Resumption is driven by the run's persisted status, not by the approval's:
    // a second resume for the same decision must be a no-op.
    if (run.status !== 'awaiting_approval' && run.status !== 'running' && run.status !== 'queued') {
      return { outcome: 'skipped', detail: `run_${run.status}` };
    }
    await executeAgentRun(db, run.id, {
      jobId: context.jobId ?? null,
      workerId: context.workerId,
      heartbeat: context.heartbeat,
      signal: context.signal,
      resumeApprovalId: approval.id
    });
    return {
      outcome: approval.status === 'approved' ? 'resumed' : 'rejected',
      detail: approval.status
    };
  }

  if (approval.kind === 'state_transition') {
    const action = approval.requestedAction as {
      workflowItemId?: string;
      transitionId?: string;
      targetStateId?: string;
      comment?: string;
    };
    if (!action.workflowItemId) return { outcome: 'skipped', detail: 'missing_work_item' };
    if (approval.status !== 'approved') {
      return { outcome: 'rejected', detail: 'transition_rejected' };
    }
    const actor = systemActor(approval.workspaceId, 'approval.resume');
    requestWorkflowItemTransitionSync(db, actor, {
      workflowItemId: action.workflowItemId,
      transitionId: action.transitionId ?? null,
      targetStateId: action.targetStateId ?? null,
      comment: action.comment ?? `Approved by ${approval.decidedByLabel ?? 'a reviewer'}`
    });
    return { outcome: 'resumed', detail: 'transition_applied' };
  }

  if (approval.kind === 'transfer') {
    const action = approval.requestedAction as {
      workflowItemId?: string;
      targetWorkflowId?: string;
      targetStateId?: string;
      fieldMappings?: Record<string, string>;
      reason?: string;
    };
    if (!action.workflowItemId || !action.targetWorkflowId) {
      return { outcome: 'skipped', detail: 'missing_transfer_target' };
    }
    if (approval.status !== 'approved') {
      addWorkflowItemNoteSync(db, systemActor(approval.workspaceId, 'approval.resume'), {
        workflowItemId: action.workflowItemId,
        body: `Transfer to the destination workflow was rejected${
          approval.decisionComment ? `: ${approval.decisionComment}` : ''
        }`
      });
      return { outcome: 'rejected', detail: 'transfer_rejected' };
    }
    transferWorkflowItemSync(db, systemActor(approval.workspaceId, 'approval.resume'), {
      workflowItemId: action.workflowItemId,
      targetWorkflowId: action.targetWorkflowId,
      targetStateId: action.targetStateId ?? null,
      fieldMappings: action.fieldMappings,
      reason: action.reason ?? `Approved by ${approval.decidedByLabel ?? 'a reviewer'}`
    });
    return { outcome: 'resumed', detail: 'transfer_applied' };
  }

  if (approval.kind === 'record_creation') {
    return {
      outcome: approval.status === 'approved' ? 'resumed' : 'rejected',
      detail: 'record_creation'
    };
  }

  return { outcome: 'skipped', detail: `unhandled_kind:${approval.kind}` };
}

async function workspaceOfApproval(db: Executor, approvalId: string): Promise<string> {
  const row = db
    .select({ workspaceId: sql<string>`workspace_id` })
    .from(sql`approval_requests`)
    .where(sql`id = ${approvalId}`)
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Approval', approvalId);
  return row.workspaceId;
}

/** Cancel a run: stops further steps, cancels pending approvals. */
export function cancelAgentRunSync(db: Executor, actor: ActorContext, runId: string): void {
  const run = db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, actor.workspaceId)))
    .limit(1)
    .all()[0];
  if (!run) throw errors.notFound('Agent run', runId);
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
    throw errors.precondition(`This run already ${run.status}`, { status: run.status });
  }

  const now = Date.now();
  db.update(agentRuns)
    .set({ status: 'cancelled', error: 'Cancelled by request', finishedAt: now, updatedAt: now })
    .where(eq(agentRuns.id, runId))
    .run();

  const pending = db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.runId, runId), eq(approvalRequests.status, 'pending')))
    .all();
  for (const approval of pending) {
    db.update(approvalRequests)
      .set({ status: 'cancelled', decisionComment: 'Run cancelled', decidedAt: now })
      .where(eq(approvalRequests.id, approval.id))
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.agentRunCancelled,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'agent_run',
    entityId: runId,
    recordId: run.recordId,
    workflowItemId: run.workflowItemId,
    workflowId: run.workflowId,
    runId,
    summary: 'Agent run cancelled by a user',
    data: { cancelledApprovals: pending.length },
    occurredAt: now
  });

  publishRunEvent(db, {
    workspaceId: actor.workspaceId,
    runId,
    recordId: run.recordId,
    workflowItemId: run.workflowItemId,
    type: RunEventTypes.runCancelled,
    data: { reason: 'cancelled_by_user' }
  });
}

// ---------------------------------------------------------------------------
// Job handler registration
// ---------------------------------------------------------------------------

export function registerExecutionJobHandlers(): void {
  // Registration is idempotent *per handler*: bootstrap runs once per process, but
  // tests and a future hot-reload path may call it again, and duplicate registration
  // is fatal by design. Checking each type individually means one handler already
  // being present (for example after a test installed its own) cannot block the rest.
  if (!getJobHandler('workflow_item.enter')) {
    // Generic WorkflowItem dispatch for every Object Type (ADR-0021/ADR-0024).
    registerWorkflowItemEntryHandler();
  }
  if (!getJobHandler('approval.resume')) registerApprovalResumeHandler();
  if (!getJobHandler('maintenance.reap')) registerMaintenanceHandler();

  log.debug('execution job handlers registered');
}

function registerApprovalResumeHandler(): void {
  registerJobHandler('approval.resume', async (context: JobHandlerContext) => {
    const payload = context.job.payload as { approvalId?: string };
    if (!payload?.approvalId) {
      throw errors.validation('approval.resume job is missing approvalId');
    }
    const result = await handleApprovalResume(context.db, payload.approvalId, {
      jobId: context.job.id,
      workerId: context.workerId,
      heartbeat: () => context.heartbeat(),
      signal: context.signal
    });
    return { result };
  });
}

function registerMaintenanceHandler(): void {
  registerJobHandler('maintenance.reap', async (context: JobHandlerContext) => {
    const { SqliteJobQueue } = await import('../jobs/queue');
    const queue = new SqliteJobQueue(context.db);
    const reaped = await queue.reapExpiredLeases();
    const { expireStaleApprovalsSync } = await import('../approvals/service');
    const expired = expireStaleApprovalsSync(context.db, context.job.workspaceId);
    const { purgeExpiredSessions } = await import('../auth/sessions');
    const sessions = await purgeExpiredSessions(context.db);
    return { result: { reaped, expired, sessions } };
  });
}

/** Enqueue an approval-resume job inside the caller's transaction. */
export function enqueueApprovalResumeSync(
  db: Executor,
  input: {
    workspaceId: string;
    approvalId: string;
    runId?: string | null;
    recordId?: string | null;
    workflowItemId?: string | null;
  }
): string {
  const job = enqueueJobSync(db, {
    workspaceId: input.workspaceId,
    type: 'approval.resume',
    payload: { approvalId: input.approvalId },
    priority: 9,
    recordId: input.recordId ?? null,
    workflowItemId: input.workflowItemId ?? null,
    runId: input.runId ?? null,
    dedupeKey: `approval.resume:${input.approvalId}`,
    actorType: 'system'
  });
  return job.id;
}

/** Redactor used when building approval previews elsewhere. */
export function approvalRedactor() {
  return createRedactor();
}
