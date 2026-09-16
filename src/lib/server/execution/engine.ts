/**
 * Execution engine.
 *
 * The engine turns "a ticket entered a state" into the right durable work, and it
 * is the only component that decides what a state *means* at runtime:
 *
 *  - `manual` / human-gated → nothing runs; the ticket waits for a human.
 *  - `agent` → an `AgentRun` is created and executed against an immutable agent
 *    version.
 *  - `system` → a deterministic action runs (set fields, transition, emit event,
 *    create a ticket, call an HTTP operation, wait).
 *  - `terminal` → the ticket is closed and nothing more happens.
 *
 * Idempotency is enforced two ways: the job carries the `enteredAt` timestamp of
 * the state entry it belongs to (so a stale job for a superseded entry is skipped),
 * and `tickets.stateRunCount` counts executions within the current entry so an
 * explicit re-run is possible without double-running the automatic path.
 */
import { and, eq, sql } from 'drizzle-orm';
import { requireApproval } from '../approvals/service';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, systemActor } from '../core/context';
import { errors, toAppError } from '../core/errors';
import { moduleLogger } from '../core/logger';
import { createRedactor } from '../core/redaction';
import type { Executor } from '../db/client';
import {
  agentRuns,
  approvalRequests,
  type StateConfig,
  type Ticket,
  tickets,
  type WorkflowState
} from '../db/schema';
import { getJobHandler, type JobHandlerContext, registerJobHandler } from '../jobs/handlers';
import { enqueueJobSync } from '../jobs/queue';
import { addNoteSync, requestTransitionSync, requireTicketSync } from '../tickets/service';
import { writeTicketFieldValues } from '../tickets/values';
import { requireState } from '../workflows/service';
import { publishRunEvent, RunEventTypes } from './events';
import { createAgentRunSync, executeAgentRun, failRun } from './runner';
import { humanGateOf, isTerminalState } from './state-machine';

const log = moduleLogger('execution.engine');

export interface StateEntryPayload {
  ticketId: string;
  stateId: string;
  workflowId: string;
  enteredAt: number;
  reason?: string;
}

export interface StateEntryResult {
  outcome: 'ran' | 'skipped' | 'waiting' | 'failed';
  runId?: string;
  detail?: string;
}

/**
 * Execute one state entry.
 *
 * Called by the `state.enter` job handler. It is safe to call repeatedly: a stale
 * entry is detected and skipped rather than running work for a state the ticket has
 * already left.
 */
export async function handleStateEntry(
  db: Executor,
  payload: StateEntryPayload,
  context: {
    jobId?: string | null;
    workerId?: string;
    heartbeat?: () => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<StateEntryResult> {
  const ticket = requireTicketSync(
    db,
    await workspaceOfTicket(db, payload.ticketId),
    payload.ticketId
  );
  const state = requireState(db, ticket.workspaceId, payload.stateId);

  if (ticket.stateId !== state.id) {
    // The ticket left this state before the job ran. Nothing to do — this is the
    // normal outcome of a duplicate delivery or a superseded entry.
    log.debug('skipping stale state entry', {
      ticketId: ticket.id,
      payloadStateId: state.id,
      currentStateId: ticket.stateId
    });
    return { outcome: 'skipped', detail: 'ticket_moved_on' };
  }
  if (ticket.enteredStateAt !== payload.enteredAt) {
    return { outcome: 'skipped', detail: 'superseded_entry' };
  }
  if (isTerminalState(state)) {
    return { outcome: 'skipped', detail: 'terminal_state' };
  }
  if (humanGateOf(state)) {
    // A human gate is a hard stop for automatic progression.
    return { outcome: 'waiting', detail: 'human_gate' };
  }

  const actor = systemActor(ticket.workspaceId, `state:${state.name}`);

  if (state.kind === 'agent') {
    if (!state.agentId) {
      return { outcome: 'failed', detail: 'agent_state_without_agent' };
    }
    // Count this execution within the current entry.
    const runCount = incrementStateRunCount(db, ticket.id);
    const _now = Date.now();
    const run = createAgentRunSync(db, {
      workspaceId: ticket.workspaceId,
      ticket,
      state,
      agentId: state.agentId,
      triggerType: 'state_entry',
      jobId: context.jobId ?? null,
      attempt: runCount
    });

    try {
      const outcome = await executeAgentRun(db, run.id, {
        jobId: context.jobId ?? null,
        workerId: context.workerId,
        heartbeat: context.heartbeat,
        signal: context.signal
      });
      return {
        outcome:
          outcome.status === 'awaiting_approval'
            ? 'waiting'
            : outcome.status === 'succeeded'
              ? 'ran'
              : 'failed',
        runId: run.id,
        detail: outcome.status
      };
    } catch (error) {
      const appError = toAppError(error);
      failRun(db, run, appError);
      return { outcome: 'failed', runId: run.id, detail: appError.message };
    }
  }

  if (state.kind === 'system') {
    return executeSystemState(db, { ticket, state, actor });
  }

  // Manual states: nothing executes. The ticket waits for a human.
  return { outcome: 'waiting', detail: 'manual_state' };
}

function incrementStateRunCount(db: Executor, ticketId: string): number {
  const updated = db
    .update(tickets)
    .set({ stateRunCount: sql`${tickets.stateRunCount} + 1`, updatedAt: Date.now() })
    .where(eq(tickets.id, ticketId))
    .returning({ stateRunCount: tickets.stateRunCount })
    .all()[0];
  return updated?.stateRunCount ?? 1;
}

async function workspaceOfTicket(db: Executor, ticketId: string): Promise<string> {
  const row = db
    .select({ workspaceId: tickets.workspaceId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Ticket', ticketId);
  return row.workspaceId;
}

/**
 * Deterministic state actions.
 *
 * These are the "no model needed" transitions: normalising fields, moving a ticket
 * on, creating follow-up work. They run without an agent so a workflow can encode
 * routing logic that must never be subject to model judgement.
 */
export async function executeSystemState(
  db: Executor,
  options: { ticket: Ticket; state: WorkflowState; actor: ActorContext }
): Promise<StateEntryResult> {
  const config = (options.state.config ?? {}) as StateConfig;
  const action = config.systemAction;
  if (!action) {
    return { outcome: 'waiting', detail: 'no_system_action_configured' };
  }

  try {
    switch (action.type) {
      case 'setFields': {
        writeTicketFieldValues(db, {
          workspaceId: options.ticket.workspaceId,
          ticketId: options.ticket.id,
          workflowId: options.ticket.workflowId,
          values: action.values,
          actor: options.actor,
          source: 'system',
          force: true
        });
        return { outcome: 'ran', detail: 'set_fields' };
      }
      case 'transition': {
        requestTransitionSync(db, options.actor, {
          ticketId: options.ticket.id,
          targetStateId: action.targetStateId ?? undefined,
          comment: `Automatic transition from ${options.state.name}`
        });
        return { outcome: 'ran', detail: 'transitioned' };
      }
      case 'emitEvent': {
        publishRunEvent(db, {
          workspaceId: options.ticket.workspaceId,
          ticketId: options.ticket.id,
          type: action.name,
          data: { stateId: options.state.id, ticketKey: options.ticket.key }
        });
        writeAudit(db, {
          workspaceId: options.ticket.workspaceId,
          action: AuditActions.ticketUpdated,
          actorType: 'system',
          entityType: 'ticket',
          entityId: options.ticket.id,
          ticketId: options.ticket.id,
          workflowId: options.ticket.workflowId,
          summary: `System event ${action.name} emitted`,
          data: { name: action.name }
        });
        return { outcome: 'ran', detail: 'emitted_event' };
      }
      case 'createTicket': {
        // Deliberately goes through the ticket contract so a system-created ticket
        // is indistinguishable from one created by a human or an agent.
        const { ticketService } = await import('../tickets/contracts');
        const created = await ticketService().create(
          options.actor,
          {
            workflowId: action.workflowId,
            title: renderTemplate(action.titleTemplate, {
              ticket: options.ticket,
              state: options.state
            }),
            originTicketId: options.ticket.id,
            provenance: {
              sourceType: 'system',
              sourceLabel: `State ${options.state.name}`,
              sourceReference: options.ticket.key
            }
          },
          db
        );
        return { outcome: 'ran', detail: `created:${created.key}` };
      }
      case 'http': {
        const { httpToolInvoker, hasHttpToolInvoker } = await import('../tools/http-locator');
        if (!hasHttpToolInvoker()) {
          return { outcome: 'failed', detail: 'http_runtime_unavailable' };
        }
        const result = await httpToolInvoker()(db, {
          workspaceId: options.ticket.workspaceId,
          operationId: action.operationId,
          input: { ticketId: options.ticket.id, ticketKey: options.ticket.key },
          actor: options.actor,
          ticketId: options.ticket.id,
          workflowId: options.ticket.workflowId
        });
        return { outcome: result.ok ? 'ran' : 'failed', detail: result.error?.message ?? 'http' };
      }
      case 'wait': {
        enqueueJobSync(db, {
          workspaceId: options.ticket.workspaceId,
          type: 'state.enter',
          payload: {
            ticketId: options.ticket.id,
            stateId: options.state.id,
            workflowId: options.ticket.workflowId,
            enteredAt: options.ticket.enteredStateAt,
            reason: 'system_wait'
          } satisfies StateEntryPayload,
          delayMs: Math.max(1, action.seconds) * 1000,
          ticketId: options.ticket.id,
          dedupeKey: `state.enter:wait:${options.ticket.id}:${options.state.id}:${options.ticket.enteredStateAt}`
        });
        return { outcome: 'waiting', detail: 'delayed' };
      }
      default: {
        const exhaustive: never = action;
        return { outcome: 'failed', detail: `unknown_system_action:${JSON.stringify(exhaustive)}` };
      }
    }
  } catch (error) {
    const appError = toAppError(error);
    return { outcome: 'failed', detail: appError.message };
  }
}

function renderTemplate(
  template: string,
  context: { ticket: Ticket; state: WorkflowState }
): string {
  return template
    .replace(/\{\{\s*ticket\.key\s*\}\}/g, context.ticket.key)
    .replace(/\{\{\s*ticket\.title\s*\}\}/g, context.ticket.title)
    .replace(/\{\{\s*state\.name\s*\}\}/g, context.state.name);
}

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
      ticketId?: string;
      transitionId?: string;
      targetStateId?: string;
      comment?: string;
    };
    if (!action.ticketId) return { outcome: 'skipped', detail: 'missing_ticket' };
    if (approval.status !== 'approved') {
      return { outcome: 'rejected', detail: 'transition_rejected' };
    }
    const actor = systemActor(approval.workspaceId, 'approval.resume');
    requestTransitionSync(db, actor, {
      ticketId: action.ticketId,
      transitionId: action.transitionId ?? null,
      targetStateId: action.targetStateId ?? null,
      comment: action.comment ?? `Approved by ${approval.decidedByLabel ?? 'a reviewer'}`
    });
    return { outcome: 'resumed', detail: 'transition_applied' };
  }

  if (approval.kind === 'transfer') {
    const action = approval.requestedAction as {
      ticketId?: string;
      targetWorkflowId?: string;
      targetStateId?: string;
      fieldMappings?: Record<string, string>;
      reason?: string;
    };
    if (!action.ticketId || !action.targetWorkflowId) {
      return { outcome: 'skipped', detail: 'missing_transfer_target' };
    }
    if (approval.status !== 'approved') {
      const ticket = requireTicketSync(db, approval.workspaceId, action.ticketId);
      addNoteSync(db, systemActor(approval.workspaceId, 'approval.resume'), {
        ticketId: ticket.id,
        body: `Transfer to the destination workflow was rejected${
          approval.decisionComment ? `: ${approval.decisionComment}` : ''
        }`,
        isSystem: true
      });
      return { outcome: 'rejected', detail: 'transfer_rejected' };
    }
    const { transferTicketSync } = await import('../tickets/service');
    transferTicketSync(db, systemActor(approval.workspaceId, 'approval.resume'), {
      ticketId: action.ticketId,
      targetWorkflowId: action.targetWorkflowId,
      targetStateId: action.targetStateId ?? null,
      fieldMappings: action.fieldMappings,
      reason: action.reason ?? `Approved by ${approval.decidedByLabel ?? 'a reviewer'}`,
      approved: true
    });
    return { outcome: 'resumed', detail: 'transfer_applied' };
  }

  if (approval.kind === 'ticket_creation') {
    return {
      outcome: approval.status === 'approved' ? 'resumed' : 'rejected',
      detail: 'ticket_creation'
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

// ---------------------------------------------------------------------------
// Manual dispatch
// ---------------------------------------------------------------------------

export interface DispatchInput {
  ticketId: string;
  /** Restrict the dispatch to a specific state (defaults to the current state). */
  stateId?: string | null;
  reason?: string | null;
  /** Allow dispatching into a state whose automatic execution is off. */
  force?: boolean;
}

/**
 * Dispatch work for a ticket on demand: the "Run now" action, an API caller, or a
 * manual trigger. It deliberately enqueues the *same* `state.enter` job as the
 * automatic path so behaviour cannot diverge.
 */
export function dispatchStateEntrySync(
  db: Executor,
  actor: ActorContext,
  input: DispatchInput
): { jobId: string; stateId: string } {
  const ticket = requireTicketSync(db, actor.workspaceId, input.ticketId);
  const stateId = input.stateId ?? ticket.stateId;
  const state = requireState(db, actor.workspaceId, stateId);
  if (state.workflowId !== ticket.workflowId) {
    throw errors.validation('The state does not belong to the ticket’s workflow');
  }
  if (humanGateOf(state)) {
    throw errors.humanGate(
      `"${state.name}" is a human-gated state; a person must decide the next step`,
      { stateId: state.id }
    );
  }
  if (state.kind === 'manual' && !input.force) {
    throw errors.precondition(
      `"${state.name}" is a manual state and has no automatic work. Use force to dispatch anyway.`,
      { stateId: state.id }
    );
  }
  if (!state.autoExecute && !input.force) {
    throw errors.precondition(`Automatic execution is disabled for "${state.name}"`, {
      stateId: state.id
    });
  }

  const job = enqueueJobSync(db, {
    workspaceId: actor.workspaceId,
    type: 'state.enter',
    payload: {
      ticketId: ticket.id,
      stateId: state.id,
      workflowId: ticket.workflowId,
      enteredAt: ticket.enteredStateAt,
      reason: input.reason ?? 'manual'
    } satisfies StateEntryPayload,
    priority: 10,
    maxAttempts: Math.max(1, state.maxAttempts),
    timeoutSeconds: state.timeoutSeconds ?? undefined,
    ticketId: ticket.id,
    dedupeKey: `state.enter:manual:${ticket.id}:${state.id}:${ticket.stateRunCount}`,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel
  });

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.jobEnqueued,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: ticket.id,
    ticketId: ticket.id,
    workflowId: ticket.workflowId,
    jobId: job.id,
    summary: `Work dispatched for ${ticket.key} (${state.name})`,
    data: { stateId: state.id, reason: input.reason ?? 'manual' }
  });

  return { jobId: job.id, stateId: state.id };
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
    ticketId: run.ticketId,
    workflowId: run.workflowId,
    runId,
    summary: 'Agent run cancelled by a user',
    data: { cancelledApprovals: pending.length },
    occurredAt: now
  });

  publishRunEvent(db, {
    workspaceId: actor.workspaceId,
    runId,
    ticketId: run.ticketId,
    type: RunEventTypes.runCancelled,
    data: { reason: 'cancelled_by_user' }
  });
}

// ---------------------------------------------------------------------------
// Job handler registration
// ---------------------------------------------------------------------------

export function registerExecutionJobHandlers(): void {
  // Registration is idempotent: bootstrap runs once per process, but tests and a
  // future hot-reload path may call it again, and duplicate registration is fatal
  // by design — so skip rather than throw when the handler is already present.
  if (getJobHandler('state.enter')) return;

  registerJobHandler('state.enter', async (context: JobHandlerContext) => {
    const payload = context.job.payload as unknown as StateEntryPayload;
    if (!payload?.ticketId || !payload.stateId) {
      throw errors.validation('state.enter job is missing ticketId/stateId');
    }
    const result = await handleStateEntry(context.db, payload, {
      jobId: context.job.id,
      workerId: context.workerId,
      heartbeat: () => context.heartbeat(),
      signal: context.signal
    });

    if (result.outcome === 'failed') {
      const ticket = requireTicketSync(context.db, context.job.workspaceId, payload.ticketId);
      const state = requireState(context.db, ticket.workspaceId, payload.stateId);
      // The final attempt moves the ticket to its configured failure state, if any.
      const isFinalAttempt = context.job.attempts >= context.job.maxAttempts;
      if (isFinalAttempt && state.failureStateId) {
        requestTransitionSync(context.db, systemActor(ticket.workspaceId, 'execution.engine'), {
          ticketId: ticket.id,
          targetStateId: state.failureStateId,
          comment: `Automatic failure handling after ${context.job.attempts} attempt(s)`
        });
        return { result: { outcome: 'failed', movedToFailureState: true } };
      }
      throw errors.dependency(result.detail ?? 'State entry failed');
    }

    return {
      result: {
        outcome: result.outcome,
        detail: result.detail ?? null,
        runId: result.runId ?? null
      }
    };
  });

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

  log.debug('execution job handlers registered');
}

/** Enqueue an approval-resume job inside the caller's transaction. */
export function enqueueApprovalResumeSync(
  db: Executor,
  input: {
    workspaceId: string;
    approvalId: string;
    runId?: string | null;
    ticketId?: string | null;
  }
): string {
  const job = enqueueJobSync(db, {
    workspaceId: input.workspaceId,
    type: 'approval.resume',
    payload: { approvalId: input.approvalId },
    priority: 9,
    ticketId: input.ticketId ?? null,
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
