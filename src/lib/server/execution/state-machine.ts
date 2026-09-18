/**
 * State machine helpers: transition resolution, human gates and terminality.
 *
 * Work-item state changes are applied by `workflow-items/service.ts`, which owns
 * the single implementation of "resolve a transition, validate it against the
 * workflow rules, then apply it". This module holds the shared, model-neutral
 * helpers that both the service layer and the execution engine depend on, so the
 * definition of a human gate or a terminal state cannot diverge between callers.
 *
 * Two distinct concepts live side by side (ADR-0013, plan §31):
 *
 *  - **Human gate**: the state intentionally stops automatic progression. Agents
 *    cannot transition out of it; only an authorized human may choose an allowed
 *    outgoing transition. The engine never auto-runs through a gated state merely
 *    because it has outgoing transitions.
 *  - **Approval**: a *running* agent execution is suspended pending a decision and
 *    then resumes. That lives in `approvals/` and `execution/runner.ts`.
 */
import { and, asc, eq } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  type HumanGateConfig,
  type WorkflowState,
  type WorkflowTransition,
  workflowStates,
  workflowTransitions
} from '../db/schema';
import { listOutgoingTransitions, listStates, requireState } from '../workflows/service';

export interface TransitionResolution {
  transition: WorkflowTransition;
  fromState: WorkflowState;
  toState: WorkflowState;
}

/**
 * Resolve the transition a caller is asking for, by id or by target state. Both
 * forms are validated against the workflow's configured transitions, so a caller
 * cannot invent a move.
 */
export function resolveTransition(
  db: Executor,
  options: {
    workspaceId: string;
    workflowId: string;
    fromStateId: string;
    transitionId?: string | null;
    targetStateId?: string | null;
  }
): TransitionResolution {
  const fromState = requireState(db, options.workspaceId, options.fromStateId);
  if (fromState.workflowId !== options.workflowId) {
    throw errors.invalidTransition('The work item is not in this workflow', {
      stateId: options.fromStateId
    });
  }

  const candidates = listOutgoingTransitions(
    db,
    options.workspaceId,
    options.workflowId,
    options.fromStateId
  );

  let transition: WorkflowTransition | undefined;
  if (options.transitionId) {
    transition = candidates.find((candidate) => candidate.id === options.transitionId);
    if (!transition) {
      // Distinguish "exists but not from this state" from "does not exist" so the
      // UI can explain the failure without leaking other workflows' config.
      const anywhere = db
        .select()
        .from(workflowTransitions)
        .where(
          and(
            eq(workflowTransitions.id, options.transitionId),
            eq(workflowTransitions.workspaceId, options.workspaceId)
          )
        )
        .limit(1)
        .all();
      if (anywhere[0]) {
        throw errors.invalidTransition('That transition is not available from the current state', {
          transitionId: options.transitionId,
          fromStateId: options.fromStateId
        });
      }
      throw errors.notFound('Transition', options.transitionId);
    }
  } else if (options.targetStateId) {
    transition = candidates.find((candidate) => candidate.toStateId === options.targetStateId);
    if (!transition) {
      throw errors.invalidTransition('There is no transition to that state', {
        targetStateId: options.targetStateId,
        fromStateId: options.fromStateId
      });
    }
  } else {
    throw errors.validation('Either a transitionId or a targetStateId is required');
  }

  if (transition.fromStateId !== null && transition.fromStateId !== options.fromStateId) {
    throw errors.invalidTransition('That transition is not available from the current state');
  }

  const toState = requireState(db, options.workspaceId, transition.toStateId);
  return { transition, fromState, toState };
}

export function humanGateOf(state: WorkflowState): HumanGateConfig | null {
  const gate = state.humanGate as HumanGateConfig | null;
  return gate?.enabled ? gate : null;
}

/**
 * What the work is waiting on after entering a state. Drives the "Waiting for
 * me / Waiting for agent / Waiting for approval" views.
 */
export function computeWaitingOn(
  state: WorkflowState
): 'human' | 'agent' | 'approval' | 'trigger' | 'none' {
  // Terminality is checked first: a "Done" column is commonly modelled as a manual
  // state with a terminal category, and it must never appear in a waiting queue.
  if (isTerminalState(state)) return 'none';
  if (humanGateOf(state)) return 'human';
  if (state.kind === 'agent') return state.autoExecute ? 'agent' : 'trigger';
  if (state.kind === 'system') return 'agent';
  return 'human';
}

/** A state is terminal when it is explicitly marked, or categorised as done. */
export function isTerminalState(state: WorkflowState): boolean {
  return state.isTerminal || state.category === 'done' || state.category === 'cancelled';
}

/** The state a work item should fall back to when a run fails. */
export function failureStateFor(
  db: Executor,
  workspaceId: string,
  state: WorkflowState
): WorkflowState | null {
  if (!state.failureStateId) return null;
  const rows = db
    .select()
    .from(workflowStates)
    .where(
      and(eq(workflowStates.id, state.failureStateId), eq(workflowStates.workspaceId, workspaceId))
    )
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/** Board ordering: states in configured order with their WIP limits. */
export function statesInOrder(
  db: Executor,
  workspaceId: string,
  workflowId: string
): WorkflowState[] {
  return listStates(db, workspaceId, workflowId);
}

/** Transition graph for a workflow, for the state designer. */
export function transitionGraph(
  db: Executor,
  workspaceId: string,
  workflowId: string
): Array<{ from: string | null; to: string; id: string; name: string }> {
  const rows = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workspaceId, workspaceId),
        eq(workflowTransitions.workflowId, workflowId)
      )
    )
    .orderBy(asc(workflowTransitions.position))
    .all();
  return rows.map((row) => ({
    id: row.id,
    from: row.fromStateId,
    to: row.toStateId,
    name: row.name
  }));
}
