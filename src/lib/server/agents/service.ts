/**
 * Agents and skills.
 *
 * An agent is *versioned configuration*, not code. Every material change appends
 * an immutable `agent_versions` snapshot and moves `currentVersionId`, so an
 * agent run can always be traced back to exactly the instructions, model, tools
 * and permissions that were in force when it ran (ADR-0008).
 *
 * Skills follow the same pattern. They are reusable instruction packages with
 * examples and references — never executable plugins.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type Agent,
  type AgentPermissions,
  type AgentSnapshot,
  agentRuns,
  agents,
  agentTools,
  agentVersions,
  type ResourceBindingMode,
  type Skill,
  type SkillVersion,
  skills,
  skillVersions,
  type Tool,
  tools,
  workflowStates,
  workflows
} from '../db/schema';
import { isReasoningEffort } from '../providers/reasoning';

export interface AgentView extends Agent {
  currentVersion: number;
  skills: Array<{ id: string; name: string; version: number; description: string | null }>;
  toolKeys: string[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | null;
  instructions?: string;
  workflowId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  skillIds?: string[];
  toolIds?: string[];
  outputSchema?: unknown;
  executionConfig?: Record<string, unknown> | null;
  permissions?: AgentPermissions | null;
  bindingMode?: ResourceBindingMode;
  sourceAgentId?: string | null;
}

export function requireAgent(db: Executor, workspaceId: string, agentId: string): Agent {
  const rows = db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const agent = rows[0];
  if (!agent) throw errors.notFound('Agent', agentId);
  return agent;
}

/** Resolve the immutable version a run must use. */
export function requireAgentVersion(
  db: Executor,
  workspaceId: string,
  agent: Agent,
  versionId?: string | null
): { version: number; snapshot: AgentSnapshot } {
  const resolvedVersionId = versionId ?? agent.currentVersionId;
  if (resolvedVersionId) {
    const rows = db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.id, resolvedVersionId),
          eq(agentVersions.workspaceId, workspaceId),
          eq(agentVersions.agentId, agent.id)
        )
      )
      .limit(1)
      .all();
    const row = rows[0];
    if (row) return { version: row.version, snapshot: row.snapshot };
  }
  // Fall back to the newest version: an agent created before versioning existed, or
  // a version row removed by an operator, must still be runnable.
  const newest = db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.workspaceId, workspaceId)))
    .orderBy(desc(agentVersions.version))
    .limit(1)
    .all()[0];
  if (newest) return { version: newest.version, snapshot: newest.snapshot };
  throw errors.precondition(`Agent "${agent.name}" has no version snapshot`, { agentId: agent.id });
}

function snapshotOf(
  agent: Agent,
  options: {
    skillIds: string[];
    toolIds: string[];
    version: number;
    modelKey?: string | null;
    providerType?: string | null;
  }
): AgentSnapshot {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    providerId: agent.providerId,
    providerType: options.providerType ?? null,
    modelId: agent.modelId,
    modelKey: options.modelKey ?? null,
    skillIds: options.skillIds,
    toolIds: options.toolIds,
    outputSchema: agent.outputSchema,
    executionConfig: agent.executionConfig,
    permissions: agent.permissions,
    version: options.version
  };
}

export function createAgent(db: Executor, actor: ActorContext, input: CreateAgentInput): AgentView {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to create agents');
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Agent name is required');
  if (input.workflowId) {
    const workflow = db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, actor.workspaceId)))
      .limit(1)
      .all();
    if (!workflow[0]) throw errors.validation('The workflow does not exist in this workspace');
  }

  verifySkillIds(db, actor.workspaceId, input.skillIds ?? []);
  verifyToolIds(db, actor.workspaceId, input.toolIds ?? []);
  validateAgentConfig(input);

  const now = Date.now();
  const agentId = uuidv7(now);
  const inserted = db
    .insert(agents)
    .values({
      id: agentId,
      workspaceId: actor.workspaceId,
      workflowId: input.workflowId ?? null,
      sourceAgentId: input.sourceAgentId ?? null,
      bindingMode: input.bindingMode ?? (input.sourceAgentId ? 'override' : 'use_asis'),
      name,
      description: input.description ?? null,
      instructions: input.instructions ?? '',
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      skillIds: (input.skillIds as never) ?? null,
      toolIds: (input.toolIds as never) ?? null,
      outputSchema: (input.outputSchema as never) ?? null,
      executionConfig: (input.executionConfig as never) ?? null,
      permissions: (input.permissions as never) ?? null,
      version: 1,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const agent = inserted[0];
  if (!agent)
    throw errors.conflict(`An agent named "${name}" already exists in this scope`, { name });

  const snapshot = snapshotOf(agent, {
    skillIds: input.skillIds ?? [],
    toolIds: input.toolIds ?? [],
    version: 1
  });
  const versionId = uuidv7(now);
  db.insert(agentVersions)
    .values({
      id: versionId,
      workspaceId: actor.workspaceId,
      agentId,
      version: 1,
      snapshot: snapshot as never,
      changeNote: 'Initial version',
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdAt: now
    })
    .run();
  db.update(agents).set({ currentVersionId: versionId }).where(eq(agents.id, agentId)).run();

  for (const [index, toolId] of (input.toolIds ?? []).entries()) {
    db.insert(agentTools)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        agentId,
        toolId,
        position: index,
        createdAt: now
      })
      .onConflictDoNothing()
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: 'agent.created',
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'agent',
    entityId: agentId,
    workflowId: agent.workflowId,
    summary: `Agent ${name} created`,
    data: { version: 1, skills: input.skillIds?.length ?? 0, tools: input.toolIds?.length ?? 0 }
  });

  return getAgentView(db, actor, agentId);
}

function validateAgentConfig(input: CreateAgentInput): void {
  const config = input.executionConfig as {
    maxSteps?: number;
    timeoutSeconds?: number;
    temperature?: number;
    reasoningEffort?: unknown;
    reasoningOptions?: unknown;
  } | null;
  if (
    config?.maxSteps !== undefined &&
    (!Number.isInteger(config.maxSteps) || config.maxSteps < 1 || config.maxSteps > 100)
  ) {
    throw errors.validation('maxSteps must be an integer between 1 and 100');
  }
  if (
    config?.timeoutSeconds !== undefined &&
    (config.timeoutSeconds < 5 || config.timeoutSeconds > 3600)
  ) {
    throw errors.validation('timeoutSeconds must be between 5 and 3600');
  }
  if (config?.temperature !== undefined && (config.temperature < 0 || config.temperature > 2)) {
    throw errors.validation('temperature must be between 0 and 2');
  }
  if (config?.reasoningEffort !== undefined && !isReasoningEffort(config.reasoningEffort)) {
    throw errors.validation(
      'reasoningEffort must be one of off, minimal, low, medium, high or max'
    );
  }
  if (
    config?.reasoningOptions !== undefined &&
    (config.reasoningOptions === null ||
      typeof config.reasoningOptions !== 'object' ||
      Array.isArray(config.reasoningOptions))
  ) {
    throw errors.validation('reasoningOptions must be a JSON object of provider-native keys');
  }
  const permissions = input.permissions;
  if (permissions?.native) {
    const unknown = permissions.native.filter((key) => !key.includes('.'));
    if (unknown.length > 0) {
      throw errors.validation(
        'Native permission keys must be namespaced (e.g. ticket.fields.set)',
        {
          keys: unknown
        }
      );
    }
  }
}

function verifySkillIds(db: Executor, workspaceId: string, skillIds: string[]): void {
  if (skillIds.length === 0) return;
  const found = db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds)))
    .all();
  const foundIds = new Set(found.map((row) => row.id));
  const missing = skillIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw errors.validation('Unknown skill(s)', { skillIds: missing });
  }
}

function verifyToolIds(db: Executor, workspaceId: string, toolIds: string[]): void {
  if (toolIds.length === 0) return;
  const found = db
    .select({ id: tools.id })
    .from(tools)
    .where(and(eq(tools.workspaceId, workspaceId), inArray(tools.id, toolIds)))
    .all();
  const foundIds = new Set(found.map((row) => row.id));
  const missing = toolIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw errors.validation('Unknown tool(s)', { toolIds: missing });
  }
}

export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  agentId: string;
  changeNote?: string;
}

/**
 * Update an agent. Any material change creates a new immutable version; a change
 * to only the display name or description still versions, because instructions and
 * configuration are what runs reference.
 */
export function updateAgent(db: Executor, actor: ActorContext, input: UpdateAgentInput): AgentView {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to edit agents');
  const current = requireAgent(db, actor.workspaceId, input.agentId);

  if (input.skillIds) verifySkillIds(db, actor.workspaceId, input.skillIds);
  if (input.toolIds) verifyToolIds(db, actor.workspaceId, input.toolIds);
  validateAgentConfig({ ...current, ...input } as CreateAgentInput);

  const merged = {
    name: input.name?.trim() ?? current.name,
    description: input.description === undefined ? current.description : input.description,
    instructions: input.instructions ?? current.instructions,
    providerId: input.providerId === undefined ? current.providerId : input.providerId,
    modelId: input.modelId === undefined ? current.modelId : input.modelId,
    skillIds: (input.skillIds ?? (current.skillIds as string[] | null) ?? []) as string[],
    toolIds: (input.toolIds ?? (current.toolIds as string[] | null) ?? []) as string[],
    outputSchema: input.outputSchema === undefined ? current.outputSchema : input.outputSchema,
    executionConfig:
      input.executionConfig === undefined ? current.executionConfig : input.executionConfig,
    permissions: input.permissions === undefined ? current.permissions : input.permissions
  };
  if (merged.name.length === 0) throw errors.validation('Agent name must not be empty');

  const nextVersion = current.version + 1;
  const now = Date.now();

  const updated = db
    .update(agents)
    .set({
      name: merged.name,
      description: merged.description ?? null,
      instructions: merged.instructions,
      providerId: merged.providerId ?? null,
      modelId: merged.modelId ?? null,
      skillIds: (merged.skillIds as never) ?? null,
      toolIds: (merged.toolIds as never) ?? null,
      outputSchema: (merged.outputSchema as never) ?? null,
      executionConfig: (merged.executionConfig as never) ?? null,
      permissions: (merged.permissions as never) ?? null,
      version: nextVersion,
      updatedAt: now
    })
    .where(eq(agents.id, input.agentId))
    .returning()
    .all()[0];
  if (!updated) throw errors.notFound('Agent', input.agentId);

  const snapshot = snapshotOf(updated, {
    skillIds: merged.skillIds,
    toolIds: merged.toolIds,
    version: nextVersion
  });
  const versionId = uuidv7(now);
  db.insert(agentVersions)
    .values({
      id: versionId,
      workspaceId: actor.workspaceId,
      agentId: input.agentId,
      version: nextVersion,
      snapshot: snapshot as never,
      changeNote: input.changeNote ?? null,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdAt: now
    })
    .run();
  db.update(agents).set({ currentVersionId: versionId }).where(eq(agents.id, input.agentId)).run();

  db.delete(agentTools).where(eq(agentTools.agentId, input.agentId)).run();
  for (const [index, toolId] of merged.toolIds.entries()) {
    db.insert(agentTools)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        agentId: input.agentId,
        toolId,
        position: index,
        createdAt: now
      })
      .onConflictDoNothing()
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: 'agent.updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'agent',
    entityId: input.agentId,
    workflowId: updated.workflowId,
    summary: `Agent ${updated.name} updated to version ${nextVersion}`,
    data: { version: nextVersion, changeNote: input.changeNote ?? null }
  });

  return getAgentView(db, actor, input.agentId);
}

export function listAgents(
  db: Executor,
  actor: ActorContext,
  options: { workflowId?: string | null; includeArchived?: boolean } = {}
): AgentView[] {
  assertPermission(actor, Permissions.agentRead);
  const conditions = [eq(agents.workspaceId, actor.workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(agents.archivedAt));
  if (options.workflowId !== undefined) {
    conditions.push(
      options.workflowId === null
        ? isNull(agents.workflowId)
        : eq(agents.workflowId, options.workflowId)
    );
  }
  const rows = db
    .select()
    .from(agents)
    .where(and(...conditions))
    .orderBy(asc(agents.name))
    .all();

  return rows.map((agent) => hydrateAgent(db, agent));
}

export function getAgentView(db: Executor, actor: ActorContext, agentId: string): AgentView {
  assertPermission(actor, Permissions.agentRead);
  return hydrateAgent(db, requireAgent(db, actor.workspaceId, agentId));
}

function hydrateAgent(db: Executor, agent: Agent): AgentView {
  const skillIds = (agent.skillIds as string[] | null) ?? [];
  const toolIds = (agent.toolIds as string[] | null) ?? [];

  const skillRows = skillIds.length
    ? db
        .select({
          id: skills.id,
          name: skills.name,
          version: skills.version,
          description: skills.description
        })
        .from(skills)
        .where(inArray(skills.id, skillIds))
        .all()
    : [];
  const toolRows = toolIds.length
    ? db.select({ key: tools.key }).from(tools).where(inArray(tools.id, toolIds)).all()
    : [];

  const versionRows = agent.currentVersionId
    ? db
        .select({ version: agentVersions.version })
        .from(agentVersions)
        .where(eq(agentVersions.id, agent.currentVersionId))
        .limit(1)
        .all()
    : [];

  return {
    ...agent,
    currentVersion: versionRows[0]?.version ?? agent.version,
    skills: skillRows,
    toolKeys: toolRows.map((row) => row.key)
  };
}

export function listAgentVersions(
  db: Executor,
  actor: ActorContext,
  agentId: string
): Array<{ id: string; version: number; changeNote: string | null; createdAt: number }> {
  assertPermission(actor, Permissions.agentRead);
  requireAgent(db, actor.workspaceId, agentId);
  return db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      changeNote: agentVersions.changeNote,
      createdAt: agentVersions.createdAt
    })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .all();
}

export function archiveAgent(db: Executor, actor: ActorContext, agentId: string): void {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to archive agents');
  const agent = requireAgent(db, actor.workspaceId, agentId);
  const activeStates = db
    .select({ count: sql<number>`count(*)` })
    .from(workflowStates)
    .where(eq(workflowStates.agentId, agentId))
    .all();
  if ((activeStates[0]?.count ?? 0) > 0) {
    throw errors.precondition(
      `Agent "${agent.name}" is bound to ${activeStates[0]?.count} state(s). Unbind it first.`
    );
  }
  const now = Date.now();
  db.update(agents).set({ archivedAt: now, updatedAt: now }).where(eq(agents.id, agentId)).run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: 'agent.archived',
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'agent',
    entityId: agentId,
    summary: `Agent ${agent.name} archived`
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface CreateSkillInput {
  name: string;
  description?: string | null;
  category?: string | null;
  workflowId?: string | null;
  instructions?: string;
  examples?: Array<{ title: string; input?: string; output?: string; notes?: string }>;
  references?: Array<{ title: string; url?: string; content?: string }>;
  recommendedToolKeys?: string[];
  sourceSkillId?: string | null;
  bindingMode?: ResourceBindingMode;
}

export interface SkillView extends Skill {
  instructions: string;
  examples: Array<{ title: string; input?: string; output?: string; notes?: string }>;
  references: Array<{ title: string; url?: string; content?: string }>;
  recommendedToolKeys: string[];
}

export function createSkill(db: Executor, actor: ActorContext, input: CreateSkillInput): SkillView {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to create skills');
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Skill name is required');

  const now = Date.now();
  const skillId = uuidv7(now);
  const inserted = db
    .insert(skills)
    .values({
      id: skillId,
      workspaceId: actor.workspaceId,
      workflowId: input.workflowId ?? null,
      sourceSkillId: input.sourceSkillId ?? null,
      bindingMode: input.bindingMode ?? (input.sourceSkillId ? 'override' : 'use_asis'),
      name,
      description: input.description ?? null,
      category: input.category ?? null,
      version: 1,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.conflict(`A skill named "${name}" already exists in this scope`);

  const versionId = uuidv7(now);
  db.insert(skillVersions)
    .values({
      id: versionId,
      workspaceId: actor.workspaceId,
      skillId,
      version: 1,
      instructions: input.instructions ?? '',
      examples: (input.examples as never) ?? null,
      references: (input.references as never) ?? null,
      recommendedToolKeys: (input.recommendedToolKeys as never) ?? null,
      createdAt: now
    })
    .run();
  db.update(skills).set({ currentVersionId: versionId }).where(eq(skills.id, skillId)).run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: 'skill.created',
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'skill',
    entityId: skillId,
    summary: `Skill ${name} created`
  });

  return getSkillView(db, actor, skillId);
}

export function updateSkill(
  db: Executor,
  actor: ActorContext,
  input: Partial<CreateSkillInput> & { skillId: string }
): SkillView {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to edit skills');
  const current = requireSkill(db, actor.workspaceId, input.skillId);
  const currentVersion = current.currentVersionId
    ? db
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.id, current.currentVersionId))
        .limit(1)
        .all()[0]
    : undefined;

  const now = Date.now();
  const nextVersion = current.version + 1;
  const updated = db
    .update(skills)
    .set({
      name: input.name?.trim() ?? current.name,
      description: input.description === undefined ? current.description : input.description,
      category: input.category === undefined ? current.category : input.category,
      version: nextVersion,
      updatedAt: now
    })
    .where(eq(skills.id, input.skillId))
    .returning()
    .all()[0];
  if (!updated) throw errors.notFound('Skill', input.skillId);

  const versionId = uuidv7(now);
  db.insert(skillVersions)
    .values({
      id: versionId,
      workspaceId: actor.workspaceId,
      skillId: input.skillId,
      version: nextVersion,
      instructions: input.instructions ?? currentVersion?.instructions ?? '',
      examples: ((input.examples ?? (currentVersion?.examples as never)) as never) ?? null,
      references: ((input.references ?? (currentVersion?.references as never)) as never) ?? null,
      recommendedToolKeys:
        ((input.recommendedToolKeys ?? (currentVersion?.recommendedToolKeys as never)) as never) ??
        null,
      createdAt: now
    })
    .run();
  db.update(skills).set({ currentVersionId: versionId }).where(eq(skills.id, input.skillId)).run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: 'skill.updated',
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'skill',
    entityId: input.skillId,
    summary: `Skill ${updated.name} updated to version ${nextVersion}`,
    data: { version: nextVersion }
  });

  return getSkillView(db, actor, input.skillId);
}

export function requireSkill(db: Executor, workspaceId: string, skillId: string): Skill {
  const rows = db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const skill = rows[0];
  if (!skill) throw errors.notFound('Skill', skillId);
  return skill;
}

function resolveSkillVersion(db: Executor, skill: Skill): SkillVersion | undefined {
  if (skill.currentVersionId) {
    const rows = db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.id, skill.currentVersionId))
      .limit(1)
      .all();
    if (rows[0]) return rows[0];
  }
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id))
    .orderBy(desc(skillVersions.version))
    .limit(1)
    .all()[0];
}

function hydrateSkill(db: Executor, skill: Skill): SkillView {
  const version = resolveSkillVersion(db, skill);
  return {
    ...skill,
    instructions: version?.instructions ?? '',
    examples: (version?.examples as SkillView['examples'] | null) ?? [],
    references: (version?.references as SkillView['references'] | null) ?? [],
    recommendedToolKeys: (version?.recommendedToolKeys as string[] | null) ?? []
  };
}

export function getSkillView(db: Executor, actor: ActorContext, skillId: string): SkillView {
  assertPermission(actor, Permissions.agentRead);
  return hydrateSkill(db, requireSkill(db, actor.workspaceId, skillId));
}

export function listSkills(
  db: Executor,
  actor: ActorContext,
  options: { includeArchived?: boolean } = {}
): SkillView[] {
  assertPermission(actor, Permissions.agentRead);
  const conditions = [eq(skills.workspaceId, actor.workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(skills.archivedAt));
  return db
    .select()
    .from(skills)
    .where(and(...conditions))
    .orderBy(asc(skills.name))
    .all()
    .map((skill) => hydrateSkill(db, skill));
}

export function archiveSkill(db: Executor, actor: ActorContext, skillId: string): void {
  assertPermission(actor, Permissions.agentWrite, 'Not permitted to archive skills');
  const skill = requireSkill(db, actor.workspaceId, skillId);
  const referencing = db
    .select({ count: sql<number>`count(*)` })
    .from(agents)
    .where(sql`${agents.skillIds} like ${`%${skillId}%`}`)
    .all();
  if ((referencing[0]?.count ?? 0) > 0) {
    throw errors.precondition(
      `Skill "${skill.name}" is used by ${referencing[0]?.count} agent(s). Detach it first.`
    );
  }
  const now = Date.now();
  db.update(skills).set({ archivedAt: now, updatedAt: now }).where(eq(skills.id, skillId)).run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: 'skill.archived',
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'skill',
    entityId: skillId,
    summary: `Skill ${skill.name} archived`
  });
}

/**
 * Assemble the skill instructions an agent run should carry.
 *
 * Skills are injected as instructions rather than executed, and only the skills
 * the agent actually references are included — this is the token-efficiency rule
 * from the plan made concrete.
 */
export function assembleSkillInstructions(
  db: Executor,
  workspaceId: string,
  skillIds: string[]
): Array<{
  id: string;
  name: string;
  version: number;
  instructions: string;
  examples: unknown;
  references: unknown;
}> {
  if (skillIds.length === 0) return [];
  const rows = db
    .select()
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds)))
    .all();
  return rows.map((skill) => {
    const version = resolveSkillVersion(db, skill);
    return {
      id: skill.id,
      name: skill.name,
      version: version?.version ?? skill.version,
      instructions: version?.instructions ?? '',
      examples: version?.examples ?? null,
      references: version?.references ?? null
    };
  });
}

/** Tools an agent may call, resolved to their stored descriptors. */
export function agentToolRows(db: Executor, workspaceId: string, toolIds: string[]): Tool[] {
  if (toolIds.length === 0) return [];
  return db
    .select()
    .from(tools)
    .where(
      and(eq(tools.workspaceId, workspaceId), inArray(tools.id, toolIds), eq(tools.enabled, true))
    )
    .all();
}

/** Agents referenced by a workflow's states, for the workflow configuration view. */
export function agentsForWorkflow(db: Executor, workspaceId: string, workflowId: string): Agent[] {
  return db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        sql`(${agents.workflowId} = ${workflowId} OR ${agents.workflowId} IS NULL)`,
        isNull(agents.archivedAt)
      )
    )
    .orderBy(asc(agents.name))
    .all();
}

/** Run counts per agent, for the agents list. */
export function agentRunStats(
  db: Executor,
  workspaceId: string,
  agentIds: string[]
): Map<string, { runs: number; failures: number; lastRunAt: number | null }> {
  const out = new Map<string, { runs: number; failures: number; lastRunAt: number | null }>();
  if (agentIds.length === 0) return out;
  const rows = db
    .select({
      agentId: agentRuns.agentId,
      runs: sql<number>`count(*)`,
      failures: sql<number>`sum(case when ${agentRuns.status} = 'failed' then 1 else 0 end)`,
      lastRunAt: sql<number>`max(${agentRuns.createdAt})`
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), inArray(agentRuns.agentId, agentIds)))
    .groupBy(agentRuns.agentId)
    .all();
  for (const row of rows) {
    out.set(row.agentId, {
      runs: row.runs,
      failures: row.failures ?? 0,
      lastRunAt: row.lastRunAt ?? null
    });
  }
  return out;
}

export type { AgentPermissions, AgentSnapshot };
