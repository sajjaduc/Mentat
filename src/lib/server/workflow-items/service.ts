/**
 * WorkflowItem service: a Record's participation in one Workflow (ADR-0021).
 *
 * The single write path for state changes is `applyWorkflowItemTransitionSync`, so
 * humans, agents and approvals cannot diverge. Transfer and add-participation are
 * separate operations with separate history — never a mutated foreign key.
 *
 * Agent execution is dispatched through the generic WorkflowItem entry engine
 * (`./dispatch`); Record identity (title/key/number/description/priority) lives on
 * the Record and its base field values, never on the participation.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { AuditActions, queryAudit, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import {
  type FileLinkRelationship,
  fieldDefinitions,
  files,
  fileWorkflowItems,
  labels,
  records,
  type WorkflowItemWait,
  workflowFields,
  workflowItemLabels,
  workflowItemNoteRevisions,
  workflowItemNotes,
  workflowItemRelationships,
  workflowItemStateHistory,
  workflowItems,
  workflowItemWorkflowHistory,
  workflowStates,
  workflows,
  workflowTransferRules,
  workflowTransitions
} from '../db/schema';
import { publishRunEvent, RunEventTypes } from '../execution/events';
import {
  computeWaitingOn,
  humanGateOf,
  isTerminalState,
  resolveTransition
} from '../execution/state-machine';
import {
  alwaysRequiredFields,
  fieldsRequiredWhileIn,
  requiredFieldsForTransfer
} from '../fields/service';
import { listBaseFieldsSync, requireObjectType } from '../records/object-types';
import { createRecordSync } from '../records/service';
import { recordFieldHistory } from '../records/values';
import { listStates, requireState, requireWorkflow } from '../workflows/service';
import { enqueueDestinationWorkflowItemWorkSync } from './enqueue';
import {
  workflowItemFieldHistory,
  workflowItemFieldValuesByKey,
  writeWorkflowItemFieldValues
} from './fields';
import { listWorkflowItems, type WorkflowItemListRow, type WorkflowItemPage } from './query';
import type {
  CreateWorkflowItemInput,
  FieldChange,
  WorkflowItemDetail,
  WorkflowItemSummary,
  WorkflowItemTransitionView
} from './types';

export async function createWorkflowItem(
  db: Executor,
  actor: ActorContext,
  input: CreateWorkflowItemInput
): Promise<WorkflowItemSummary> {
  return withTransaction(db, (tx) => summarize(tx, createWorkflowItemSync(tx, actor, input)));
}

export function createWorkflowItemSync(
  tx: Executor,
  actor: ActorContext,
  input: CreateWorkflowItemInput
): WorkflowItemRow {
  assertPermission(actor, Permissions.workflowItemCreate, 'Not permitted to start work');
  const workflow = requireWorkflow(tx, actor.workspaceId, input.workflowId);
  if (workflow.archivedAt) {
    throw errors.precondition('This workflow is archived and cannot accept new work');
  }

  const record = resolveOrCreateRecord(tx, actor, workflow, input);
  const state = resolveStartState(
    tx,
    actor.workspaceId,
    input.workflowId,
    workflow.defaultStateId,
    input.stateId
  );
  enforceParticipationPolicy(tx, actor.workspaceId, workflow, record.id, state.id);

  const now = Date.now();
  const inserted = tx
    .insert(workflowItems)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowId: workflow.id,
      recordId: record.id,
      stateId: state.id,
      ownerUserId: input.ownerUserId ?? null,
      ownerTeamId: input.ownerTeamId ?? null,
      version: 1,
      structuredData: (input.structuredData as never) ?? null,
      originWorkflowItemId: input.originWorkflowItemId ?? null,
      sourceWorkflowItemId: input.sourceWorkflowItemId ?? null,
      participation: input.participation ?? 'primary',
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdByLabel: actor.actorLabel,
      provenance: (input.provenance as never) ?? null,
      enteredStateAt: now,
      lastActivityAt: now,
      closedAt: null,
      completedAt: null,
      stateRunCount: 0,
      waitingOn: computeWaitingOn(state),
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.internal('Failed to create workflow item');

  if (input.fields && Object.keys(input.fields).length > 0) {
    writeWorkflowItemFieldValues(tx, {
      workspaceId: actor.workspaceId,
      workflowItemId: inserted.id,
      workflowId: workflow.id,
      recordId: record.id,
      objectTypeId: record.objectTypeId,
      values: input.fields,
      actor
    });
  }

  tx.insert(workflowItemStateHistory)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowItemId: inserted.id,
      workflowId: workflow.id,
      stateId: state.id,
      stateName: state.name,
      stateKind: state.kind,
      previousStateId: null,
      enteredAt: now,
      enteredByType: actor.actorType,
      enteredById: actor.actorId,
      enteredByLabel: actor.actorLabel,
      runId: actor.runId ?? null,
      reason: input.reason ?? 'Work started'
    })
    .run();

  tx.insert(workflowItemWorkflowHistory)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowItemId: inserted.id,
      kind:
        input.participation === 'transferred'
          ? 'transfer'
          : input.participation === 'additional'
            ? 'add_participation'
            : 'initial',
      fromWorkflowId: null,
      fromStateId: null,
      toWorkflowId: workflow.id,
      toStateId: state.id,
      sourceWorkflowItemId: input.sourceWorkflowItemId ?? null,
      reason: input.reason ?? null,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      runId: actor.runId ?? null,
      createdAt: now
    })
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: inserted.id,
    recordId: record.id,
    workflowItemId: inserted.id,
    workflowId: workflow.id,
    summary: `${workflow.name}: work started`,
    data: { stateId: state.id, participation: inserted.participation }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: record.id,
    workflowItemId: inserted.id,
    type: RunEventTypes.workflowItemCreated,
    data: { workflowId: workflow.id, stateId: state.id }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: record.id,
    workflowItemId: inserted.id,
    type: RunEventTypes.workflowItemStateEntered,
    data: { stateId: state.id, stateName: state.name }
  });
  enqueueDestinationWorkflowItemWorkSync(tx, {
    workspaceId: actor.workspaceId,
    item: inserted,
    state,
    actor,
    enteredAt: now,
    defer: input.deferExecution
  });
  return inserted;
}

export type WorkflowItemRow = typeof workflowItems.$inferSelect;

function resolveOrCreateRecord(
  tx: Executor,
  actor: ActorContext,
  workflow: { id: string; objectTypeId: string | null; workspaceId: string; name: string },
  input: CreateWorkflowItemInput
) {
  if (input.recordId) {
    const row = tx
      .select()
      .from(records)
      .where(and(eq(records.workspaceId, actor.workspaceId), eq(records.id, input.recordId)))
      .all()[0];
    if (!row) throw errors.notFound('Record', input.recordId);
    if (row.archivedAt) {
      throw errors.conflict('Archived records cannot start new work', { recordId: row.id });
    }
    assertObjectTypeMatches(tx, actor.workspaceId, workflow, row.objectTypeId);
    return row;
  }
  if (input.record) {
    const objectTypeId = workflow.objectTypeId ?? undefined;
    const created = createRecordSync(tx, actor, {
      ...input.record,
      objectTypeId: input.record.objectTypeId ?? objectTypeId ?? null
    });
    assertObjectTypeMatches(tx, actor.workspaceId, workflow, created.objectTypeId);
    return created;
  }
  throw errors.validation('A workflow item needs a recordId or an inline record');
}

function assertObjectTypeMatches(
  tx: Executor,
  workspaceId: string,
  workflow: { objectTypeId: string | null; id: string },
  recordObjectTypeId: string
): void {
  const resolved =
    workflow.objectTypeId ?? resolveWorkflowObjectTypeId(tx, workspaceId, workflow.id);
  if (resolved !== recordObjectTypeId) {
    const expected = requireObjectType(tx, workspaceId, resolved);
    const actual = requireObjectType(tx, workspaceId, recordObjectTypeId);
    throw errors.validation(`This workflow processes ${expected.name}, not ${actual.name}`, {
      workflowObjectTypeId: resolved,
      recordObjectTypeId
    });
  }
}

function resolveWorkflowObjectTypeId(
  tx: Executor,
  workspaceId: string,
  workflowId: string
): string {
  const workflow = requireWorkflow(tx, workspaceId, workflowId);
  if (workflow.objectTypeId) return workflow.objectTypeId;
  throw errors.precondition('This workflow has no Object Type configured', { workflowId });
}

function resolveStartState(
  tx: Executor,
  workspaceId: string,
  workflowId: string,
  defaultStateId: string | null,
  requestedStateId?: string | null
) {
  const stateId = requestedStateId ?? defaultStateId;
  if (stateId) {
    const state = requireState(tx, workspaceId, stateId);
    if (state.workflowId !== workflowId) {
      throw errors.validation('State does not belong to this workflow', { stateId });
    }
    return state;
  }
  const states = listStates(tx, workspaceId, workflowId).filter((state) => !isTerminalState(state));
  const start = states.find((state) => state.isStart) ?? states[0];
  if (!start) throw errors.conflict('This workflow has no start state', { workflowId });
  return start;
}

function enforceParticipationPolicy(
  tx: Executor,
  workspaceId: string,
  workflow: { id: string; settings: unknown },
  recordId: string,
  stateId: string
): void {
  const settings = (workflow.settings as { allowMultipleActiveItems?: boolean } | null) ?? {};
  if (settings.allowMultipleActiveItems === true) return;
  const active = tx
    .select({ id: workflowItems.id })
    .from(workflowItems)
    .where(
      and(
        eq(workflowItems.workspaceId, workspaceId),
        eq(workflowItems.workflowId, workflow.id),
        eq(workflowItems.recordId, recordId),
        isNull(workflowItems.archivedAt),
        isNull(workflowItems.completedAt)
      )
    )
    .all();
  if (active.length > 0) {
    throw errors.conflict('This record already has active work in this workflow', {
      workflowId: workflow.id,
      recordId,
      stateId,
      existingWorkflowItemId: active[0]?.id
    });
  }
}

export function requireWorkflowItemRow(
  db: Executor,
  workspaceId: string,
  workflowItemId: string
): WorkflowItemRow {
  const row = db
    .select()
    .from(workflowItems)
    .where(and(eq(workflowItems.workspaceId, workspaceId), eq(workflowItems.id, workflowItemId)))
    .all()[0];
  if (!row) throw errors.notFound('Workflow item', workflowItemId);
  return row;
}

export async function requireWorkflowItem(
  db: Executor,
  actor: ActorContext,
  workflowItemId: string
): Promise<WorkflowItemSummary> {
  assertPermission(actor, Permissions.workflowItemRead, 'Not permitted to read work');
  return summarize(db, requireWorkflowItemRow(db, actor.workspaceId, workflowItemId));
}

export function summarize(_db: Executor, row: WorkflowItemRow): WorkflowItemSummary {
  return {
    id: row.id,
    workflowId: row.workflowId,
    recordId: row.recordId,
    stateId: row.stateId,
    ownerUserId: row.ownerUserId,
    ownerTeamId: row.ownerTeamId,
    participation: row.participation,
    version: row.version,
    waitingOn: row.waitingOn,
    enteredStateAt: row.enteredStateAt,
    lastActivityAt: row.lastActivityAt,
    completedAt: row.completedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function getWorkflowItemDetail(
  db: Executor,
  actor: ActorContext,
  workflowItemId: string
): Promise<WorkflowItemDetail> {
  assertPermission(actor, Permissions.workflowItemRead, 'Not permitted to read work');
  const row = requireWorkflowItemRow(db, actor.workspaceId, workflowItemId);
  const workflow = requireWorkflow(db, actor.workspaceId, row.workflowId);
  const state = requireState(db, actor.workspaceId, row.stateId);
  const record = db.select().from(records).where(eq(records.id, row.recordId)).all()[0];
  if (!record) throw errors.notFound('Record', row.recordId);
  const objectType = requireObjectType(db, actor.workspaceId, record.objectTypeId);

  const transitions = buildTransitionViews(db, actor.workspaceId, row);
  const notes = db
    .select()
    .from(workflowItemNotes)
    .where(
      and(
        eq(workflowItemNotes.workspaceId, actor.workspaceId),
        eq(workflowItemNotes.workflowItemId, row.id),
        isNull(workflowItemNotes.deletedAt)
      )
    )
    .orderBy(desc(workflowItemNotes.createdAt))
    .all();
  const stateHistory = db
    .select()
    .from(workflowItemStateHistory)
    .where(
      and(
        eq(workflowItemStateHistory.workspaceId, actor.workspaceId),
        eq(workflowItemStateHistory.workflowItemId, row.id)
      )
    )
    .orderBy(asc(workflowItemStateHistory.enteredAt))
    .all();

  return {
    ...summarize(db, row),
    record: {
      id: record.id,
      displayName: record.displayName,
      key: record.key,
      number: record.number,
      objectTypeId: record.objectTypeId,
      objectTypeKey: objectType.key,
      objectTypeName: objectType.name
    },
    workflow: { id: workflow.id, name: workflow.name, key: workflow.key },
    state: {
      id: state.id,
      name: state.name,
      kind: state.kind,
      category: state.category,
      isTerminal: isTerminalState(state)
    },
    fields: workflowItemFieldValuesByKey(db, actor.workspaceId, row.id, record.id),
    availableTransitions: transitions,
    notes: notes.map((note) => ({
      id: note.id,
      authorType: note.authorType,
      authorId: note.authorId,
      authorLabel: note.authorLabel,
      body: note.body,
      createdAt: note.createdAt,
      editedAt: note.editedAt
    })),
    stateHistory: stateHistory.map((entry) => ({
      id: entry.id,
      stateId: entry.stateId,
      stateName: entry.stateName,
      enteredAt: entry.enteredAt,
      exitedAt: entry.exitedAt,
      durationMs: entry.durationMs,
      enteredByLabel: entry.enteredByLabel,
      reason: entry.reason
    }))
  };
}

function buildTransitionViews(
  db: Executor,
  workspaceId: string,
  item: WorkflowItemRow
): WorkflowItemTransitionView[] {
  const states = new Map(
    listStates(db, workspaceId, item.workflowId).map((state) => [state.id, state])
  );
  const outgoing = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workspaceId, workspaceId),
        eq(workflowTransitions.workflowId, item.workflowId),
        or(
          eq(workflowTransitions.fromStateId, item.stateId),
          isNull(workflowTransitions.fromStateId)
        )
      )
    )
    .orderBy(asc(workflowTransitions.position))
    .all();
  return outgoing.map((transition) => ({
    id: transition.id,
    name: transition.name,
    toStateId: transition.toStateId,
    toStateName: states.get(transition.toStateId)?.name ?? transition.toStateId,
    requiresComment: transition.requiresComment,
    requiredFieldKeys: (transition.requiredFieldKeys as string[] | null) ?? []
  }));
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface WorkflowItemTransitionInput {
  workflowItemId: string;
  transitionId?: string | null;
  targetStateId?: string | null;
  comment?: string | null;
  fieldValues?: Record<string, unknown>;
  runId?: string | null;
  reason?: string | null;
  /** Set when the transition originates from a decision surface rather than a drag. */
  viaGate?: boolean;
}

export interface WorkflowItemTransitionResult {
  workflowItemId: string;
  fromStateId: string;
  toStateId: string;
  transitionId: string | null;
  historyId: string;
  enteredAt: number;
}

export async function requestWorkflowItemTransition(
  db: Executor,
  actor: ActorContext,
  input: WorkflowItemTransitionInput
): Promise<WorkflowItemTransitionResult> {
  return withTransaction(db, (tx) => requestWorkflowItemTransitionSync(tx, actor, input));
}

export function requestWorkflowItemTransitionSync(
  tx: Executor,
  actor: ActorContext,
  input: WorkflowItemTransitionInput
): WorkflowItemTransitionResult {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to move work');
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  if (item.completedAt) {
    throw errors.conflict('Completed work cannot transition', { workflowItemId: item.id });
  }
  const resolution = resolveTransition(tx, {
    workspaceId: actor.workspaceId,
    workflowId: item.workflowId,
    fromStateId: item.stateId,
    transitionId: input.transitionId ?? null,
    targetStateId: input.targetStateId ?? null
  });
  validateWorkflowItemTransition(tx, actor, item, resolution, input);
  const applied = applyWorkflowItemTransitionSync(tx, actor, item, resolution, input);
  if (input.viaGate) {
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.workflowItemHumanGateDecided,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'workflow_item',
      entityId: item.id,
      recordId: item.recordId,
      workflowItemId: item.id,
      workflowId: item.workflowId,
      summary: `Human gate decided in ${resolution.fromState.name}`,
      data: { transitionId: resolution.transition.id, comment: input.comment ?? null }
    });
  }
  return applied;
}

type TransitionResolution = ReturnType<typeof resolveTransition>;

function validateWorkflowItemTransition(
  tx: Executor,
  actor: ActorContext,
  item: WorkflowItemRow,
  resolution: TransitionResolution,
  input: WorkflowItemTransitionInput
): void {
  const transition = resolution.transition;
  const gate = humanGateOf(resolution.fromState);
  if (gate) {
    if (actor.actorType !== 'user') {
      throw errors.forbidden('This state waits for a human decision', {
        stateId: resolution.fromState.id
      });
    }
    if (gate.allowedTransitionIds && gate.allowedTransitionIds.length > 0) {
      if (!gate.allowedTransitionIds.includes(transition.id)) {
        throw errors.forbidden('That transition is not permitted from this gate', {
          transitionId: transition.id,
          allowed: gate.allowedTransitionIds
        });
      }
    }
    if (
      gate.allowedRoles &&
      gate.allowedRoles.length > 0 &&
      !gate.allowedRoles.includes(actor.role as 'owner' | 'admin' | 'member')
    ) {
      throw errors.forbidden('Your role cannot decide this gate', { role: actor.role });
    }
    if (gate.allowedTeamIds && gate.allowedTeamIds.length > 0) {
      const teams = actor.teamIds ?? [];
      if (!gate.allowedTeamIds.some((teamId) => teams.includes(teamId))) {
        throw errors.forbidden('Your team cannot decide this gate', { teams });
      }
    }
    if (gate.requiredComment && !input.comment?.trim()) {
      throw errors.validation('This gate requires a comment');
    }
  }
  if (
    transition.allowedRoles &&
    transition.allowedRoles.length > 0 &&
    !transition.allowedRoles.includes(actor.role)
  ) {
    throw errors.forbidden('Your role cannot take this transition', {
      transitionId: transition.id,
      role: actor.role
    });
  }
  if (transition.requiresComment && !input.comment?.trim()) {
    throw errors.validation('This transition requires a comment');
  }
  const condition = transition.condition;
  if (condition?.actors && condition.actors.length > 0) {
    if (!condition.actors.includes(actor.actorType as 'human' | 'agent' | 'system' | 'any')) {
      throw errors.forbidden('This transition is not available to your actor type');
    }
  }
  if (condition?.minDwellSeconds) {
    const dwellMs = Date.now() - item.enteredStateAt;
    if (dwellMs < condition.minDwellSeconds * 1000) {
      throw errors.validation('Minimum dwell time has not elapsed', {
        requiredSeconds: condition.minDwellSeconds,
        actualSeconds: Math.floor(dwellMs / 1000)
      });
    }
  }

  const merged = {
    ...workflowItemFieldValuesByKey(tx, actor.workspaceId, item.id, item.recordId),
    ...(input.fieldValues ?? {})
  };
  if (condition?.fieldEquals && condition.fieldEquals.length > 0) {
    for (const requirement of condition.fieldEquals) {
      if (String(merged[requirement.fieldKey] ?? '') !== String(requirement.value ?? '')) {
        throw errors.validation(
          `Transition condition not met: ${requirement.fieldKey} must equal ${String(requirement.value)}`
        );
      }
    }
  }

  const required = collectRequiredFields(tx, actor.workspaceId, item, resolution, gate);
  const missing = required.filter((field) => isBlank(merged[field.key])).map((field) => field.name);
  if (missing.length > 0) {
    throw errors.validation(`Missing required field(s): ${missing.join(', ')}`, { missing });
  }
}

function collectRequiredFields(
  tx: Executor,
  workspaceId: string,
  item: WorkflowItemRow,
  resolution: TransitionResolution,
  gate: ReturnType<typeof humanGateOf>
): Array<{ key: string; name: string }> {
  const byKey = new Map<string, { key: string; name: string }>();
  const add = (definition: { key: string; name: string }) => {
    if (!byKey.has(definition.key)) byKey.set(definition.key, definition);
  };
  for (const key of (resolution.transition.requiredFieldKeys as string[] | null) ?? []) {
    add({ key, name: key });
  }
  for (const key of gate?.requiredFieldKeys ?? []) add({ key, name: key });
  for (const definition of alwaysRequiredFields(tx, workspaceId, item.workflowId)) add(definition);
  for (const definition of fieldsRequiredWhileIn(tx, workspaceId, item.workflowId, item.stateId)) {
    add(definition);
  }
  const record = tx
    .select({ objectTypeId: records.objectTypeId })
    .from(records)
    .where(eq(records.id, item.recordId))
    .all()[0];
  if (record) {
    for (const field of listBaseFieldsSync(tx, workspaceId, record.objectTypeId)) {
      if (field.required) add(field);
    }
  }
  return [...byKey.values()];
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim().length === 0;
}

function applyWorkflowItemTransitionSync(
  tx: Executor,
  actor: ActorContext,
  item: WorkflowItemRow,
  resolution: TransitionResolution,
  input: WorkflowItemTransitionInput
): WorkflowItemTransitionResult {
  const fresh = requireWorkflowItemRow(tx, actor.workspaceId, item.id);
  if (fresh.stateId !== resolution.fromState.id) {
    throw errors.versionConflict('Workflow item', fresh.version, item.version);
  }
  if (input.fieldValues && Object.keys(input.fieldValues).length > 0) {
    const record = tx
      .select({ objectTypeId: records.objectTypeId })
      .from(records)
      .where(eq(records.id, fresh.recordId))
      .all()[0];
    if (!record) throw errors.notFound('Record', fresh.recordId);
    writeWorkflowItemFieldValues(tx, {
      workspaceId: actor.workspaceId,
      workflowItemId: fresh.id,
      workflowId: fresh.workflowId,
      recordId: fresh.recordId,
      objectTypeId: record.objectTypeId,
      values: input.fieldValues,
      actor,
      source: inferSource(actor),
      runId: input.runId ?? null
    });
  }

  const now = Date.now();
  const toState = resolution.toState;
  const terminal = isTerminalState(toState);
  tx.update(workflowItemStateHistory)
    .set({ exitedAt: now, durationMs: now - fresh.enteredStateAt })
    .where(
      and(
        eq(workflowItemStateHistory.workflowItemId, fresh.id),
        isNull(workflowItemStateHistory.exitedAt)
      )
    )
    .run();

  const historyId = uuidv7(now);
  tx.insert(workflowItemStateHistory)
    .values({
      id: historyId,
      workspaceId: actor.workspaceId,
      workflowItemId: fresh.id,
      workflowId: fresh.workflowId,
      stateId: toState.id,
      stateName: toState.name,
      stateKind: toState.kind,
      previousStateId: fresh.stateId,
      enteredAt: now,
      enteredByType: actor.actorType,
      enteredById: actor.actorId,
      enteredByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      transitionId: resolution.transition.id,
      reason: input.reason ?? input.comment ?? null
    })
    .run();

  const updated = tx
    .update(workflowItems)
    .set({
      stateId: toState.id,
      enteredStateAt: now,
      lastActivityAt: now,
      stateRunCount: 0,
      waitingOn: computeWaitingOn(toState),
      closedAt: terminal ? now : null,
      completedAt: terminal ? now : null,
      version: fresh.version + 1,
      updatedAt: now
    })
    .where(eq(workflowItems.id, fresh.id))
    .returning()
    .all()[0];
  if (!updated) throw errors.internal('Failed to move workflow item');

  tx.insert(workflowItemWorkflowHistory)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowItemId: fresh.id,
      kind: 'state_change',
      fromWorkflowId: fresh.workflowId,
      fromStateId: fresh.stateId,
      toWorkflowId: fresh.workflowId,
      toStateId: toState.id,
      reason: input.reason ?? input.comment ?? null,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemStateExited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: fresh.id,
    recordId: fresh.recordId,
    workflowItemId: fresh.id,
    workflowId: fresh.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: `Left ${resolution.fromState.name}`,
    data: { fromStateId: fresh.stateId, toStateId: toState.id }
  });
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemStateEntered,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: fresh.id,
    recordId: fresh.recordId,
    workflowItemId: fresh.id,
    workflowId: fresh.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: `Entered ${toState.name}`,
    data: { stateId: toState.id, viaTransition: resolution.transition.id }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: fresh.recordId,
    workflowItemId: fresh.id,
    type: RunEventTypes.workflowItemStateExited,
    data: { stateId: fresh.stateId, stateName: resolution.fromState.name }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: fresh.recordId,
    workflowItemId: fresh.id,
    type: RunEventTypes.workflowItemStateEntered,
    data: { stateId: toState.id, stateName: toState.name, transitionId: resolution.transition.id }
  });
  if (terminal) {
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.workflowItemCompleted,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'workflow_item',
      entityId: fresh.id,
      recordId: fresh.recordId,
      workflowItemId: fresh.id,
      workflowId: fresh.workflowId,
      summary: `Work completed in ${toState.name}`
    });
    publishRunEvent(tx, {
      workspaceId: actor.workspaceId,
      recordId: fresh.recordId,
      workflowItemId: fresh.id,
      type: RunEventTypes.workflowItemCompleted,
      data: { stateId: toState.id }
    });
  }

  enqueueDestinationWorkflowItemWorkSync(tx, {
    workspaceId: actor.workspaceId,
    item: updated,
    state: toState,
    actor,
    enteredAt: now
  });

  return {
    workflowItemId: fresh.id,
    fromStateId: fresh.stateId,
    toStateId: toState.id,
    transitionId: resolution.transition.id,
    historyId,
    enteredAt: now
  };
}

// ---------------------------------------------------------------------------
// Ownership, notes, work relationships
// ---------------------------------------------------------------------------

export function setWorkflowItemOwnerSync(
  tx: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; ownerUserId?: string | null; ownerTeamId?: string | null }
): WorkflowItemRow {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to assign work');
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  const updated = tx
    .update(workflowItems)
    .set({
      ownerUserId: input.ownerUserId === undefined ? item.ownerUserId : input.ownerUserId,
      ownerTeamId: input.ownerTeamId === undefined ? item.ownerTeamId : input.ownerTeamId,
      lastActivityAt: Date.now(),
      updatedAt: Date.now(),
      version: item.version + 1
    })
    .where(eq(workflowItems.id, item.id))
    .returning()
    .all()[0];
  if (!updated) throw errors.internal('Failed to assign workflow item');
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemAssigned,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: item.id,
    recordId: item.recordId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    summary: 'Work ownership changed',
    data: { ownerUserId: updated.ownerUserId, ownerTeamId: updated.ownerTeamId }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: item.recordId,
    workflowItemId: item.id,
    type: RunEventTypes.workflowItemOwnerChanged,
    data: { ownerUserId: updated.ownerUserId, ownerTeamId: updated.ownerTeamId }
  });
  return updated;
}

export async function addWorkflowItemNote(
  db: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; body: string; runId?: string | null }
): Promise<{ noteId: string }> {
  return withTransaction(db, (tx) => addWorkflowItemNoteSync(tx, actor, input));
}

export function addWorkflowItemNoteSync(
  tx: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; body: string; runId?: string | null }
): { noteId: string } {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to add work notes');
  const body = input.body.trim();
  if (body.length === 0) throw errors.validation('Note body is required');
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  const now = Date.now();
  const id = uuidv7(now);
  tx.insert(workflowItemNotes)
    .values({
      id,
      workspaceId: actor.workspaceId,
      workflowItemId: item.id,
      authorType: actor.actorType,
      authorId: actor.actorId,
      authorLabel: actor.actorLabel,
      body,
      isSystem: false,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .run();
  tx.update(workflowItems)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(eq(workflowItems.id, item.id))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemNoteAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: item.id,
    recordId: item.recordId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    runId: input.runId ?? actor.runId ?? null,
    summary: 'Work note added'
  });
  return { noteId: id };
}

export function editWorkflowItemNoteSync(
  tx: Executor,
  actor: ActorContext,
  input: { noteId: string; body: string }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to edit work notes');
  const existing = tx
    .select()
    .from(workflowItemNotes)
    .where(
      and(
        eq(workflowItemNotes.workspaceId, actor.workspaceId),
        eq(workflowItemNotes.id, input.noteId)
      )
    )
    .all()[0];
  if (!existing) throw errors.notFound('Work note', input.noteId);
  const body = input.body.trim();
  if (body.length === 0) throw errors.validation('Note body is required');
  const now = Date.now();
  tx.insert(workflowItemNoteRevisions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      noteId: existing.id,
      body: existing.body,
      editedByType: actor.actorType,
      editedById: actor.actorId,
      createdAt: now
    })
    .run();
  tx.update(workflowItemNotes)
    .set({ body, editedAt: now, editedByType: actor.actorType, editedById: actor.actorId })
    .where(eq(workflowItemNotes.id, existing.id))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemNoteEdited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: existing.workflowItemId,
    workflowItemId: existing.workflowItemId,
    summary: 'Work note edited'
  });
}

export function linkWorkItemsSync(
  tx: Executor,
  actor: ActorContext,
  input: {
    fromWorkflowItemId: string;
    toWorkflowItemId: string;
    type: import('../db/schema').WorkRelationshipType;
    note?: string | null;
  }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to link work');
  if (input.fromWorkflowItemId === input.toWorkflowItemId) {
    throw errors.validation('A work item cannot relate to itself');
  }
  const from = requireWorkflowItemRow(tx, actor.workspaceId, input.fromWorkflowItemId);
  const to = requireWorkflowItemRow(tx, actor.workspaceId, input.toWorkflowItemId);
  const now = Date.now();
  tx.insert(workflowItemRelationships)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      fromWorkflowItemId: from.id,
      toWorkflowItemId: to.id,
      type: input.type,
      note: input.note ?? null,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdByLabel: actor.actorLabel,
      runId: actor.runId ?? null,
      createdAt: now
    })
    .onConflictDoNothing()
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemRelationshipAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: from.id,
    recordId: from.recordId,
    workflowItemId: from.id,
    summary: `Work relationship ${input.type} added`,
    data: { toWorkflowItemId: to.id }
  });
}

export function unlinkWorkItemsSync(
  tx: Executor,
  actor: ActorContext,
  input: { relationshipId: string }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to unlink work');
  const existing = tx
    .select()
    .from(workflowItemRelationships)
    .where(
      and(
        eq(workflowItemRelationships.workspaceId, actor.workspaceId),
        eq(workflowItemRelationships.id, input.relationshipId)
      )
    )
    .all()[0];
  if (!existing) throw errors.notFound('Work relationship', input.relationshipId);
  tx.delete(workflowItemRelationships).where(eq(workflowItemRelationships.id, existing.id)).run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemRelationshipRemoved,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: existing.fromWorkflowItemId,
    workflowItemId: existing.fromWorkflowItemId,
    summary: `Work relationship ${existing.type} removed`
  });
}

// ---------------------------------------------------------------------------
// Transfer vs add-participation
// ---------------------------------------------------------------------------

export interface TransferWorkflowItemInput {
  workflowItemId: string;
  targetWorkflowId: string;
  targetStateId?: string | null;
  fieldMappings?: Record<string, string> | null;
  reason?: string | null;
  /** Set when an approval has already authorised a policy-gated transfer. */
  approved?: boolean;
  /**
   * Field values the caller will persist on the destination immediately after the
   * transfer (e.g. a validated contract submission). They are counted when checking
   * destination requirements but are not written here.
   */
  fieldValues?: Record<string, unknown> | null;
}

export interface TransferWorkflowItemResult {
  sourceWorkflowItemId: string;
  workflowItem: WorkflowItemSummary;
}

/** Move the *work* to another workflow. The source item is closed, not deleted. */
export async function transferWorkflowItem(
  db: Executor,
  actor: ActorContext,
  input: TransferWorkflowItemInput
): Promise<TransferWorkflowItemResult> {
  return withTransaction(db, (tx) => transferWorkflowItemSync(tx, actor, input));
}

export function transferWorkflowItemSync(
  tx: Executor,
  actor: ActorContext,
  input: TransferWorkflowItemInput
): TransferWorkflowItemResult {
  assertPermission(actor, Permissions.workflowItemTransfer, 'Not permitted to transfer work');
  const source = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  if (source.completedAt) {
    throw errors.conflict('Completed work cannot be transferred', { workflowItemId: source.id });
  }
  if (source.workflowId === input.targetWorkflowId) {
    throw errors.validation('Transfer requires a different target workflow');
  }
  const targetWorkflow = requireWorkflow(tx, actor.workspaceId, input.targetWorkflowId);
  if (targetWorkflow.archivedAt) {
    throw errors.precondition('The destination workflow is archived');
  }
  assertObjectTypeMatches(
    tx,
    actor.workspaceId,
    targetWorkflow,
    sourceRecordObjectType(tx, source.recordId)
  );

  const policy = evaluateWorkflowTransferPolicy(tx, actor, {
    workflowItemId: source.id,
    targetWorkflowId: input.targetWorkflowId
  });
  if (!policy.allowed) {
    throw errors.policyDenied(policy.reason ?? 'Transfer is not permitted', {
      targetWorkflowId: input.targetWorkflowId
    });
  }
  if (policy.requiresApproval && !input.approved) {
    throw errors.approvalRequired('This transfer requires approval before it can proceed', {
      targetWorkflowId: input.targetWorkflowId
    });
  }
  const rule = policy.rule;

  const mappings =
    input.fieldMappings ?? (rule?.fieldMappings as Record<string, string> | null) ?? null;
  const sourceValues = workflowItemFieldValuesByKey(
    tx,
    actor.workspaceId,
    source.id,
    source.recordId
  );
  const mapped = mappedFields(tx, actor.workspaceId, source, mappings);
  // A field active in both workflows travels with the Record without an explicit
  // mapping, so shared workspace definitions never silently lose their value.
  const targetFieldKeys = new Set(workflowFieldKeys(tx, actor.workspaceId, input.targetWorkflowId));
  for (const key of workflowFieldKeys(tx, actor.workspaceId, source.workflowId)) {
    if (targetFieldKeys.has(key) && sourceValues[key] !== undefined && mapped[key] === undefined) {
      mapped[key] = sourceValues[key];
    }
  }

  // Validate destination requirements *before* any mutation, against the values
  // the Record will hold after mapping, so a rejected transfer leaves no partial
  // state behind.
  const absent = (value: unknown): boolean =>
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  const projected = { ...sourceValues, ...mapped, ...(input.fieldValues ?? {}) };
  const requiredDefinitions = alwaysRequiredFields(tx, actor.workspaceId, input.targetWorkflowId);
  const extraRequiredKeys = (rule?.requiredTargetFieldKeys as string[] | null) ?? [];
  const missingKeys = [
    ...requiredDefinitions
      .filter((field) => absent(projected[field.key]))
      .map((field) => field.key),
    ...extraRequiredKeys.filter((key) => absent(projected[key]))
  ];
  if (missingKeys.length > 0) {
    const unique = [...new Set(missingKeys)];
    throw errors.precondition(`The destination requires: ${unique.join(', ')}`, {
      fieldKeys: unique,
      targetWorkflowId: input.targetWorkflowId
    });
  }

  // Fields the source workflow must hold before work may leave it at all.
  const mustLeaveWith = requiredFieldsForTransfer(tx, actor.workspaceId, source.workflowId);
  const absentOnLeave = mustLeaveWith.filter((field) => absent(sourceValues[field.key]));
  if (absentOnLeave.length > 0) {
    throw errors.precondition(
      `Transfer requires: ${absentOnLeave.map((field) => field.name).join(', ')}`,
      { fieldKeys: absentOnLeave.map((field) => field.key) }
    );
  }

  const now = Date.now();

  tx.update(workflowItemStateHistory)
    .set({ exitedAt: now, durationMs: now - source.enteredStateAt })
    .where(
      and(
        eq(workflowItemStateHistory.workflowItemId, source.id),
        isNull(workflowItemStateHistory.exitedAt)
      )
    )
    .run();
  tx.update(workflowItems)
    .set({
      completedAt: now,
      closedAt: now,
      waitingOn: 'none',
      lastActivityAt: now,
      updatedAt: now,
      version: source.version + 1
    })
    .where(eq(workflowItems.id, source.id))
    .run();

  const destination = createWorkflowItemSync(tx, actor, {
    workflowId: input.targetWorkflowId,
    recordId: source.recordId,
    stateId: input.targetStateId ?? rule?.defaultTargetStateId ?? null,
    participation: 'transferred',
    sourceWorkflowItemId: source.id,
    fields: mapped,
    reason: input.reason ?? `Transferred from ${source.workflowId}`
  });

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemTransferred,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: destination.id,
    recordId: source.recordId,
    workflowItemId: destination.id,
    workflowId: input.targetWorkflowId,
    summary: 'Work transferred',
    data: { sourceWorkflowItemId: source.id, targetWorkflowId: input.targetWorkflowId }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: source.recordId,
    workflowItemId: destination.id,
    type: RunEventTypes.workflowItemTransferred,
    data: { sourceWorkflowItemId: source.id, targetWorkflowId: input.targetWorkflowId }
  });
  return { sourceWorkflowItemId: source.id, workflowItem: summarize(tx, destination) };
}

function sourceRecordObjectType(tx: Executor, recordId: string): string {
  const row = tx
    .select({ objectTypeId: records.objectTypeId })
    .from(records)
    .where(eq(records.id, recordId))
    .all()[0];
  if (!row) throw errors.notFound('Record', recordId);
  return row.objectTypeId;
}

function mappedFields(
  tx: Executor,
  workspaceId: string,
  source: WorkflowItemRow,
  mappings: Record<string, string> | null
): Record<string, unknown> {
  if (!mappings) return {};
  const values = workflowItemFieldValuesByKey(tx, workspaceId, source.id, source.recordId);
  const result: Record<string, unknown> = {};
  for (const [sourceKey, targetKey] of Object.entries(mappings)) {
    if (values[sourceKey] !== undefined) result[targetKey] = values[sourceKey];
  }
  return result;
}

/**
 * Add a Record to another Workflow without ending existing participation.
 * Distinct from `transferWorkflowItem` by design.
 */
export async function addWorkflowParticipation(
  db: Executor,
  actor: ActorContext,
  input: Omit<CreateWorkflowItemInput, 'participation' | 'record'> & { recordId: string }
): Promise<WorkflowItemSummary> {
  assertPermission(actor, Permissions.workflowItemCreate, 'Not permitted to start work');
  return withTransaction(db, (tx) =>
    summarize(tx, createWorkflowItemSync(tx, actor, { ...input, participation: 'additional' }))
  );
}

function inferSource(actor: ActorContext): 'human' | 'agent' | 'system' | 'extraction' {
  if (actor.actorType === 'agent') return 'agent';
  if (actor.actorType === 'user') return 'human';
  if (actor.actorType === 'extraction') return 'extraction';
  return 'system';
}

/** Set base and/or overlay field values on a participation, atomically. */
export async function setWorkflowItemFields(
  db: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; values: Record<string, unknown> }
): Promise<{ changes: Array<{ key: string; previous: unknown; next: unknown }> }> {
  return withTransaction(db, (tx) => {
    assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to edit work');
    const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
    const record = tx
      .select({ objectTypeId: records.objectTypeId })
      .from(records)
      .where(eq(records.id, item.recordId))
      .all()[0];
    if (!record) throw errors.notFound('Record', item.recordId);
    const changes = writeWorkflowItemFieldValues(tx, {
      workspaceId: actor.workspaceId,
      workflowItemId: item.id,
      workflowId: item.workflowId,
      recordId: item.recordId,
      objectTypeId: record.objectTypeId,
      values: input.values,
      actor,
      source: inferSource(actor)
    });
    tx.update(workflowItems)
      .set({ lastActivityAt: Date.now(), updatedAt: Date.now() })
      .where(eq(workflowItems.id, item.id))
      .run();
    return {
      changes: changes.map((change) => ({
        key: change.key,
        previous: change.previous,
        next: change.next
      }))
    };
  });
}

// ---------------------------------------------------------------------------
// Item updates: ownership, context and record identity
// ---------------------------------------------------------------------------

export interface UpdateWorkflowItemInput {
  workflowItemId: string;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  /** Workflow-context JSON with no field definition. */
  structuredData?: Record<string, unknown> | null;
  dueAt?: number | null;
  slaDueAt?: number | null;
  /** Record/overlay values routed through the one field engine. */
  values?: Record<string, unknown>;
  /** Alias of `values`, for callers ported from the ticket update API. */
  fields?: Record<string, unknown>;
  /** Convenience aliases routed as base/overlay field values when configured. */
  description?: string | null;
  priority?: string | null;
  /** Rename the Record that backs this item (identity display name). */
  displayName?: string | null;
  /** Alias of `displayName`. */
  title?: string | null;
  expectedVersion?: number;
  runId?: string | null;
  reason?: string | null;
}

/**
 * Update what the *participation* owns (ownership, context JSON, due dates) plus
 * the Record identity it is allowed to touch (display name and base/overlay field
 * values). State is never changed here — that is the transition engine's job.
 */
export function updateWorkflowItemSync(
  tx: Executor,
  actor: ActorContext,
  input: UpdateWorkflowItemInput
): WorkflowItemRow {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to update work');
  const before = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
    throw errors.versionConflict('Workflow item', input.expectedVersion, before.version);
  }
  const record = tx
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, actor.workspaceId), eq(records.id, before.recordId)))
    .all()[0];
  if (!record) throw errors.notFound('Record', before.recordId);

  const now = Date.now();
  const changed: string[] = [];

  // 1) Field values first: a validation failure must not leave the item touched.
  const values: Record<string, unknown> = {
    ...(input.fields ?? {}),
    ...(input.values ?? {})
  };
  if (input.description !== undefined) values.description = input.description;
  if (input.priority !== undefined) values.priority = input.priority;
  let fieldChanges: FieldChange[] = [];
  if (Object.keys(values).length > 0) {
    fieldChanges = writeWorkflowItemFieldValues(tx, {
      workspaceId: actor.workspaceId,
      workflowItemId: before.id,
      workflowId: before.workflowId,
      recordId: before.recordId,
      objectTypeId: record.objectTypeId,
      values,
      actor,
      source: inferSource(actor),
      runId: input.runId ?? null
    });
    changed.push(...fieldChanges.map((change) => change.key));
  }

  // 2) Record identity: display name is the Record's, so a rename bumps the record.
  const requestedName = input.displayName ?? input.title ?? null;
  let renamedTo: string | null = null;
  if (requestedName !== null && requestedName !== undefined) {
    const trimmed = requestedName.trim().slice(0, 500);
    if (trimmed.length > 0 && trimmed !== record.displayName) {
      tx.update(records)
        .set({
          displayName: trimmed,
          version: sql`${records.version} + 1`,
          lastActivityAt: now,
          updatedAt: now
        })
        .where(eq(records.id, record.id))
        .run();
      renamedTo = trimmed;
      changed.push('displayName');
    }
  }

  // 3) The participation's own mutable context.
  const nextOwnerUserId = input.ownerUserId === undefined ? before.ownerUserId : input.ownerUserId;
  const nextOwnerTeamId = input.ownerTeamId === undefined ? before.ownerTeamId : input.ownerTeamId;
  const nextStructuredData =
    input.structuredData === undefined ? before.structuredData : input.structuredData;
  const nextDueAt = input.dueAt === undefined ? before.dueAt : input.dueAt;
  const nextSlaDueAt = input.slaDueAt === undefined ? before.slaDueAt : input.slaDueAt;

  if (input.ownerUserId !== undefined && input.ownerUserId !== before.ownerUserId) {
    changed.push('ownerUserId');
  }
  if (input.ownerTeamId !== undefined && input.ownerTeamId !== before.ownerTeamId) {
    changed.push('ownerTeamId');
  }
  if (input.structuredData !== undefined) changed.push('structuredData');
  if (input.dueAt !== undefined && input.dueAt !== before.dueAt) changed.push('dueAt');
  if (input.slaDueAt !== undefined && input.slaDueAt !== before.slaDueAt) changed.push('slaDueAt');

  const updated = tx
    .update(workflowItems)
    .set({
      ownerUserId: nextOwnerUserId,
      ownerTeamId: nextOwnerTeamId,
      structuredData: (nextStructuredData as never) ?? null,
      dueAt: nextDueAt,
      slaDueAt: nextSlaDueAt,
      version: before.version + 1,
      lastActivityAt: now,
      updatedAt: now
    })
    .where(eq(workflowItems.id, before.id))
    .returning()
    .all()[0];
  if (!updated) throw errors.internal('Failed to update workflow item');

  if (changed.length > 0) {
    const ownershipChanged = changed.some((key) => key === 'ownerUserId' || key === 'ownerTeamId');
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: ownershipChanged
        ? AuditActions.workflowItemAssigned
        : AuditActions.workflowItemUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'workflow_item',
      entityId: before.id,
      recordId: before.recordId,
      workflowItemId: before.id,
      workflowId: before.workflowId,
      runId: input.runId ?? actor.runId ?? null,
      summary: `Work item updated (${changed.join(', ')})`,
      data: {
        changed,
        before: {
          ownerUserId: before.ownerUserId,
          ownerTeamId: before.ownerTeamId,
          dueAt: before.dueAt,
          displayName: record.displayName
        },
        after: {
          ownerUserId: updated.ownerUserId,
          ownerTeamId: updated.ownerTeamId,
          dueAt: updated.dueAt,
          displayName: renamedTo ?? record.displayName
        }
      }
    });
  }

  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: before.recordId,
    workflowItemId: before.id,
    type: RunEventTypes.workflowItemUpdated,
    data: { workflowItemId: before.id, changed }
  });

  return updated;
}

/** Set the wait bucket without changing state or ownership. */
export function setWorkflowItemWaitingOnSync(
  tx: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; waitingOn: WorkflowItemWait }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to update work');
  requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  tx.update(workflowItems)
    .set({ waitingOn: input.waitingOn, updatedAt: Date.now() })
    .where(eq(workflowItems.id, input.workflowItemId))
    .run();
}

// ---------------------------------------------------------------------------
// Search and "My Work"
// ---------------------------------------------------------------------------

export interface WorkflowItemSearchOptions {
  workflowId?: string | null;
  recordId?: string | null;
  stateIds?: string[] | null;
  ownerUserId?: string | null;
  waitingOn?: string | null;
  includeCompleted?: boolean;
  includeArchived?: boolean;
  search?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface WorkflowItemSearchResult extends WorkflowItemPage {
  /** Alias of `items`, for callers ported from the ticket search API. */
  rows: WorkflowItemListRow[];
}

/** Board/list search over WorkflowItems, scoped to the actor's workspace. */
export async function searchWorkflowItems(
  db: Executor,
  actor: ActorContext,
  options: WorkflowItemSearchOptions = {}
): Promise<WorkflowItemSearchResult> {
  assertPermission(actor, Permissions.workflowItemRead, 'Not permitted to read work');
  const page = await listWorkflowItems(db, { ...options, workspaceId: actor.workspaceId });
  return { ...page, rows: page.items };
}

export interface MyWorkView {
  /** Items assigned to the actor (the primary bucket). */
  owned: WorkflowItemListRow[];
  /** Alias of `owned`, for callers ported from `tickets/service.myWork`. */
  assigned: WorkflowItemListRow[];
  waitingForMe: WorkflowItemListRow[];
  waitingForAgent: WorkflowItemListRow[];
  waitingForApproval: WorkflowItemListRow[];
  needsAttention: WorkflowItemListRow[];
  createdByMe: WorkflowItemListRow[];
}

/**
 * The "My Work" surface. Each bucket is a real query over persisted state, so the
 * counts can never drift from what the board and item drawer show.
 */
export async function myWork(
  db: Executor,
  actor: ActorContext,
  options: { limit?: number } = {}
): Promise<MyWorkView> {
  assertPermission(actor, Permissions.workflowItemRead, 'Not permitted to read work');
  const workspaceId = actor.workspaceId;
  const limit = options.limit ?? 50;

  const owned = actor.actorId
    ? (await listWorkflowItems(db, { workspaceId, ownerUserId: actor.actorId, limit })).items
    : [];
  const waitingForMe = (await listWorkflowItems(db, { workspaceId, waitingOn: 'human', limit }))
    .items;
  const waitingForAgent = (await listWorkflowItems(db, { workspaceId, waitingOn: 'agent', limit }))
    .items;
  const waitingForApproval = (
    await listWorkflowItems(db, { workspaceId, waitingOn: 'approval', limit })
  ).items;
  const needsAttention = (await listWorkflowItems(db, { workspaceId, needsAttention: true, limit }))
    .items;
  const createdByMe = actor.actorId
    ? (await listWorkflowItems(db, { workspaceId, createdById: actor.actorId, limit })).items
    : [];

  return {
    owned,
    assigned: owned,
    waitingForMe,
    waitingForAgent,
    waitingForApproval,
    needsAttention,
    createdByMe
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineFilter = 'all' | 'human' | 'agents' | 'fields' | 'states' | 'tools' | 'files';

/** The audit ledger projected chronologically for one participation. */
export async function workflowItemTimeline(
  db: Executor,
  actor: ActorContext,
  workflowItemId: string,
  options: { limit?: number; cursor?: number; filter?: TimelineFilter } = {}
) {
  assertPermission(actor, Permissions.workflowItemRead, 'Not permitted to read work');
  requireWorkflowItemRow(db, actor.workspaceId, workflowItemId);
  const events = await queryAudit(db, {
    workspaceId: actor.workspaceId,
    workflowItemId,
    limit: options.limit ?? 200,
    cursor: options.cursor,
    order: 'desc'
  });
  const filter = options.filter ?? 'all';
  return filter === 'all'
    ? events
    : events.filter((event) => matchesTimelineFilter(event.action, filter));
}

export function matchesTimelineFilter(action: string, filter: TimelineFilter): boolean {
  // Ticket-named audit constants are still emitted by shared modules during the
  // ADR-0021 migration, so both prefixes count as work-item activity.
  const isWorkItem = action.startsWith('workflow_item.') || action.startsWith('ticket.');
  switch (filter) {
    case 'human':
      return isWorkItem || action.startsWith('approval.') || action.startsWith('workspace.');
    case 'agents':
      return action.startsWith('agent.') || action.startsWith('job.');
    case 'fields':
      return (
        action.startsWith('workflow_item.field') ||
        action.startsWith('ticket.field') ||
        action.startsWith('record.field') ||
        action.startsWith('file.field')
      );
    case 'states':
      return (
        action.startsWith('workflow_item.state') ||
        action.startsWith('workflow_item.transferred') ||
        action.startsWith('workflow_item.completed') ||
        action.startsWith('ticket.state') ||
        action.startsWith('ticket.transferred')
      );
    case 'tools':
      return action.startsWith('tool.') || action.startsWith('http.');
    case 'files':
      return action.startsWith('file.');
    default:
      return true;
  }
}

/** One field change on a participation, whether base (Record) or overlay. */
export interface WorkflowItemFieldChangeRow {
  id: string;
  fieldDefinitionId: string;
  fieldKey: string;
  fieldName: string;
  previousValue: unknown;
  newValue: unknown;
  actorType: string;
  actorLabel: string | null;
  source: 'human' | 'agent' | 'system' | 'extraction' | null;
  createdAt: number;
}

/**
 * Field-change history for a participation (base Record values and workflow
 * overlay values), oldest first — the single field story the drawer shows.
 */
export async function workflowItemFieldChanges(
  db: Executor,
  actor: ActorContext,
  workflowItemId: string
): Promise<WorkflowItemFieldChangeRow[]> {
  assertPermission(actor, Permissions.workflowItemRead, 'Not permitted to read work');
  const item = requireWorkflowItemRow(db, actor.workspaceId, workflowItemId);
  const [base, overlay] = await Promise.all([
    recordFieldHistory(db, actor.workspaceId, item.recordId),
    workflowItemFieldHistory(db, actor.workspaceId, item.id)
  ]);
  const rows: WorkflowItemFieldChangeRow[] = [
    ...base.map((row) => ({
      id: row.id,
      fieldDefinitionId: row.fieldDefinitionId,
      fieldKey: row.fieldKey,
      fieldName: row.fieldName,
      previousValue: row.previousValue,
      newValue: row.newValue,
      actorType: row.actorType as string,
      actorLabel: row.actorLabel,
      source: row.source,
      createdAt: row.createdAt
    })),
    ...overlay.map((row) => ({
      id: row.id,
      fieldDefinitionId: row.fieldDefinitionId,
      fieldKey: row.fieldKey,
      fieldName: row.fieldName,
      previousValue: row.previousValue,
      newValue: row.newValue,
      actorType: row.actorType as string,
      actorLabel: row.actorLabel,
      source: row.source,
      createdAt: row.createdAt
    }))
  ];
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// Files and labels
// ---------------------------------------------------------------------------

/** Attach a File to one participation (`file_workflow_items`). */
export function attachFileToWorkflowItemSync(
  tx: Executor,
  actor: ActorContext,
  input: {
    workflowItemId: string;
    fileId: string;
    relationship?: FileLinkRelationship;
    caption?: string | null;
    runId?: string | null;
  }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to attach files to work');
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  const file = tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, input.fileId),
        eq(files.workspaceId, actor.workspaceId),
        isNull(files.deletedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!file) throw errors.notFound('File', input.fileId);

  const now = Date.now();
  const relationship = input.relationship ?? 'attachment';
  tx.insert(fileWorkflowItems)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowItemId: item.id,
      fileId: file.id,
      relationship,
      caption: input.caption ?? null,
      addedByType: actor.actorType,
      addedById: actor.actorId,
      addedByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .onConflictDoNothing()
    .run();

  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemFileLinked,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'file',
    entityId: file.id,
    recordId: item.recordId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    fileId: file.id,
    runId: input.runId ?? actor.runId ?? null,
    summary: `${file.originalFilename} attached to work`,
    data: { relationship }
  });

  publishRunEvent(
    tx,
    {
      workspaceId: actor.workspaceId,
      recordId: item.recordId,
      workflowItemId: item.id,
      runId: input.runId ?? null,
      type: RunEventTypes.workflowItemFileAttached,
      data: { fileId: file.id, filename: file.originalFilename }
    },
    now
  );
}

/** Add labels by id or name (names are created on demand), idempotently. */
export function addWorkflowItemLabelsSync(
  tx: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; labelIds?: string[]; labelNames?: string[] }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to label work');
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);

  const resolved: string[] = [];
  if (input.labelIds && input.labelIds.length > 0) {
    const rows = tx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.workspaceId, actor.workspaceId), inArray(labels.id, input.labelIds)))
      .all();
    if (rows.length !== input.labelIds.length) {
      throw errors.validation('One or more labels do not exist in this workspace');
    }
    resolved.push(...rows.map((row) => row.id));
  }

  for (const rawName of input.labelNames ?? []) {
    const name = rawName.trim();
    if (name.length === 0) continue;
    const existing = tx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.workspaceId, actor.workspaceId), eq(labels.name, name)))
      .limit(1)
      .all();
    if (existing[0]) {
      resolved.push(existing[0].id);
      continue;
    }
    const id = uuidv7();
    const now = Date.now();
    tx.insert(labels)
      .values({ id, workspaceId: actor.workspaceId, name, createdAt: now, updatedAt: now })
      .run();
    resolved.push(id);
  }

  for (const labelId of new Set(resolved)) {
    tx.insert(workflowItemLabels)
      .values({
        id: uuidv7(),
        workspaceId: actor.workspaceId,
        workflowItemId: item.id,
        labelId,
        createdAt: Date.now()
      })
      .onConflictDoNothing()
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.workflowItemLabelAdded,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'workflow_item',
      entityId: item.id,
      recordId: item.recordId,
      workflowItemId: item.id,
      workflowId: item.workflowId,
      summary: 'Label added',
      data: { labelId }
    });
  }
}

/** Remove one label from a participation. */
export function removeWorkflowItemLabelSync(
  tx: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; labelId: string }
): void {
  assertPermission(actor, Permissions.workflowItemWrite, 'Not permitted to label work');
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  tx.delete(workflowItemLabels)
    .where(
      and(
        eq(workflowItemLabels.workflowItemId, item.id),
        eq(workflowItemLabels.labelId, input.labelId)
      )
    )
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemLabelRemoved,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: item.id,
    recordId: item.recordId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    summary: 'Label removed',
    data: { labelId: input.labelId }
  });
}

// ---------------------------------------------------------------------------
// Cross-workflow transfer policy and preview
// ---------------------------------------------------------------------------

export interface TransferPolicy {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
  rule: typeof workflowTransferRules.$inferSelect | null;
}

/**
 * Decide whether the actor may move this item to the target workflow. Precedence:
 * explicit transfer rule, then the source workflow's `settings.transfer` block,
 * then allow (the intake → specialist default).
 */
export function evaluateWorkflowTransferPolicy(
  db: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; targetWorkflowId: string }
): TransferPolicy {
  const item = requireWorkflowItemRow(db, actor.workspaceId, input.workflowItemId);
  const rule =
    db
      .select()
      .from(workflowTransferRules)
      .where(
        and(
          eq(workflowTransferRules.workspaceId, actor.workspaceId),
          eq(workflowTransferRules.sourceWorkflowId, item.workflowId),
          eq(workflowTransferRules.targetWorkflowId, input.targetWorkflowId)
        )
      )
      .limit(1)
      .all()[0] ?? null;

  if (!actor.permissions.has(Permissions.workflowItemTransfer)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason:
        actor.actorType === 'agent'
          ? 'This agent is not permitted to transfer work'
          : 'You do not have permission to transfer work',
      rule
    };
  }

  const isHuman = actor.actorType === 'user';
  if (rule) {
    if (isHuman && !rule.allowHumans) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Humans may not transfer out of this workflow',
        rule
      };
    }
    if (!isHuman && !rule.allowAgents) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Agents may not transfer out of this workflow',
        rule
      };
    }
    return { allowed: true, requiresApproval: rule.requiresApproval, rule };
  }

  const source = db
    .select({ settings: workflows.settings })
    .from(workflows)
    .where(eq(workflows.id, item.workflowId))
    .limit(1)
    .all()[0];
  const settings = (source?.settings ?? null) as {
    transfer?: {
      allowedTargetWorkflowIds?: string[];
      allowAgents?: boolean;
      allowHumans?: boolean;
      requiresApproval?: boolean;
    };
  } | null;
  const transfer = settings?.transfer;
  if (!transfer) return { allowed: true, requiresApproval: false, rule: null };

  if (
    transfer.allowedTargetWorkflowIds &&
    transfer.allowedTargetWorkflowIds.length > 0 &&
    !transfer.allowedTargetWorkflowIds.includes(input.targetWorkflowId)
  ) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Destination workflow is not an allowed target',
      rule: null
    };
  }
  if (isHuman && transfer.allowHumans === false) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Humans may not transfer out of this workflow',
      rule: null
    };
  }
  if (!isHuman && transfer.allowAgents === false) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: 'Agents may not transfer out of this workflow',
      rule: null
    };
  }
  return { allowed: true, requiresApproval: transfer.requiresApproval ?? false, rule: null };
}

export interface TransferPreview {
  policy: TransferPolicy;
  targetWorkflow: {
    id: string;
    name: string;
    key: string;
    states: Array<typeof workflowStates.$inferSelect>;
  };
  defaultTargetStateId: string | null;
  compatible: string[];
  mapped: Array<{ source: string; target: string }>;
  destinationRequired: Array<{ key: string; name: string; satisfied: boolean }>;
  sourceOnly: string[];
}

/** Explain a transfer before it happens: policy, mapping and field coverage. */
export function previewTransfer(
  db: Executor,
  actor: ActorContext,
  input: { workflowItemId: string; targetWorkflowId: string }
): TransferPreview {
  const item = requireWorkflowItemRow(db, actor.workspaceId, input.workflowItemId);
  const policy = evaluateWorkflowTransferPolicy(db, actor, input);
  const target = requireWorkflow(db, actor.workspaceId, input.targetWorkflowId);
  const states = db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.workflowId, target.id))
    .orderBy(asc(workflowStates.position))
    .all();

  const mappings = (policy.rule?.fieldMappings as Record<string, string> | null) ?? {};
  const sourceKeys = workflowFieldKeys(db, actor.workspaceId, item.workflowId);
  const targetKeys = workflowFieldKeys(db, actor.workspaceId, target.id);
  const values = workflowItemFieldValuesByKey(db, actor.workspaceId, item.id, item.recordId);

  const compatible = sourceKeys.filter(
    (key) => targetKeys.includes(key) && values[key] !== undefined
  );
  const mapped = Object.entries(mappings).map(([source, mappedTarget]) => ({
    source,
    target: mappedTarget
  }));

  const defaultTargetStateId = policy.rule?.defaultTargetStateId ?? target.defaultStateId ?? null;
  const requiredStateId = defaultTargetStateId ?? states[0]?.id ?? '';
  const requiredDefinitions = requiredStateId
    ? alwaysRequiredFields(db, actor.workspaceId, target.id)
    : [];
  const mappedTargets = new Set(Object.values(mappings));
  const destinationRequired = requiredDefinitions.map((definition) => {
    const satisfied =
      values[definition.key] !== undefined ||
      (mappedTargets.has(definition.key) &&
        Object.entries(mappings).some(
          ([sourceKey, mappedTarget]) =>
            mappedTarget === definition.key && values[sourceKey] !== undefined
        ));
    return { key: definition.key, name: definition.name, satisfied };
  });

  const sourceOnly = sourceKeys.filter((key) => !targetKeys.includes(key) && !(key in mappings));

  return {
    policy,
    targetWorkflow: { id: target.id, name: target.name, key: target.key, states },
    defaultTargetStateId,
    compatible,
    mapped,
    destinationRequired,
    sourceOnly
  };
}

/** Field keys configured on a workflow (archived definitions excluded). */
export function workflowFieldKeys(db: Executor, workspaceId: string, workflowId: string): string[] {
  const rows = db
    .select({ key: fieldDefinitions.key })
    .from(workflowFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowFields.fieldDefinitionId))
    .where(
      and(
        eq(workflowFields.workspaceId, workspaceId),
        eq(workflowFields.workflowId, workflowId),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .all();
  return rows.map((row) => row.key);
}
