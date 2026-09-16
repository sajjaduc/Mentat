/**
 * Workspaces, members and teams.
 *
 * A workspace is the tenant boundary: every other module scopes its queries by
 * `workspaceId`. Membership roles are practical (owner/admin/member) and map onto
 * a permission set in `core/context`, so authorization is checkable from one place
 * and never re-derived per call site.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { hashPassword } from '../auth/passwords';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { slugify, uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type Team,
  teamMembers,
  teams,
  type User,
  users,
  type Workspace,
  type WorkspaceRole,
  type WorkspaceSettings,
  workspaceMembers,
  workspaces
} from '../db/schema';
import { ensureNativeToolRows } from '../tools/catalog';

export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}

export function createUserRecord(
  db: Executor,
  input: { email: string; name: string; passwordHash?: string | null; isPlatformAdmin?: boolean }
): User {
  const email = normalizeEmail(input.email);
  const existing = db.select().from(users).where(eq(users.email, email)).limit(1).all();
  if (existing[0]) throw errors.conflict('An account with this email already exists', { email });

  const now = Date.now();
  const inserted = db
    .insert(users)
    .values({
      id: uuidv7(now),
      email,
      name: input.name.trim() || email.split('@')[0] || 'User',
      passwordHash: input.passwordHash ?? null,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
      timezone: 'UTC',
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const user = inserted[0];
  if (!user) throw errors.internal('Failed to create user');

  writeAudit(db, {
    // Account creation is a platform event, not a tenant event.
    workspaceId: null,
    action: AuditActions.userCreated,
    actorType: 'system',
    entityType: 'user',
    entityId: user.id,
    summary: `User ${user.name} created`
  });

  return user;
}

export async function registerUser(
  db: Executor,
  input: { email: string; name: string; password: string }
): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return createUserRecord(db, { email: input.email, name: input.name, passwordHash });
}

export function findUserByEmail(db: Executor, email: string): User | null {
  const rows = db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function getUser(db: Executor, userId: string): User {
  const rows = db.select().from(users).where(eq(users.id, userId)).limit(1).all();
  const user = rows[0];
  if (!user) throw errors.notFound('User', userId);
  return user;
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw errors.validation('A valid email address is required');
  }
  return normalized;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  description?: string | null;
  settings?: WorkspaceSettings | null;
}

/**
 * Create a workspace with its founding owner. The owner membership and the
 * workspace row are created in one transaction so a workspace can never exist
 * without an owner.
 */
export function createWorkspaceWithOwner(
  db: Executor,
  input: CreateWorkspaceInput & { ownerUserId: string }
): Workspace {
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Workspace name is required');

  const baseSlug = slugify(input.slug ?? name, 'workspace');
  let slug = baseSlug;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const taken = db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1).all();
    if (!taken[0]) break;
    slug = `${baseSlug}-${attempt + 1}`;
  }

  const now = Date.now();
  const workspaceId = uuidv7(now);
  const inserted = db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name,
      slug,
      description: input.description ?? null,
      settings: (input.settings as never) ?? null,
      storageProvider: 'local',
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const workspace = inserted[0];
  if (!workspace) throw errors.internal('Failed to create workspace');

  db.insert(workspaceMembers)
    .values({
      id: uuidv7(now),
      workspaceId,
      userId: input.ownerUserId,
      role: 'owner',
      status: 'active',
      createdAt: now,
      updatedAt: now
    })
    .run();

  // Seed the bindable tool catalogue so agents in a brand-new workspace can be
  // granted capabilities straight away.
  ensureNativeToolRows(db, workspaceId);

  writeAudit(db, {
    workspaceId,
    action: AuditActions.workspaceCreated,
    actorType: 'user',
    actorId: input.ownerUserId,
    entityType: 'workspace',
    entityId: workspaceId,
    summary: `Workspace ${name} created`
  });

  return workspace;
}

export function listWorkspacesForUser(db: Executor, userId: string): WorkspaceWithRole[] {
  const rows = db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, 'active'),
        isNull(workspaces.archivedAt)
      )
    )
    .orderBy(workspaces.name)
    .all();
  return rows.map((row) => ({ ...row.workspace, role: row.role }));
}

export function requireWorkspace(db: Executor, workspaceId: string): Workspace {
  const rows = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).all();
  const workspace = rows[0];
  if (!workspace) throw errors.notFound('Workspace', workspaceId);
  return workspace;
}

export function updateWorkspace(
  db: Executor,
  actor: ActorContext,
  input: {
    name?: string;
    description?: string | null;
    settings?: WorkspaceSettings | null;
    storageProvider?: 'local' | 'gcs';
  }
): Workspace {
  assertPermission(actor, Permissions.workspaceAdmin, 'Not permitted to update the workspace');
  const current = requireWorkspace(db, actor.workspaceId);

  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) {
    throw errors.validation('Workspace name must not be empty');
  }

  const updated = db
    .update(workspaces)
    .set({
      name: name ?? current.name,
      description: input.description === undefined ? current.description : input.description,
      settings:
        input.settings === undefined ? current.settings : ((input.settings as never) ?? null),
      storageProvider: input.storageProvider ?? current.storageProvider,
      updatedAt: Date.now()
    })
    .where(eq(workspaces.id, actor.workspaceId))
    .returning()
    .all();

  const workspace = updated[0];
  if (!workspace) throw errors.notFound('Workspace', actor.workspaceId);

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workspaceUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workspace',
    entityId: workspace.id,
    summary: 'Workspace settings updated',
    data: { name: workspace.name, storageProvider: workspace.storageProvider }
  });

  return workspace;
}

export interface MemberView {
  memberId: string;
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  status: string;
  title: string | null;
  createdAt: number;
}

export function listMembers(db: Executor, actor: ActorContext): MemberView[] {
  assertPermission(actor, Permissions.workspaceRead);
  return db
    .select({
      memberId: workspaceMembers.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: workspaceMembers.role,
      status: workspaceMembers.status,
      title: workspaceMembers.title,
      createdAt: workspaceMembers.createdAt
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, actor.workspaceId))
    .orderBy(users.name)
    .all();
}

/**
 * Add a member. When the email has no account yet, an account is created in
 * `invited` state with no password so the invitation flow can set one later; the
 * membership and account are created together.
 */
export function addMember(
  db: Executor,
  actor: ActorContext,
  input: { email: string; name?: string; role?: WorkspaceRole; title?: string | null }
): MemberView {
  assertPermission(actor, Permissions.memberManage, 'Not permitted to manage members');
  const email = normalizeEmail(input.email);
  const now = Date.now();

  let user = findUserByEmail(db, email);
  if (!user) {
    user = createUserRecord(db, {
      email,
      name: input.name ?? email.split('@')[0] ?? 'Member',
      passwordHash: null
    });
  }

  const existing = db
    .select()
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, actor.workspaceId), eq(workspaceMembers.userId, user.id))
    )
    .limit(1)
    .all();
  if (existing[0]) {
    throw errors.conflict('This person is already a member of the workspace', { email });
  }

  db.insert(workspaceMembers)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      userId: user.id,
      role: input.role ?? 'member',
      status: 'invited',
      title: input.title ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.memberAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workspace_member',
    entityId: user.id,
    summary: `${user.name} added as ${input.role ?? 'member'}`
  });

  return {
    memberId: '',
    userId: user.id,
    email: user.email,
    name: user.name,
    role: input.role ?? 'member',
    status: 'invited',
    title: input.title ?? null,
    createdAt: now
  };
}

export function updateMemberRole(
  db: Executor,
  actor: ActorContext,
  input: {
    userId: string;
    role?: WorkspaceRole;
    status?: 'active' | 'suspended';
    title?: string | null;
  }
): void {
  assertPermission(actor, Permissions.memberManage, 'Not permitted to manage members');

  const target = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, actor.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .limit(1)
    .all();
  const membership = target[0];
  if (!membership) throw errors.notFound('Member', input.userId);

  // The last owner cannot be demoted or suspended: a workspace must always have an
  // owner who can administer it.
  if (membership.role === 'owner' && input.role !== undefined && input.role !== 'owner') {
    assertNotLastOwner(db, actor.workspaceId, input.userId);
  }
  if (membership.role === 'owner' && input.status === 'suspended') {
    assertNotLastOwner(db, actor.workspaceId, input.userId);
  }

  const now = Date.now();
  db.update(workspaceMembers)
    .set({
      role: input.role ?? membership.role,
      status: input.status ?? membership.status,
      title: input.title === undefined ? membership.title : input.title,
      updatedAt: now
    })
    .where(eq(workspaceMembers.id, membership.id))
    .run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.memberRoleChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workspace_member',
    entityId: input.userId,
    summary: `Member role updated to ${input.role ?? membership.role}`,
    data: { role: input.role ?? membership.role, status: input.status ?? membership.status }
  });
}

function assertNotLastOwner(db: Executor, workspaceId: string, userId: string): void {
  const others = db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, 'owner'),
        ne(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, 'active')
      )
    )
    .all();
  if ((others[0]?.count ?? 0) === 0) {
    throw errors.precondition('A workspace must always have at least one active owner');
  }
}

export function removeMember(db: Executor, actor: ActorContext, userId: string): void {
  assertPermission(actor, Permissions.memberManage, 'Not permitted to manage members');
  const target = db
    .select()
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, actor.workspaceId), eq(workspaceMembers.userId, userId))
    )
    .limit(1)
    .all();
  const membership = target[0];
  if (!membership) throw errors.notFound('Member', userId);
  if (membership.role === 'owner') assertNotLastOwner(db, actor.workspaceId, userId);

  db.delete(workspaceMembers).where(eq(workspaceMembers.id, membership.id)).run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.memberRoleChanged,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workspace_member',
    entityId: userId,
    summary: 'Member removed from workspace',
    data: { removed: true }
  });
}

export interface TeamView extends Team {
  memberIds: string[];
}

export function createTeam(
  db: Executor,
  actor: ActorContext,
  input: { name: string; description?: string | null; color?: string | null; memberIds?: string[] }
): Team {
  assertPermission(actor, Permissions.memberManage, 'Not permitted to manage teams');
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Team name is required');

  const now = Date.now();
  const id = uuidv7(now);
  const inserted = db
    .insert(teams)
    .values({
      id,
      workspaceId: actor.workspaceId,
      name,
      description: input.description ?? null,
      color: input.color ?? null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const team = inserted[0];
  if (!team) throw errors.conflict('A team with this name already exists', { name });

  for (const userId of input.memberIds ?? []) {
    db.insert(teamMembers)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        teamId: id,
        userId,
        createdAt: now
      })
      .onConflictDoNothing()
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workspaceUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'team',
    entityId: id,
    summary: `Team ${name} created`
  });

  return team;
}

export function listTeams(db: Executor, actor: ActorContext): TeamView[] {
  assertPermission(actor, Permissions.workspaceRead);
  const teamRows = db
    .select()
    .from(teams)
    .where(eq(teams.workspaceId, actor.workspaceId))
    .orderBy(teams.name)
    .all();
  const memberRows = db
    .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.workspaceId, actor.workspaceId))
    .all();

  const byTeam = new Map<string, string[]>();
  for (const row of memberRows) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push(row.userId);
    byTeam.set(row.teamId, list);
  }
  return teamRows.map((team) => ({ ...team, memberIds: byTeam.get(team.id) ?? [] }));
}

export function setTeamMembers(
  db: Executor,
  actor: ActorContext,
  teamId: string,
  userIds: string[]
): void {
  assertPermission(actor, Permissions.memberManage, 'Not permitted to manage teams');
  const team = db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, actor.workspaceId)))
    .limit(1)
    .all();
  if (!team[0]) throw errors.notFound('Team', teamId);

  const now = Date.now();
  db.delete(teamMembers).where(eq(teamMembers.teamId, teamId)).run();
  for (const userId of userIds) {
    db.insert(teamMembers)
      .values({ id: uuidv7(now), workspaceId: actor.workspaceId, teamId, userId, createdAt: now })
      .onConflictDoNothing()
      .run();
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workspaceUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'team',
    entityId: teamId,
    summary: 'Team membership updated',
    data: { memberIds: userIds }
  });
}

/**
 * First-run bootstrap: give a brand-new installation a workspace so a fresh clone
 * is usable immediately. Returns null when any workspace already exists.
 */
export function ensureStarterWorkspace(db: Executor, owner: User): Workspace | null {
  const anyWorkspace = db.select().from(workspaces).limit(1).all();
  if (anyWorkspace[0]) return null;
  return createWorkspaceWithOwner(db, {
    name: `${owner.name.split(' ')[0] ?? 'My'}'s Workspace`,
    ownerUserId: owner.id
  });
}
