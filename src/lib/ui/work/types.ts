/**
 * Wire types for the core work surfaces.
 *
 * These mirror exactly what the API returns (raw camelCase rows, epoch-ms
 * timestamps, JSON configs that may be null). They are declared here — never in a
 * component — so the board, list, drawer and configuration tabs cannot drift apart
 * in their understanding of a ticket or a state.
 */

/* ------------------------------------------------------------------ filters */

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_true'
  | 'is_false'
  | 'before'
  | 'after'
  | 'within_last_days'
  | 'not_within_last_days';

export type FilterFieldKind =
  | 'system'
  | 'field'
  | 'file_field'
  | 'state'
  | 'workflow'
  | 'label'
  | 'owner'
  | 'team'
  | 'run'
  | 'approval'
  | 'file'
  | 'collection';

export interface FilterCondition {
  type: 'condition';
  kind: FilterFieldKind;
  key: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  type: 'group';
  op: 'and' | 'or';
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterCondition;
export type FilterAst = FilterNode;

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

/* ----------------------------------------------------------------- fields */

export type FieldType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'user'
  | 'team'
  | 'url'
  | 'email'
  | 'phone'
  | 'json';

export interface FieldChoice {
  value: string;
  label: string;
  color?: string;
}

export interface FieldOptions {
  choices?: FieldChoice[];
  currency?: string;
  precision?: number;
  rows?: number;
}

export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
}

export interface FieldDisplay {
  format?: string;
  width?: 'compact' | 'normal' | 'wide';
  placeholder?: string;
  prefix?: string;
  suffix?: string;
}

export interface FieldDefinition {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  type: FieldType;
  scope: 'ticket' | 'file';
  options: FieldOptions | null;
  defaultValue: unknown;
  validation: FieldValidation | null;
  display: FieldDisplay | null;
  isSystem: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface WorkflowFieldView {
  id: string;
  workspaceId: string;
  workflowId: string;
  fieldDefinitionId: string;
  position: number;
  required: boolean;
  visible: boolean;
  editable: boolean;
  defaultValue: unknown;
  requiredInStates: string[] | null;
  showOnCard: boolean;
  showInList: boolean;
  filterable: boolean;
  requiredForTransfer: boolean;
  createdAt: number;
  updatedAt: number;
  definition: FieldDefinition;
}

/** The configuration half of `GET /api/tickets/:id/fields`. */
export interface TicketFieldConfig {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  editable: boolean;
  visible: boolean;
  showOnCard: boolean;
  showInList: boolean;
  requiredInStates: string[] | null;
  options: FieldOptions | null;
}

/* ---------------------------------------------------------------- workflow */

export interface TransferSettings {
  allowedTargetWorkflowIds?: string[];
  defaultTargetStateId?: string;
  allowAgents: boolean;
  allowHumans: boolean;
  requiresApproval: boolean;
  requiredFieldKeys?: string[];
}

export interface WorkflowSettings {
  transfer?: TransferSettings;
  defaultTimezone?: string;
  allowAgentTicketCreation?: boolean;
  allowHumanTicketCreation?: boolean;
  requiresApprovalToClose?: boolean;
}

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  defaultStateId: string | null;
  settings: WorkflowSettings | null;
  position: number;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type WorkflowListItem = Workflow & { stateCount: number; ticketCount: number };

export interface WorkflowTemplate {
  key: 'blank' | 'basic' | 'intake' | 'claims' | 'support';
  label: string;
  description: string;
  stateCount: number;
}

export type StateKind = 'manual' | 'agent' | 'system' | 'terminal';
export type StateCategory = 'backlog' | 'active' | 'review' | 'done' | 'cancelled';

export interface HumanGateConfig {
  enabled: boolean;
  allowedTransitionIds?: string[];
  requiredFieldKeys?: string[];
  requiredComment?: boolean;
  allowedRoles?: Array<'owner' | 'admin' | 'member'>;
  allowedTeamIds?: string[];
  instructions?: string;
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
}

export type SystemAction =
  | { type: 'transition'; targetStateId?: string }
  | { type: 'setFields'; values: Record<string, unknown> }
  | { type: 'emitEvent'; name: string }
  | { type: 'createTicket'; workflowId: string; titleTemplate: string }
  | { type: 'http'; operationId: string }
  | { type: 'wait'; seconds: number };

export interface StateConfig {
  systemAction?: SystemAction;
  context?: AgentContextConfig;
  allowedToolKeys?: string[];
  runOncePerEntry?: boolean;
  wipLimit?: number;
  slaSeconds?: number;
}

export interface WorkflowState {
  id: string;
  workspaceId: string;
  workflowId: string;
  name: string;
  description: string | null;
  kind: StateKind;
  category: StateCategory;
  color: string | null;
  position: number;
  isStart: boolean;
  isTerminal: boolean;
  agentId: string | null;
  agentVersionId: string | null;
  autoExecute: boolean;
  maxAttempts: number;
  timeoutSeconds: number | null;
  failureStateId: string | null;
  humanGate: HumanGateConfig | null;
  config: StateConfig | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowTransition {
  id: string;
  workspaceId: string;
  workflowId: string;
  fromStateId: string | null;
  toStateId: string;
  name: string;
  description: string | null;
  position: number;
  requiresComment: boolean;
  requiredFieldKeys: string[] | null;
  allowedRoles: string[] | null;
  condition: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowTransferRule {
  id: string;
  workspaceId: string;
  sourceWorkflowId: string;
  targetWorkflowId: string;
  defaultTargetStateId: string | null;
  fieldMappings: Record<string, string> | null;
  requiredTargetFieldKeys: string[] | null;
  allowAgents: boolean;
  allowHumans: boolean;
  requiresApproval: boolean;
  carryLabels: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowDetailResponse {
  workflow: Workflow;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  transferRules: WorkflowTransferRule[];
}

/* ------------------------------------------------------------------ tickets */

export type TicketPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface TicketProvenance {
  sourceType?: string;
  sourceReference?: string;
  sourceLabel?: string;
  triggerId?: string;
  triggerEventId?: string;
  externalRef?: string;
  ingestedAt?: number;
}

export interface TicketLabelRef {
  id: string;
  name: string;
  color: string | null;
}

export interface Ticket {
  id: string;
  workspaceId: string;
  workflowId: string;
  stateId: string;
  key: string;
  number: number;
  title: string;
  description: string | null;
  priority: TicketPriority;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  structuredData: Record<string, unknown> | null;
  version: number;
  originTicketId: string | null;
  createdByType: string;
  createdById: string | null;
  createdByLabel: string | null;
  provenance: TicketProvenance | null;
  enteredStateAt: number;
  lastActivityAt: number;
  dueAt: number | null;
  slaDueAt: number | null;
  closedAt: number | null;
  stateRunCount: number;
  waitingOn: 'human' | 'agent' | 'approval' | 'trigger' | 'none' | null;
  createdAt: number;
  updatedAt: number;
}

export interface TicketListRow {
  ticket: Ticket;
  stateName: string;
  stateKind: string;
  stateCategory: string;
  ownerName: string | null;
  labels: TicketLabelRef[];
  fields: Record<string, unknown>;
}

export interface TicketPage {
  rows: TicketListRow[];
  nextCursor: string | null;
  total: number;
}

export interface AvailableTransition {
  id: string;
  name: string;
  toStateId: string;
  toStateName: string;
  requiresComment: boolean;
  requiredFieldKeys: string[];
  allowed: boolean;
  reason?: string;
}

export interface GateDecision {
  id: string;
  outcome: string;
  comment: string | null;
  decidedByLabel: string | null;
  createdAt: number;
}

export interface TicketFileLink {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  status: string;
  relationship: string;
}

export interface TicketRunSummary {
  id: string;
  status: string;
  agentId: string;
  modelKey: string | null;
  attempt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface TicketApprovalSummary {
  id: string;
  kind: string;
  title: string;
  status: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface TicketRelationshipView {
  id: string;
  type: string;
  direction: 'outgoing' | 'incoming';
  ticket: { id: string; key: string; title: string; stateId: string; stateName: string | null };
  createdAt: number;
}

export interface TicketNoteView {
  id: string;
  authorType: string;
  authorId: string | null;
  authorLabel: string | null;
  body: string;
  isSystem: boolean;
  createdAt: number;
  editedAt: number | null;
}

export interface TicketDetail {
  ticket: Ticket;
  key: string;
  state: WorkflowState;
  workflow: { id: string; name: string; key: string };
  fields: Record<string, unknown>;
  labels: TicketLabelRef[];
  notes: TicketNoteView[];
  relationships: TicketRelationshipView[];
  files: TicketFileLink[];
  runs: TicketRunSummary[];
  approvals: TicketApprovalSummary[];
  availableTransitions: AvailableTransition[];
  humanGate: HumanGateConfig | null;
  gateDecisions: GateDecision[];
  historySummary: {
    created: number;
    lastActivityAt: number;
    stateEntries: number;
    transfers: number;
  };
}

export interface TicketFieldValuesResponse {
  fields: Record<string, unknown>;
  config: TicketFieldConfig[];
}

export interface TransferPreview {
  policy: {
    allowed: boolean;
    requiresApproval: boolean;
    reason?: string;
    rule: WorkflowTransferRule | null;
  };
  targetWorkflow: { id: string; name: string; key: string; states: WorkflowState[] };
  defaultTargetStateId: string | null;
  compatible: string[];
  mapped: Array<{ source: string; target: string }>;
  destinationRequired: Array<{ key: string; name: string; satisfied: boolean }>;
  sourceOnly: string[];
}

/* --------------------------------------------------------------------- runs */

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval'
  | 'skipped';

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costCents?: number;
  durationMs?: number;
}

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

export interface AgentRun {
  id: string;
  workspaceId: string;
  ticketId: string | null;
  workflowId: string;
  stateId: string;
  agentId: string;
  agentVersionId: string;
  agentVersion: number;
  providerId: string | null;
  providerType: string | null;
  modelId: string | null;
  modelKey: string | null;
  status: AgentRunStatus;
  attempt: number;
  jobId: string | null;
  triggerType: string;
  triggerId: string | null;
  inputSnapshot: unknown;
  contextConfig: unknown;
  promptVersion: string | null;
  output: unknown;
  outputText: string | null;
  usage: RunUsage | null;
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'stored' | null;
  requestedTransitionId: string | null;
  appliedTransitionId: string | null;
  error: string | null;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunStep {
  id: string;
  workspaceId: string;
  runId: string;
  index: number;
  type: RunStepType;
  name: string | null;
  status: 'started' | 'completed' | 'failed';
  input: unknown;
  output: unknown;
  error: string | null;
  toolId: string | null;
  toolKey: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
}

export interface RunDetail {
  run: AgentRun;
  steps: AgentRunStep[];
  agent: { id: string; name: string } | null;
  agentSnapshot: unknown;
  approvals: ApprovalRequest[];
}

/* -------------------------------------------------------------------- events */

export interface WorkEvent {
  seq: number;
  type: string;
  runId: string | null;
  ticketId: string | null;
  data: unknown;
  createdAt: number;
}

/* ----------------------------------------------------------------- approvals */

export type ApprovalKind = 'state_transition' | 'tool_call' | 'transfer' | 'ticket_creation';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  ticketId: string | null;
  workflowId: string | null;
  runId: string | null;
  stepId: string | null;
  jobId: string | null;
  kind: ApprovalKind;
  title: string;
  description: string | null;
  requestedAction: Record<string, unknown>;
  contextSnapshot: unknown;
  requestedByType: string;
  requestedById: string | null;
  requestedByLabel: string | null;
  status: ApprovalStatus;
  reviewerUserId: string | null;
  reviewerTeamId: string | null;
  decidedByUserId: string | null;
  decidedByLabel: string | null;
  decisionComment: string | null;
  decision: Record<string, unknown> | null;
  resumeToken: string | null;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number | null;
}

export interface ApprovalView extends ApprovalRequest {
  ticketKey: string | null;
  ticketTitle: string | null;
  runStatus: string | null;
}

/* --------------------------------------------------------------- saved views */

export interface SavedView {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  scope: 'tickets' | 'files';
  workflowId: string | null;
  filterAst: FilterAst | null;
  sort: SortSpec[] | null;
  columns: string[] | null;
  isShared: boolean;
  isPinned: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppliedSavedView {
  id: string;
  name: string;
  scope: 'tickets' | 'files';
  workflowId: string | null;
  filter: FilterAst | null;
  sort: SortSpec[];
  columns: string[];
}

/* ------------------------------------------------------- data / state / files */

export interface CollectionView {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  key: string;
  name: string;
  description: string | null;
  schema: Record<string, unknown> | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CollectionRecordView {
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

export interface StateEntryView {
  id: string;
  workspaceId: string;
  scope: string;
  workflowId: string | null;
  ticketId: string | null;
  agentId: string | null;
  runId: string | null;
  namespace: string;
  key: string;
  value: unknown;
  version: number;
  expiresAt: number | null;
  createdByType: string | null;
  createdById: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FileSummaryView {
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

/* ------------------------------------------------------- resources / people */

export interface AgentOption {
  id: string;
  name: string;
  description: string | null;
  workflowId: string | null;
  archivedAt: number | null;
}

export interface MemberOption {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  status: string;
  title: string | null;
  createdAt: number;
}

export interface TeamOption {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  color: string | null;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Label {
  id: string;
  workspaceId: string;
  name: string;
  color: string | null;
  description: string | null;
  ticketCount?: number;
  createdAt: number;
  updatedAt: number;
}

/* ----------------------------------------------------------------- timeline */

export interface AuditEventView {
  seq: number;
  id: string;
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
  data: unknown;
  occurredAt: number;
  createdAt: number;
}

export type TimelineFilter = 'all' | 'human' | 'agents' | 'fields' | 'states' | 'tools' | 'files';

/* ------------------------------------------------------------ my work views */

/** A column in the dense ticket table; `field:<key>` keys render a typed field. */
export interface TicketColumn {
  key: string;
  label: string;
  type?: FieldType;
  options?: FieldOptions | null;
  sortable?: boolean;
  width?: string;
}

export interface MyWorkResponse {
  assigned: TicketListRow[];
  waitingForMe: TicketListRow[];
  waitingForAgent: TicketListRow[];
  waitingForApproval: TicketListRow[];
  needsAttention: TicketListRow[];
  createdByMe: TicketListRow[];
}

export type MyWorkBucket = keyof MyWorkResponse;
