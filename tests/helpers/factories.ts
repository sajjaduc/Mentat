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
import { eq } from 'drizzle-orm';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../src/lib/server/core/context';
import { keyPrefix, uuidv7 } from '../../src/lib/server/core/ids';
import type { Executor } from '../../src/lib/server/db/client';
import {
  type ActorType,
  type FieldType,
  fieldDefinitions,
  labels,
  type Model,
  type ModelCapabilities,
  type ModelInferenceDefaults,
  models,
  type Provider,
  type ProviderConfig,
  type ProviderType,
  providers,
  type StateKind,
  teamMembers,
  teams,
  ticketFieldValues,
  tickets,
  users,
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

export interface ProviderRowOptions {
  workspaceId: string;
  name?: string;
  type?: ProviderType;
  baseUrl?: string | null;
  apiKeySecretId?: string | null;
  config?: ProviderConfig | null;
  enabled?: boolean;
  isDefault?: boolean;
  createdByUserId?: string | null;
}

/** Insert a provider row directly, bypassing the provider service under test. */
export async function createProviderRow(
  db: Executor,
  options: ProviderRowOptions
): Promise<Provider> {
  const id = uuidv7();
  const now = Date.now();
  await db
    .insert(providers)
    .values({
      id,
      workspaceId: options.workspaceId,
      name: options.name ?? unique('Provider'),
      type: options.type ?? 'ollama',
      baseUrl: options.baseUrl ?? null,
      apiKeySecretId: options.apiKeySecretId ?? null,
      config: options.config ?? null,
      enabled: options.enabled ?? true,
      isDefault: options.isDefault ?? false,
      createdByUserId: options.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();
  const rows = await db.select().from(providers).where(eq(providers.id, id)).all();
  return rows[0]!;
}

export interface ModelRowOptions {
  workspaceId: string;
  providerId: string;
  modelKey?: string;
  displayName?: string;
  family?: string | null;
  parameterSize?: string | null;
  quantization?: string | null;
  capabilities?: ModelCapabilities | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inferenceDefaults?: ModelInferenceDefaults | null;
  enabled?: boolean;
  discovered?: boolean;
}

/** Insert a model row directly, bypassing the model service under test. */
export async function createModelRow(db: Executor, options: ModelRowOptions): Promise<Model> {
  const id = uuidv7();
  const now = Date.now();
  await db
    .insert(models)
    .values({
      id,
      workspaceId: options.workspaceId,
      providerId: options.providerId,
      modelKey: options.modelKey ?? unique('model'),
      displayName: options.displayName ?? options.modelKey ?? 'Model',
      family: options.family ?? null,
      parameterSize: options.parameterSize ?? null,
      quantization: options.quantization ?? null,
      capabilities: options.capabilities ?? null,
      contextWindow: options.contextWindow ?? null,
      maxOutputTokens: options.maxOutputTokens ?? null,
      inferenceDefaults: options.inferenceDefaults ?? null,
      enabled: options.enabled ?? true,
      discovered: options.discovered ?? false,
      discoveredAt: options.discovered ? now : null,
      lastSeenAt: options.discovered ? now : null,
      createdAt: now,
      updatedAt: now
    })
    .run();
  const rows = await db.select().from(models).where(eq(models.id, id)).all();
  return rows[0]!;
}
