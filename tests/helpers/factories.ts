/**
 * Test factories.
 *
 * Factories write through the schema rather than through services. That keeps them
 * usable by every workstream (including ones that own the services) and means a
 * factory never silently depends on behaviour that is itself under test.
 *
 * Every factory is workspace-scoped, so tenant-isolation tests can build two
 * complete tenants in one database.
 */
import { and, eq } from 'drizzle-orm';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../src/lib/server/core/context';
import { keyPrefix, uuidv7 } from '../../src/lib/server/core/ids';
import type { Executor } from '../../src/lib/server/db/client';
import {
  type ActorType,
  agentRuns,
  approvalRequests,
  blobs,
  dashboards,
  dashboardWidgets,
  type FieldType,
  fieldDefinitions,
  fieldValueHistory,
  fileFieldValues,
  fileSources,
  files,
  labels,
  type StateKind,
  teamMembers,
  teams,
  ticketFieldValues,
  ticketFiles,
  ticketLabels,
  ticketStateHistory,
  tickets,
  users,
  type WidgetDataSource,
  type WidgetGrouping,
  type WidgetMeasure,
  type WidgetTimeRange,
  type WidgetType,
  type WorkspaceRole,
  workflowStates,
  workflows,
  workflowTransitions,
  workspaceMembers,
  workspaces
} from '../../src/lib/server/db/schema';

export interface WorkspaceFixture {
  id: string;
  name: string;
  slug: string;
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function createWorkspace(
  db: Executor,
  name = 'Test Workspace'
): Promise<WorkspaceFixture> {
  const id = uuidv7();
  const slug = `${unique('ws')}`;
  await db
    .insert(workspaces)
    .values({ id, name, slug, createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  return { id, name, slug };
}

export interface UserFixture {
  id: string;
  email: string;
  name: string;
}

export async function createUser(
  db: Executor,
  options: { email?: string; name?: string; password?: string } = {}
): Promise<UserFixture> {
  const id = uuidv7();
  const email = options.email ?? `${unique('user')}@example.test`;
  const name = options.name ?? 'Test User';
  await db
    .insert(users)
    .values({
      id,
      email,
      name,
      passwordHash: options.password ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  return { id, email, name };
}

export async function addMember(
  db: Executor,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = 'member'
): Promise<void> {
  await db
    .insert(workspaceMembers)
    .values({
      id: uuidv7(),
      workspaceId,
      userId,
      role,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
}

export async function createTeam(
  db: Executor,
  workspaceId: string,
  name = 'Team'
): Promise<string> {
  const id = uuidv7();
  await db
    .insert(teams)
    .values({ id, workspaceId, name: unique(name), createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  return id;
}

export async function addTeamMember(
  db: Executor,
  workspaceId: string,
  teamId: string,
  userId: string
): Promise<void> {
  await db
    .insert(teamMembers)
    .values({ id: uuidv7(), workspaceId, teamId, userId, createdAt: Date.now() })
    .run();
}

export interface WorkflowFixture {
  id: string;
  key: string;
  stateIds: Record<string, string>;
  /** Ordered list of state ids, matching `stateNames`. */
  states: string[];
  stateNames: string[];
  transitionIds: string[];
}

export interface WorkflowStateSpec {
  name: string;
  kind?: StateKind;
  category?: 'backlog' | 'active' | 'review' | 'done' | 'cancelled';
  isStart?: boolean;
  isTerminal?: boolean;
  agentId?: string;
  autoExecute?: boolean;
  humanGate?: Record<string, unknown>;
}

export async function createWorkflow(
  db: Executor,
  workspaceId: string,
  options: {
    name?: string;
    key?: string;
    states?: WorkflowStateSpec[];
    /** `[fromName, toName, transitionName?]` tuples. */
    transitions?: Array<[string, string, string?]>;
    createdByUserId?: string;
  } = {}
): Promise<WorkflowFixture> {
  const id = uuidv7();
  const name = options.name ?? unique('Workflow');
  const key = options.key ?? keyPrefix(name, 'WF');
  const now = Date.now();
  await db
    .insert(workflows)
    .values({
      id,
      workspaceId,
      name,
      key,
      createdByUserId: options.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();

  const specs: WorkflowStateSpec[] = options.states ?? [
    { name: 'Backlog', kind: 'manual', category: 'backlog', isStart: true },
    { name: 'In Progress', kind: 'manual', category: 'active' },
    { name: 'Done', kind: 'manual', category: 'done', isTerminal: true }
  ];

  const stateIds: Record<string, string> = {};
  const stateOrder: string[] = [];
  const stateNames: string[] = [];
  for (const [index, spec] of specs.entries()) {
    const stateId = uuidv7();
    stateIds[spec.name] = stateId;
    stateOrder.push(stateId);
    stateNames.push(spec.name);
    await db
      .insert(workflowStates)
      .values({
        id: stateId,
        workspaceId,
        workflowId: id,
        name: spec.name,
        kind: spec.kind ?? 'manual',
        category: spec.category ?? 'active',
        position: index,
        isStart: spec.isStart ?? index === 0,
        isTerminal: spec.isTerminal ?? false,
        agentId: spec.agentId ?? null,
        autoExecute: spec.autoExecute ?? true,
        humanGate: (spec.humanGate as never) ?? null,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }

  // Point defaultStateId at the first state so ticket creation works out of the box.
  await db
    .update(workflows)
    .set({ defaultStateId: stateOrder[0] ?? null })
    .where(eq(workflows.id, id))
    .run();

  const transitionIds: string[] = [];
  const transitionSpecs =
    options.transitions ??
    specs
      .slice(0, -1)
      .map(
        (spec, index) =>
          [spec.name, specs[index + 1]!.name, undefined] as [string, string, undefined]
      );

  for (const [from, to, transitionName] of transitionSpecs) {
    const transitionId = uuidv7();
    transitionIds.push(transitionId);
    await db
      .insert(workflowTransitions)
      .values({
        id: transitionId,
        workspaceId,
        workflowId: id,
        fromStateId: stateIds[from] ?? null,
        toStateId: stateIds[to]!,
        name: transitionName ?? `${from} → ${to}`,
        position: transitionIds.length - 1,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }

  return { id, key, stateIds, states: stateOrder, stateNames, transitionIds };
}

export interface TicketFixture {
  id: string;
  key: string;
  number: number;
}

export async function createTicket(
  db: Executor,
  options: {
    workspaceId: string;
    workflow: WorkflowFixture;
    stateId?: string;
    title?: string;
    description?: string;
    priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
    ownerUserId?: string;
    ownerTeamId?: string;
    createdByType?: ActorType;
    createdById?: string;
    number?: number;
  }
): Promise<TicketFixture> {
  const id = uuidv7();
  const stateId = options.stateId ?? options.workflow.states[0]!;
  const number = options.number ?? (await nextTicketNumber(db, options.workspaceId));
  const now = Date.now();
  await db
    .insert(tickets)
    .values({
      id,
      workspaceId: options.workspaceId,
      workflowId: options.workflow.id,
      stateId,
      key: `${options.workflow.key}-${number}`,
      number,
      title: options.title ?? unique('Ticket'),
      description: options.description ?? null,
      priority: options.priority ?? 'none',
      ownerUserId: options.ownerUserId ?? null,
      ownerTeamId: options.ownerTeamId ?? null,
      createdByType: options.createdByType ?? 'user',
      createdById: options.createdById ?? null,
      enteredStateAt: now,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return { id, key: `${options.workflow.key}-${number}`, number };
}

async function nextTicketNumber(db: Executor, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ number: tickets.number })
    .from(tickets)
    .where(eq(tickets.workspaceId, workspaceId))
    .all();
  return rows.reduce((max, row) => Math.max(max, row.number), 0) + 1;
}

export async function createField(
  db: Executor,
  options: {
    workspaceId: string;
    key?: string;
    name?: string;
    type?: FieldType;
    scope?: 'ticket' | 'file';
    options?: Record<string, unknown>;
  }
): Promise<string> {
  const id = uuidv7();
  const now = Date.now();
  await db
    .insert(fieldDefinitions)
    .values({
      id,
      workspaceId: options.workspaceId,
      key: options.key ?? unique('field'),
      name: options.name ?? 'Field',
      type: options.type ?? 'short_text',
      scope: options.scope ?? 'ticket',
      options: (options.options as never) ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return id;
}

export async function setTicketFieldValue(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    fieldDefinitionId: string;
    value: unknown;
  }
): Promise<void> {
  await db
    .insert(ticketFieldValues)
    .values({
      id: uuidv7(),
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      fieldDefinitionId: options.fieldDefinitionId,
      valueJson: options.value as never,
      searchText: typeof options.value === 'string' ? options.value.toLowerCase() : null,
      updatedAt: Date.now()
    })
    .run();
}

export async function createLabel(
  db: Executor,
  workspaceId: string,
  name = 'label'
): Promise<string> {
  const id = uuidv7();
  await db
    .insert(labels)
    .values({ id, workspaceId, name: unique(name), createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  return id;
}

/** Actor contexts for tests, with the same permission derivation as production. */
export function ownerActor(workspaceId: string, userId: string, label = 'Owner'): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'user',
    actorId: userId,
    actorLabel: label,
    role: 'owner',
    permissions: permissionsForRole('owner')
  });
}

export function memberActor(workspaceId: string, userId: string, label = 'Member'): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'user',
    actorId: userId,
    actorLabel: label,
    role: 'member',
    permissions: permissionsForRole('member')
  });
}

/* -------------------------------------------------------------------------- *
 * Analytics + filtering fixtures.
 *
 * Appended by the analytics workstream. These write raw rows (never through the
 * services under test) so that filter, widget, funnel and report assertions rest
 * on controlled state instead of on a service's own side effects.
 * -------------------------------------------------------------------------- */

/** Patch any ticket column. Used to seed dates, provenance and ownership. */
export async function updateTicketRow(
  db: Executor,
  ticketId: string,
  values: Partial<typeof tickets.$inferInsert>
): Promise<void> {
  await db.update(tickets).set(values).where(eq(tickets.id, ticketId)).run();
}

/**
 * Persist a typed ticket field value in the *correct* typed column. The original
 * `setTicketFieldValue` only writes `valueJson`, which is not what filtering and
 * analytics read.
 */
export async function setTypedFieldValue(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    fieldDefinitionId: string;
    type: FieldType;
    value: unknown;
    updatedAt?: number;
  }
): Promise<void> {
  const columns = typedValueColumns(options.type, options.value);
  await db
    .delete(ticketFieldValues)
    .where(
      and(
        eq(ticketFieldValues.ticketId, options.ticketId),
        eq(ticketFieldValues.fieldDefinitionId, options.fieldDefinitionId)
      )
    )
    .run();
  await db
    .insert(ticketFieldValues)
    .values({
      id: uuidv7(),
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      fieldDefinitionId: options.fieldDefinitionId,
      ...columns,
      updatedAt: options.updatedAt ?? Date.now()
    } as never)
    .run();
}

export async function setFileFieldValueTyped(
  db: Executor,
  options: {
    workspaceId: string;
    fileId: string;
    workflowId?: string | null;
    fieldDefinitionId: string;
    type: FieldType;
    value: unknown;
  }
): Promise<void> {
  const columns = typedValueColumns(options.type, options.value);
  await db
    .insert(fileFieldValues)
    .values({
      id: uuidv7(),
      workspaceId: options.workspaceId,
      fileId: options.fileId,
      workflowId: options.workflowId ?? null,
      fieldDefinitionId: options.fieldDefinitionId,
      ...columns,
      updatedAt: Date.now()
    } as never)
    .run();
}

function typedValueColumns(type: FieldType, value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {
      valueText: null,
      valueNumber: null,
      valueDate: null,
      valueBool: null,
      valueJson: null,
      searchText: null
    };
  }
  switch (type) {
    case 'number':
    case 'currency': {
      const numeric = typeof value === 'number' ? value : Number(value);
      return { valueNumber: numeric, valueJson: value, searchText: String(value).toLowerCase() };
    }
    case 'date':
    case 'datetime': {
      const stamp = typeof value === 'number' ? value : Date.parse(String(value));
      return { valueDate: stamp, valueJson: value };
    }
    case 'boolean':
      return { valueBool: Boolean(value), valueJson: value };
    case 'multi_select': {
      const list = Array.isArray(value) ? value : [value];
      return {
        valueJson: list,
        searchText: list
          .map((entry) => String(entry))
          .join(' ')
          .toLowerCase()
      };
    }
    case 'json':
      return {
        valueJson: value,
        searchText:
          typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value).toLowerCase()
      };
    default:
      return {
        valueText: String(value),
        searchText: String(value).toLowerCase(),
        valueJson: value
      };
  }
}

export async function addTicketLabel(
  db: Executor,
  options: { workspaceId: string; ticketId: string; labelId: string }
): Promise<string> {
  const id = uuidv7();
  await db
    .insert(ticketLabels)
    .values({
      id,
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      labelId: options.labelId,
      createdAt: Date.now()
    })
    .run();
  return id;
}

export async function createTicketStateInterval(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    workflowId: string;
    stateId: string;
    stateName: string;
    stateKind?: string;
    previousStateId?: string | null;
    enteredAt: number;
    exitedAt?: number | null;
    durationMs?: number | null;
    enteredByType?: ActorType;
    runId?: string | null;
  }
): Promise<string> {
  const id = uuidv7(options.enteredAt);
  const exitedAt = options.exitedAt ?? null;
  await db
    .insert(ticketStateHistory)
    .values({
      id,
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      workflowId: options.workflowId,
      stateId: options.stateId,
      stateName: options.stateName,
      stateKind: options.stateKind ?? 'manual',
      previousStateId: options.previousStateId ?? null,
      enteredAt: options.enteredAt,
      exitedAt,
      durationMs: options.durationMs ?? (exitedAt === null ? null : exitedAt - options.enteredAt),
      enteredByType: options.enteredByType ?? 'user',
      runId: options.runId ?? null
    })
    .run();
  return id;
}

export async function createFieldValueHistory(
  db: Executor,
  options: {
    workspaceId: string;
    ownerId: string;
    fieldDefinitionId: string;
    ownerType?: 'ticket' | 'file';
    previousValue?: unknown;
    newValue?: unknown;
    createdAt?: number;
    actorType?: ActorType;
  }
): Promise<string> {
  const id = uuidv7(options.createdAt ?? Date.now());
  await db
    .insert(fieldValueHistory)
    .values({
      id,
      workspaceId: options.workspaceId,
      ownerType: options.ownerType ?? 'ticket',
      ownerId: options.ownerId,
      fieldDefinitionId: options.fieldDefinitionId,
      previousValue: (options.previousValue ?? null) as never,
      newValue: (options.newValue ?? null) as never,
      actorType: options.actorType ?? 'user',
      createdAt: options.createdAt ?? Date.now()
    })
    .run();
  return id;
}

export async function createAgentRun(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    workflowId: string;
    stateId: string;
    status?:
      | 'queued'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'awaiting_approval'
      | 'skipped';
    agentId?: string;
    createdAt?: number;
  }
): Promise<string> {
  const id = uuidv7(options.createdAt ?? Date.now());
  const createdAt = options.createdAt ?? Date.now();
  await db
    .insert(agentRuns)
    .values({
      id,
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      workflowId: options.workflowId,
      stateId: options.stateId,
      agentId: options.agentId ?? 'agent-1',
      agentVersionId: 'agent-version-1',
      status: options.status ?? 'queued',
      createdAt,
      updatedAt: createdAt
    })
    .run();
  return id;
}

export async function createApprovalRequest(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
    kind?: 'state_transition' | 'tool_call' | 'transfer' | 'ticket_creation';
    createdAt?: number;
  }
): Promise<string> {
  const createdAt = options.createdAt ?? Date.now();
  const id = uuidv7(createdAt);
  await db
    .insert(approvalRequests)
    .values({
      id,
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      kind: options.kind ?? 'state_transition',
      title: 'Approval',
      requestedAction: { type: 'transition' } as never,
      requestedByType: 'agent',
      status: options.status ?? 'pending',
      createdAt
    })
    .run();
  return id;
}

export async function createBlobRecord(
  db: Executor,
  options: {
    workspaceId: string;
    contentHash?: string;
    size?: number;
    mimeType?: string;
  }
): Promise<string> {
  const id = uuidv7();
  const contentHash = options.contentHash ?? unique('hash');
  await db
    .insert(blobs)
    .values({
      id,
      workspaceId: options.workspaceId,
      contentHash,
      size: options.size ?? 128,
      mimeType: options.mimeType ?? 'application/pdf',
      storageProvider: 'local',
      storageKey: `blobs/${contentHash}`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  return id;
}

export async function createFileRecord(
  db: Executor,
  options: {
    workspaceId: string;
    blobId?: string;
    originalFilename?: string;
    mimeType?: string;
    size?: number;
    kind?: 'upload' | 'generated' | 'external';
    status?: 'pending' | 'processing' | 'ready' | 'failed' | 'quarantined';
    summary?: string | null;
    primaryWorkflowId?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: number;
    updatedAt?: number;
  }
): Promise<string> {
  const blobId =
    options.blobId ?? (await createBlobRecord(db, { workspaceId: options.workspaceId }));
  const id = uuidv7(options.createdAt ?? Date.now());
  const createdAt = options.createdAt ?? Date.now();
  await db
    .insert(files)
    .values({
      id,
      workspaceId: options.workspaceId,
      blobId,
      originalFilename: options.originalFilename ?? unique('file.pdf'),
      mimeType: options.mimeType ?? 'application/pdf',
      size: options.size ?? 128,
      kind: options.kind ?? 'upload',
      status: options.status ?? 'ready',
      summary: options.summary ?? null,
      primaryWorkflowId: options.primaryWorkflowId ?? null,
      metadata: (options.metadata ?? null) as never,
      createdAt,
      updatedAt: options.updatedAt ?? createdAt
    })
    .run();
  return id;
}

export async function linkTicketFile(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    fileId: string;
    relationship?: 'attachment' | 'reference' | 'output' | 'evidence';
    createdAt?: number;
  }
): Promise<string> {
  const id = uuidv7(options.createdAt ?? Date.now());
  await db
    .insert(ticketFiles)
    .values({
      id,
      workspaceId: options.workspaceId,
      ticketId: options.ticketId,
      fileId: options.fileId,
      relationship: options.relationship ?? 'attachment',
      createdAt: options.createdAt ?? Date.now()
    })
    .run();
  return id;
}

export async function addFileSource(
  db: Executor,
  options: {
    workspaceId: string;
    fileId: string;
    sourceType:
      | 'human_upload'
      | 'incoming_email'
      | 'incoming_message'
      | 'webhook'
      | 'agent_run'
      | 'http_connector'
      | 'api'
      | 'system';
    ticketId?: string | null;
    occurredAt?: number;
  }
): Promise<string> {
  const id = uuidv7();
  await db
    .insert(fileSources)
    .values({
      id,
      workspaceId: options.workspaceId,
      fileId: options.fileId,
      sourceType: options.sourceType,
      ticketId: options.ticketId ?? null,
      occurredAt: options.occurredAt ?? Date.now(),
      createdAt: Date.now()
    })
    .run();
  return id;
}

export async function createDashboardRecord(
  db: Executor,
  options: {
    workspaceId: string;
    name?: string;
    description?: string | null;
    globalFilters?: unknown;
    layout?: Array<{ widgetId: string; x: number; y: number; w: number; h: number }> | null;
    isShared?: boolean;
    isDefault?: boolean;
    createdByUserId?: string | null;
  }
): Promise<string> {
  const id = uuidv7();
  const now = Date.now();
  await db
    .insert(dashboards)
    .values({
      id,
      workspaceId: options.workspaceId,
      name: options.name ?? unique('Dashboard'),
      description: options.description ?? null,
      globalFilters: (options.globalFilters ?? null) as never,
      layout: (options.layout ?? null) as never,
      isShared: options.isShared ?? true,
      isDefault: options.isDefault ?? false,
      createdByUserId: options.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return id;
}

export async function createWidgetRecord(
  db: Executor,
  options: {
    workspaceId: string;
    dashboardId: string;
    type: WidgetType;
    dataSource: WidgetDataSource;
    measure: WidgetMeasure;
    grouping?: WidgetGrouping | null;
    timeRange?: WidgetTimeRange | null;
    filter?: unknown;
    title?: string;
    position?: number;
    savedViewId?: string | null;
  }
): Promise<string> {
  const id = uuidv7();
  const now = Date.now();
  await db
    .insert(dashboardWidgets)
    .values({
      id,
      workspaceId: options.workspaceId,
      dashboardId: options.dashboardId,
      title: options.title ?? 'Widget',
      type: options.type,
      position: options.position ?? 0,
      dataSource: options.dataSource as never,
      filter: (options.filter ?? null) as never,
      measure: options.measure as never,
      grouping: (options.grouping ?? null) as never,
      timeRange: (options.timeRange ?? null) as never,
      savedViewId: options.savedViewId ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();
  return id;
}
