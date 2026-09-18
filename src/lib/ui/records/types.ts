/**
 * UI types for the universal Record / WorkflowItem model (ADR-0021).
 *
 * These mirror the server response shapes in `records/query.ts`,
 * `records/service.ts` and `workflow-items/*`; they are intentionally separate
 * from the legacy collection `RecordPage` types in `$ui/types`.
 */
import type { FieldOptions, FieldType } from '$ui/work/types';

export interface ObjectTypeSummary {
  id: string;
  key: string;
  name: string;
  pluralName: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
  position: number;
  settings: Record<string, unknown>;
  fieldCount: number;
  recordCount: number;
}

export interface ObjectTypeFieldView {
  bindingId: string;
  fieldDefinitionId: string;
  key: string;
  name: string;
  description: string | null;
  type: FieldType;
  options: FieldOptions | null;
  validation: Record<string, unknown> | null;
  display: Record<string, unknown> | null;
  required: boolean;
  isIdentity: boolean;
  isPrimaryDisplay: boolean;
  isSecondaryDisplay: boolean;
  showInList: boolean;
  showOnCard: boolean;
  filterable: boolean;
  position: number;
  defaultValue: unknown;
}

export interface EffectiveField extends ObjectTypeFieldView {
  source: 'base' | 'workflow';
}

export interface RecordListRow {
  id: string;
  objectTypeId: string;
  displayName: string;
  key: string | null;
  number: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  fields: Record<string, unknown>;
}

export interface RecordListPage {
  rows: RecordListRow[];
  nextCursor: string | null;
  total: number;
  unresolved: string[];
}

export interface RecordSummary {
  id: string;
  objectTypeId: string;
  objectTypeKey: string;
  objectTypeName: string;
  displayName: string;
  key: string | null;
  number: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface RecordNoteView {
  id: string;
  authorType: string;
  authorId: string | null;
  authorLabel: string | null;
  body: string;
  createdAt: number;
  editedAt: number | null;
}

export interface RecordExternalIdView {
  id: string;
  system: string;
  externalId: string;
  label: string | null;
  url: string | null;
}

export interface RecordDetail extends RecordSummary {
  fields: Record<string, unknown>;
  effectiveFields: EffectiveField[];
  externalIds: RecordExternalIdView[];
  notes: RecordNoteView[];
  structuredData: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
}

export interface RecordFieldHistoryEntry {
  id: string;
  fieldDefinitionId: string;
  fieldKey: string;
  fieldName: string;
  previousValue: unknown;
  newValue: unknown;
  actorType: string;
  actorLabel: string | null;
  runId: string | null;
  source: string | null;
  createdAt: number;
}

export interface RelatedRecordView {
  relationshipId: string;
  direction: 'outgoing' | 'incoming';
  definitionId: string;
  definitionKey: string;
  label: string;
  note: string | null;
  record: { id: string; displayName: string; objectTypeId: string; key: string | null };
  createdAt: number;
}

export interface RecordFileView {
  id: string;
  fileId: string;
  relationship: string;
  caption: string | null;
  filename: string;
  mimeType: string;
  size: number;
  status: string;
  summary: string | null;
  createdAt: number;
}

export interface WorkflowItemListRow {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowKey: string;
  recordId: string;
  recordDisplayName: string;
  recordKey: string | null;
  objectTypeId: string;
  stateId: string;
  stateName: string;
  stateKind: string;
  stateCategory: string;
  ownerUserId: string | null;
  ownerName: string | null;
  waitingOn: string | null;
  participation: string;
  enteredStateAt: number;
  updatedAt: number;
  completedAt: number | null;
}
