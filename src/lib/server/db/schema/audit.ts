/**
 * Append-only audit ledger.
 *
 * Current domain rows remain authoritative — this is not event sourcing. The
 * ledger exists so that a Record's history stays one coherent chronological record
 * across workflows, agents and humans, and so operational questions ("which agent
 * generated the most retries") have a durable answer.
 *
 * `seq` is an autoincrement *log ordinal*, not an entity identity (ADR-0003): ids
 * remain application-generated UUIDv7, while `seq` gives strict ordering and cheap
 * keyset pagination across dialect versions.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from '../../core/ids';
import { createdAt, json } from './_helpers';
import type { ActorType } from './fields';
import { workspaces } from './tenancy';

/** Canonical audit action names. Keep them stable: filters and tests rely on them. */
export const AuditActions = {
  workspaceCreated: 'workspace.created',
  workspaceUpdated: 'workspace.updated',
  memberAdded: 'workspace.member.added',
  memberRoleChanged: 'workspace.member.role_changed',
  userSignedIn: 'user.signed_in',
  userSignedOut: 'user.signed_out',
  userCreated: 'user.created',

  workflowCreated: 'workflow.created',
  workflowUpdated: 'workflow.updated',
  workflowArchived: 'workflow.archived',
  stateCreated: 'workflow.state.created',
  stateUpdated: 'workflow.state.updated',
  stateDeleted: 'workflow.state.deleted',
  transitionCreated: 'workflow.transition.created',
  transitionDeleted: 'workflow.transition.deleted',
  transferRuleChanged: 'workflow.transfer_rule.changed',

  objectTypeCreated: 'object_type.created',
  objectTypeUpdated: 'object_type.updated',
  objectTypeArchived: 'object_type.archived',

  recordCreated: 'record.created',
  recordUpdated: 'record.updated',
  recordArchived: 'record.archived',
  recordFieldChanged: 'record.field.changed',
  recordFieldsChanged: 'record.fields.changed',
  recordNoteAdded: 'record.note.added',
  recordNoteEdited: 'record.note.edited',
  recordRelationshipAdded: 'record.relationship.added',
  recordRelationshipRemoved: 'record.relationship.removed',
  recordExternalIdSet: 'record.external_id.set',
  recordExternalIdRemoved: 'record.external_id.removed',
  recordFileLinked: 'record.file.linked',
  recordFileUnlinked: 'record.file.unlinked',

  workflowItemCreated: 'workflow_item.created',
  workflowItemUpdated: 'workflow_item.updated',
  workflowItemStateEntered: 'workflow_item.state.entered',
  workflowItemStateExited: 'workflow_item.state.exited',
  workflowItemTransitionRequested: 'workflow_item.transition.requested',
  workflowItemTransitionRejected: 'workflow_item.transition.rejected',
  workflowItemTransferred: 'workflow_item.transferred',
  workflowItemParticipationAdded: 'workflow_item.participation.added',
  workflowItemCompleted: 'workflow_item.completed',
  workflowItemAssigned: 'workflow_item.assigned',
  workflowItemNoteAdded: 'workflow_item.note.added',
  workflowItemNoteEdited: 'workflow_item.note.edited',
  workflowItemRelationshipAdded: 'workflow_item.relationship.added',
  workflowItemRelationshipRemoved: 'workflow_item.relationship.removed',
  workflowItemFieldChanged: 'workflow_item.field.changed',
  workflowItemFieldsChanged: 'workflow_item.fields.changed',
  workflowItemLabelAdded: 'workflow_item.label.added',
  workflowItemLabelRemoved: 'workflow_item.label.removed',
  workflowItemFileLinked: 'workflow_item.file.linked',
  workflowItemFileUnlinked: 'workflow_item.file.unlinked',
  workflowItemHumanGateDecided: 'workflow_item.human_gate.decided',
  workflowItemHumanGateBlocked: 'workflow_item.human_gate.blocked',

  agentRunStarted: 'agent.run.started',
  agentRunCompleted: 'agent.run.completed',
  agentRunFailed: 'agent.run.failed',
  agentRunPaused: 'agent.run.paused',
  agentRunResumed: 'agent.run.resumed',
  agentRunCancelled: 'agent.run.cancelled',
  toolCallStarted: 'tool.call.started',
  toolCallCompleted: 'tool.call.completed',
  toolCallFailed: 'tool.call.failed',
  toolCallDenied: 'tool.call.denied',

  approvalRequested: 'approval.requested',
  approvalDecided: 'approval.decided',
  approvalExpired: 'approval.expired',

  jobEnqueued: 'job.enqueued',
  jobStarted: 'job.started',
  jobCompleted: 'job.completed',
  jobFailed: 'job.failed',
  jobRetryScheduled: 'job.retry_scheduled',
  jobDead: 'job.dead',
  jobCancelled: 'job.cancelled',
  jobLeaseExpired: 'job.lease_expired',

  triggerReceived: 'trigger.received',
  triggerProcessed: 'trigger.processed',
  triggerFailed: 'trigger.failed',
  triggerDuplicate: 'trigger.duplicate',

  fileIngested: 'file.ingested',
  fileBlobDeduplicated: 'file.blob.deduplicated',
  fileProcessingQueued: 'file.processing.queued',
  fileProcessingCompleted: 'file.processing.completed',
  fileProcessingFailed: 'file.processing.failed',
  fileSummaryGenerated: 'file.summary.generated',
  fileFieldExtracted: 'file.field.extracted',
  fileFieldCorrected: 'file.field.corrected',
  fileLinkedToWorkItem: 'file.linked_to_work_item',
  fileUnlinkedFromWorkItem: 'file.unlinked_from_work_item',
  fileContextAdded: 'file.context.added',
  fileDeleted: 'file.deleted',
  blobDeleted: 'blob.deleted',

  secretCreated: 'secret.created',
  secretRotated: 'secret.rotated',
  secretDeleted: 'secret.deleted',
  secretAccessed: 'secret.accessed',
  variableSet: 'variable.set',
  variableDeleted: 'variable.deleted',
  overrideSet: 'override.set',
  overrideRemoved: 'override.removed',

  serviceCreated: 'http.service.created',
  serviceUpdated: 'http.service.updated',
  operationCreated: 'http.operation.created',
  operationUpdated: 'http.operation.updated',
  httpRequestCompleted: 'http.request.completed',
  httpRequestFailed: 'http.request.failed',
  httpRequestTested: 'http.request.tested',

  mcpServerCreated: 'mcp.server.created',
  mcpServerUpdated: 'mcp.server.updated',
  mcpServerRemoved: 'mcp.server.removed',
  mcpToolsDiscovered: 'mcp.tools.discovered',
  toolEnabledChanged: 'tool.enabled.changed',
  toolsImported: 'tool.imported',

  providerCreated: 'provider.created',
  providerUpdated: 'provider.updated',
  providerHealthChecked: 'provider.health.checked',
  modelsDiscovered: 'provider.models.discovered',

  dashboardCreated: 'dashboard.created',
  dashboardUpdated: 'dashboard.updated',
  dashboardDeleted: 'dashboard.deleted',
  savedViewCreated: 'saved_view.created',

  cacheCleared: 'cache.cleared',
  collectionCreated: 'collection.created',
  collectionRecordChanged: 'collection.record.changed',
  migrationApplied: 'system.migration.applied',
  rateLimited: 'http.rate_limited'
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions] | (string & {});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    /** Monotonic log ordinal (see module comment). */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id')
      .notNull()
      .$defaultFn(() => uuidv7()),
    /**
     * Null for platform-level events (account creation, key rotation) that belong to
     * no tenant. Tenant ledger queries filter by workspaceId and therefore never see
     * them, which is the correct isolation behaviour.
     */
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull().default('system'),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** Universal-model identities, denormalized for record/work-item timelines. */
    recordId: text('record_id'),
    workflowItemId: text('workflow_item_id'),
    workflowId: text('workflow_id'),
    runId: text('run_id'),
    jobId: text('job_id'),
    fileId: text('file_id'),
    approvalId: text('approval_id'),
    summary: text('summary'),
    /** Redacted structured detail; never contains secret plaintext. */
    data: json<unknown>('data'),
    occurredAt: integer('occurred_at').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('audit_events_id_unique').on(table.id),
    index('audit_events_record_idx').on(table.workspaceId, table.recordId, table.seq),
    index('audit_events_workflow_item_idx').on(table.workspaceId, table.workflowItemId, table.seq),
    index('audit_events_action_idx').on(table.workspaceId, table.action, table.seq),
    index('audit_events_entity_idx').on(table.workspaceId, table.entityType, table.entityId),
    index('audit_events_workspace_idx').on(table.workspaceId, table.seq),
    index('audit_events_run_idx').on(table.runId, table.seq),
    index('audit_events_file_idx').on(table.workspaceId, table.fileId, table.seq)
  ]
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
