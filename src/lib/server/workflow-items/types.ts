/**
 * WorkflowItem vocabulary (ADR-0021).
 *
 * A WorkflowItem is a Record's participation in one Workflow. The UI may call it a
 * "Ticket" when the workflow processes the Ticket Object Type, but the model never
 * assumes that.
 */
import type { ParticipationKind, WorkflowItemProvenance, WorkRelationshipType } from '../db/schema';
import type { CreateRecordInput } from '../records/service';

export type { WorkflowItemWait } from '../db/schema';
export type { ParticipationKind, WorkflowItemProvenance, WorkRelationshipType };

export const WORK_RELATIONSHIP_TYPES: WorkRelationshipType[] = [
  'parent',
  'child',
  'related',
  'duplicate',
  'blocks',
  'blocked_by'
];

/**
 * One recorded change to a field value (base or workflow overlay). Owned here
 * because the ticket field engine that defined it has been removed (ADR-0021).
 */
export interface FieldChange {
  fieldDefinitionId: string;
  key: string;
  name: string;
  previous: unknown;
  next: unknown;
}

export interface WorkflowItemSummary {
  id: string;
  workflowId: string;
  recordId: string;
  stateId: string;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  participation: ParticipationKind;
  version: number;
  waitingOn: string | null;
  enteredStateAt: number;
  lastActivityAt: number;
  completedAt: number | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkflowItemInput {
  workflowId: string;
  /** Existing record to put into the workflow. */
  recordId?: string | null;
  /** Or create a Record inline (UX/API convenience; atomic in one transaction). */
  record?: CreateRecordInput | null;
  stateId?: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  fields?: Record<string, unknown>;
  structuredData?: Record<string, unknown>;
  participation?: ParticipationKind;
  sourceWorkflowItemId?: string | null;
  originWorkflowItemId?: string | null;
  provenance?: WorkflowItemProvenance | null;
  /** Human-readable reason recorded on the initial state interval / move. */
  reason?: string | null;
  /** Suppress the destination-state dispatch (used when the caller owns it). */
  deferExecution?: boolean;
}

export interface WorkflowItemTransitionView {
  id: string;
  name: string;
  toStateId: string;
  toStateName: string;
  requiresComment: boolean;
  requiredFieldKeys: string[];
}

export interface WorkflowItemDetail extends WorkflowItemSummary {
  record: {
    id: string;
    displayName: string;
    key: string | null;
    number: number | null;
    objectTypeId: string;
    objectTypeKey: string;
    objectTypeName: string;
  };
  workflow: { id: string; name: string; key: string };
  state: {
    id: string;
    name: string;
    kind: string;
    category: string;
    isTerminal: boolean;
  };
  fields: Record<string, unknown>;
  availableTransitions: WorkflowItemTransitionView[];
  notes: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    authorLabel: string | null;
    body: string;
    createdAt: number;
    editedAt: number | null;
  }>;
  stateHistory: Array<{
    id: string;
    stateId: string;
    stateName: string;
    enteredAt: number;
    exitedAt: number | null;
    durationMs: number | null;
    enteredByLabel: string | null;
    reason: string | null;
  }>;
}
