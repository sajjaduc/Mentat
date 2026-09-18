/**
 * Row helpers for the work surfaces.
 *
 * A board move and an inline create must both be visible before the server
 * answers, which means constructing a plausible `WorkItemListRow` locally and
 * rebuilding it from the response. Keeping that in one module stops the optimistic
 * shapes from drifting between the board, the list and My Work.
 *
 * The API exposes WorkflowItems backed by Records. The board and list responses are
 * flattened (`recordDisplayName`, `recordKey`, `stateName`, …) while the drawer
 * detail is nested (`record`, `state`). `normalizeWorkItemRow` bridges the two so a
 * component always sees the same `WorkItem` shape.
 */
import type {
  AvailableTransition,
  FieldType,
  WorkflowFieldView,
  WorkflowState,
  WorkItem,
  WorkItemApprovalSummary,
  WorkItemColumn,
  WorkItemDetail,
  WorkItemFileLink,
  WorkItemLabelRef,
  WorkItemListRow,
  WorkItemNoteView,
  WorkItemPriority,
  WorkItemRecordRef,
  WorkItemRelationshipView,
  WorkItemRunSummary
} from '$ui/work/types';

export interface BoardColumn {
  state: WorkflowState;
  items: WorkItemListRow[];
  count: number;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
};

/** The loose shape the board/list endpoints may return. */
export interface RawWorkItemRow {
  id?: string;
  workflowItemId?: string;
  workflowId?: string;
  recordId?: string;
  stateId?: string;
  record?: Partial<WorkItemRecordRef> | null;
  recordDisplayName?: string;
  recordKey?: string | null;
  objectTypeId?: string;
  objectTypeKey?: string | null;
  objectTypeName?: string | null;
  objectTypePluralName?: string | null;
  stateName?: string;
  stateKind?: string;
  stateCategory?: string;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  ownerName?: string | null;
  waitingOn?: WorkItem['waitingOn'];
  participation?: string;
  enteredStateAt?: number;
  lastActivityAt?: number;
  updatedAt?: number;
  createdAt?: number;
  completedAt?: number | null;
  closedAt?: number | null;
  version?: number;
  key?: string | null;
  number?: number;
  title?: string;
  displayName?: string;
  description?: string | null;
  priority?: WorkItemPriority;
  dueAt?: number | null;
  labels?: WorkItemLabelRef[];
  fields?: Record<string, unknown>;
}

function baseRecord(input: {
  id: string;
  displayName: string;
  key: string | null;
  objectTypeId: string;
}): WorkItemRecordRef {
  return {
    id: input.id,
    displayName: input.displayName,
    key: input.key,
    objectTypeId: input.objectTypeId
  };
}

function baseWorkItem(input: {
  id: string;
  workflowId: string;
  stateId: string;
  key: string | null;
  title: string;
  now: number;
  recordId?: string;
  objectTypeId?: string;
}): WorkItem {
  const recordId = input.recordId ?? input.id;
  return {
    id: input.id,
    workflowItemId: input.id,
    workspaceId: '',
    workflowId: input.workflowId,
    recordId,
    stateId: input.stateId,
    ownerUserId: null,
    ownerTeamId: null,
    waitingOn: null,
    participation: 'primary',
    version: 1,
    record: baseRecord({
      id: recordId,
      displayName: input.title,
      key: input.key,
      objectTypeId: input.objectTypeId ?? ''
    }),
    key: input.key,
    number: 0,
    title: input.title,
    description: null,
    priority: 'none',
    structuredData: null,
    originWorkflowItemId: null,
    createdByType: 'user',
    createdById: null,
    createdByLabel: null,
    provenance: null,
    enteredStateAt: input.now,
    lastActivityAt: input.now,
    dueAt: null,
    slaDueAt: null,
    closedAt: null,
    completedAt: null,
    stateRunCount: 0,
    createdAt: input.now,
    updatedAt: input.now
  };
}

/** Resolve the durable Record identity from either a nested or flat API row. */
function resolveRecord(
  raw: RawWorkItemRow,
  fallbackId: string,
  fallbackName: string,
  fallbackKey: string | null
): WorkItemRecordRef {
  return baseRecord({
    id: raw.record?.id ?? raw.recordId ?? fallbackId,
    displayName: raw.record?.displayName ?? raw.recordDisplayName ?? fallbackName,
    key: raw.record?.key ?? raw.recordKey ?? fallbackKey,
    objectTypeId: raw.record?.objectTypeId ?? raw.objectTypeId ?? ''
  });
}

/** Bridge a flat API row (or a nested WorkItem) into the canonical row shape. */
export function normalizeWorkItemRow(raw: RawWorkItemRow): WorkItemListRow {
  const id = raw.id ?? raw.workflowItemId ?? '';
  const title = raw.title ?? raw.displayName ?? raw.recordDisplayName ?? '';
  const key = raw.key ?? raw.recordKey ?? null;
  const record = resolveRecord(raw, id, title, key);
  const base = baseWorkItem({
    id,
    workflowId: raw.workflowId ?? '',
    stateId: raw.stateId ?? '',
    key,
    title,
    now: raw.createdAt ?? Date.now(),
    recordId: record.id,
    objectTypeId: record.objectTypeId
  });
  const workItem: WorkItem = {
    ...base,
    workflowItemId: raw.workflowItemId ?? id,
    record,
    recordId: record.id,
    key: record.key,
    title: record.displayName,
    description: raw.description ?? null,
    priority: raw.priority ?? 'none',
    ownerUserId: raw.ownerUserId ?? null,
    ownerTeamId: raw.ownerTeamId ?? null,
    waitingOn: raw.waitingOn ?? null,
    participation: raw.participation ?? 'primary',
    version: raw.version ?? 1,
    enteredStateAt: raw.enteredStateAt ?? base.enteredStateAt,
    lastActivityAt: raw.lastActivityAt ?? base.lastActivityAt,
    dueAt: raw.dueAt ?? null,
    closedAt: raw.closedAt ?? null,
    completedAt: raw.completedAt ?? null,
    createdAt: raw.createdAt ?? base.createdAt,
    updatedAt: raw.updatedAt ?? base.updatedAt
  };
  return {
    workItem,
    stateName: raw.stateName ?? '',
    stateKind: raw.stateKind ?? 'manual',
    stateCategory: raw.stateCategory ?? 'active',
    ownerName: raw.ownerName ?? null,
    labels: raw.labels ?? [],
    fields: raw.fields ?? {}
  };
}

/**
 * A row that can be rendered immediately after a create is submitted. The key is a
 * placeholder until the server assigns the real one.
 */
export function optimisticWorkItemRow(input: {
  id: string;
  workflowId: string;
  stateId: string;
  stateName: string;
  stateKind: string;
  stateCategory: string;
  title: string;
  key?: string | null;
  recordId?: string;
  objectTypeId?: string;
  now?: number;
}): WorkItemListRow {
  const now = input.now ?? Date.now();
  return {
    workItem: baseWorkItem({
      id: input.id,
      workflowId: input.workflowId,
      stateId: input.stateId,
      key: input.key ?? '···',
      title: input.title,
      now,
      recordId: input.recordId,
      objectTypeId: input.objectTypeId
    }),
    stateName: input.stateName,
    stateKind: input.stateKind,
    stateCategory: input.stateCategory,
    ownerName: null,
    labels: [],
    fields: {}
  };
}

/** Replace an optimistic row with the server's canonical row. */
export function reconcileRow(row: WorkItemListRow, summary: Partial<WorkItem>): WorkItemListRow {
  const workItem = { ...row.workItem, ...summary };
  return {
    ...row,
    workItem,
    stateName: row.stateName,
    ownerName: row.ownerName
  };
}

/** The loose shape `GET /api/workflow-items/:id` returns (service detail + files). */
export interface RawWorkItemDetail extends RawWorkItemRow {
  workflow?: { id: string; name: string; key: string } | null;
  state?: Partial<WorkflowState> | null;
  notes?: WorkItemNoteView[];
  relationships?: WorkItemRelationshipView[];
  files?: WorkItemFileLink[];
  runs?: WorkItemRunSummary[];
  approvals?: WorkItemApprovalSummary[];
  availableTransitions?: AvailableTransition[];
  stateHistory?: Array<{ enteredAt: number; exitedAt: number | null }>;
}

/**
 * Bridge the service's WorkflowItem detail into the richer view shape the surface
 * renders. The service keeps participation (`workItem`) and identity (`record`)
 * separate; the view nests the record under the work item and defaults the
 * collections a tab may not need.
 */
export function normalizeWorkItemDetail(raw: RawWorkItemDetail): WorkItemDetail {
  const row = normalizeWorkItemRow(raw);
  const priority = (raw.fields?.priority as WorkItemPriority | undefined) ?? 'none';
  const workItem: WorkItem = {
    ...row.workItem,
    priority,
    title: row.workItem.record.displayName,
    key: row.workItem.record.key
  };
  const stateHistory = raw.stateHistory ?? [];
  const relationships = raw.relationships ?? [];
  const state: WorkflowState = {
    id: raw.stateId ?? raw.state?.id ?? '',
    workspaceId: '',
    workflowId: raw.workflowId ?? '',
    name: raw.state?.name ?? row.stateName,
    description: null,
    kind: (raw.state?.kind as WorkflowState['kind']) ?? (row.stateKind as WorkflowState['kind']),
    category:
      (raw.state?.category as WorkflowState['category']) ??
      (row.stateCategory as WorkflowState['category']),
    color: null,
    position: raw.state?.position ?? 0,
    isStart: raw.state?.isStart ?? false,
    isTerminal: raw.state?.isTerminal ?? false,
    agentId: null,
    agentVersionId: null,
    autoExecute: true,
    maxAttempts: 3,
    timeoutSeconds: null,
    failureStateId: null,
    humanGate: null,
    config: null,
    createdAt: raw.createdAt ?? workItem.createdAt,
    updatedAt: raw.updatedAt ?? workItem.updatedAt
  };
  return {
    workItem,
    key: workItem.record.key ?? '',
    state,
    workflow: raw.workflow ?? { id: raw.workflowId ?? '', name: '', key: '' },
    fields: raw.fields ?? {},
    fieldConfig: undefined,
    labels: raw.labels ?? [],
    notes: raw.notes ?? [],
    relationships,
    files: raw.files ?? [],
    runs: raw.runs ?? [],
    approvals: raw.approvals ?? [],
    availableTransitions: raw.availableTransitions ?? [],
    humanGate: null,
    gateDecisions: [],
    historySummary: {
      created: raw.createdAt ?? workItem.createdAt,
      lastActivityAt: raw.lastActivityAt ?? workItem.lastActivityAt,
      stateEntries: stateHistory.length,
      transfers: relationships.length
    }
  };
}

function sortValue(row: WorkItemListRow, key: string): unknown {
  if (key.startsWith('field:')) return row.fields[key.slice('field:'.length)];
  switch (key) {
    case 'key':
      return row.workItem.record.key ?? '';
    case 'title':
      return row.workItem.record.displayName.toLowerCase();
    case 'state':
      return row.stateName.toLowerCase();
    case 'priority':
      return PRIORITY_ORDER[row.workItem.priority] ?? 5;
    case 'owner':
      return (row.ownerName ?? '').toLowerCase();
    case 'updated':
      return row.workItem.updatedAt;
    case 'due':
      return row.workItem.dueAt ?? 0;
    case 'age':
      return row.workItem.enteredStateAt;
    default:
      return '';
  }
}

/** Stable client-side sort: the endpoint cannot sort reliably, so lists do. */
export function sortRows(rows: WorkItemListRow[], field: string, direction: 'asc' | 'desc') {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortValue(left, field);
    const b = sortValue(right, field);
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor;
    return String(a).localeCompare(String(b)) * factor;
  });
}

/** Columns the List tab offers, including the workflow's own list fields. */
export function buildListColumns(fields: WorkflowFieldView[]): WorkItemColumn[] {
  const columns: WorkItemColumn[] = [
    { key: 'key', label: 'Key', sortable: true, width: '7rem' },
    { key: 'title', label: 'Name', sortable: true },
    { key: 'state', label: 'State', sortable: true },
    { key: 'priority', label: 'Priority', sortable: true },
    { key: 'owner', label: 'Owner', sortable: true },
    { key: 'labels', label: 'Labels' },
    { key: 'updated', label: 'Updated', sortable: true }
  ];
  for (const view of fields) {
    columns.push({
      key: `field:${view.definition.key}`,
      label: view.definition.name,
      type: view.definition.type as FieldType,
      options: view.definition.options,
      sortable: true
    });
  }
  return columns;
}

/** Remove an item from every column and place it at the top of the target one. */
export function moveRow(
  columns: BoardColumn[],
  workflowItemId: string,
  targetStateId: string
): BoardColumn[] {
  let source: BoardColumn | undefined;
  for (const column of columns) {
    if (column.items.some((row) => row.workItem.id === workflowItemId)) {
      source = column;
      break;
    }
  }
  if (!source) return columns;
  const moved = source.items.find((row) => row.workItem.id === workflowItemId);
  const target = columns.find((column) => column.state.id === targetStateId);
  if (!moved || !target || source.state.id === targetStateId) return columns;
  const updated: WorkItemListRow = {
    ...moved,
    workItem: { ...moved.workItem, stateId: targetStateId, enteredStateAt: Date.now() },
    stateName: target.state.name,
    stateKind: target.state.kind,
    stateCategory: target.state.category
  };
  return columns.map((column) => {
    if (column.state.id === targetStateId) {
      return { ...column, items: [updated, ...column.items], count: column.count + 1 };
    }
    if (column.state.id === source.state.id) {
      return {
        ...column,
        items: column.items.filter((row) => row.workItem.id !== workflowItemId),
        count: Math.max(0, column.count - 1)
      };
    }
    return column;
  });
}
