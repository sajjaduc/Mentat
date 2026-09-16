/**
 * Session management.
 *
 * Sessions are opaque random tokens in an HttpOnly cookie. Only the SHA-256 of the
 * token is stored, so a database read cannot be replayed as a login. A session
 * carries the currently active workspace, which lets one human belong to several
 * workspaces without re-authenticating.
 */
import { and, eq, isNull, lt } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { env } from '../config/env';
import { type ActorContext, createActorContext, permissionsForRole } from '../core/context';
import { errors } from '../core/errors';
import { sha256Hex, sha256HexSync } from '../core/hash';
import { randomToken, uuidv7 } from '../core/ids';
import { moduleLogger } from '../core/logger';
import type { Executor } from '../db/client';
import {
  type Session,
  sessions,
  teamMembers,
  type User,
  users,
  workspaceMembers,
  workspaces
} from '../db/schema';

export const SESSION_COOKIE = 'mentat_session';

export interface SessionContext {
  session: Session;
  user: User;
  workspaceId: string | null;
}

export interface CreatedSession {
  token: string;
  session: Session;
  expiresAt: number;
}

export interface WorkspaceMembershipView {
  workspaceId: string;
  name: string;
  slug: string;
  role: 'owner' | 'admin' | 'member';
  status: string;
}

const log = moduleLogger('auth.sessions');

export async function createSession(
  db: Executor,
  user: User,
  options: {
    activeWorkspaceId?: string | null;
    userAgent?: string | null;
    ip?: string | null;
  } = {}
): Promise<CreatedSession> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + env().MENTAT_SESSION_DAYS * 24 * 60 * 60 * 1000;

  const inserted = await db
    .insert(sessions)
    .values({
      id: uuidv7(now),
      userId: user.id,
      tokenHash,
      activeWorkspaceId: options.activeWorkspaceId ?? null,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      userAgent: options.userAgent?.slice(0, 500) ?? null,
      ipAddress: options.ip ?? null
    })
    .returning()
    .all();

  const session = inserted[0];
  if (!session) throw errors.internal('Failed to create session');

  // Sign-in is recorded against the active workspace so the workspace activity
  // view can show it; workspaceless sign-ins are not audited at workspace level.
  if (options.activeWorkspaceId) {
    writeAudit(db, {
      workspaceId: options.activeWorkspaceId,
      action: AuditActions.userSignedIn,
      actorType: 'user',
      actorId: user.id,
      actorLabel: user.name,
      entityType: 'session',
      entityId: session.id,
      summary: `${user.name} signed in`
    });
  }

  log.debug('session created', { userId: user.id, expiresAt });
  return { token, session, expiresAt };
}

/**
 * Look up a session by its opaque token. Returns null for unknown, expired or
 * revoked tokens — the caller turns that into an unauthenticated request.
 */
export function resolveSession(db: Executor, token: string): SessionContext | null {
  if (!token || token.length < 16) return null;
  const tokenHash = sha256HexSync(new TextEncoder().encode(token));

  const rows = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1)
    .all();

  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt <= Date.now()) return null;
  const disabledAt = row.user.disabledAt;
  if (disabledAt !== null && disabledAt !== undefined) return null;

  return { session: row.session, user: row.user, workspaceId: row.session.activeWorkspaceId };
}

export function touchSession(db: Executor, sessionId: string): void {
  db.update(sessions).set({ lastSeenAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
}

export function revokeSession(db: Executor, sessionId: string, user: User): void {
  db.update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
  log.debug('session revoked', { sessionId, userId: user.id });
}

export function revokeAllSessions(db: Executor, userId: string): number {
  const revoked = db
    .update(sessions)
    .set({ revokedAt: Date.now() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
    .all();
  return revoked.length;
}

/** Remove sessions that expired more than 90 days ago. */
export async function purgeExpiredSessions(db: Executor, now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now - 90 * 24 * 60 * 60 * 1000))
    .returning({ id: sessions.id })
    .all();
  return deleted.length;
}

export function listMemberships(db: Executor, userId: string): WorkspaceMembershipView[] {
  return db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
      status: workspaceMembers.status
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .orderBy(workspaces.name)
    .all();
}

export function membershipFor(
  db: Executor,
  userId: string,
  workspaceId: string
): WorkspaceMembershipView | null {
  const rows = db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
      status: workspaceMembers.status
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.status, 'active')
      )
    )
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/** Switch the session's active workspace after verifying membership. */
export function switchWorkspace(
  db: Executor,
  sessionId: string,
  userId: string,
  workspaceId: string
): void {
  const membership = membershipFor(db, userId, workspaceId);
  if (!membership) throw errors.notFound('Workspace', workspaceId);
  db.update(sessions)
    .set({ activeWorkspaceId: workspaceId })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .run();
}

/** Build the actor context for a human request in a workspace. */
export function actorForMember(
  membership: WorkspaceMembershipView,
  user: User,
  options: { sessionId?: string | null; requestId?: string | null; teamIds?: string[] } = {}
): ActorContext {
  return createActorContext({
    workspaceId: membership.workspaceId,
    actorType: 'user',
    actorId: user.id,
    actorLabel: user.name,
    role: membership.role,
    permissions: permissionsForRole(membership.role),
    sessionId: options.sessionId ?? null,
    requestId: options.requestId ?? null,
    teamIds: options.teamIds ?? []
  });
}

/** Team ids a user belongs to, for team-scoped human gates. */
export function teamIdsForUser(db: Executor, workspaceId: string, userId: string): string[] {
  const rows = db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.workspaceId, workspaceId), eq(teamMembers.userId, userId)))
    .all();
  return rows.map((row) => row.teamId);
}
