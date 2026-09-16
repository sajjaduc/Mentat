/**
 * Application shell data.
 *
 * The shell needs identity, the active workspace and the few counts that appear in
 * navigation. Everything else is fetched by the page that owns it, which keeps this
 * loader small and cacheable.
 */

import { redirect } from '@sveltejs/kit';
import { countPendingApprovals } from '$server/approvals/service';
import { listMemberships } from '$server/auth/sessions';
import { ensureBootstrapped } from '$server/bootstrap';
import { getDb } from '$server/db/client';
import { myWork } from '$server/tickets/service';
import { requireWorkspace } from '$server/workspaces/service';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
  await ensureBootstrapped();

  if (!locals.userId) {
    // Preserve the destination so sign-in returns the user where they were going.
    const next = url.pathname + url.search;
    throw redirect(303, `/login?next=${encodeURIComponent(next)}`);
  }

  const db = getDb();
  const memberships = listMemberships(db, locals.userId);

  if (memberships.length === 0) {
    return {
      actor: null,
      workspace: null,
      workspaces: [],
      counts: { approvals: 0, waitingForMe: 0 }
    };
  }

  const active =
    memberships.find((membership) => membership.workspaceId === locals.workspaceId) ??
    memberships[0]!;

  let counts = { approvals: 0, waitingForMe: 0 };
  if (locals.actor) {
    try {
      const work = await myWork(db, locals.actor, { limit: 5 });
      counts = {
        approvals: countPendingApprovals(db, active.workspaceId),
        waitingForMe: work.waitingForMe.length
      };
    } catch {
      // Counts are decoration; a failure here must not block the shell.
    }
  }

  return {
    actor: {
      userId: locals.userId,
      role: active.role,
      isPlatformAdmin: false
    },
    workspace: {
      id: active.workspaceId,
      name: active.name,
      slug: active.slug
    },
    workspaces: memberships,
    counts,
    workspaceRecord: safeWorkspace(db, active.workspaceId)
  };
};

function safeWorkspace(db: ReturnType<typeof getDb>, workspaceId: string) {
  try {
    const workspace = requireWorkspace(db, workspaceId);
    return { id: workspace.id, name: workspace.name, description: workspace.description };
  } catch {
    return null;
  }
}
