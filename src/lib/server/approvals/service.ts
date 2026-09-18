/**
 * Approvals.
 *
 * An approval *suspends a running execution* pending a human decision, then
 * resumes it from persisted state. This is deliberately different from a human
 * gate, which stops automatic progression at a state (ADR-0013, plan §31).
 *
 * Approval policy is always evaluated by Mentat against persisted configuration:
 * a model claiming it asked for permission is irrelevant. The paused run stores
 * the exact action it wants to take, redacted, so a reviewer sees precisely what
 * will happen if they approve.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import type { Executor } from '../db/client';
import {
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  agentRuns,
  approvalRequests,
  records,
  users,
  workflowItems,
  workspaceMembers
} from '../db/schema';
import { publishRunEvent, RunEventTypes } from '../execution/events';

export interface RequestApprovalInput {
  workspaceId: string;
  kind: ApprovalKind;
  title: string;
  description?: string | null;
  requestedAction: Record<string, unknown>;
  contextSnapshot?: unknown;
  recordId?: string | null;
  workflowItemId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  jobId?: string | null;
  requestedByType: ActorContext['actorType'];
  requestedById?: string | null;
  requestedByLabel?: string | null;
  reviewerUserId?: string | null;
  reviewerTeamId?: string | null;
  expiresInMs?: number;
}

/** Create a pending approval inside the caller's transaction. */
export function requestApprovalSync(tx: Executor, input: RequestApprovalInput): ApprovalRequest {
  const redactor = createRedactor(registeredSecretValues());
  const now = Date.now();
  const inserted = tx
    .insert(approvalRequests)
    .values({
      id: uuidv7(now),
      workspaceId: input.workspaceId,
      recordId: input.recordId ?? null,
      workflowItemId: input.workflowItemId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      jobId: input.jobId ?? null,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      // Redacted at write time: an approval record is readable by every reviewer.
      requestedAction: redactor.value(input.requestedAction) as never,
      contextSnapshot: (redactor.value(input.contextSnapshot) ?? null) as never,
      requestedByType: input.requestedByType,
      requestedById: input.requestedById ?? null,
      requestedByLabel: input.requestedByLabel ?? null,
      status: 'pending',
      reviewerUserId: input.reviewerUserId ?? null,
      reviewerTeamId: input.reviewerTeamId ?? null,
      createdAt: now,
      expiresAt: input.expiresInMs ? now + input.expiresInMs : null
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.internal('Failed to create approval request');

  writeAudit(tx, {
    workspaceId: input.workspaceId,
    action: AuditActions.approvalRequested,
    actorType: input.requestedByType,
    actorId: input.requestedById ?? null,
    actorLabel: input.requestedByLabel ?? null,
    entityType: 'approval',
    entityId: inserted.id,
    recordId: inserted.recordId,
    workflowItemId: inserted.workflowItemId,
    workflowId: inserted.workflowId,
    runId: inserted.runId,
    approvalId: inserted.id,
    summary: input.title,
    data: { kind: input.kind, action: redactor.value(input.requestedAction) },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: input.workspaceId,
      runId: inserted.runId,
      recordId: inserted.recordId,
      workflowItemId: inserted.workflowItemId,
      type: RunEventTypes.approvalRequested,
      data: { approvalId: inserted.id, kind: input.kind, title: input.title }
    },
    now
  );

  return inserted;
}

export interface ApprovalView extends ApprovalRequest {
  recordKey: string | null;
  recordTitle: string | null;
  runStatus: string | null;
}

export function listApprovals(
  db: Executor,
  actor: ActorContext,
  options: {
    status?: ApprovalStatus[];
    recordId?: string;
    workflowItemId?: string;
    kind?: ApprovalKind;
    /** Only approvals the actor may decide. */
    assignedToMe?: boolean;
    limit?: number;
  } = {}
): ApprovalView[] {
  assertPermission(actor, Permissions.approvalRead);
  const conditions = [eq(approvalRequests.workspaceId, actor.workspaceId)];
  if (options.status && options.status.length > 0) {
    conditions.push(inArray(approvalRequests.status, options.status));
  }
  if (options.recordId) conditions.push(eq(approvalRequests.recordId, options.recordId));
  if (options.workflowItemId) {
    conditions.push(eq(approvalRequests.workflowItemId, options.workflowItemId));
  }
  if (options.kind) conditions.push(eq(approvalRequests.kind, options.kind));
  if (options.assignedToMe && actor.actorId) {
    conditions.push(
      or(
        eq(approvalRequests.reviewerUserId, actor.actorId),
        isNull(approvalRequests.reviewerUserId)
      ) as never
    );
  }

  const rows = db
    .select({
      approval: approvalRequests,
      recordKey: records.key,
      recordTitle: records.displayName,
      runStatus: agentRuns.status
    })
    .from(approvalRequests)
    .leftJoin(workflowItems, eq(workflowItems.id, approvalRequests.workflowItemId))
    .leftJoin(
      records,
      eq(records.id, sql`coalesce(${approvalRequests.recordId}, ${workflowItems.recordId})`)
    )
    .leftJoin(agentRuns, eq(agentRuns.id, approvalRequests.runId))
    .where(and(...conditions))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(Math.min(options.limit ?? 100, 500))
    .all();

  return rows.map((row) => ({
    ...row.approval,
    recordKey: row.recordKey ?? null,
    recordTitle: row.recordTitle ?? null,
    runStatus: row.runStatus ?? null
  }));
}

export function requireApproval(
  db: Executor,
  workspaceId: string,
  approvalId: string
): ApprovalRequest {
  const rows = db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const approval = rows[0];
  if (!approval) throw errors.notFound('Approval', approvalId);
  return approval;
}

export function countPendingApprovals(db: Executor, workspaceId: string): number {
  const rows = db
    .select({ count: sql<number>`count(*)` })
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.status, 'pending'))
    )
    .all();
  return rows[0]?.count ?? 0;
}

export interface DecisionInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  comment?: string | null;
  /** Structured payload the resume path may need (for example a chosen transition). */
  decisionData?: Record<string, unknown>;
}

export interface DecisionResult {
  approval: ApprovalRequest;
  /** True when the caller must enqueue the resume job. */
  shouldResume: boolean;
}

/**
 * Record a decision. Execution is *not* continued here: the caller enqueues an
 * `approval.resume` job inside the same transaction, so a crash between the
 * decision and the resumption cannot lose the work.
 */
export function decideApprovalSync(
  tx: Executor,
  actor: ActorContext,
  input: DecisionInput
): DecisionResult {
  assertPermission(actor, Permissions.approvalDecide, 'Not permitted to decide approvals');
  const approval = requireApproval(tx, actor.workspaceId, input.approvalId);
  if (approval.status !== 'pending') {
    throw errors.precondition(`This approval was already ${approval.status}`, {
      status: approval.status
    });
  }
  if (approval.expiresAt && approval.expiresAt <= Date.now()) {
    throw errors.precondition('This approval has expired');
  }
  // A specifically assigned reviewer cannot be bypassed; a team-assigned approval
  // may be decided by any member of that team.
  if (approval.reviewerUserId && approval.reviewerUserId !== actor.actorId) {
    const isAdmin = actor.permissions.has(Permissions.workspaceAdmin);
    if (!isAdmin) {
      throw errors.forbidden('This approval is assigned to a different reviewer', {
        reviewerUserId: approval.reviewerUserId
      });
    }
  }
  if (approval.reviewerTeamId) {
    const teams = actor.teamIds ?? [];
    if (
      !teams.includes(approval.reviewerTeamId) &&
      !actor.permissions.has(Permissions.workspaceAdmin)
    ) {
      throw errors.forbidden('This approval is assigned to a different team', {
        reviewerTeamId: approval.reviewerTeamId
      });
    }
  }
  if (input.decision === 'rejected' && (!input.comment || input.comment.trim().length === 0)) {
    throw errors.validation('A reason is required when rejecting');
  }

  const now = Date.now();
  const updated = tx
    .update(approvalRequests)
    .set({
      status: input.decision,
      decidedByUserId: actor.actorId,
      decidedByLabel: actor.actorLabel,
      decisionComment: input.comment ?? null,
      decision: (input.decisionData as never) ?? null,
      decidedAt: now
    })
    .where(eq(approvalRequests.id, input.approvalId))
    .returning()
    .all()[0];
  if (!updated) throw errors.notFound('Approval', input.approvalId);

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.approvalDecided,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'approval',
    entityId: approval.id,
    recordId: approval.recordId,
    workflowItemId: approval.workflowItemId,
    workflowId: approval.workflowId,
    runId: approval.runId,
    approvalId: approval.id,
    summary:
      input.decision === 'approved' ? `Approved: ${approval.title}` : `Rejected: ${approval.title}`,
    data: { decision: input.decision, comment: input.comment ?? null },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId: actor.workspaceId,
      runId: approval.runId,
      recordId: approval.recordId,
      workflowItemId: approval.workflowItemId,
      type: RunEventTypes.approvalDecided,
      data: {
        approvalId: approval.id,
        decision: input.decision,
        comment: input.comment ?? null,
        decidedBy: actor.actorLabel
      }
    },
    now
  );

  return { approval: updated, shouldResume: true };
}

/** Expire approvals whose deadline has passed; execution stays paused. */
export function expireStaleApprovalsSync(
  tx: Executor,
  workspaceId: string,
  now = Date.now()
): number {
  const stale = tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.status, 'pending'),
        sql`${approvalRequests.expiresAt} IS NOT NULL AND ${approvalRequests.expiresAt} <= ${now}`
      )
    )
    .all();

  for (const approval of stale) {
    tx.update(approvalRequests)
      .set({ status: 'expired', decidedAt: now })
      .where(eq(approvalRequests.id, approval.id))
      .run();
    if (approval.runId) {
      tx.update(agentRuns)
        .set({
          status: 'failed',
          error: 'Approval expired',
          errorCode: 'approval_expired',
          updatedAt: now
        })
        .where(eq(agentRuns.id, approval.runId))
        .run();
    }
    writeAudit(tx, {
      workspaceId,
      action: AuditActions.approvalExpired,
      actorType: 'system',
      entityType: 'approval',
      entityId: approval.id,
      recordId: approval.recordId,
      workflowItemId: approval.workflowItemId,
      runId: approval.runId,
      approvalId: approval.id,
      summary: `Approval expired: ${approval.title}`,
      occurredAt: now
    });
  }
  return stale.length;
}

/** Cancel every pending approval attached to a run (used when a run is cancelled). */
export function cancelApprovalsForRunSync(
  tx: Executor,
  workspaceId: string,
  runId: string,
  reason: string,
  now = Date.now()
): number {
  const pending = tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.runId, runId),
        eq(approvalRequests.status, 'pending')
      )
    )
    .all();
  for (const approval of pending) {
    tx.update(approvalRequests)
      .set({ status: 'cancelled', decisionComment: reason, decidedAt: now })
      .where(eq(approvalRequests.id, approval.id))
      .run();
  }
  return pending.length;
}

/** Reviewers available for assignment, for the approval configuration UI. */
export function listReviewerCandidates(
  db: Executor,
  actor: ActorContext
): Array<{ id: string; name: string; email: string }> {
  assertPermission(actor, Permissions.approvalRead);
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, actor.workspaceId))
    .orderBy(users.name)
    .all();
}
