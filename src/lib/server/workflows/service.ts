/**
 * Workflow configuration.
 *
 * A Workflow is a project plus a state machine. Everything the execution engine
 * needs to decide "what happens when a ticket enters this state" lives in
 * configuration read at runtime, never in code: state kind, bound agent,
 * auto-execution, retries, timeout, failure state, human gate and outgoing
 * transitions.
 *
 * Templates exist so a fresh workspace can produce a useful workflow immediately,
 * including the Intake → specialised routing pattern the product is built around.
 * A template is ordinary configuration — it creates no special-cased behaviour.
 */
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { keyPrefix, uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type HumanGateConfig,
  type StateCategory,
  type StateConfig,
  type StateKind,
  type Workflow,
  type WorkflowSettings,
  type WorkflowState,
  type WorkflowTransferRule,
  type WorkflowTransition,
  workflowItems,
  workflowStates,
  workflows,
  workflowTransferRules,
  workflowTransitions
} from '../db/schema';
import { findObjectTypeByKey, requireObjectType } from '../records/object-types';

export interface WorkflowDetail {
  workflow: Workflow;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  transferRules: WorkflowTransferRule[];
}

export function requireWorkflow(db: Executor, workspaceId: string, workflowId: string): Workflow {
  const rows = db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const workflow = rows[0];
  if (!workflow) throw errors.notFound('Workflow', workflowId);
  return workflow;
}

export function listWorkflows(
  db: Executor,
  actor: ActorContext,
  options: { includeArchived?: boolean } = {}
): Array<Workflow & { itemCount: number; stateCount: number }> {
  assertPermission(actor, Permissions.workflowRead);
  const conditions = [eq(workflows.workspaceId, actor.workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(workflows.archivedAt));

  const rows = db
    .select()
    .from(workflows)
    .where(and(...conditions))
    .orderBy(asc(workflows.position), asc(workflows.name))
    .all();

  const stateCounts = db
    .select({ workflowId: workflowStates.workflowId, count: sql<number>`count(*)` })
    .from(workflowStates)
    .where(eq(workflowStates.workspaceId, actor.workspaceId))
    .groupBy(workflowStates.workflowId)
    .all();
  const itemCounts = db
    .select({ workflowId: workflowItems.workflowId, count: sql<number>`count(*)` })
    .from(workflowItems)
    .where(and(eq(workflowItems.workspaceId, actor.workspaceId), isNull(workflowItems.archivedAt)))
    .groupBy(workflowItems.workflowId)
    .all();

  const stateMap = new Map(stateCounts.map((row) => [row.workflowId, row.count]));
  const itemMap = new Map(itemCounts.map((row) => [row.workflowId, row.count]));
  return rows.map((workflow) => ({
    ...workflow,
    stateCount: stateMap.get(workflow.id) ?? 0,
    itemCount: itemMap.get(workflow.id) ?? 0
  }));
}

export function getWorkflowDetail(
  db: Executor,
  actor: ActorContext,
  workflowId: string
): WorkflowDetail {
  assertPermission(actor, Permissions.workflowRead);
  const workflow = requireWorkflow(db, actor.workspaceId, workflowId);
  return {
    workflow,
    states: listStates(db, actor.workspaceId, workflowId),
    transitions: listTransitions(db, actor.workspaceId, workflowId),
    transferRules: listTransferRules(db, actor.workspaceId, workflowId)
  };
}

export function listStates(db: Executor, workspaceId: string, workflowId: string): WorkflowState[] {
  return db
    .select()
    .from(workflowStates)
    .where(
      and(eq(workflowStates.workspaceId, workspaceId), eq(workflowStates.workflowId, workflowId))
    )
    .orderBy(asc(workflowStates.position), asc(workflowStates.name))
    .all();
}

export function requireState(db: Executor, workspaceId: string, stateId: string): WorkflowState {
  const rows = db
    .select()
    .from(workflowStates)
    .where(and(eq(workflowStates.id, stateId), eq(workflowStates.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const state = rows[0];
  if (!state) throw errors.notFound('Workflow state', stateId);
  return state;
}

export function listTransitions(
  db: Executor,
  workspaceId: string,
  workflowId: string
): WorkflowTransition[] {
  return db
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
}

export function listOutgoingTransitions(
  db: Executor,
  workspaceId: string,
  workflowId: string,
  fromStateId: string
): WorkflowTransition[] {
  return db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workspaceId, workspaceId),
        eq(workflowTransitions.workflowId, workflowId),
        sql`(${workflowTransitions.fromStateId} = ${fromStateId} OR ${workflowTransitions.fromStateId} IS NULL)`
      )
    )
    .orderBy(asc(workflowTransitions.position))
    .all();
}

export function listTransferRules(
  db: Executor,
  workspaceId: string,
  workflowId: string
): WorkflowTransferRule[] {
  return db
    .select()
    .from(workflowTransferRules)
    .where(
      and(
        eq(workflowTransferRules.workspaceId, workspaceId),
        eq(workflowTransferRules.sourceWorkflowId, workflowId)
      )
    )
    .all();
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type WorkflowTemplate = 'blank' | 'basic' | 'intake' | 'claims' | 'support';

interface TemplateState {
  name: string;
  kind: StateKind;
  category: StateCategory;
  description?: string;
  isStart?: boolean;
  isTerminal?: boolean;
  autoExecute?: boolean;
  humanGate?: HumanGateConfig;
}

interface TemplateDefinition {
  label: string;
  description: string;
  states: TemplateState[];
  /** `[from, to, name]` — `from: null` means "from any state". */
  transitions: Array<[string | null, string, string]>;
}

export const WORKFLOW_TEMPLATES: Record<WorkflowTemplate, TemplateDefinition> = {
  blank: {
    label: 'Blank',
    description: 'A single state you can shape yourself.',
    states: [{ name: 'New', kind: 'manual', category: 'backlog', isStart: true }],
    transitions: []
  },
  basic: {
    label: 'Basic board',
    description: 'Backlog → In progress → Done.',
    states: [
      { name: 'Backlog', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'In progress', kind: 'manual', category: 'active' },
      { name: 'Done', kind: 'terminal', category: 'done', isTerminal: true }
    ],
    transitions: [
      ['Backlog', 'In progress', 'Start'],
      ['In progress', 'Backlog', 'Pause'],
      ['In progress', 'Done', 'Complete']
    ]
  },
  intake: {
    label: 'Intake & routing',
    description:
      'Receives heterogeneous events, lets an agent classify and enrich them, then routes the ticket to a specialised workflow.',
    states: [
      { name: 'Incoming', kind: 'manual', category: 'backlog', isStart: true },
      {
        name: 'Triaging',
        kind: 'agent',
        category: 'active',
        description: 'The triage agent classifies the request and populates typed fields.'
      },
      {
        name: 'Needs information',
        kind: 'manual',
        category: 'review',
        description: 'Waiting on the requester before routing.'
      },
      {
        name: 'Routed',
        kind: 'terminal',
        category: 'done',
        isTerminal: true,
        description: 'The ticket has been transferred to a specialised workflow.'
      }
    ],
    transitions: [
      ['Incoming', 'Triaging', 'Triage'],
      ['Triaging', 'Needs information', 'Request information'],
      ['Needs information', 'Triaging', 'Information received'],
      ['Triaging', 'Routed', 'Route']
    ]
  },
  claims: {
    label: 'Claims',
    description:
      'Investigation with a human review gate, then a decision. Demonstrates typed fields, a human gate and approvals.',
    states: [
      { name: 'New claim', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Investigation', kind: 'agent', category: 'active' },
      {
        name: 'Human review',
        kind: 'manual',
        category: 'review',
        humanGate: {
          enabled: true,
          requiredComment: true,
          instructions: 'Confirm the assessment before the claim is decided.'
        }
      },
      { name: 'Approved', kind: 'terminal', category: 'done', isTerminal: true },
      { name: 'Declined', kind: 'terminal', category: 'cancelled', isTerminal: true }
    ],
    transitions: [
      ['New claim', 'Investigation', 'Investigate'],
      ['Investigation', 'Human review', 'Request review'],
      ['Human review', 'Approved', 'Approve'],
      ['Human review', 'Investigation', 'Rework'],
      ['Human review', 'Declined', 'Decline']
    ]
  },
  support: {
    label: 'Support',
    description: 'Triage → response with an agent draft and a human send gate.',
    states: [
      { name: 'New', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Drafting', kind: 'agent', category: 'active' },
      { name: 'Ready to send', kind: 'manual', category: 'review', humanGate: { enabled: true } },
      { name: 'Resolved', kind: 'terminal', category: 'done', isTerminal: true }
    ],
    transitions: [
      ['New', 'Drafting', 'Draft'],
      ['Drafting', 'Ready to send', 'Request review'],
      ['Ready to send', 'Resolved', 'Send'],
      ['Ready to send', 'Drafting', 'Redraft']
    ]
  }
};

export interface CreateWorkflowInput {
  name: string;
  key?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  template?: WorkflowTemplate;
  settings?: WorkflowSettings | null;
  /** Which Object Type this workflow processes (defaults to Ticket). */
  objectTypeId?: string | null;
  objectTypeKey?: string | null;
}

export function createWorkflow(
  db: Executor,
  actor: ActorContext,
  input: CreateWorkflowInput
): WorkflowDetail {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to create workflows');
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Workflow name is required');

  const templateName = input.template ?? 'basic';
  const template = WORKFLOW_TEMPLATES[templateName];
  if (!template) throw errors.validation(`Unknown workflow template: ${templateName}`);

  let key = (input.key ?? keyPrefix(name)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.length < 2) key = keyPrefix(name);
  key = ensureUniqueKey(db, actor.workspaceId, key);

  const now = Date.now();
  const workflowId = uuidv7(now);
  const positionRows = db
    .select({ max: sql<number>`coalesce(max(${workflows.position}), -1)` })
    .from(workflows)
    .where(eq(workflows.workspaceId, actor.workspaceId))
    .all();

  const inserted = db
    .insert(workflows)
    .values({
      id: workflowId,
      workspaceId: actor.workspaceId,
      name,
      key,
      description: input.description ?? template.description,
      icon: input.icon ?? null,
      color: input.color ?? null,
      objectTypeId: resolveObjectTypeId(db, actor, input),
      settings: (input.settings as never) ?? null,
      position: (positionRows[0]?.max ?? -1) + 1,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const workflow = inserted[0];
  if (!workflow) throw errors.internal('Failed to create workflow');

  const stateIds = new Map<string, string>();
  let startStateId: string | null = null;
  for (const [index, spec] of template.states.entries()) {
    const stateId = uuidv7(now);
    stateIds.set(spec.name, stateId);
    if (spec.isStart || startStateId === null) startStateId = stateId;
    db.insert(workflowStates)
      .values({
        id: stateId,
        workspaceId: actor.workspaceId,
        workflowId,
        name: spec.name,
        description: spec.description ?? null,
        kind: spec.kind,
        category: spec.category,
        position: index,
        isStart: spec.isStart ?? index === 0,
        isTerminal: spec.isTerminal ?? (spec.category === 'done' || spec.category === 'cancelled'),
        autoExecute: spec.autoExecute ?? true,
        humanGate: (spec.humanGate as never) ?? null,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }

  db.update(workflows)
    .set({ defaultStateId: startStateId })
    .where(eq(workflows.id, workflowId))
    .run();

  for (const [index, [from, to, transitionName]] of template.transitions.entries()) {
    db.insert(workflowTransitions)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        workflowId,
        fromStateId: from ? (stateIds.get(from) ?? null) : null,
        toStateId: stateIds.get(to) ?? (startStateId as string),
        name: transitionName,
        position: index,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow',
    entityId: workflowId,
    workflowId,
    summary: `Workflow ${name} created from the ${template.label} template`,
    data: { template: templateName, states: template.states.length, key }
  });

  const created = getWorkflowDetail(db, actor, workflowId);
  return { ...created, workflow: { ...created.workflow, defaultStateId: startStateId } };
}

function ensureUniqueKey(db: Executor, workspaceId: string, base: string): string {
  let key = base;
  for (let attempt = 2; attempt < 100; attempt++) {
    const taken = db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.key, key)))
      .limit(1)
      .all();
    if (!taken[0]) return key;
    key = `${base}${attempt}`;
  }
  throw errors.conflict(`Unable to allocate a unique workflow key for ${base}`);
}

function resolveObjectTypeId(
  db: Executor,
  actor: ActorContext,
  input: { objectTypeId?: string | null; objectTypeKey?: string | null }
): string {
  if (input.objectTypeId) return requireObjectType(db, actor.workspaceId, input.objectTypeId).id;
  if (input.objectTypeKey) {
    const found = findObjectTypeByKey(db, actor.workspaceId, input.objectTypeKey);
    if (!found) throw errors.notFound('Object type', input.objectTypeKey);
    return found.id;
  }
  throw errors.validation('Choose an Object Type for this workflow');
}

export function updateWorkflow(
  db: Executor,
  actor: ActorContext,
  input: {
    workflowId: string;
    name?: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    settings?: WorkflowSettings | null;
    defaultStateId?: string | null;
    objectTypeId?: string | null;
  }
): Workflow {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to update workflows');
  const current = requireWorkflow(db, actor.workspaceId, input.workflowId);

  if (input.defaultStateId) {
    requireState(db, actor.workspaceId, input.defaultStateId);
  }
  if (input.objectTypeId) {
    requireObjectType(db, actor.workspaceId, input.objectTypeId);
  }
  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) {
    throw errors.validation('Workflow name must not be empty');
  }

  const updated = db
    .update(workflows)
    .set({
      name: name ?? current.name,
      description: input.description === undefined ? current.description : input.description,
      icon: input.icon === undefined ? current.icon : input.icon,
      color: input.color === undefined ? current.color : input.color,
      objectTypeId: input.objectTypeId === undefined ? current.objectTypeId : input.objectTypeId,
      settings:
        input.settings === undefined ? current.settings : ((input.settings as never) ?? null),
      defaultStateId:
        input.defaultStateId === undefined ? current.defaultStateId : input.defaultStateId,
      updatedAt: Date.now()
    })
    .where(eq(workflows.id, input.workflowId))
    .returning()
    .all();

  const workflow = updated[0];
  if (!workflow) throw errors.notFound('Workflow', input.workflowId);

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow',
    entityId: workflow.id,
    workflowId: workflow.id,
    summary: `Workflow ${workflow.name} updated`
  });
  return workflow;
}

export function archiveWorkflow(db: Executor, actor: ActorContext, workflowId: string): void {
  assertPermission(actor, Permissions.workflowAdmin, 'Not permitted to archive workflows');
  const workflow = requireWorkflow(db, actor.workspaceId, workflowId);
  const now = Date.now();
  db.update(workflows)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(workflows.id, workflowId))
    .run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowArchived,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow',
    entityId: workflowId,
    workflowId,
    summary: `Workflow ${workflow.name} archived`
  });
}

export interface StateInput {
  name: string;
  description?: string | null;
  kind?: StateKind;
  category?: StateCategory;
  color?: string | null;
  position?: number;
  isStart?: boolean;
  isTerminal?: boolean;
  agentId?: string | null;
  autoExecute?: boolean;
  maxAttempts?: number;
  timeoutSeconds?: number | null;
  failureStateId?: string | null;
  humanGate?: HumanGateConfig | null;
  config?: StateConfig | null;
}

export function createState(
  db: Executor,
  actor: ActorContext,
  workflowId: string,
  input: StateInput
): WorkflowState {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit workflows');
  const workflow = requireWorkflow(db, actor.workspaceId, workflowId);
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('State name is required');

  validateStateInput(input, workflow);

  const now = Date.now();
  const positionRows = db
    .select({ max: sql<number>`coalesce(max(${workflowStates.position}), -1)` })
    .from(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId))
    .all();

  const stateId = uuidv7(now);
  const inserted = db
    .insert(workflowStates)
    .values({
      id: stateId,
      workspaceId: actor.workspaceId,
      workflowId,
      name,
      description: input.description ?? null,
      kind: input.kind ?? 'manual',
      category: input.category ?? 'active',
      color: input.color ?? null,
      position: input.position ?? (positionRows[0]?.max ?? -1) + 1,
      isStart: input.isStart ?? false,
      isTerminal: input.isTerminal ?? (input.category === 'done' || input.category === 'cancelled'),
      agentId: input.agentId ?? null,
      autoExecute: input.autoExecute ?? true,
      maxAttempts: input.maxAttempts ?? 3,
      timeoutSeconds: input.timeoutSeconds ?? null,
      failureStateId: input.failureStateId ?? null,
      humanGate: (input.humanGate as never) ?? null,
      config: (input.config as never) ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const state = inserted[0];
  if (!state) throw errors.conflict('A state with this name already exists', { name });

  if (state.isStart) {
    db.update(workflowStates)
      .set({ isStart: false })
      .where(and(eq(workflowStates.workflowId, workflowId), ne(workflowStates.id, stateId)))
      .run();
    db.update(workflows)
      .set({ defaultStateId: stateId, updatedAt: now })
      .where(eq(workflows.id, workflowId))
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.stateCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_state',
    entityId: stateId,
    workflowId,
    summary: `State ${name} created`
  });

  return state;
}

function validateStateInput(input: StateInput, workflow: Workflow): void {
  if (input.kind === 'agent' && !input.agentId) {
    // An agent state with no bound agent would silently do nothing; require the
    // binding so the board never contains a state that cannot run.
    throw errors.validation('An agent state requires an agentId');
  }
  if (input.humanGate?.enabled && input.kind === 'agent') {
    throw errors.validation(
      'A human gate applies to manual states; agent states use tool-call approvals instead'
    );
  }
  if (input.category === 'done' && input.humanGate?.enabled) {
    throw errors.validation('A terminal state cannot be human-gated');
  }
  if (workflow.id.length === 0) throw errors.internal('Workflow is required');
}

export function updateState(
  db: Executor,
  actor: ActorContext,
  input: Partial<StateInput> & { stateId: string }
): WorkflowState {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit workflows');
  const current = requireState(db, actor.workspaceId, input.stateId);
  const workflow = requireWorkflow(db, actor.workspaceId, current.workflowId);

  const merged: StateInput = {
    name: input.name ?? current.name,
    description: input.description === undefined ? current.description : input.description,
    kind: input.kind ?? current.kind,
    category: input.category ?? current.category,
    color: input.color === undefined ? current.color : input.color,
    position: input.position ?? current.position,
    isStart: input.isStart ?? current.isStart,
    isTerminal: input.isTerminal ?? current.isTerminal,
    agentId: input.agentId === undefined ? current.agentId : input.agentId,
    autoExecute: input.autoExecute ?? current.autoExecute,
    maxAttempts: input.maxAttempts ?? current.maxAttempts,
    timeoutSeconds:
      input.timeoutSeconds === undefined ? current.timeoutSeconds : input.timeoutSeconds,
    failureStateId:
      input.failureStateId === undefined ? current.failureStateId : input.failureStateId,
    humanGate:
      input.humanGate === undefined
        ? (current.humanGate as HumanGateConfig | null)
        : input.humanGate,
    config: input.config === undefined ? (current.config as StateConfig | null) : input.config
  };
  validateStateInput(merged, workflow);

  const name = merged.name.trim();
  if (name.length === 0) throw errors.validation('State name must not be empty');

  const now = Date.now();
  const updated = db
    .update(workflowStates)
    .set({
      name,
      description: merged.description ?? null,
      kind: merged.kind ?? 'manual',
      category: merged.category ?? 'active',
      color: merged.color ?? null,
      position: merged.position ?? current.position,
      isStart: merged.isStart ?? false,
      isTerminal:
        merged.isTerminal ?? (merged.category === 'done' || merged.category === 'cancelled'),
      agentId: merged.agentId ?? null,
      autoExecute: merged.autoExecute ?? true,
      maxAttempts: merged.maxAttempts ?? 3,
      timeoutSeconds: merged.timeoutSeconds ?? null,
      failureStateId: merged.failureStateId ?? null,
      humanGate: (merged.humanGate as never) ?? null,
      config: (merged.config as never) ?? null,
      updatedAt: now
    })
    .where(eq(workflowStates.id, input.stateId))
    .returning()
    .all();

  const state = updated[0];
  if (!state) throw errors.notFound('Workflow state', input.stateId);

  if (state.isStart) {
    db.update(workflowStates)
      .set({ isStart: false })
      .where(
        and(eq(workflowStates.workflowId, current.workflowId), ne(workflowStates.id, state.id))
      )
      .run();
    db.update(workflows)
      .set({ defaultStateId: state.id, updatedAt: now })
      .where(eq(workflows.id, current.workflowId))
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.stateUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_state',
    entityId: state.id,
    workflowId: current.workflowId,
    summary: `State ${state.name} updated`,
    data: {
      kind: state.kind,
      humanGateEnabled: (state.humanGate as HumanGateConfig | null)?.enabled ?? false
    }
  });

  return state;
}

export function deleteState(db: Executor, actor: ActorContext, stateId: string): void {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit workflows');
  const state = requireState(db, actor.workspaceId, stateId);

  const occupants = db
    .select({ count: sql<number>`count(*)` })
    .from(workflowItems)
    .where(
      and(eq(workflowItems.workspaceId, actor.workspaceId), eq(workflowItems.stateId, stateId))
    )
    .all();
  if ((occupants[0]?.count ?? 0) > 0) {
    throw errors.precondition('This state still holds work. Move it before deleting the state.', {
      itemCount: occupants[0]?.count ?? 0
    });
  }

  const states = listStates(db, actor.workspaceId, state.workflowId);
  if (states.length <= 1) {
    throw errors.precondition('A workflow must keep at least one state');
  }

  db.delete(workflowTransitions)
    .where(
      sql`${workflowTransitions.workflowId} = ${state.workflowId} AND (${workflowTransitions.fromStateId} = ${stateId} OR ${workflowTransitions.toStateId} = ${stateId})`
    )
    .run();
  db.delete(workflowStates).where(eq(workflowStates.id, stateId)).run();

  if (state.isStart) {
    const next = states.find((candidate) => candidate.id !== stateId);
    if (next) {
      db.update(workflowStates).set({ isStart: true }).where(eq(workflowStates.id, next.id)).run();
      db.update(workflows)
        .set({ defaultStateId: next.id, updatedAt: Date.now() })
        .where(eq(workflows.id, state.workflowId))
        .run();
    }
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.stateDeleted,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_state',
    entityId: stateId,
    workflowId: state.workflowId,
    summary: `State ${state.name} deleted`
  });
}

export function reorderStates(
  db: Executor,
  actor: ActorContext,
  workflowId: string,
  stateIds: string[]
): void {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit workflows');
  requireWorkflow(db, actor.workspaceId, workflowId);
  const known = new Set(listStates(db, actor.workspaceId, workflowId).map((state) => state.id));
  for (const stateId of stateIds) {
    if (!known.has(stateId))
      throw errors.validation(`State ${stateId} does not belong to this workflow`);
  }
  const now = Date.now();
  stateIds.forEach((stateId, index) => {
    db.update(workflowStates)
      .set({ position: index, updatedAt: now })
      .where(eq(workflowStates.id, stateId))
      .run();
  });
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.stateUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow',
    entityId: workflowId,
    workflowId,
    summary: 'State order updated',
    data: { order: stateIds }
  });
}

export interface TransitionInput {
  fromStateId: string | null;
  toStateId: string;
  name: string;
  description?: string | null;
  position?: number;
  requiresComment?: boolean;
  requiredFieldKeys?: string[];
  allowedRoles?: string[];
  condition?: Record<string, unknown> | null;
}

export function createTransition(
  db: Executor,
  actor: ActorContext,
  workflowId: string,
  input: TransitionInput
): WorkflowTransition {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit workflows');
  requireWorkflow(db, actor.workspaceId, workflowId);

  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Transition name is required');
  const target = requireState(db, actor.workspaceId, input.toStateId);
  if (target.workflowId !== workflowId) {
    throw errors.validation('The target state must belong to the same workflow');
  }
  if (input.fromStateId) {
    const source = requireState(db, actor.workspaceId, input.fromStateId);
    if (source.workflowId !== workflowId) {
      throw errors.validation('The source state must belong to the same workflow');
    }
  }

  const now = Date.now();
  const positionRows = db
    .select({ max: sql<number>`coalesce(max(${workflowTransitions.position}), -1)` })
    .from(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowId))
    .all();

  const inserted = db
    .insert(workflowTransitions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowId,
      fromStateId: input.fromStateId,
      toStateId: input.toStateId,
      name,
      description: input.description ?? null,
      position: input.position ?? (positionRows[0]?.max ?? -1) + 1,
      requiresComment: input.requiresComment ?? false,
      requiredFieldKeys: (input.requiredFieldKeys as never) ?? null,
      allowedRoles: (input.allowedRoles as never) ?? null,
      condition: (input.condition as never) ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const transition = inserted[0];
  if (!transition) throw errors.conflict('That transition already exists', { name });

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.transitionCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_transition',
    entityId: transition.id,
    workflowId,
    summary: `Transition ${name} created`
  });

  return transition;
}

export function deleteTransition(db: Executor, actor: ActorContext, transitionId: string): void {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit workflows');
  const rows = db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.id, transitionId),
        eq(workflowTransitions.workspaceId, actor.workspaceId)
      )
    )
    .limit(1)
    .all();
  const transition = rows[0];
  if (!transition) throw errors.notFound('Transition', transitionId);

  db.delete(workflowTransitions).where(eq(workflowTransitions.id, transitionId)).run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.transitionDeleted,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_transition',
    entityId: transitionId,
    workflowId: transition.workflowId,
    summary: `Transition ${transition.name} deleted`
  });
}

export interface TransferRuleInput {
  targetWorkflowId: string;
  defaultTargetStateId?: string | null;
  fieldMappings?: Record<string, string>;
  requiredTargetFieldKeys?: string[];
  allowAgents?: boolean;
  allowHumans?: boolean;
  requiresApproval?: boolean;
  carryLabels?: boolean;
}

export function setTransferRule(
  db: Executor,
  actor: ActorContext,
  sourceWorkflowId: string,
  input: TransferRuleInput
): WorkflowTransferRule {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit transfer rules');
  requireWorkflow(db, actor.workspaceId, sourceWorkflowId);
  const target = requireWorkflow(db, actor.workspaceId, input.targetWorkflowId);
  if (target.id === sourceWorkflowId) {
    throw errors.validation('A workflow cannot define a transfer rule to itself');
  }
  if (input.defaultTargetStateId) {
    const state = requireState(db, actor.workspaceId, input.defaultTargetStateId);
    if (state.workflowId !== target.id) {
      throw errors.validation('The default target state must belong to the destination workflow');
    }
  }

  const now = Date.now();
  const existing = db
    .select()
    .from(workflowTransferRules)
    .where(
      and(
        eq(workflowTransferRules.sourceWorkflowId, sourceWorkflowId),
        eq(workflowTransferRules.targetWorkflowId, input.targetWorkflowId)
      )
    )
    .limit(1)
    .all();

  const values = {
    defaultTargetStateId: input.defaultTargetStateId ?? target.defaultStateId ?? null,
    fieldMappings: (input.fieldMappings as never) ?? null,
    requiredTargetFieldKeys: (input.requiredTargetFieldKeys as never) ?? null,
    allowAgents: input.allowAgents ?? true,
    allowHumans: input.allowHumans ?? true,
    requiresApproval: input.requiresApproval ?? false,
    carryLabels: input.carryLabels ?? true,
    updatedAt: now
  };

  let rule: WorkflowTransferRule | undefined;
  if (existing[0]) {
    const updated = db
      .update(workflowTransferRules)
      .set(values)
      .where(eq(workflowTransferRules.id, existing[0].id))
      .returning()
      .all();
    rule = updated[0];
  } else {
    const inserted = db
      .insert(workflowTransferRules)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        sourceWorkflowId,
        targetWorkflowId: input.targetWorkflowId,
        createdAt: now,
        ...values
      })
      .returning()
      .all();
    rule = inserted[0];
  }
  if (!rule) throw errors.internal('Failed to save transfer rule');

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.transferRuleChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_transfer_rule',
    entityId: rule.id,
    workflowId: sourceWorkflowId,
    summary: `Transfer rule to ${target.name} saved`,
    data: { targetWorkflowId: target.id, requiresApproval: rule.requiresApproval }
  });

  return rule;
}

export function deleteTransferRule(db: Executor, actor: ActorContext, ruleId: string): void {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit transfer rules');
  const rows = db
    .select()
    .from(workflowTransferRules)
    .where(
      and(
        eq(workflowTransferRules.id, ruleId),
        eq(workflowTransferRules.workspaceId, actor.workspaceId)
      )
    )
    .limit(1)
    .all();
  const rule = rows[0];
  if (!rule) throw errors.notFound('Transfer rule', ruleId);
  db.delete(workflowTransferRules).where(eq(workflowTransferRules.id, ruleId)).run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.transferRuleChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_transfer_rule',
    entityId: ruleId,
    workflowId: rule.sourceWorkflowId,
    summary: 'Transfer rule removed'
  });
}

/** Outgoing transitions available to a specific actor, honouring role restrictions. */
export function availableTransitions(
  db: Executor,
  actor: ActorContext,
  workflowId: string,
  fromStateId: string
): WorkflowTransition[] {
  const transitions = listOutgoingTransitions(db, actor.workspaceId, workflowId, fromStateId);
  return transitions.filter((transition) => {
    const roles = transition.allowedRoles as string[] | null;
    if (!roles || roles.length === 0) return true;
    return roles.includes(actor.role);
  });
}
