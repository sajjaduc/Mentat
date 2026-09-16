/**
 * Agents, skills, tools and agent-scoped state.
 *
 * Agents and skills are *versioned configuration*, not code. An `agent_versions`
 * row is an immutable snapshot; every `agent_run` references one, so changing an
 * agent never rewrites the history of work that already happened (ADR-0008).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  bool,
  createdAt,
  epochMs,
  json,
  primaryId,
  type ResourceBindingMode,
  updatedAt
} from './_helpers';
import { users, workspaces } from './tenancy';

export interface AgentExecutionConfig {
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutSeconds?: number;
  /** Stop the run instead of failing when a tool errors. */
  continueOnToolError?: boolean;
  retryOnProviderError?: boolean;
  /** Require an approval before every mutating tool call. */
  requireApprovalForMutations?: boolean;
}

export interface AgentPermissions {
  /** Native capability keys the agent may call, e.g. `ticket.fields.set`. */
  native?: string[];
  /** Permission scopes for HTTP operations. */
  httpOperationIds?: string[];
  /** Whether the agent may transfer tickets between workflows. */
  canTransferTickets?: boolean;
  canCreateTickets?: boolean;
  /** Workspace-scoped state writes are opt-in. */
  canWriteWorkspaceState?: boolean;
  canUploadFiles?: boolean;
  /** Field keys the agent may write; empty means none, `*` means all. */
  writableFieldKeys?: string[];
}

export interface AgentSnapshot {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  instructions: string;
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
  modelKey?: string | null;
  skillIds: string[];
  toolIds: string[];
  outputSchema?: unknown;
  executionConfig?: AgentExecutionConfig | null;
  permissions?: AgentPermissions | null;
  version: number;
}

export const agents = sqliteTable(
  'agents',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Null means the agent is a workspace-common resource. */
    workflowId: text('workflow_id'),
    /** Set when this agent is a workflow-specific copy of a common agent. */
    sourceAgentId: text('source_agent_id'),
    bindingMode: text('binding_mode').$type<ResourceBindingMode>().notNull().default('use_asis'),
    name: text('name').notNull(),
    description: text('description'),
    instructions: text('instructions').notNull().default(''),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    skillIds: json<string[]>('skill_ids'),
    toolIds: json<string[]>('tool_ids'),
    outputSchema: json<unknown>('output_schema'),
    executionConfig: json<AgentExecutionConfig>('execution_config'),
    permissions: json<AgentPermissions>('permissions'),
    /** Current immutable version; bumped on every material change. */
    currentVersionId: text('current_version_id'),
    version: integer('version').notNull().default(1),
    isFavorite: bool('is_favorite'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('agents_name_unique').on(table.workspaceId, table.workflowId, table.name),
    index('agents_workspace_idx').on(table.workspaceId, table.archivedAt)
  ]
);

export const agentVersions = sqliteTable(
  'agent_versions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: json<AgentSnapshot>('snapshot').notNull(),
    changeNote: text('change_note'),
    createdByType: text('created_by_type'),
    createdById: text('created_by_id'),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('agent_versions_unique').on(table.agentId, table.version),
    index('agent_versions_agent_idx').on(table.agentId, table.createdAt)
  ]
);

export interface SkillExample {
  title: string;
  input?: string;
  output?: string;
  notes?: string;
}

export interface SkillReference {
  title: string;
  url?: string;
  content?: string;
}

export const skills = sqliteTable(
  'skills',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    sourceSkillId: text('source_skill_id'),
    bindingMode: text('binding_mode').$type<ResourceBindingMode>().notNull().default('use_asis'),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),
    currentVersionId: text('current_version_id'),
    version: integer('version').notNull().default(1),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('skills_name_unique').on(table.workspaceId, table.workflowId, table.name),
    index('skills_workspace_idx').on(table.workspaceId, table.archivedAt)
  ]
);

export const skillVersions = sqliteTable(
  'skill_versions',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    instructions: text('instructions').notNull().default(''),
    examples: json<SkillExample[]>('examples'),
    references: json<SkillReference[]>('references'),
    recommendedToolKeys: json<string[]>('recommended_tool_keys'),
    createdAt: createdAt()
  },
  (table) => [uniqueIndex('skill_versions_unique').on(table.skillId, table.version)]
);

export type ToolKind = 'native' | 'http';

export interface NativeToolImplementation {
  kind: 'native';
  /** Registry key, e.g. `ticket.fields.set`. */
  key: string;
}

export interface HttpToolImplementation {
  kind: 'http';
  operationId: string;
  serviceId: string;
}

export type ToolImplementation = NativeToolImplementation | HttpToolImplementation;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: number[];
  honorRetryAfter?: boolean;
}

export interface ApprovalPolicy {
  mode: 'never' | 'always' | 'conditional';
  /** Machine-readable condition evaluated by the policy engine, never by the model. */
  condition?: string;
  /** Human-readable explanation shown in the approval inbox. */
  reason?: string;
}

export interface CachePolicy {
  enabled: boolean;
  ttlSeconds?: number;
  /** Whether to read from cache. Writes still happen when `enabled`. */
  read?: boolean;
  varyOn?: string[];
}

export const tools = sqliteTable(
  'tools',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Semantic, model-facing name, e.g. `hubspot.get_contact`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind').$type<ToolKind>().notNull(),
    implementation: json<ToolImplementation>('implementation').notNull(),
    inputSchema: json<unknown>('input_schema'),
    outputSchema: json<unknown>('output_schema'),
    permissions: json<string[]>('permissions'),
    timeoutSeconds: integer('timeout_seconds').notNull().default(30),
    retryPolicy: json<RetryPolicy>('retry_policy'),
    approvalPolicy: json<ApprovalPolicy>('approval_policy'),
    cachePolicy: json<CachePolicy>('cache_policy'),
    enabled: bool('enabled', true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('tools_key_unique').on(table.workspaceId, table.key),
    index('tools_workspace_idx').on(table.workspaceId, table.enabled)
  ]
);

export const agentTools = sqliteTable(
  'agent_tools',
  {
    id: primaryId(),
    workspaceId: text('workspace_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    toolId: text('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: createdAt()
  },
  (table) => [uniqueIndex('agent_tools_unique').on(table.agentId, table.toolId)]
);

export type AgentStateScope = 'workspace' | 'workflow' | 'ticket' | 'agent' | 'run';

/**
 * Scoped key/value state for agents (`state.get/set/delete/list`).
 *
 * Scope determines the visibility lifetime: a ticket-scoped value travels with the
 * ticket, a workspace-scoped value is shared across workflows. Arbitrary SQL is
 * never exposed.
 */
export const agentState = sqliteTable(
  'agent_state',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<AgentStateScope>().notNull(),
    workflowId: text('workflow_id'),
    ticketId: text('ticket_id'),
    agentId: text('agent_id'),
    runId: text('run_id'),
    namespace: text('namespace').notNull().default('default'),
    key: text('key').notNull(),
    value: json<unknown>('value'),
    version: integer('version').notNull().default(1),
    expiresAt: epochMs('expires_at'),
    createdByType: text('created_by_type'),
    createdById: text('created_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('agent_state_unique').on(
      table.workspaceId,
      table.scope,
      table.workflowId,
      table.ticketId,
      table.agentId,
      table.runId,
      table.namespace,
      table.key
    ),
    index('agent_state_lookup_idx').on(table.workspaceId, table.scope, table.namespace)
  ]
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SkillVersion = typeof skillVersions.$inferSelect;
export type Tool = typeof tools.$inferSelect;
export type AgentStateRow = typeof agentState.$inferSelect;
