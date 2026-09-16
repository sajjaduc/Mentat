/**
 * First-class files backed by content-addressed blobs.
 *
 * The model is `Blob ← File`, never `Ticket → attachment blob` (ADR-0009):
 *
 *   - a `blobs` row is the *bytes*: SHA-256 content hash, size, MIME and the
 *     storage key inside a BlobStore. One row per unique byte sequence per
 *     workspace, which is what makes dedupe safe and tenant-scoped.
 *   - a `files` row is a *logical* document: original filename, provenance,
 *     summary, extracted content and file-field values. The same blob can back
 *     several file rows when distinct provenance requires it, while byte storage
 *     stays deduplicated.
 *
 * Blob dedupe is explicitly NOT processing dedupe: `file_processing_runs.processingKey`
 * captures `contentHash + processorType + processorVersion + configurationFingerprint`
 * so improved parsers/prompts/schemas re-process the same bytes (ADR-0010).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import type { ActorType } from './fields';
import { workspaces } from './tenancy';
import { tickets } from './tickets';
import { workflows } from './workflows';

export type BlobStorageProvider = 'local' | 'gcs';

export const blobs = sqliteTable(
  'blobs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** SHA-256 over the actual bytes, lowercase hex. */
    contentHash: text('content_hash').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    storageProvider: text('storage_provider').$type<BlobStorageProvider>().notNull(),
    storageKey: text('storage_key').notNull(),
    /** Populated once a stored object is confirmed present/readable. */
    verifiedAt: epochMs('verified_at'),
    /** Set when retention policy allows the physical object to be reclaimed. */
    orphanedAt: epochMs('orphaned_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    // Tenant-scoped uniqueness: hash equality must never reveal that another
    // workspace possesses the same bytes.
    uniqueIndex('blobs_workspace_hash_unique').on(table.workspaceId, table.contentHash),
    index('blobs_workspace_idx').on(table.workspaceId)
  ]
);

export type FileKind = 'upload' | 'generated' | 'external';
export type FileStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'quarantined';

export interface FileMetadata {
  pageCount?: number;
  language?: string;
  wordCount?: number;
  charCount?: number;
  detectedMime?: string;
  checksumVerified?: boolean;
  imageWidth?: number;
  imageHeight?: number;
  /** Anything a processor discovered that is generic rather than workflow-specific. */
  extra?: Record<string, unknown>;
}

export const files = sqliteTable(
  'files',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    blobId: text('blob_id')
      .notNull()
      .references(() => blobs.id, { onDelete: 'restrict' }),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    kind: text('kind').$type<FileKind>().notNull().default('upload'),
    status: text('status').$type<FileStatus>().notNull().default('pending'),
    /** Current human-editable summary; generated history lives in file_summaries. */
    summary: text('summary'),
    metadata: json<FileMetadata>('metadata'),
    /** Primary workflow context, when the file was ingested for one. */
    primaryWorkflowId: text('primary_workflow_id'),
    version: integer('version').notNull().default(1),
    createdByType: text('created_by_type').$type<ActorType>().notNull().default('user'),
    createdById: text('created_by_id'),
    createdByLabel: text('created_by_label'),
    runId: text('run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: epochMs('deleted_at')
  },
  (table) => [
    index('files_workspace_idx').on(table.workspaceId, table.deletedAt, table.createdAt),
    index('files_blob_idx').on(table.blobId),
    index('files_status_idx').on(table.workspaceId, table.status)
  ]
);

export type FileSourceType =
  | 'human_upload'
  | 'incoming_email'
  | 'incoming_message'
  | 'webhook'
  | 'agent_run'
  | 'http_connector'
  | 'api'
  | 'system';

/**
 * Provenance is preserved even when the underlying bytes were deduplicated: two
 * appearances of the same document remain two distinguishable events.
 */
export const fileSources = sqliteTable(
  'file_sources',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').$type<FileSourceType>().notNull(),
    /** External reference such as a message id, ticket key or URL. */
    sourceReference: text('source_reference'),
    sourceLabel: text('source_label'),
    actorType: text('actor_type').$type<ActorType>(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    runId: text('run_id'),
    toolCallId: text('tool_call_id'),
    triggerEventId: text('trigger_event_id'),
    ticketId: text('ticket_id'),
    /** True when ingestion reused an existing blob instead of storing new bytes. */
    deduplicated: bool('deduplicated'),
    /** SHA-256 of the incoming bytes, recorded even when a blob already existed. */
    observedContentHash: text('observed_content_hash'),
    detail: json<Record<string, unknown>>('detail'),
    occurredAt: integer('occurred_at').notNull(),
    createdAt: createdAt()
  },
  (table) => [
    index('file_sources_file_idx').on(table.workspaceId, table.fileId, table.createdAt),
    index('file_sources_type_idx').on(table.workspaceId, table.sourceType)
  ]
);

/**
 * A workflow's interpretation of a file. The same document may be a
 * `Policy Schedule` in Underwriting and `Evidence` in Compliance without one
 * interpretation overwriting the other.
 */
export const workflowFiles = sqliteTable(
  'workflow_files',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** Workflow-specific role, e.g. `Invoice`, `Evidence`, `Policy Schedule`. */
    contextLabel: text('context_label'),
    metadata: json<Record<string, unknown>>('metadata'),
    addedByType: text('added_by_type').$type<ActorType>(),
    addedById: text('added_by_id'),
    createdAt: createdAt(),
    removedAt: epochMs('removed_at')
  },
  (table) => [
    uniqueIndex('workflow_files_unique').on(table.workflowId, table.fileId),
    index('workflow_files_workflow_idx').on(table.workspaceId, table.workflowId, table.removedAt)
  ]
);

export type TicketFileRelationship = 'attachment' | 'reference' | 'output' | 'evidence';

/** Explicit many-to-many: one file may support many tickets and vice versa. */
export const ticketFiles = sqliteTable(
  'ticket_files',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    relationship: text('relationship')
      .$type<TicketFileRelationship>()
      .notNull()
      .default('attachment'),
    caption: text('caption'),
    addedByType: text('added_by_type').$type<ActorType>(),
    addedById: text('added_by_id'),
    addedByLabel: text('added_by_label'),
    runId: text('run_id'),
    createdAt: createdAt(),
    removedAt: epochMs('removed_at')
  },
  (table) => [
    uniqueIndex('ticket_files_unique').on(table.ticketId, table.fileId, table.relationship),
    index('ticket_files_ticket_idx').on(table.workspaceId, table.ticketId, table.removedAt),
    index('ticket_files_file_idx').on(table.workspaceId, table.fileId)
  ]
);

export type ProcessingStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

/**
 * One attempt to process a file. `processingKey` is the reuse identity:
 * `contentHash + processorType + processorVersion + configurationFingerprint`.
 */
export const fileProcessingRuns = sqliteTable(
  'file_processing_runs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    processorType: text('processor_type').notNull(),
    processorVersion: text('processor_version').notNull(),
    configurationFingerprint: text('configuration_fingerprint').notNull(),
    /** `contentHash + processor identity`; unique per file to guarantee reuse. */
    processingKey: text('processing_key').notNull(),
    status: text('status').$type<ProcessingStatus>().notNull().default('queued'),
    attempt: integer('attempt').notNull().default(1),
    jobId: text('job_id'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    resultSummary: text('result_summary'),
    error: text('error'),
    errorCode: text('error_code'),
    startedAt: epochMs('started_at'),
    finishedAt: epochMs('finished_at'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('file_processing_runs_key_unique').on(table.fileId, table.processingKey),
    index('file_processing_runs_file_idx').on(table.workspaceId, table.fileId, table.createdAt),
    index('file_processing_runs_status_idx').on(table.workspaceId, table.status)
  ]
);

/** Extracted content is persisted separately from raw bytes. */
export const fileExtractedContent = sqliteTable(
  'file_extracted_content',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    processingRunId: text('processing_run_id')
      .notNull()
      .references(() => fileProcessingRuns.id, { onDelete: 'cascade' }),
    contentKind: text('content_kind')
      .$type<'text' | 'markdown' | 'html' | 'json' | 'csv'>()
      .notNull()
      .default('text'),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull().default(0),
    pageCount: integer('page_count'),
    language: text('language'),
    /** Page/span segments so downstream tools can cite where content came from. */
    segments: json<Array<{ page?: number; span?: string; text: string }>>('segments'),
    truncated: bool('truncated'),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex('file_extracted_content_unique').on(table.processingRunId),
    index('file_extracted_content_file_idx').on(table.workspaceId, table.fileId)
  ]
);

export const fileSummaries = sqliteTable(
  'file_summaries',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    processingRunId: text('processing_run_id').references(() => fileProcessingRuns.id, {
      onDelete: 'set null'
    }),
    summary: text('summary').notNull(),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    isCurrent: bool('is_current', true),
    editedByType: text('edited_by_type').$type<ActorType>(),
    editedById: text('edited_by_id'),
    createdAt: createdAt()
  },
  (table) => [index('file_summaries_file_idx').on(table.workspaceId, table.fileId, table.createdAt)]
);

export type Blob = typeof blobs.$inferSelect;
export type NewBlob = typeof blobs.$inferInsert;
export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type FileSource = typeof fileSources.$inferSelect;
export type WorkflowFile = typeof workflowFiles.$inferSelect;
export type TicketFile = typeof ticketFiles.$inferSelect;
export type FileProcessingRun = typeof fileProcessingRuns.$inferSelect;
export type FileExtractedContent = typeof fileExtractedContent.$inferSelect;
export type FileSummary = typeof fileSummaries.$inferSelect;
