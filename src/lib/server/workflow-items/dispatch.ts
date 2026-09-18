/**
 * Generic dispatch engine for WorkflowItems (ADR-0024).
 *
 * The generic `state.enter` path drives WorkflowItems of any Object Type: agent
 * states run against the record (with the submission contract), system states
 * execute deterministic actions, human gates wait, and terminal states close.
 */
import { eq } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, systemActor } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { records, type WorkflowItem, type WorkflowState, workflowItems } from '../db/schema';
import { publishRunEvent } from '../execution/events';
import { createAgentRunSync, executeAgentRun } from '../execution/runner';
import { humanGateOf, isTerminalState } from '../execution/state-machine';
import { getJobHandler, type JobHandlerContext, registerJobHandler } from '../jobs/handlers';
import { enqueueJobSync } from '../jobs/queue';
import { requireState, requireWorkflow } from '../workflows/service';
import { setWaitingOn, WORKFLOW_ITEM_ENTER_JOB, type WorkflowItemEntryPayload } from './enqueue';
import { workflowItemFieldValuesByKey, writeWorkflowItemFieldValues } from './fields';
import {
  createWorkflowItemSync,
  requestWorkflowItemTransitionSync,
  requireWorkflowItemRow
} from './service';

export { WORKFLOW_ITEM_ENTER_JOB, type WorkflowItemEntryPayload } from './enqueue';

export interface WorkflowItemEntryResult {
  outcome: 'ran' | 'skipped' | 'waiting' | 'failed';
  runId?: string;
  detail?: string;
}

/** Execute one WorkflowItem state entry. Safe to call repeatedly. */
export async function handleWorkflowItemStateEntry(
  db: Executor,
  payload: WorkflowItemEntryPayload,
  context: {
    jobId?: string | null;
    workerId?: string;
    heartbeat?: () => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<WorkflowItemEntryResult> {
  const item = requireWorkflowItemRow(db, payload.workspaceId, payload.workflowItemId);
  const state = requireState(db, payload.workspaceId, payload.stateId);
  if (item.stateId !== state.id) {
    return { outcome: 'skipped', detail: 'workflow_item_moved_on' };
  }
  if (item.enteredStateAt !== payload.enteredAt) {
    return { outcome: 'skipped', detail: 'superseded_entry' };
  }
  if (isTerminalState(state)) return { outcome: 'skipped', detail: 'terminal_state' };
  if (humanGateOf(state)) {
    setWaitingOn(db, item.id, 'human');
    return { outcome: 'waiting', detail: 'human_gate' };
  }

  const actor = systemActor(payload.workspaceId, `workflow_item:${state.name}`);

  if (state.kind === 'agent') {
    if (!state.agentId) return { outcome: 'failed', detail: 'agent_state_without_agent' };
    const attempt = incrementStateRunCount(db, item.id);
    const run = createAgentRunSync(db, {
      workspaceId: payload.workspaceId,
      state,
      agentId: state.agentId,
      triggerType: 'state_entry',
      jobId: context.jobId ?? null,
      attempt,
      workflowItemId: item.id,
      recordId: item.recordId
    });
    const outcome = await executeAgentRun(db, run.id, {
      jobId: context.jobId ?? null,
      workerId: context.workerId,
      heartbeat: context.heartbeat,
      signal: context.signal
    });
    switch (outcome.status) {
      case 'succeeded':
        return { outcome: 'ran', runId: run.id };
      case 'awaiting_approval':
        return { outcome: 'waiting', runId: run.id, detail: 'awaiting_approval' };
      case 'cancelled':
        return { outcome: 'skipped', runId: run.id, detail: 'cancelled' };
      default:
        return { outcome: 'failed', runId: run.id, detail: outcome.error ?? 'agent_run_failed' };
    }
  }

  if (state.kind === 'system') {
    return executeWorkflowItemSystemState(db, { item, state, actor });
  }

  return { outcome: 'waiting', detail: 'manual_state' };
}

/** Deterministic actions available to a system state on a WorkflowItem. */
async function executeWorkflowItemSystemState(
  db: Executor,
  input: { item: WorkflowItem; state: WorkflowState; actor: ActorContext }
): Promise<WorkflowItemEntryResult> {
  const action = input.state.config?.systemAction;
  if (!action) return { outcome: 'skipped', detail: 'no_system_action' };
  try {
    switch (action.type) {
      case 'transition':
        requestWorkflowItemTransitionSync(db, input.actor, {
          workflowItemId: input.item.id,
          targetStateId: action.targetStateId ?? null
        });
        return { outcome: 'ran' };
      case 'setFields': {
        const record = db
          .select({ objectTypeId: records.objectTypeId })
          .from(records)
          .where(eq(records.id, input.item.recordId))
          .all()[0];
        if (!record) return { outcome: 'failed', detail: 'record_missing' };
        writeWorkflowItemFieldValues(db, {
          workspaceId: input.item.workspaceId,
          workflowItemId: input.item.id,
          workflowId: input.item.workflowId,
          recordId: input.item.recordId,
          objectTypeId: record.objectTypeId,
          values: action.values,
          actor: input.actor,
          source: 'system'
        });
        return { outcome: 'ran' };
      }
      case 'emitEvent':
        publishRunEvent(db, {
          workspaceId: input.item.workspaceId,
          recordId: input.item.recordId,
          workflowItemId: input.item.id,
          type: action.name,
          data: { stateId: input.state.id }
        });
        return { outcome: 'ran' };
      case 'wait': {
        const seconds = Math.max(1, action.seconds);
        enqueueJobSync(db, {
          workspaceId: input.item.workspaceId,
          type: WORKFLOW_ITEM_ENTER_JOB,
          payload: {
            workspaceId: input.item.workspaceId,
            workflowItemId: input.item.id,
            stateId: input.state.id,
            workflowId: input.item.workflowId,
            recordId: input.item.recordId,
            enteredAt: input.item.enteredStateAt
          } satisfies WorkflowItemEntryPayload,
          delayMs: seconds * 1000,
          dedupeKey: `${WORKFLOW_ITEM_ENTER_JOB}:wait:${input.item.id}:${input.state.id}:${input.item.enteredStateAt}`,
          recordId: input.item.recordId,
          workflowItemId: input.item.id,
          actorType: input.actor.actorType
        });
        return { outcome: 'waiting', detail: 'wait' };
      }
      case 'createWorkItem': {
        // Deterministic follow-up work: create a Record + WorkflowItem in the
        // target workflow, naming it from the source item through a `{{...}}`
        // template (e.g. `{{title}} follow-up`).
        const target = requireWorkflow(db, input.item.workspaceId, action.workflowId);
        if (!target.objectTypeId) {
          return { outcome: 'failed', detail: 'target_workflow_without_object_type' };
        }
        const source = db
          .select({ displayName: records.displayName, key: records.key })
          .from(records)
          .where(eq(records.id, input.item.recordId))
          .all()[0];
        const context: Record<string, unknown> = {
          title: source?.displayName ?? '',
          displayName: source?.displayName ?? '',
          key: source?.key ?? '',
          ...workflowItemFieldValuesByKey(
            db,
            input.item.workspaceId,
            input.item.id,
            input.item.recordId
          )
        };
        const displayName =
          renderTemplate(action.titleTemplate, context).trim() ||
          source?.displayName ||
          'New work item';
        createWorkflowItemSync(db, input.actor, {
          workflowId: action.workflowId,
          record: { objectTypeId: target.objectTypeId, displayName },
          reason: `Created by system state ${input.state.name}`
        });
        return { outcome: 'ran' };
      }
      case 'http':
        return { outcome: 'failed', detail: 'http_action_not_available_for_workflow_items' };
      default: {
        const exhaustive: never = action;
        return { outcome: 'failed', detail: `unknown_system_action:${String(exhaustive)}` };
      }
    }
  } catch (error) {
    return {
      outcome: 'failed',
      detail: error instanceof Error ? error.message : 'system_action_failed'
    };
  }
}

/** Resolve `{{path}}` references from a context map; unknown paths render empty. */
function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = context[rawPath.trim()];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Manually dispatch the current (or a chosen) state of a WorkflowItem. */
export function dispatchWorkflowItemEntrySync(
  db: Executor,
  actor: ActorContext,
  input: {
    workflowItemId: string;
    stateId?: string | null;
    reason?: string | null;
    force?: boolean;
  }
): { jobId: string; stateId: string } {
  const item = requireWorkflowItemRow(db, actor.workspaceId, input.workflowItemId);
  const stateId = input.stateId ?? item.stateId;
  const state = requireState(db, actor.workspaceId, stateId);
  if (state.workflowId !== item.workflowId) {
    throw errors.validation('State does not belong to this workflow', { stateId });
  }
  if (isTerminalState(state)) {
    throw errors.conflict('Cannot dispatch a terminal state', { stateId });
  }
  if (humanGateOf(state) && !input.force) {
    throw errors.conflict('This state requires a human decision', { stateId });
  }
  const job = enqueueJobSync(db, {
    workspaceId: actor.workspaceId,
    type: WORKFLOW_ITEM_ENTER_JOB,
    payload: {
      workspaceId: actor.workspaceId,
      workflowItemId: item.id,
      stateId: state.id,
      workflowId: item.workflowId,
      recordId: item.recordId,
      enteredAt: item.enteredStateAt,
      reason: input.reason ?? undefined
    } satisfies WorkflowItemEntryPayload,
    priority: 10,
    dedupeKey: `${WORKFLOW_ITEM_ENTER_JOB}:manual:${item.id}:${state.id}:${item.stateRunCount}`,
    recordId: item.recordId,
    workflowItemId: item.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel
  });
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: item.id,
    recordId: item.recordId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    summary: `Work dispatched in ${state.name}`,
    data: { stateId: state.id, jobId: job.id }
  });
  return { jobId: job.id, stateId: state.id };
}

/** Register the `workflow_item.enter` job handler (idempotent). */
export function registerWorkflowItemEntryHandler(): void {
  if (getJobHandler(WORKFLOW_ITEM_ENTER_JOB)) return;
  registerJobHandler(WORKFLOW_ITEM_ENTER_JOB, async (context: JobHandlerContext) => {
    const payload = context.job.payload as unknown as WorkflowItemEntryPayload;
    if (!payload?.workflowItemId || !payload.stateId || !payload.workspaceId) {
      throw errors.validation('workflow_item.enter job is missing its subject');
    }
    const result = await handleWorkflowItemStateEntry(context.db, payload, {
      jobId: context.job.id,
      workerId: context.workerId,
      heartbeat: () => context.heartbeat(),
      signal: context.signal
    });
    if (result.outcome === 'failed') {
      const item = requireWorkflowItemRow(context.db, payload.workspaceId, payload.workflowItemId);
      const state = requireState(context.db, payload.workspaceId, payload.stateId);
      const isFinalAttempt = context.job.attempts >= context.job.maxAttempts;
      if (isFinalAttempt && state.failureStateId) {
        requestWorkflowItemTransitionSync(
          context.db,
          systemActor(payload.workspaceId, 'workflow_items.engine'),
          {
            workflowItemId: item.id,
            targetStateId: state.failureStateId,
            comment: `Automatic failure handling after ${context.job.attempts} attempt(s)`
          }
        );
        return { result: { outcome: 'failed', movedToFailureState: true } };
      }
      throw errors.dependency(result.detail ?? 'Workflow item state entry failed');
    }
    return {
      result: {
        outcome: result.outcome,
        detail: result.detail ?? null,
        runId: result.runId ?? null
      }
    };
  });
}

function incrementStateRunCount(tx: Executor, workflowItemId: string): number {
  const item = tx
    .select({ stateRunCount: workflowItems.stateRunCount })
    .from(workflowItems)
    .where(eq(workflowItems.id, workflowItemId))
    .all()[0];
  const next = (item?.stateRunCount ?? 0) + 1;
  tx.update(workflowItems)
    .set({ stateRunCount: next, updatedAt: Date.now() })
    .where(eq(workflowItems.id, workflowItemId))
    .run();
  return next;
}
