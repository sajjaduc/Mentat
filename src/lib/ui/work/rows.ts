/**
 * Row helpers for the work surfaces.
 *
 * A board move and an inline create must both be visible before the server
 * answers, which means constructing a plausible `TicketListRow` locally and
 * rebuilding it from the response. Keeping that in one module stops the optimistic
 * shapes from drifting between the board, the list and My Work.
 */
import type {
  FieldType,
  Ticket,
  TicketColumn,
  TicketListRow,
  WorkflowFieldView,
  WorkflowState
} from '$ui/work/types';

export interface BoardColumn {
  state: WorkflowState;
  tickets: TicketListRow[];
  total: number;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
};

function baseTicket(input: {
  id: string;
  workflowId: string;
  stateId: string;
  key: string;
  title: string;
  now: number;
}): Ticket {
  return {
    id: input.id,
    workspaceId: '',
    workflowId: input.workflowId,
    stateId: input.stateId,
    key: input.key,
    number: 0,
    title: input.title,
    description: null,
    priority: 'none',
    ownerUserId: null,
    ownerTeamId: null,
    structuredData: null,
    version: 1,
    originTicketId: null,
    createdByType: 'user',
    createdById: null,
    createdByLabel: null,
    provenance: null,
    enteredStateAt: input.now,
    lastActivityAt: input.now,
    dueAt: null,
    slaDueAt: null,
    closedAt: null,
    stateRunCount: 0,
    waitingOn: null,
    createdAt: input.now,
    updatedAt: input.now
  };
}

/**
 * A row that can be rendered immediately after a create is submitted. The key is a
 * placeholder until the server assigns the real one.
 */
export function optimisticTicketRow(input: {
  id: string;
  workflowId: string;
  stateId: string;
  stateName: string;
  stateKind: string;
  stateCategory: string;
  title: string;
  key?: string;
  now?: number;
}): TicketListRow {
  const now = input.now ?? Date.now();
  return {
    ticket: baseTicket({
      id: input.id,
      workflowId: input.workflowId,
      stateId: input.stateId,
      key: input.key ?? '···',
      title: input.title,
      now
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
export function reconcileRow(row: TicketListRow, summary: Partial<Ticket>): TicketListRow {
  return { ...row, ticket: { ...row.ticket, ...summary } };
}

function sortValue(row: TicketListRow, key: string): unknown {
  if (key.startsWith('field:')) return row.fields[key.slice('field:'.length)];
  switch (key) {
    case 'key':
      return row.ticket.key;
    case 'title':
      return row.ticket.title.toLowerCase();
    case 'state':
      return row.stateName.toLowerCase();
    case 'priority':
      return PRIORITY_ORDER[row.ticket.priority] ?? 5;
    case 'owner':
      return (row.ownerName ?? '').toLowerCase();
    case 'updated':
      return row.ticket.updatedAt;
    case 'due':
      return row.ticket.dueAt ?? 0;
    case 'age':
      return row.ticket.enteredStateAt;
    default:
      return '';
  }
}

/** Stable client-side sort: the ticket endpoint cannot sort reliably, so lists do. */
export function sortRows(rows: TicketListRow[], field: string, direction: 'asc' | 'desc') {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = sortValue(left, field);
    const b = sortValue(right, field);
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor;
    return String(a).localeCompare(String(b)) * factor;
  });
}

/** Columns the List tab offers, including the workflow's own list fields. */
export function buildListColumns(fields: WorkflowFieldView[]): TicketColumn[] {
  const columns: TicketColumn[] = [
    { key: 'key', label: 'Key', sortable: true, width: '7rem' },
    { key: 'title', label: 'Title', sortable: true },
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

/** Remove a ticket from every column and place it at the top of the target one. */
export function moveRow(
  columns: BoardColumn[],
  ticketId: string,
  targetStateId: string
): BoardColumn[] {
  let source: BoardColumn | undefined;
  for (const column of columns) {
    if (column.tickets.some((row) => row.ticket.id === ticketId)) {
      source = column;
      break;
    }
  }
  if (!source) return columns;
  const moved = source.tickets.find((row) => row.ticket.id === ticketId);
  const target = columns.find((column) => column.state.id === targetStateId);
  if (!moved || !target || source.state.id === targetStateId) return columns;
  const updated: TicketListRow = {
    ...moved,
    ticket: { ...moved.ticket, stateId: targetStateId, enteredStateAt: Date.now() },
    stateName: target.state.name,
    stateKind: target.state.kind,
    stateCategory: target.state.category
  };
  return columns.map((column) => {
    if (column.state.id === targetStateId) {
      return { ...column, tickets: [updated, ...column.tickets], total: column.total + 1 };
    }
    if (column.state.id === source.state.id) {
      return {
        ...column,
        tickets: column.tickets.filter((row) => row.ticket.id !== ticketId),
        total: Math.max(0, column.total - 1)
      };
    }
    return column;
  });
}
