/**
 * Request/execution context and authorization primitives.
 *
 * Every service method receives an `ActorContext`. It carries the workspace
 * boundary, the acting identity, and the permission set derived from membership
 * plus resource policy. Repositories enforce `workspaceId`; services enforce
 * permissions. Tenant isolation is therefore checkable in one place and testable
 * from the outside.
 */
import type { ActorType, WorkspaceRole } from '../db/schema';
import { errors } from './errors';

export interface ActorContext {
  workspaceId: string;
  /** Who is acting. `system` covers workers and scheduled maintenance. */
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  /** Workspace role for humans; agents get `agent` and rely on granted permissions. */
  role: WorkspaceRole | 'agent' | 'service';
  /** Effective permission keys, e.g. `ticket:write`, `workflow:admin`. */
  permissions: Set<string>;
  /** Populated for agent runs so services can attribute changes precisely. */
  runId?: string | null;
  toolCallId?: string | null;
  /** Request correlation id. */
  requestId?: string | null;
  /** Session id for humans, when authenticated through the browser. */
  sessionId?: string | null;
  /** Team ids the actor belongs to; used by team-scoped gates. */
  teamIds?: string[];
}

export interface PermissionGrant {
  key: string;
}

export const Permissions = {
  workspaceRead: 'workspace:read',
  workspaceAdmin: 'workspace:admin',
  memberManage: 'workspace:member:manage',
  workflowRead: 'workflow:read',
  workflowWrite: 'workflow:write',
  workflowAdmin: 'workflow:admin',
  ticketRead: 'ticket:read',
  ticketWrite: 'ticket:write',
  ticketAssign: 'ticket:assign',
  ticketTransfer: 'ticket:transfer',
  ticketCreate: 'ticket:create',
  ticketDelete: 'ticket:delete',
  approvalRead: 'approval:read',
  approvalDecide: 'approval:decide',
  agentRead: 'agent:read',
  agentWrite: 'agent:write',
  runRead: 'run:read',
  runExecute: 'run:execute',
  runCancel: 'run:cancel',
  httpRead: 'http:read',
  httpWrite: 'http:write',
  httpInvoke: 'http:invoke',
  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileDelete: 'file:delete',
  secretRead: 'secret:read',
  secretWrite: 'secret:write',
  configRead: 'config:read',
  configWrite: 'config:write',
  providerRead: 'provider:read',
  providerWrite: 'provider:write',
  analyticsRead: 'analytics:read',
  analyticsWrite: 'analytics:write',
  triggerRead: 'trigger:read',
  triggerWrite: 'trigger:write',
  cacheRead: 'cache:read',
  cacheWrite: 'cache:write',
  dataRead: 'data:read',
  dataWrite: 'data:write',
  auditRead: 'audit:read',
  jobRead: 'job:read',
  jobAdmin: 'job:admin'
} as const;

export type PermissionKey = (typeof Permissions)[keyof typeof Permissions];

const ALL_PERMISSIONS = new Set<string>(Object.values(Permissions));

/** Role → permission mapping. Agents never get this; they get explicit grants. */
export function permissionsForRole(role: WorkspaceRole): Set<string> {
  switch (role) {
    case 'owner':
      return new Set(ALL_PERMISSIONS);
    case 'admin': {
      const set = new Set(ALL_PERMISSIONS);
      // Only owners may delete the workspace or transfer ownership.
      set.delete('workspace:delete');
      return set;
    }
    case 'member': {
      return new Set<string>([
        Permissions.workspaceRead,
        Permissions.workflowRead,
        Permissions.ticketRead,
        Permissions.ticketWrite,
        Permissions.ticketAssign,
        Permissions.ticketTransfer,
        Permissions.ticketCreate,
        Permissions.approvalRead,
        Permissions.approvalDecide,
        Permissions.agentRead,
        Permissions.runRead,
        Permissions.runExecute,
        Permissions.runCancel,
        Permissions.httpRead,
        Permissions.httpInvoke,
        Permissions.fileRead,
        Permissions.fileWrite,
        Permissions.configRead,
        Permissions.providerRead,
        Permissions.analyticsRead,
        Permissions.analyticsWrite,
        Permissions.triggerRead,
        Permissions.cacheRead,
        Permissions.dataRead,
        Permissions.dataWrite,
        Permissions.auditRead,
        Permissions.jobRead
      ]);
    }
    default:
      return new Set<string>();
  }
}

export function hasPermission(context: ActorContext, permission: string): boolean {
  return context.permissions.has(permission);
}

export function assertPermission(context: ActorContext, permission: string, detail?: string): void {
  if (!hasPermission(context, permission)) {
    throw errors.forbidden(detail ?? `Missing permission: ${permission}`, {
      permission,
      role: context.role
    });
  }
}

export function assertAnyPermission(context: ActorContext, permissions: string[]): void {
  if (!permissions.some((permission) => context.permissions.has(permission))) {
    throw errors.forbidden('Missing required permission', { permissions, role: context.role });
  }
}

export function assertWorkspace(context: ActorContext, workspaceId: string): void {
  if (context.workspaceId !== workspaceId) {
    // Deliberately a 404-style failure: cross-tenant probing must not confirm
    // existence of a resource in another workspace.
    throw errors.notFound('Resource', workspaceId);
  }
}

export interface ActorInput {
  workspaceId: string;
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  role?: WorkspaceRole | 'agent' | 'service';
  permissions?: Iterable<string>;
  runId?: string | null;
  toolCallId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  teamIds?: string[];
}

export function createActorContext(input: ActorInput): ActorContext {
  const role = input.role ?? 'member';
  const permissions =
    input.permissions !== undefined
      ? new Set(input.permissions)
      : role === 'owner' || role === 'admin' || role === 'member'
        ? permissionsForRole(role)
        : new Set<string>();
  return {
    workspaceId: input.workspaceId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel ?? null,
    role,
    permissions,
    runId: input.runId ?? null,
    toolCallId: input.toolCallId ?? null,
    requestId: input.requestId ?? null,
    sessionId: input.sessionId ?? null,
    teamIds: input.teamIds ?? []
  };
}

/** A system actor for workers, schedulers and migrations. */
export function systemActor(workspaceId: string, label = 'system'): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'system',
    actorId: null,
    actorLabel: label,
    role: 'service',
    permissions: ALL_PERMISSIONS
  });
}

/** An agent actor. Permissions come from the agent's declared grants, never implied. */
export function agentActor(
  workspaceId: string,
  agentId: string,
  label: string,
  permissions: Iterable<string>,
  options: { runId?: string; teamIds?: string[] } = {}
): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'agent',
    actorId: agentId,
    actorLabel: label,
    role: 'agent',
    permissions,
    runId: options.runId ?? null,
    teamIds: options.teamIds ?? []
  });
}

/** Narrow a context to a run + tool call for precise attribution inside a step. */
export function withRun(
  context: ActorContext,
  runId: string,
  toolCallId?: string | null
): ActorContext {
  return { ...context, runId, toolCallId: toolCallId ?? context.toolCallId ?? null };
}
