import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { isAppError } from '../../../src/lib/server/core/errors';
import { auditEvents, savedViews } from '../../../src/lib/server/db/schema';
import type { FilterAst } from '../../../src/lib/server/filters/ast';
import { filterTickets } from '../../../src/lib/server/filters/compile';
import {
  applySavedView,
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  updateSavedView
} from '../../../src/lib/server/filters/views';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createTicket,
  createUser,
  createWorkflow,
  createWorkspace,
  memberActor,
  ownerActor,
  type UserFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let owner: UserFixture;
let other: UserFixture;
let ownerView: ReturnType<typeof ownerActor>;

const highPriority: FilterAst = {
  type: 'condition',
  kind: 'system',
  key: 'priority',
  operator: 'eq',
  value: 'high'
};

async function auditActions(): Promise<string[]> {
  const rows = await handle.db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .all();
  return rows.map((row) => row.action);
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Views WS');
  workspaceId = workspace.id;
  owner = await createUser(handle.db, { name: 'Owner' });
  other = await createUser(handle.db, { name: 'Other' });
  ownerView = ownerActor(workspaceId, owner.id);
});

afterEach(() => {
  handle.cleanup();
});

describe('saved views: CRUD and audit', () => {
  test('creates a view with a validated AST, sort and columns, and audits it', async () => {
    const view = await createSavedView(handle.db, ownerView, {
      name: 'High priority',
      description: 'Anything urgent',
      filter: highPriority,
      sort: [{ field: 'updatedAt', direction: 'desc' }],
      columns: ['title', 'priority'],
      isPinned: true
    });
    expect(view.name).toBe('High priority');
    expect(view.scope).toBe('tickets');
    expect(view.isShared).toBe(true);
    expect(view.createdByUserId).toBe(owner.id);

    const detail = await getSavedView(handle.db, ownerView, view.id);
    expect(detail.filter).toEqual(highPriority);
    expect(detail.sort).toEqual([{ field: 'updatedAt', direction: 'desc' }]);
    expect(detail.columns).toEqual(['title', 'priority']);
    expect(await auditActions()).toContain('saved_view.created');
  });

  test('rejects an invalid filter AST and an empty name', async () => {
    let code: string | undefined;
    try {
      await createSavedView(handle.db, ownerView, {
        name: 'Broken',
        filter: { type: 'condition', kind: 'system', key: 'priority', operator: 'nope' }
      });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('validation_failed');

    code = undefined;
    try {
      await createSavedView(handle.db, ownerView, { name: '   ' });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('validation_failed');
  });

  test('rejects a duplicate name in the same scope', async () => {
    await createSavedView(handle.db, ownerView, { name: 'Mine', filter: highPriority });
    let code: string | undefined;
    try {
      await createSavedView(handle.db, ownerView, { name: 'Mine', filter: highPriority });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('conflict');
  });

  test('updates and deletes with audit rows', async () => {
    const view = await createSavedView(handle.db, ownerView, {
      name: 'Mine',
      filter: highPriority
    });
    const updated = await updateSavedView(handle.db, ownerView, view.id, {
      name: 'Renamed',
      isPinned: true
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.isPinned).toBe(true);

    await deleteSavedView(handle.db, ownerView, view.id);
    const remaining = await handle.db
      .select()
      .from(savedViews)
      .where(eq(savedViews.workspaceId, workspaceId))
      .all();
    expect(remaining).toHaveLength(0);
    const actions = await auditActions();
    expect(actions).toContain('saved_view.updated');
    expect(actions).toContain('saved_view.deleted');
  });
});

describe('saved views: privacy and permissions', () => {
  test('a private view is visible only to its creator', async () => {
    const privateView = await createSavedView(handle.db, ownerView, {
      name: 'Private',
      isShared: false
    });
    const otherView = memberActor(workspaceId, other.id);

    const ownerList = await listSavedViews(handle.db, ownerView);
    expect(ownerList.map((entry) => entry.id)).toContain(privateView.id);
    const otherList = await listSavedViews(handle.db, otherView);
    expect(otherList.map((entry) => entry.id)).not.toContain(privateView.id);

    // Cross-user access is a not-found, never a forbidden that confirms existence.
    let code: string | undefined;
    try {
      await getSavedView(handle.db, otherView, privateView.id);
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('not_found');
  });

  test('a shared view is listed for every member', async () => {
    const shared = await createSavedView(handle.db, ownerView, {
      name: 'Shared',
      isShared: true
    });
    const otherList = await listSavedViews(handle.db, memberActor(workspaceId, other.id));
    expect(otherList.map((entry) => entry.id)).toContain(shared.id);
  });

  test('a shared view may only be edited by its creator or a workspace admin', async () => {
    const shared = await createSavedView(handle.db, ownerView, { name: 'Shared', isShared: true });
    const member = memberActor(workspaceId, other.id);

    let code: string | undefined;
    try {
      await updateSavedView(handle.db, member, shared.id, { name: 'Hijacked' });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('forbidden');

    const admin = createActorContext({
      workspaceId,
      actorType: 'user',
      actorId: other.id,
      role: 'admin',
      permissions: [Permissions.workspaceAdmin, Permissions.ticketRead]
    });
    const renamed = await updateSavedView(handle.db, admin, shared.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
  });

  test('requires the read permission for the view scope', async () => {
    const nobody = createActorContext({
      workspaceId,
      actorType: 'user',
      actorId: other.id,
      role: 'member',
      permissions: []
    });
    let code: string | undefined;
    try {
      await createSavedView(handle.db, nobody, { name: 'Nope' });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('forbidden');

    const filesView = await createSavedView(handle.db, ownerView, {
      name: 'Files view',
      scope: 'files',
      filter: null
    });
    expect(filesView.scope).toBe('files');
    // Owner has file:read; a member without it cannot list the files scope.
    const filesOnly = createActorContext({
      workspaceId,
      actorType: 'user',
      actorId: other.id,
      role: 'member',
      permissions: [Permissions.ticketRead]
    });
    let scopeCode: string | undefined;
    try {
      await getSavedView(handle.db, filesOnly, filesView.id);
    } catch (error) {
      scopeCode = isAppError(error) ? error.code : 'other';
    }
    expect(scopeCode).toBe('forbidden');
  });

  test('views are isolated per workspace', async () => {
    const otherWorkspace = await createWorkspace(handle.db, 'Other');
    const otherOwner = ownerActor(otherWorkspace.id, other.id);
    const foreign = await createSavedView(handle.db, otherOwner, { name: 'Foreign' });

    let code: string | undefined;
    try {
      await getSavedView(handle.db, ownerView, foreign.id);
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('not_found');
  });
});

describe('saved views: apply', () => {
  test('returns the stored filter, sort and columns for a list endpoint', async () => {
    const view = await createSavedView(handle.db, ownerView, {
      name: 'Pinned high',
      filter: highPriority,
      sort: [{ field: 'number', direction: 'asc' }],
      columns: ['title'],
      isPinned: true
    });
    const applied = await applySavedView(handle.db, ownerView, view.id);
    expect(applied.filter).toEqual(highPriority);
    expect(applied.sort).toEqual([{ field: 'number', direction: 'asc' }]);
    expect(applied.columns).toEqual(['title']);
    expect(applied.scope).toBe('tickets');
  });

  test('applies a saved view to a real ticket list', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'View WF' });
    const high = await createTicket(handle.db, {
      workspaceId,
      workflow,
      title: 'High',
      priority: 'high'
    });
    await createTicket(handle.db, { workspaceId, workflow, title: 'Low', priority: 'low' });

    const view = await createSavedView(handle.db, ownerView, {
      name: 'High priority list',
      filter: highPriority,
      sort: [{ field: 'number', direction: 'asc' }]
    });
    const applied = await applySavedView(handle.db, ownerView, view.id);
    const page = await filterTickets(handle.db, {
      workspaceId,
      filter: applied.filter,
      sort: applied.sort
    });
    expect(page.rows.map((row) => row.id)).toEqual([high.id]);
  });
});
