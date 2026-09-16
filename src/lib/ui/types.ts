/**
 * Wire types for the surfaces this workstream owns: files, analytics, settings
 * and workspace data.
 *
 * The API is the contract, and these interfaces mirror exactly what the handlers
 * in `$server/api/handlers` serialize. They are deliberately *not* generated: the
 * server's Drizzle row types carry columns the API never returns (soft-delete
 * markers, storage keys, ciphertext columns), and reusing them here would let a
 * screen render a field it is not allowed to see. Mirroring keeps the security
 * boundary explicit.
 *
 * Everything is optional-tolerant on the read side: a field a future server adds
 * is ignored, and a field that disappears shows as `undefined` rather than
 * crashing a render.
 */

// --------------------------------------------------------------------- files

export type FileStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'quarantined';
export type FileKind = 'upload' | 'generated' | 'external';
export type FileSourceType =
  | 'human_upload'
  | 'incoming_email'
  | 'incoming_message'
  | 'webhook'
  | 'agent_run'
  | 'http_connector'
  | 'api'
  | 'system';

export type TicketFileRelationship = 'attachment' | 'reference' | 'output' | 'evidence';

export const FILE_STATUSES: readonly FileStatus[] = [
  'pending',
  'processing',
  'ready',
  'failed',
  'quarantined'
];

export const FILE_SOURCE_TYPES: readonly FileSourceType[] = [
  'human_upload',
  'incoming_email',
  'incoming_message',
  'webhook',
  'agent_run',
  'http_connector',
  'api',
  'system'
];

export const TICKET_FILE_RELATIONSHIPS: readonly TicketFileRelationship[] = [
  'attachment',
  'reference',
  'output',
  'evidence'
];

/** `GET /api/files` and `GET /api/files/:id` — the shared file projection. */
export interface FileSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  status: string;
  summary: string | null;
  contentHash: string;
  createdAt: number;
  provenance: { sourceType: string; sourceLabel: string | null } | null;
  workflowIds: string[];
  ticketIds: string[];
}

export interface WorkflowContext {
  workflowId: string;
  contextLabel: string | null;
}

/**
 * One typed value from `file_field_values` joined to its definition. The server
 * returns the raw join row, so every typed column is present and exactly one is
 * meaningful; `readFieldValue` in `$ui/files/fields` does that normalization.
 */
export interface FileFieldValueRow {
  id: string;
  file_id: string;
  workflow_id: string | null;
  field_definition_id: string;
  key: string;
  name: string;
  type: string;
  options: Record<string, unknown> | null;
  value_text?: string | null;
  value_number?: number | null;
  value_date?: number | null;
  value_bool?: boolean | number | null;
  value_json?: unknown;
  confidence?: number | null;
  source_page?: number | null;
  source_span?: string | null;
  source?: string | null;
  updated_at?: number | null;
  created_at?: number | null;
}

export interface ExtractedContent {
  id: string;
  content_kind: string;
  text: string;
  char_count: number;
  page_count: number | null;
  language: string | null;
  segments: Array<{ page?: number; span?: string; text: string }> | null;
  truncated: boolean;
  created_at: number;
}

export interface ContentResponse {
  content: ExtractedContent | null;
  pending: boolean;
}

export interface ContentSearchHit {
  fileId: string;
  filename: string;
  snippet: string;
  pageCount: number | null;
}

export interface UploadResult {
  fileId: string;
  blobId: string;
  contentHash: string;
  size: number;
  /** True when the bytes already existed for this workspace. */
  deduplicated: boolean;
  /** True when a logical file row was reused rather than created. */
  reusedFile: boolean;
  processingQueued: boolean;
}

// --------------------------------------------------------------- saved views

export type ViewScope = 'tickets' | 'files';

export interface SavedView {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  scope: ViewScope;
  workflowId: string | null;
  filterAst: unknown;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }> | null;
  columns: string[] | null;
  isShared: boolean;
  isPinned: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/views/:id/apply` — a saved view resolved into runnable inputs. */
export interface AppliedSavedView {
  view: SavedView;
  filter: unknown;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }> | null;
  columns: string[] | null;
}

// --------------------------------------------------------------- dashboards

export type WidgetType =
  | 'kpi'
  | 'number'
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'table'
  | 'funnel'
  | 'aging';

export const WIDGET_TYPES: readonly WidgetType[] = [
  'kpi',
  'number',
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'table',
  'funnel',
  'aging'
];

export type WidgetAggregation =
  | 'count'
  | 'sum'
  | 'avg'
  | 'median'
  | 'min'
  | 'max'
  | 'conversion'
  | 'duration';

export type WidgetGroupingBy =
  | 'none'
  | 'state'
  | 'priority'
  | 'owner'
  | 'team'
  | 'label'
  | 'workflow'
  | 'field'
  | 'day'
  | 'week'
  | 'month';

export type WidgetDataSourceKind = 'tickets' | 'state_history' | 'field_history' | 'runs' | 'files';

export interface FunnelStageDefinition {
  label: string;
  stateIds?: string[];
  fieldKey?: string;
  fieldValue?: unknown;
}

export interface WidgetDataSource {
  kind: WidgetDataSourceKind;
  workflowIds?: string[];
  funnelStages?: FunnelStageDefinition[];
  agingStates?: string[];
}

export interface WidgetMeasure {
  aggregation: WidgetAggregation;
  fieldKey?: string | null;
  durationOf?: 'time_in_state' | 'cycle_time' | 'time_to_state';
}

export interface WidgetGrouping {
  by: WidgetGroupingBy;
  fieldKey?: string;
  limit?: number;
}

export interface WidgetTimeRange {
  kind: 'relative' | 'absolute' | 'all';
  lastDays?: number;
  from?: number;
  to?: number;
  basis?: 'created' | 'updated' | 'entered_state';
}

export interface WidgetVisualization {
  color?: string;
  showLegend?: boolean;
  showValues?: boolean;
  stacked?: boolean;
  valueFormat?: 'number' | 'currency' | 'percent' | 'duration';
  currency?: string;
}

export interface DashboardWidget {
  id: string;
  workspaceId: string;
  dashboardId: string;
  title: string;
  description: string | null;
  type: WidgetType;
  position: number;
  size: 'sm' | 'md' | 'lg' | 'full';
  dataSource: WidgetDataSource;
  filter: unknown;
  measure: WidgetMeasure;
  grouping: WidgetGrouping | null;
  timeRange: WidgetTimeRange | null;
  visualization: WidgetVisualization | null;
  savedViewId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Dashboard {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  globalFilters: unknown;
  layout: Array<{ widgetId: string; x: number; y: number; w: number; h: number }> | null;
  isDefault: boolean;
  isShared: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardDetail extends Dashboard {
  widgets: DashboardWidget[];
  globalFilter: unknown;
}

export interface WidgetRow {
  key: string | null;
  label: string | null;
  bucket?: string;
  value: number;
}

export interface WidgetSeriesPoint {
  label: string;
  bucket?: string;
  value: number;
}

export interface WidgetMeta {
  dataSource: WidgetDataSourceKind;
  measure: WidgetMeasure;
  grouping: WidgetGroupingBy;
  timeRange: WidgetTimeRange;
  basis: 'created' | 'updated' | 'entered_state';
  from: number | null;
  to: number | null;
  filter: string;
  unresolved: string[];
  note?: string;
}

export interface WidgetResult {
  kind: WidgetType;
  value?: number | null;
  series?: WidgetSeriesPoint[];
  rows?: WidgetRow[];
  grouping: WidgetGroupingBy;
  meta: WidgetMeta;
}

export interface DashboardRunResult {
  dashboard: Dashboard;
  globalFilter: unknown;
  results: Record<string, WidgetResult>;
}

// ----------------------------------------------------------------- settings

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  settings: WorkspaceSettings | null;
  storageProvider: 'local' | 'gcs';
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface WorkspaceSettings {
  defaultTimezone?: string;
  retentionDays?: number;
  allowAgentTicketCreation?: boolean;
  allowAgentTransfer?: boolean;
  dailyRunLimit?: number;
  branding?: { accent?: string; logoUrl?: string };
}

export interface WorkspaceMember {
  memberId: string;
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  status: string;
  title: string | null;
  createdAt: number;
}

export interface TeamRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: number;
  updatedAt: number;
  memberIds: string[];
}

export interface SecretRecord {
  id: string;
  workspaceId: string;
  scope: 'workspace' | 'workflow';
  workflowId: string | null;
  key: string;
  name: string;
  description: string | null;
  lastFour: string | null;
  valueLength: number | null;
  version: number;
  bindingMode: string;
  sourceSecretId: string | null;
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
  hasWorkflowOverride: boolean;
}

export type EnvironmentProvenance = 'inherited' | 'overridden' | 'local';

export interface EffectiveEnvironmentEntry {
  key: string;
  value: string | null;
  isSecret: boolean;
  secretId: string | null;
  lastFour: string | null;
  source: 'workspace' | 'workflow' | 'default';
  state: EnvironmentProvenance;
  workspaceVariableId: string | null;
  workflowVariableId: string | null;
}

export type BindableResourceType =
  | 'agent'
  | 'skill'
  | 'tool'
  | 'http_service'
  | 'http_operation'
  | 'field_definition'
  | 'collection'
  | 'provider'
  | 'model'
  | 'secret'
  | 'environment_variable';

export type BindingMode = 'use_asis' | 'override' | 'fork';

export interface BindingResolution {
  workflowId: string;
  resourceType: BindableResourceType;
  resourceId: string;
  mode: BindingMode;
  sourceResourceId: string | null;
  overriddenFields: string[];
  inherited: boolean;
  local: boolean;
  forked: boolean;
  exists: boolean;
}

export interface EffectiveConfigurationGroup {
  resourceType: BindableResourceType;
  counts: { inherited: number; overridden: number; local: number; forked: number };
  bindings: BindingResolution[];
}

export interface EffectiveConfiguration {
  workspaceId: string;
  workflowId: string;
  groups: EffectiveConfigurationGroup[];
  totals: { inherited: number; overridden: number; local: number; forked: number };
}

export interface OverrideRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  resourceType: BindableResourceType;
  resourceId: string;
  sourceResourceId: string | null;
  mode: BindingMode;
  overriddenFields: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StorageConfig {
  id: string | null;
  workspaceId: string;
  provider: 'local' | 'gcs';
  bucket: string | null;
  prefix: string | null;
  credentialsSecretId: string | null;
  credentialsLastFour: string | null;
  localRoot: string | null;
  maxFileBytes: number;
  isDefault: boolean;
  createdAt: number | null;
  updatedAt: number | null;
}

export type JobStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'dead' | 'cancelled';

export interface JobRecord {
  id: string;
  workspaceId: string;
  type: string;
  queue: string;
  payload: unknown;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leasedAt: number | null;
  leasedBy: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  result: unknown;
  timeoutSeconds: number | null;
  dedupeKey: string | null;
  idempotencyKey: string | null;
  ticketId: string | null;
  runId: string | null;
  parentJobId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface JobAttempt {
  id: string;
  workspaceId: string;
  jobId: string;
  attempt: number;
  workerId: string;
  status: 'started' | 'succeeded' | 'failed' | 'lease_expired';
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
  errorCode: string | null;
}

export interface AuditEventRecord {
  seq: number;
  workspaceId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  entityType: string | null;
  entityId: string | null;
  ticketId: string | null;
  workflowId: string | null;
  runId: string | null;
  jobId: string | null;
  fileId: string | null;
  approvalId: string | null;
  summary: string | null;
  /** Already redacted by the ledger before it was persisted. */
  data: unknown;
  occurredAt: number;
  createdAt: number;
}

// -------------------------------------------------------------- collections

export interface CollectionSchemaProperty {
  type?: string;
  required?: boolean;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface CollectionSchema {
  type?: string;
  properties?: Record<string, CollectionSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface CollectionRecord {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  key: string;
  name: string;
  description: string | null;
  schema: CollectionSchema | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CollectionDocument {
  id: string;
  workspaceId: string;
  collectionId: string;
  externalKey: string | null;
  data: Record<string, unknown>;
  searchText: string;
  version: number;
  createdByType: string | null;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RecordPage {
  records: CollectionDocument[];
  nextCursor: string | null;
  truncated: boolean;
}

// ------------------------------------------------------------ state / cache

export type StateScope = 'workspace' | 'workflow' | 'ticket' | 'agent' | 'run';

export interface StateEntry {
  id: string;
  workspaceId: string;
  scope: StateScope;
  workflowId: string | null;
  ticketId: string | null;
  agentId: string | null;
  runId: string | null;
  namespace: string;
  key: string;
  value: unknown;
  version: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CacheEntry {
  id: string;
  key: string;
  namespace: string;
  authScope: string;
  sizeBytes: number;
  hits: number;
  tags: string[];
  expiresAt: number | null;
  storedAt: number;
  ageMs: number;
  expired: boolean;
  value?: unknown;
}

export interface CacheStatsView {
  entries: number;
  bytes: number;
  expiringSoon: number;
  expired: number;
  hits: number;
  misses: number;
  namespaces: number;
}

// ------------------------------------------------------------------ shared

export interface WorkflowSummary {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  stateCount: number;
  ticketCount: number;
}

export interface WorkflowStateRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  name: string;
  category: string | null;
  kind: string;
  position: number;
  isStart: boolean;
  isTerminal: boolean;
  color: string | null;
}

export interface TicketSummary {
  id: string;
  key: string;
  title: string;
  workflowId: string;
  stateId: string | null;
  priority: string | null;
}

/** `GET /api/tickets/:id` — the fields the Files detail Relationships tab reads. */
export interface TicketDetailView {
  ticket: {
    id: string;
    key: string;
    title: string;
    workflowId: string;
    stateId: string | null;
    priority: string | null;
    ownerUserId: string | null;
  };
  key: string;
  state: { id: string; name: string; kind: string } | null;
  workflow: { id: string; name: string; key: string };
}

export interface TicketFileLink {
  ticketId: string;
  relationship: string;
  caption: string | null;
  createdAt: number | null;
}

/** A page of results plus the cursor the server reported. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
