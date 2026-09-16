/**
 * State machine: transitions, human gates and state entry.
 *
 * This module is the only place a ticket's state changes. Everything that moves a
 * ticket — a human clicking a column, an agent reporting an outcome, a system
 * action, an approval resumption or a cross-workflow transfer — resolves a
 * transition here, so the rules cannot diverge between callers.
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
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type HumanGateConfig,
  humanGateDecisions,
  type Ticket,
  ticketStateHistory,
  tickets,
  type WorkflowState,
  type WorkflowTransition,
  workflowStates,
  workflowTransitions
} from '../db/schema';
import { alwaysRequiredFields, fieldsRequiredWhileIn } from '../fields/service';
import { enqueueJobSync } from '../jobs/queue';
import {
  assertRequiredFieldsSatisfied,
  fieldValuesByKey,
  writeTicketFieldValues
} from '../tickets/values';
import { listOutgoingTransitions, listStates, requireState } from '../workflows/service';
import { publishRunEvent, RunEventTypes } from './events';

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
    throw errors.invalidTransition('The ticket is not in this workflow', {
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

export interface TransitionRequestInput {
  actor: ActorContext;
  ticket: Ticket;
  transitionId?: string | null;
  targetStateId?: string | null;
  comment?: string | null;
  /** Field values supplied as part of the transition (gate/required fields). */
  fieldValues?: Record<string, unknown>;
  runId?: string | null;
  reason?: string | null;
  /** Set by the execution engine when it applies an agent's requested outcome. */
  viaRun?: boolean;
}

export function humanGateOf(state: WorkflowState): HumanGateConfig | null {
  const gate = state.humanGate as HumanGateConfig | null;
  return gate?.enabled ? gate : null;
}

/**
 * Validate a transition without applying it. Used both by the real transition path
 * and by the UI to preview what a caller is allowed to do.
 */
export function validateTransition(
  db: Executor,
  input: TransitionRequestInput
): TransitionResolution {
  const ticket = input.ticket;
  const resolution = resolveTransition(db, {
    workspaceId: input.actor.workspaceId,
    workflowId: ticket.workflowId,
    fromStateId: ticket.stateId,
    transitionId: input.transitionId,
    targetStateId: input.targetStateId
  });

  const gate = humanGateOf(resolution.fromState);
  const isHuman = input.actor.actorType === 'user';

  if (gate) {
    // A human gate is a hard stop for automatic progression. An agent run may
    // report that work is finished, but it cannot choose the exit itself.
    if (!isHuman) {
      throw errors.humanGate(
        `"${resolution.fromState.name}" requires a human decision before the ticket can move`,
        { stateId: resolution.fromState.id, stateName: resolution.fromState.name }
      );
    }
    const allowed = gate.allowedTransitionIds;
    if (allowed && allowed.length > 0 && !allowed.includes(resolution.transition.id)) {
      throw errors.policyDenied('That transition is not permitted at this human gate', {
        transitionId: resolution.transition.id,
        allowedTransitionIds: allowed
      });
    }
    if (
      gate.allowedRoles &&
      gate.allowedRoles.length > 0 &&
      !gate.allowedRoles.includes(input.actor.role as never)
    ) {
      throw errors.policyDenied('Your role is not permitted to decide this gate', {
        requiredRoles: gate.allowedRoles
      });
    }
    if (gate.allowedTeamIds?.length) {
      const teams = input.actor.teamIds ?? [];
      if (!teams.some((teamId) => gate.allowedTeamIds?.includes(teamId))) {
        throw errors.policyDenied('Your team is not permitted to decide this gate', {
          requiredTeamIds: gate.allowedTeamIds
        });
      }
    }
    if (gate.requiredComment && (!input.comment || input.comment.trim().length === 0)) {
      throw errors.validation('A comment is required to decide this human gate');
    }
  }

  // Transition-level rules.
  const allowedRoles = resolution.transition.allowedRoles as string[] | null;
  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(input.actor.role)) {
    throw errors.policyDenied('Your role is not permitted to use that transition', {
      requiredRoles: allowedRoles
    });
  }
  if (
    resolution.transition.requiresComment &&
    (!input.comment || input.comment.trim().length === 0)
  ) {
    throw errors.validation(`A comment is required to "${resolution.transition.name}"`);
  }

  const condition = resolution.transition.condition as {
    fieldEquals?: Array<{ fieldKey: string; value: unknown }>;
    actors?: string[];
    minDwellSeconds?: number;
  } | null;
  if (condition) {
    if (condition.actors && condition.actors.length > 0) {
      const actorKind =
        input.actor.actorType === 'user'
          ? 'human'
          : input.actor.actorType === 'agent'
            ? 'agent'
            : 'system';
      if (!condition.actors.includes(actorKind) && !condition.actors.includes('any')) {
        throw errors.policyDenied('That transition is not available to this kind of actor', {
          actors: condition.actors
        });
      }
    }
    if (condition.minDwellSeconds !== undefined) {
      const dwell = Date.now() - ticket.enteredStateAt;
      if (dwell < condition.minDwellSeconds * 1000) {
        throw errors.precondition(
          `This transition requires staying in the state for at least ${condition.minDwellSeconds}s`,
          { dwellMs: dwell, requiredMs: condition.minDwellSeconds * 1000 }
        );
      }
    }
    if (condition.fieldEquals && condition.fieldEquals.length > 0) {
      const values = fieldValuesByKey(db, input.actor.workspaceId, ticket.id);
      const failures = condition.fieldEquals.filter(
        (rule) =>
          JSON.stringify(values[rule.fieldKey] ?? null) !== JSON.stringify(rule.value ?? null)
      );
      if (failures.length > 0) {
        throw errors.precondition('This transition has unmet conditions', {
          conditions: failures.map((rule) => rule.fieldKey)
        });
      }
    }
  }

  // Field requirements, in the order a reviewer would expect to see them:
  //  - the transition's own list and the gate's list (explicit policy);
  //  - fields the workflow marks universally required;
  //  - fields that must hold a value while the ticket is in the *source* state —
  //    this is what makes "Review Outcome is required before leaving Human review"
  //    true without making the state impossible to enter.
  const requiredKeys = new Set<string>([
    ...((resolution.transition.requiredFieldKeys as string[] | null) ?? []),
    ...(gate?.requiredFieldKeys ?? []),
    ...alwaysRequiredFields(db, input.actor.workspaceId, ticket.workflowId).map(
      (definition) => definition.key
    ),
    ...fieldsRequiredWhileIn(
      db,
      input.actor.workspaceId,
      ticket.workflowId,
      resolution.fromState.id
    ).map((definition) => definition.key)
  ]);
  if (requiredKeys.size > 0) {
    const values = fieldValuesByKey(db, input.actor.workspaceId, ticket.id);
    const merged = { ...values, ...(input.fieldValues ?? {}) };
    const missing = [...requiredKeys].filter((key) => {
      const value = merged[key];
      return (
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      );
    });
    if (missing.length > 0) {
      throw errors.precondition(`Required field(s) missing: ${missing.join(', ')}`, {
        fieldKeys: missing
      });
    }
  }

  return resolution;
}

export interface AppliedTransition {
  ticket: Ticket;
  transitionId: string | null;
  fromStateId: string;
  toStateId: string;
  historyId: string;
  enteredAt: number;
}

/**
 * Apply a transition: close the current state interval, open the next one, update
 * the ticket and enqueue destination-state work — all in one transaction.
 *
 * `withTicketTransaction` is the caller's responsibility; this function is
 * synchronous so it can run inside one.
 */
export function applyTransitionSync(
  tx: Executor,
  input: TransitionRequestInput & { resolution: TransitionResolution }
): AppliedTransition {
  const { actor, resolution } = input;
  const workspaceId = actor.workspaceId;
  const now = Date.now();
  const current = input.ticket;

  // Guard against a concurrent writer having moved the ticket already.
  const fresh = tx.select().from(tickets).where(eq(tickets.id, current.id)).limit(1).all()[0];
  if (!fresh) throw errors.notFound('Ticket', current.id);
  if (fresh.stateId !== resolution.fromState.id) {
    throw errors.versionConflict('Ticket state', 0, fresh.version);
  }

  // Apply field values that accompany the transition before validating the
  // destination's requirements, so a form submission can satisfy them in one step.
  if (input.fieldValues && Object.keys(input.fieldValues).length > 0) {
    writeTicketFieldValues(tx, {
      workspaceId,
      ticketId: current.id,
      workflowId: current.workflowId,
      values: input.fieldValues,
      actor,
      runId: input.runId ?? null,
      source:
        actor.actorType === 'agent' ? 'agent' : actor.actorType === 'user' ? 'human' : 'system'
    });
  }

  // Universally required fields must hold in the destination too. State-scoped
  // requirements are deliberately *not* checked here: they describe what the work in
  // that state produces, and are enforced when the ticket leaves it.
  const universal = alwaysRequiredFields(tx, workspaceId, current.workflowId);
  assertRequiredFieldsSatisfied(tx, {
    workspaceId,
    ticketId: current.id,
    workflowId: current.workflowId,
    stateId: resolution.toState.id,
    requiredFields: universal
  });

  // Close the open interval.
  tx.update(ticketStateHistory)
    .set({ exitedAt: now, durationMs: now - current.enteredStateAt })
    .where(and(eq(ticketStateHistory.ticketId, current.id), isNull(ticketStateHistory.exitedAt)))
    .run();

  const historyId = uuidv7(now);
  tx.insert(ticketStateHistory)
    .values({
      id: historyId,
      workspaceId,
      ticketId: current.id,
      workflowId: current.workflowId,
      stateId: resolution.toState.id,
      stateName: resolution.toState.name,
      stateKind: resolution.toState.kind,
      previousStateId: resolution.fromState.id,
      enteredAt: now,
      enteredByType: actor.actorType,
      enteredById: actor.actorId,
      enteredByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      transitionId: resolution.transition.id,
      reason: input.reason ?? input.comment ?? null
    })
    .run();

  const isTerminal =
    resolution.toState.isTerminal ||
    resolution.toState.category === 'done' ||
    resolution.toState.category === 'cancelled';
  const waitingOn = computeWaitingOn(resolution.toState);

  const updated = tx
    .update(tickets)
    .set({
      stateId: resolution.toState.id,
      enteredStateAt: now,
      lastActivityAt: now,
      stateRunCount: 0,
      waitingOn,
      closedAt: isTerminal ? now : null,
      version: sql`${tickets.version} + 1`,
      updatedAt: now
    })
    .where(eq(tickets.id, current.id))
    .returning()
    .all();
  const ticket = updated[0];
  if (!ticket) throw errors.internal('Failed to update ticket state');

  writeAudit(tx, {
    workspaceId,
    action: AuditActions.ticketStateExited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: ticket.id,
    ticketId: ticket.id,
    workflowId: ticket.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: `Left ${resolution.fromState.name}`,
    data: {
      fromStateId: resolution.fromState.id,
      toStateId: resolution.toState.id,
      dwellMs: now - current.enteredStateAt
    },
    occurredAt: now
  });

  writeAudit(tx, {
    workspaceId,
    action: AuditActions.ticketStateEntered,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: ticket.id,
    ticketId: ticket.id,
    workflowId: ticket.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: `Entered ${resolution.toState.name}`,
    data: {
      stateId: resolution.toState.id,
      stateName: resolution.toState.name,
      viaTransition: resolution.transition.name,
      comment: input.comment ?? null
    },
    occurredAt: now
  });

  publishRunEvent(
    tx,
    {
      workspaceId,
      runId: input.runId ?? null,
      ticketId: ticket.id,
      type: RunEventTypes.stateTransition,
      data: {
        fromStateId: resolution.fromState.id,
        fromStateName: resolution.fromState.name,
        toStateId: resolution.toState.id,
        toStateName: resolution.toState.name,
        transitionId: resolution.transition.id,
        transitionName: resolution.transition.name,
        actorLabel: actor.actorLabel
      }
    },
    now
  );

  enqueueDestinationStateWork(tx, {
    workspaceId,
    ticket,
    state: resolution.toState,
    actor,
    enteredAt: now
  });

  return {
    ticket,
    transitionId: resolution.transition.id,
    fromStateId: resolution.fromState.id,
    toStateId: resolution.toState.id,
    historyId,
    enteredAt: now
  };
}

/**
 * Enqueue the destination state's work. Human-gated states deliberately enqueue
 * nothing: progression is a human decision, not a job.
 */
export function enqueueDestinationStateWork(
  tx: Executor,
  options: {
    workspaceId: string;
    ticket: Ticket;
    state: WorkflowState;
    actor: ActorContext;
    enteredAt: number;
    /** Suppress execution when the caller explicitly defers dispatch. */
    defer?: boolean;
  }
): void {
  if (options.defer) return;
  const gate = humanGateOf(options.state);
  if (gate) {
    // Nothing to execute; mark the ticket as waiting on a human so My Work and
    // the board both show it in the right queue.
    tx.update(tickets)
      .set({ waitingOn: 'human', updatedAt: Date.now() })
      .where(eq(tickets.id, options.ticket.id))
      .run();
    return;
  }

  if (isTerminalState(options.state)) {
    tx.update(tickets)
      .set({ waitingOn: 'none', updatedAt: Date.now() })
      .where(eq(tickets.id, options.ticket.id))
      .run();
    return;
  }

  if (options.state.kind === 'agent') {
    if (!options.state.autoExecute) return;
    enqueueJobSync(tx, {
      workspaceId: options.workspaceId,
      type: 'state.enter',
      payload: {
        ticketId: options.ticket.id,
        stateId: options.state.id,
        workflowId: options.ticket.workflowId,
        enteredAt: options.enteredAt
      },
      priority: 5,
      maxAttempts: Math.max(1, options.state.maxAttempts),
      timeoutSeconds: options.state.timeoutSeconds ?? undefined,
      ticketId: options.ticket.id,
      // Idempotency: the same entry of the same state for the same ticket can only
      // be dispatched once, even if the transition is replayed.
      dedupeKey: `state.enter:${options.ticket.id}:${options.state.id}:${options.enteredAt}`,
      actorType: options.actor.actorType,
      actorId: options.actor.actorId,
      actorLabel: options.actor.actorLabel
    });
    return;
  }

  if (options.state.kind === 'system') {
    enqueueJobSync(tx, {
      workspaceId: options.workspaceId,
      type: 'state.enter',
      payload: {
        ticketId: options.ticket.id,
        stateId: options.state.id,
        workflowId: options.ticket.workflowId,
        enteredAt: options.enteredAt
      },
      priority: 8,
      ticketId: options.ticket.id,
      dedupeKey: `state.enter:${options.ticket.id}:${options.state.id}:${options.enteredAt}`,
      actorType: options.actor.actorType,
      actorId: options.actor.actorId,
      actorLabel: options.actor.actorLabel
    });
  }
}

/**
 * What the ticket is waiting on after entering a state. Drives the "Waiting for
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

/** Record the initial state interval for a newly created ticket. */
export function recordInitialStateSync(
  tx: Executor,
  options: {
    workspaceId: string;
    ticket: Ticket;
    state: WorkflowState;
    actor: ActorContext;
    enteredAt: number;
    reason?: string | null;
  }
): string {
  const historyId = uuidv7(options.enteredAt);
  tx.insert(ticketStateHistory)
    .values({
      id: historyId,
      workspaceId: options.workspaceId,
      ticketId: options.ticket.id,
      workflowId: options.ticket.workflowId,
      stateId: options.state.id,
      stateName: options.state.name,
      stateKind: options.state.kind,
      previousStateId: null,
      enteredAt: options.enteredAt,
      enteredByType: options.actor.actorType,
      enteredById: options.actor.actorId,
      enteredByLabel: options.actor.actorLabel,
      runId: options.actor.runId ?? null,
      reason: options.reason ?? 'Ticket created'
    })
    .run();
  return historyId;
}

// ---------------------------------------------------------------------------
// Human gate decisions
// ---------------------------------------------------------------------------

export interface HumanGateDecisionInput {
  actor: ActorContext;
  ticket: Ticket;
  toStateId: string;
  transitionId?: string | null;
  comment?: string | null;
  outcome?: 'approved' | 'rework' | 'rejected' | 'custom';
  fieldValues?: Record<string, unknown>;
}

/**
 * A human decides a gate. This is the *only* path out of a gated state, and it
 * records the decision explicitly so the ticket timeline can show who decided
 * what, and why.
 */
export function decideHumanGateSync(
  tx: Executor,
  input: HumanGateDecisionInput
): AppliedTransition {
  const actor = input.actor;
  if (actor.actorType !== 'user') {
    throw errors.forbidden('Only a human may decide a human gate', {
      actorType: actor.actorType
    });
  }
  assertPermission(actor, Permissions.ticketWrite, 'Not permitted to move tickets');

  const state = requireState(tx, actor.workspaceId, input.ticket.stateId);
  const gate = humanGateOf(state);
  if (!gate) {
    throw errors.precondition(`"${state.name}" is not a human-gated state`, {
      stateId: state.id
    });
  }
  if (!input.comment || input.comment.trim().length === 0) {
    if (gate.requiredComment) {
      throw errors.validation('A comment is required to decide this human gate');
    }
  }

  const resolution = validateTransition(tx, {
    actor,
    ticket: input.ticket,
    transitionId: input.transitionId,
    targetStateId: input.toStateId,
    comment: input.comment,
    fieldValues: input.fieldValues
  });

  const applied = applyTransitionSync(tx, {
    actor,
    ticket: input.ticket,
    transitionId: resolution.transition.id,
    comment: input.comment,
    fieldValues: input.fieldValues,
    reason: input.comment ?? resolution.transition.name,
    resolution
  });

  const now = Date.now();
  tx.insert(humanGateDecisions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      ticketId: input.ticket.id,
      workflowId: input.ticket.workflowId,
      stateId: state.id,
      transitionId: resolution.transition.id,
      toStateId: resolution.toState.id,
      outcome: input.outcome ?? 'custom',
      comment: input.comment ?? null,
      decidedByUserId: actor.actorId as string,
      decidedByLabel: actor.actorLabel,
      createdAt: now
    })
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.humanGateDecided,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'ticket',
    entityId: input.ticket.id,
    ticketId: input.ticket.id,
    workflowId: input.ticket.workflowId,
    summary: `${actor.actorLabel ?? 'A reviewer'} chose "${resolution.transition.name}" at ${state.name}`,
    data: {
      fromStateId: state.id,
      toStateId: resolution.toState.id,
      transitionId: resolution.transition.id,
      outcome: input.outcome ?? 'custom',
      comment: input.comment ?? null
    },
    occurredAt: now
  });

  return applied;
}

/** Audit helper for refused automatic progression through a gate. */
export function auditGateBlocked(
  tx: Executor,
  options: { actor: ActorContext; ticket: Ticket; state: WorkflowState }
): void {
  writeAudit(tx, {
    workspaceId: options.actor.workspaceId,
    action: AuditActions.humanGateBlocked,
    actorType: options.actor.actorType,
    actorId: options.actor.actorId,
    actorLabel: options.actor.actorLabel,
    entityType: 'ticket',
    entityId: options.ticket.id,
    ticketId: options.ticket.id,
    workflowId: options.ticket.workflowId,
    runId: options.actor.runId ?? null,
    summary: `Automatic progression blocked by the human gate at ${options.state.name}`,
    data: { stateId: options.state.id }
  });
}

/** The state a ticket should fall back to when a run fails. */
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
