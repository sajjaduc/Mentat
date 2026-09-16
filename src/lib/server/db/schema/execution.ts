/**
 * Durable execution: jobs, agent runs, run steps and approvals.
 *
 * Execution state is persisted before anything observable happens. Streaming is a
 * *view* over persisted facts, so a browser disconnect can never stop or lose a
 * running agent (ADR-0007).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from '../../core/ids';
import { createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import type { ActorType } from './fields';
import { users, workspaces } from './tenancy';

export type JobStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'dead' | 'cancelled';

export type JobType =
  | 'agent.run'
  | 'state.enter'
  | 'approval.resume'
  | 'file.process'
  | 'file.hash'
  | 'trigger.webhook'
  | 'trigger.cron'
  | 'http.request'
  | 'maintenance.reap'
  | 'maintenance.schedule'
  | 'analytics.refresh'
  | 'webhook.deliver';

export interface JobPayload {
  [key: string]: unknown;
}

export const jobs = sqliteTable(
  'jobs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').$type<JobType>().notNull(),
    queue: text('queue').notNull().default('default'),
    payload: json<JobPayload>('payload').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /** Earliest time the job may be leased (epoch ms). Drives retry backoff. */
    availableAt: integer('available_at').notNull(),
    leasedAt: epochMs('leased_at'),
    leasedBy: text('leased_by'),
    leaseExpiresAt: epochMs('lease_expires_at'),
    lastError: text('last_error'),
    lastErrorCode: text('last_error_code'),
    result: json<unknown>('result'),
    timeoutSeconds: integer('timeout_seconds'),
    /** Stable key that makes enqueueing the same unit of work idempotent. */
    dedupeKey: text('dedupe_key'),
    idempotencyKey: text('idempotency_key'),
    ticketId: text('ticket_id'),
    runId: text('run_id'),
    parentJobId: text('parent_job_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: epochMs('completed_at')
  },
  (table) => [
    index('jobs_lease_idx').on(table.status, table.queue, table.availableAt, table.priority),
    index('jobs_dedupe_idx').on(table.workspaceId, table.dedupeKey),
    index('jobs_run_idx').on(table.runId),
    index('jobs_ticket_idx').on(table.workspaceId, table.ticketId),
    index('jobs_status_idx').on(table.workspaceId, table.status, table.createdAt)
  ]
);

export const jobAttempts = sqliteTable(
  'job_attempts',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    workerId: text('worker_id').notNull(),
    status: text('status').$type<'started' | 'succeeded' | 'failed' | 'lease_expired'>().notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: epochMs('finished_at'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    errorCode: text('error_code')
  },
  (table) => [
    uniqueIndex('job_attempts_unique').on(table.jobId, table.attempt),
    index('job_attempts_job_idx').on(table.jobId, table.startedAt)
  ]
);

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval'
  | 'skipped';

export type RunTriggerType = 'state_entry' | 'manual' | 'webhook' | 'cron' | 'retry' | 'api';

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costCents?: number;
  durationMs?: number;
}

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id'),
    workflowId: text('workflow_id').notNull(),
    stateId: text('state_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** Immutable agent version used by this run. */
    agentVersionId: text('agent_version_id').notNull(),
    agentVersion: integer('agent_version').notNull().default(1),
    providerId: text('provider_id'),
    providerType: text('provider_type'),
    modelId: text('model_id'),
    modelKey: text('model_key'),
    status: text('status').$type<AgentRunStatus>().notNull().default('queued'),
    attempt: integer('attempt').notNull().default(1),
    jobId: text('job_id'),
    triggerType: text('trigger_type').$type<RunTriggerType>().notNull().default('state_entry'),
    triggerId: text('trigger_id'),
    /** Redacted snapshot of everything the model was allowed to see. */
    inputSnapshot: json<unknown>('input_snapshot'),
    contextConfig: json<unknown>('context_config'),
    promptVersion: text('prompt_version'),
    output: json<unknown>('output'),
    outputText: text('output_text'),
    usage: json<RunUsage>('usage'),
    cacheStatus: text('cache_status').$type<'hit' | 'miss' | 'bypass' | 'stored'>(),
    requestedTransitionId: text('requested_transition_id'),
    appliedTransitionId: text('applied_transition_id'),
    error: text('error'),
    errorCode: text('error_code'),
    startedAt: epochMs('started_at'),
    finishedAt: epochMs('finished_at'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index('agent_runs_ticket_idx').on(table.workspaceId, table.ticketId, table.createdAt),
    index('agent_runs_status_idx').on(table.workspaceId, table.status, table.createdAt),
    index('agent_runs_agent_idx').on(table.workspaceId, table.agentId, table.createdAt)
  ]
);

export type RunStepType =
  | 'message'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'state'
  | 'field_change'
  | 'note'
  | 'transition'
  | 'approval'
  | 'error'
  | 'context';

export const agentRunSteps = sqliteTable(
  'agent_run_steps',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    index: integer('step_index').notNull(),
    type: text('type').$type<RunStepType>().notNull(),
    name: text('name'),
    status: text('status')
      .$type<'started' | 'completed' | 'failed'>()
      .notNull()
      .default('completed'),
    /** Redacted at write time; never contains secret plaintext. */
    input: json<unknown>('input'),
    output: json<unknown>('output'),
    error: text('error'),
    toolId: text('tool_id'),
    toolKey: text('tool_key'),
    startedAt: integer('started_at').notNull(),
    finishedAt: epochMs('finished_at'),
    durationMs: integer('duration_ms'),
    metadata: json<Record<string, unknown>>('metadata')
  },
  (table) => [uniqueIndex('agent_run_steps_unique').on(table.runId, table.index)]
);

/**
 * Streamable run events. `seq` is a monotonic sequence used for SSE replay and
 * gap detection by the client. The autoincrement here is a log ordinal, not an
 * entity identity, which is why it does not violate ADR-0003.
 */
export const runEvents = sqliteTable(
  'run_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id')
      .notNull()
      .$defaultFn(() => uuidv7()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    ticketId: text('ticket_id'),
    type: text('type').notNull(),
    data: json<unknown>('data'),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('run_events_id_unique').on(table.id),
    index('run_events_run_idx').on(table.runId, table.seq),
    index('run_events_ticket_idx').on(table.workspaceId, table.ticketId, table.seq)
  ]
);

export type ApprovalKind = 'state_transition' | 'tool_call' | 'transfer' | 'ticket_creation';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface ApprovalAction {
  type: string;
  [key: string]: unknown;
}

export const approvalRequests = sqliteTable(
  'approval_requests',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id'),
    workflowId: text('workflow_id'),
    runId: text('run_id'),
    stepId: text('step_id'),
    jobId: text('job_id'),
    kind: text('kind').$type<ApprovalKind>().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** Exactly what will happen if approved; redacted of secrets. */
    requestedAction: json<ApprovalAction>('requested_action').notNull(),
    contextSnapshot: json<unknown>('context_snapshot'),
    requestedByType: text('requested_by_type').$type<ActorType>().notNull(),
    requestedById: text('requested_by_id'),
    requestedByLabel: text('requested_by_label'),
    status: text('status').$type<ApprovalStatus>().notNull().default('pending'),
    reviewerUserId: text('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerTeamId: text('reviewer_team_id'),
    decidedByUserId: text('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    decidedByLabel: text('decided_by_label'),
    decisionComment: text('decision_comment'),
    decision: json<Record<string, unknown>>('decision'),
    /** Set when execution may resume without re-running completed work. */
    resumeToken: text('resume_token'),
    createdAt: createdAt(),
    decidedAt: epochMs('decided_at'),
    expiresAt: epochMs('expires_at')
  },
  (table) => [
    index('approval_requests_status_idx').on(table.workspaceId, table.status, table.createdAt),
    index('approval_requests_ticket_idx').on(table.workspaceId, table.ticketId),
    index('approval_requests_run_idx').on(table.runId)
  ]
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobAttempt = typeof jobAttempts.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type AgentRunStep = typeof agentRunSteps.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
