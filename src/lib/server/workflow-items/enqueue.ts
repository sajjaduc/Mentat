/**
 * WorkflowItem work enqueue seam (ADR-0024).
 *
 * Kept in its own module so the WorkflowItem service can enqueue destination work
 * without importing the dispatch executor (which imports the service).
 */
import { eq } from 'drizzle-orm';
import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';
import type { WorkflowItem, WorkflowState } from '../db/schema';
import { workflowItems } from '../db/schema';
import { computeWaitingOn, humanGateOf, isTerminalState } from '../execution/state-machine';
import { enqueueJobSync } from '../jobs/queue';

export const WORKFLOW_ITEM_ENTER_JOB = 'workflow_item.enter';

export interface WorkflowItemEntryPayload {
  workspaceId: string;
  workflowItemId: string;
  stateId: string;
  workflowId: string;
  recordId: string;
  enteredAt: number;
  reason?: string;
}

/**
 * Enqueue the work implied by entering `state`. Called inside the transaction that
 * moved the item, so dispatched work can never observe an uncommitted move.
 */
export function enqueueDestinationWorkflowItemWorkSync(
  tx: Executor,
  input: {
    workspaceId: string;
    item: WorkflowItem;
    state: WorkflowState;
    actor: ActorContext;
    enteredAt: number;
    /** Suppress enqueue when the caller owns dispatch. */
    defer?: boolean;
  }
): void {
  if (humanGateOf(input.state)) {
    setWaitingOn(tx, input.item.id, 'human');
    return;
  }
  if (isTerminalState(input.state)) {
    setWaitingOn(tx, input.item.id, 'none');
    return;
  }
  setWaitingOn(tx, input.item.id, computeWaitingOn(input.state));
  if (input.defer) return;

  const shouldRun =
    input.state.kind === 'system' ||
    (input.state.kind === 'agent' && input.state.autoExecute !== false);
  if (!shouldRun) return;

  enqueueJobSync(tx, {
    workspaceId: input.workspaceId,
    type: WORKFLOW_ITEM_ENTER_JOB,
    payload: {
      workspaceId: input.workspaceId,
      workflowItemId: input.item.id,
      stateId: input.state.id,
      workflowId: input.item.workflowId,
      recordId: input.item.recordId,
      enteredAt: input.enteredAt
    } satisfies WorkflowItemEntryPayload,
    priority: input.state.kind === 'system' ? 8 : 5,
    maxAttempts: Math.max(1, input.state.maxAttempts),
    timeoutSeconds: input.state.timeoutSeconds ?? undefined,
    dedupeKey: `${WORKFLOW_ITEM_ENTER_JOB}:${input.item.id}:${input.state.id}:${input.enteredAt}`,
    recordId: input.item.recordId,
    workflowItemId: input.item.id,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    actorLabel: input.actor.actorLabel
  });
}

export function setWaitingOn(tx: Executor, workflowItemId: string, waitingOn: string | null): void {
  tx.update(workflowItems)
    .set({ waitingOn: waitingOn as never, updatedAt: Date.now() })
    .where(eq(workflowItems.id, workflowItemId))
    .run();
}
