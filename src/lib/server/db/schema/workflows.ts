/**
 * Workflows, states and transitions.
 *
 * A Workflow is a project plus a configurable state machine. States describe the
 * *kind* of work that happens there (human, agent, deterministic, terminal) and
 * transitions describe what may follow. Nothing about a workflow is hard-coded in
 * the engine: the executor reads this configuration at runtime.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { objectTypes } from './records';
import { users, workspaces } from './tenancy';

export type StateKind = 'manual' | 'agent' | 'system' | 'terminal';
export type StateCategory = 'backlog' | 'active' | 'review' | 'done' | 'cancelled';
export type TransitionTrigger = 'human' | 'agent' | 'system' | 'any';

export interface HumanGateConfig {
  enabled: boolean;
  /** Transition ids a human may take out of this state. Empty means "all outgoing". */
  allowedTransitionIds?: string[];
  requiredFieldKeys?: string[];
  requiredComment?: boolean;
  allowedRoles?: Array<'owner' | 'admin' | 'member'>;
  allowedTeamIds?: string[];
  /** Free-form guidance shown in the review surface. */
  instructions?: string;
}

export interface StateConfig {
  /** Deterministic action executed for `system` states, e.g. `ticket.setField`. */
  systemAction?: SystemAction;
  /** Context selection for agent states: which fields/notes/files enter the prompt. */
  context?: AgentContextConfig;
  /** Optional tool subset for this state, overriding the agent's tool list. */
  allowedToolKeys?: string[];
  /** When true the state only ever runs once per ticket entry (default). */
  runOncePerEntry?: boolean;
  wipLimit?: number;
  slaSeconds?: number;
  /**
   * Enforced structured submission (ADR-0023). For record-bound runs, the agent
   * must successfully call this tool with a payload validated against the record's
   * Object Type schema before the run may succeed; otherwise the runner nudges it
   * and, after `maxNudges`, fails the run.
   */
  requiredSubmission?: RequiredSubmissionConfig;
  /**
   * A Zod schema authored as source that applies while work is in this state. It is
   * validated against the submitted record in addition to the Object Type contract,
   * so a step can demand data the record schema does not (ADR-0023). The same
   * source is compiled on every submission, which is what makes it reusable.
   */
  zodSchema?: string;
}

export interface RequiredSubmissionConfig {
  /** Defaults to `workflowItems.submit`. */
  toolKey?: string;
  /** Corrective nudges before the run fails. Defaults to 2. */
  maxNudges?: number;
  /** Allow the submission to name a different target Workflow. Defaults to true. */
  allowWorkflowChange?: boolean;
}

export interface AgentContextConfig {
  includeTitle?: boolean;
  includeDescription?: boolean;
  fieldKeys?: string[];
  includeRecentNotes?: number;
  includeFileSummaries?: boolean;
  includeFileFields?: string[];
  includeFullFileContent?: boolean;
  includeHistory?: boolean;
  includeStateHistory?: boolean;
  /** Include the effective Object Type schema and submission contract. */
  includeRecordSchema?: boolean;
}

export type SystemAction =
  | { type: 'transition'; targetStateId?: string }
  | { type: 'setFields'; values: Record<string, unknown> }
  | { type: 'emitEvent'; name: string }
  | { type: 'createWorkItem'; workflowId: string; titleTemplate: string }
  | { type: 'http'; operationId: string }
  | { type: 'wait'; seconds: number };

export const workflows = sqliteTable(
  'workflows',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    key: text('key').notNull(),
    description: text('description'),
    icon: text('icon'),
    color: text('color'),
    /**
     * The Object Type this Workflow processes (ADR-0021). Null is tolerated only
     * for rows written before the universal model; the service resolves them to
     * the workspace's Ticket object type.
     */
    objectTypeId: text('object_type_id').references(() => objectTypes.id, {
      onDelete: 'restrict'
    }),
    /** Default state for items created without an explicit state. */
    defaultStateId: text('default_state_id'),
    settings: json<WorkflowSettings>('settings'),
    position: integer('position').notNull().default(0),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('workflows_key_unique').on(table.workspaceId, table.key),
    index('workflows_workspace_idx').on(table.workspaceId, table.archivedAt)
  ]
);

export interface WorkflowSettings {
  /** Cross-workflow routing policy (ADR-0011). */
  transfer?: TransferSettings;
  defaultTimezone?: string;
  /** Allow agents in this workflow to create tickets at all. */
  allowAgentWorkCreation?: boolean;
  allowHumanWorkCreation?: boolean;
  requiresApprovalToClose?: boolean;
  /**
   * Whether one Record may have more than one *active* WorkflowItem in this
   * workflow. Defaults to false (at most one active participation).
   */
  allowMultipleActiveItems?: boolean;
  /**
   * The authoritative Zod contract for this workflow's overlay fields, authored as
   * source (ADR-0023). Bound `workflow_fields` are a projection of it.
   */
  zodSchema?: string;
}

export interface TransferSettings {
  /** When empty, any workflow in the workspace is a legal destination. */
  allowedTargetWorkflowIds?: string[];
  defaultTargetStateId?: string;
  allowAgents: boolean;
  allowHumans: boolean;
  requiresApproval: boolean;
  /** Field keys that must be present on the ticket before it may leave. */
  requiredFieldKeys?: string[];
}

export const workflowStates = sqliteTable(
  'workflow_states',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind').$type<StateKind>().notNull().default('manual'),
    category: text('category').$type<StateCategory>().notNull().default('active'),
    color: text('color'),
    position: integer('position').notNull().default(0),
    isStart: bool('is_start'),
    isTerminal: bool('is_terminal'),
    /** Agent bound to this state; run uses the agent's current version snapshot. */
    agentId: text('agent_id'),
    agentVersionId: text('agent_version_id'),
    /** When false an agent state waits for an explicit trigger (human/system). */
    autoExecute: bool('auto_execute', true),
    maxAttempts: integer('max_attempts').notNull().default(3),
    timeoutSeconds: integer('timeout_seconds'),
    failureStateId: text('failure_state_id'),
    /** Tools the state may call, when restricted. */
    humanGate: json<HumanGateConfig>('human_gate'),
    config: json<StateConfig>('config'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('workflow_states_name_unique').on(table.workflowId, table.name),
    index('workflow_states_workflow_idx').on(table.workspaceId, table.workflowId, table.position)
  ]
);

export interface TransitionCondition {
  /** Only allow the transition when these field values match. */
  fieldEquals?: Array<{ fieldKey: string; value: unknown }>;
  /** Restrict by actor. */
  actors?: TransitionTrigger[];
  /** Minimum time the ticket must have been in the source state. */
  minDwellSeconds?: number;
}

export const workflowTransitions = sqliteTable(
  'workflow_transitions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    /** Null `fromStateId` means "from any state" (used sparingly). */
    fromStateId: text('from_state_id'),
    toStateId: text('to_state_id')
      .notNull()
      .references(() => workflowStates.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    requiresComment: bool('requires_comment'),
    requiredFieldKeys: json<string[]>('required_field_keys'),
    allowedRoles: json<string[]>('allowed_roles'),
    condition: json<TransitionCondition>('condition'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('workflow_transitions_from_idx').on(
      table.workspaceId,
      table.workflowId,
      table.fromStateId
    ),
    uniqueIndex('workflow_transitions_unique').on(table.fromStateId, table.toStateId, table.name)
  ]
);

/**
 * Cross-workflow transfer policy: which workflows a ticket may move to, how source
 * fields map onto destination fields, and who is allowed to perform the move.
 */
export const workflowTransferRules = sqliteTable(
  'workflow_transfer_rules',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceWorkflowId: text('source_workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    targetWorkflowId: text('target_workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    defaultTargetStateId: text('default_target_state_id'),
    /** `{ sourceFieldKey: targetFieldKey }` — applied on transfer. */
    fieldMappings: json<Record<string, string>>('field_mappings'),
    /** Target fields that must have a value after mapping. */
    requiredTargetFieldKeys: json<string[]>('required_target_field_keys'),
    allowAgents: bool('allow_agents', true),
    allowHumans: bool('allow_humans', true),
    requiresApproval: bool('requires_approval'),
    /** Copy the originating workflow's labels onto the ticket when unmapped. */
    carryLabels: bool('carry_labels', true),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('workflow_transfer_rules_unique').on(table.sourceWorkflowId, table.targetWorkflowId)
  ]
);

export const labels = sqliteTable(
  'labels',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex('labels_unique').on(table.workspaceId, table.name)]
);

export type SavedViewScope = 'workflowItems' | 'files';

export interface SavedViewSort {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * A saved view stores the serializable filter AST used by ticket and file lists.
 * The same AST powers dashboard widgets, so there is exactly one filtering
 * language in the product (ADR-0012).
 */
export const savedViews = sqliteTable(
  'saved_views',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    scope: text('scope').$type<SavedViewScope>().notNull().default('workflowItems'),
    workflowId: text('workflow_id'),
    filterAst: json<unknown>('filter_ast'),
    sort: json<SavedViewSort[]>('sort'),
    columns: json<string[]>('columns'),
    isShared: bool('is_shared', true),
    isPinned: bool('is_pinned'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('saved_views_scope_idx').on(table.workspaceId, table.scope),
    uniqueIndex('saved_views_unique').on(table.workspaceId, table.scope, table.name)
  ]
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowState = typeof workflowStates.$inferSelect;
export type NewWorkflowState = typeof workflowStates.$inferInsert;
export type WorkflowTransition = typeof workflowTransitions.$inferSelect;
export type WorkflowTransferRule = typeof workflowTransferRules.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
