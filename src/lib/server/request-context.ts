/**
 * Request context resolution.
 *
 * Every server entry point (API route, page loader, SSE stream) resolves its
 * context here so the rules are identical:
 *
 *  1. `ensureBootstrapped()` — the database, locators, handlers and tools exist;
 *  2. resolve the session cookie to a user (or no actor for public routes);
 *  3. resolve the active workspace and build the actor context, including team
 *     membership for team-scoped human gates;
 *  4. expose the request id for correlation.
 *
 * `locals` is populated for page loaders; the API adapter consumes the returned
 * context directly.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { readCookie } from '$server/api/handlers/auth';
import {
  actorForMember,
  membershipFor,
  resolveSession,
  SESSION_COOKIE,
  teamIdsForUser,
  touchSession
} from '$server/auth/sessions';
import { ensureBootstrapped } from '$server/bootstrap';
import { type ActorContext, createActorContext } from '$server/core/context';
import { moduleLogger } from '$server/core/logger';
import { type Executor, getDb } from '$server/db/client';

const log = moduleLogger('request-context');

export interface RequestContext {
  db: Executor;
  actor: ActorContext | null;
  userId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  requestId: string;
}

export async function resolveRequestContext(event: RequestEvent): Promise<RequestContext> {
  await ensureBootstrapped();
  const db = getDb();
  const requestId = crypto.randomUUID();

  const token = readCookie(event.request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) {
    return { db, actor: null, userId: null, sessionId: null, workspaceId: null, requestId };
  }

  const resolved = resolveSession(db, token);
  if (!resolved) {
    return { db, actor: null, userId: null, sessionId: null, workspaceId: null, requestId };
  }

  // Cheap liveness signal for the session list; deliberately not awaited so it can
  // never delay a request.
  try {
    touchSession(db, resolved.session.id);
  } catch {
    // A failed touch is not worth failing the request over.
  }

  const workspaceId = resolved.workspaceId;
  if (!workspaceId) {
    // Signed in but no workspace yet: the app shell routes to onboarding.
    const actor = createActorContext({
      workspaceId: 'none',
      actorType: 'user',
      actorId: resolved.user.id,
      actorLabel: resolved.user.name,
      role: 'member',
      permissions: [],
      sessionId: resolved.session.id,
      requestId
    });
    return {
      db,
      actor,
      userId: resolved.user.id,
      sessionId: resolved.session.id,
      workspaceId: null,
      requestId
    };
  }

  const membership = membershipFor(db, resolved.user.id, workspaceId);
  if (!membership) {
    log.warn('session references a workspace the user is not a member of', {
      userId: resolved.user.id,
      workspaceId
    });
    return {
      db,
      actor: null,
      userId: resolved.user.id,
      sessionId: resolved.session.id,
      workspaceId: null,
      requestId
    };
  }

  const actor = actorForMember(membership, resolved.user, {
    sessionId: resolved.session.id,
    requestId,
    teamIds: teamIdsForUser(db, workspaceId, resolved.user.id)
  });

  return {
    db,
    actor,
    userId: resolved.user.id,
    sessionId: resolved.session.id,
    workspaceId,
    requestId
  };
}

/** Serialize a router result into a Response with the house content type. */
export function toResponse(result: {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}): Response {
  if (result.status === 204 || result.body === null || result.body === undefined) {
    return new Response(null, { status: result.status, headers: result.headers });
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...result.headers }
  });
}

/** Actor for a system operation triggered by a page action (never a session). */
export function systemContext(workspaceId: string, label: string): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'system',
    actorLabel: label,
    role: 'service'
  });
}
