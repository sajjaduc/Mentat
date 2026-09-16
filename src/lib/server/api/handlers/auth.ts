/**
 * Authentication, workspaces, members and teams.
 *
 * Session handling lives in the SvelteKit adapter (`hooks.server.ts` sets locals);
 * these routes cover everything after that: sign-up/sign-in, workspace switching,
 * membership administration and the bootstrap payload the app shell needs.
 */

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { countPendingApprovals } from '../../approvals/service';
import { verifyPassword } from '../../auth/passwords';
import {
  actorForMember,
  createSession,
  listMemberships,
  membershipFor,
  resolveSession,
  revokeSession,
  SESSION_COOKIE,
  switchWorkspace,
  teamIdsForUser
} from '../../auth/sessions';
import { allowSignup, env } from '../../config/env';
import { Permissions, permissionsForRole } from '../../core/context';
import { errors } from '../../core/errors';
import type { Executor } from '../../db/client';
import { workspaces } from '../../db/schema';
import {
  addMember,
  createTeam,
  createWorkspaceWithOwner,
  ensureStarterWorkspace,
  findUserByEmail,
  getUser,
  listMembers,
  listTeams,
  listWorkspacesForUser,
  registerUser,
  removeMember,
  requireWorkspace,
  setTeamMembers,
  updateMemberRole,
  updateWorkspace
} from '../../workspaces/service';
import { route } from '../types';

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(10).max(200);

export const authRoutes = [
  route({
    method: 'GET',
    path: '/health',
    public: true,
    summary: 'Liveness, schema and worker status',
    handler: async ({ db }) => {
      // A raw catalog query is appropriate here: this endpoint reports on the
      // local SQLite instance itself rather than on domain data.
      const tables = db.get<{ n: number }>(
        sql`select count(*) as n from sqlite_master where type = 'table'`
      );
      return {
        body: {
          ok: true,
          version: '0.1.0',
          environment: env().NODE_ENV,
          tables: tables?.n ?? 0,
          masterKeyFromEnv: Boolean(env().MENTAT_MASTER_KEY),
          workerEnabled: env().MENTAT_WORKER_ENABLED
        }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/auth/register',
    public: true,
    summary: 'Create the first account and its starter workspace',
    body: z.object({
      email: emailSchema,
      name: z.string().trim().min(1).max(120),
      password: passwordSchema
    }),
    handler: async ({ db, body, request }) => {
      if (!allowSignup()) throw errors.forbidden('Sign-up is disabled on this instance');
      const user = await registerUser(
        db,
        body as { email: string; name: string; password: string }
      );
      const workspace = ensureStarterWorkspace(db, user);
      const session = await createSession(db, user, {
        activeWorkspaceId: workspace?.id ?? null,
        userAgent: request.headers.get('user-agent'),
        ip: clientIp(request)
      });
      return {
        status: 201,
        body: { user: publicUser(user), workspaceId: workspace?.id ?? null },
        headers: cookieHeader(session.token)
      };
    }
  }),

  route({
    method: 'POST',
    path: '/auth/login',
    public: true,
    summary: 'Sign in with email and password',
    body: z.object({ email: emailSchema, password: z.string().min(1) }),
    handler: async ({ db, body, request }) => {
      const input = body as { email: string; password: string };
      const user = findUserByEmail(db, input.email);
      const ok = await verifyPassword(input.password, user?.passwordHash ?? null);
      if (!user || !ok) {
        // Uniform failure: do not reveal whether the account exists.
        throw errors.unauthorized('Email or password is incorrect');
      }
      if (user.disabledAt) throw errors.forbidden('This account is disabled');
      const memberships = listMemberships(db, user.id);
      const session = await createSession(db, user, {
        activeWorkspaceId: memberships[0]?.workspaceId ?? null,
        userAgent: request.headers.get('user-agent'),
        ip: clientIp(request)
      });
      return {
        body: { user: publicUser(user), workspaces: memberships },
        headers: cookieHeader(session.token)
      };
    }
  }),

  route({
    method: 'POST',
    path: '/auth/logout',
    summary: 'End the current session',
    handler: async ({ db, actor, request }) => {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      if (token) {
        const context = resolveSession(db, token);
        if (context) revokeSession(db, context.session.id, context.user);
      }
      void actor;
      return { body: { ok: true }, headers: clearCookieHeader() };
    }
  }),

  route({
    method: 'GET',
    path: '/auth/me',
    summary: 'Current user, memberships, workspace and navigation counts',
    handler: async ({ db, actor }) => {
      const memberships = listMemberships(db, actor.actorId as string);
      const workspace = actor.workspaceId ? requireWorkspace(db, actor.workspaceId) : null;
      const user = actor.actorId ? getUser(db, actor.actorId) : null;
      return {
        body: {
          user: user ? publicUser(user) : null,
          role: actor.role,
          permissions: [...actor.permissions].filter((permission) => permission.includes(':')),
          workspaces: memberships,
          workspace,
          counts:
            user && workspace
              ? { pendingApprovals: countPendingApprovals(db, workspace.id) }
              : { pendingApprovals: 0 }
        }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/auth/switch-workspace',
    summary: 'Switch the active workspace for this session',
    body: z.object({ workspaceId: z.string().min(1) }),
    handler: async ({ db, actor, body, request }) => {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      if (!token) throw errors.unauthorized();
      switchWorkspace(
        db,
        actor.sessionId as string,
        actor.actorId as string,
        (body as { workspaceId: string }).workspaceId
      );
      const membership = membershipFor(
        db,
        actor.actorId as string,
        (body as { workspaceId: string }).workspaceId
      );
      return { body: { ok: true, workspaceId: membership?.workspaceId ?? null } };
    }
  }),

  // ---------------------------------------------------------------- workspaces
  route({
    method: 'GET',
    path: '/workspaces',
    summary: 'Workspaces the current user belongs to',
    handler: async ({ db, actor }) => ({
      body: { workspaces: listWorkspacesForUser(db, actor.actorId as string) }
    })
  }),

  route({
    method: 'POST',
    path: '/workspaces',
    permission: Permissions.workspaceRead,
    summary: 'Create a workspace owned by the current user',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish()
    }),
    handler: async ({ db, actor, body }) => {
      const input = body as { name: string; description?: string | null };
      const workspace = createWorkspaceWithOwner(db, {
        name: input.name,
        description: input.description ?? null,
        ownerUserId: actor.actorId as string
      });
      return { status: 201, body: { workspace } };
    }
  }),

  route({
    method: 'GET',
    path: '/workspaces/:id',
    permission: Permissions.workspaceRead,
    summary: 'Workspace detail including effective storage settings',
    handler: async ({ db, actor, params }) => {
      // Workspace reads are scoped to the active workspace: another tenant's id is
      // indistinguishable from a missing one.
      if (params.id !== actor.workspaceId) throw errors.notFound('Workspace', params.id);
      return { body: { workspace: requireWorkspace(db, actor.workspaceId) } };
    }
  }),

  route({
    method: 'PATCH',
    path: '/workspaces/:id',
    permission: Permissions.workspaceAdmin,
    summary: 'Update workspace name, description or settings',
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(2000).nullish(),
      settings: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: async ({ db, actor, params, body }) => {
      if (params.id !== actor.workspaceId) throw errors.notFound('Workspace', params.id);
      return { body: { workspace: updateWorkspace(db, actor, body as never) } };
    }
  }),

  route({
    method: 'GET',
    path: '/workspaces/:id/members',
    permission: Permissions.workspaceRead,
    summary: 'List workspace members',
    handler: async ({ db, actor, params }) => {
      if (params.id !== actor.workspaceId) throw errors.notFound('Workspace', params.id);
      return { body: { members: listMembers(db, actor) } };
    }
  }),

  route({
    method: 'POST',
    path: '/workspaces/:id/members',
    permission: Permissions.memberManage,
    summary: 'Add a member, creating an invitation account when needed',
    body: z.object({
      email: emailSchema,
      name: z.string().trim().max(120).optional(),
      role: z.enum(['owner', 'admin', 'member']).optional(),
      title: z.string().max(120).nullish()
    }),
    handler: async ({ db, actor, params, body }) => {
      if (params.id !== actor.workspaceId) throw errors.notFound('Workspace', params.id);
      return { status: 201, body: { member: addMember(db, actor, body as never) } };
    }
  }),

  route({
    method: 'PATCH',
    path: '/workspaces/:id/members/:userId',
    permission: Permissions.memberManage,
    summary: 'Change a member role, status or title',
    body: z.object({
      role: z.enum(['owner', 'admin', 'member']).optional(),
      status: z.enum(['active', 'invited', 'suspended']).optional(),
      title: z.string().max(120).nullish()
    }),
    handler: async ({ db, actor, params, body }) => {
      if (params.id !== actor.workspaceId) throw errors.notFound('Workspace', params.id);
      const memberInput = body as {
        role?: 'owner' | 'admin' | 'member';
        status?: 'active' | 'invited' | 'suspended';
        title?: string | null;
      };
      updateMemberRole(db, actor, {
        userId: params.userId as string,
        role: memberInput.role,
        // `invited` is only reachable through addMember; reactivation is explicit.
        status: memberInput.status === 'invited' ? 'active' : memberInput.status,
        title: memberInput.title
      });
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/workspaces/:id/members/:userId',
    permission: Permissions.memberManage,
    summary: 'Remove a member',
    handler: async ({ db, actor, params }) => {
      if (params.id !== actor.workspaceId) throw errors.notFound('Workspace', params.id);
      removeMember(db, actor, params.userId as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/teams',
    permission: Permissions.workspaceRead,
    summary: 'List teams with their members',
    handler: async ({ db, actor }) => ({ body: { teams: listTeams(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/teams',
    permission: Permissions.memberManage,
    summary: 'Create a team',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      color: z.string().max(40).nullish(),
      memberIds: z.array(z.string()).optional()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { team: createTeam(db, actor, body as never) }
    })
  }),

  route({
    method: 'PUT',
    path: '/teams/:id/members',
    permission: Permissions.memberManage,
    summary: 'Replace a team’s membership',
    body: z.object({ userIds: z.array(z.string()) }),
    handler: async ({ db, actor, params, body }) => {
      setTeamMembers(db, actor, params.id as string, (body as { userIds: string[] }).userIds);
      return { body: { ok: true } };
    }
  })
];

function publicUser(user: {
  id: string;
  email: string;
  name: string;
  timezone: string;
  isPlatformAdmin: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    isPlatformAdmin: user.isPlatformAdmin
  };
}

function cookieHeader(token: string): Record<string, string> {
  const maxAge = env().MENTAT_SESSION_DAYS * 24 * 60 * 60;
  const secure = env().MENTAT_COOKIE_SECURE ? '; Secure' : '';
  return {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  };
}

function clearCookieHeader(): Record<string, string> {
  return { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function clientIp(request: Request): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    null
  );
}

/** Re-exported so the SvelteKit adapter can build the same actor context. */
export { actorForMember, membershipFor, permissionsForRole, teamIdsForUser };

/** Test helper: assert a workspace row exists before writing against it. */
export async function workspaceExists(db: Executor, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId)))
    .limit(1)
    .all();
  return rows.length > 0;
}
