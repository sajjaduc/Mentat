/**
 * Work relationship integration tests (ADR-0021 port of ticket relationships).
 *
 * Work relationships live on WorkflowItems (work dependencies) and are deliberately
 * separate from Record relationships (domain facts). Linking is directional and
 * typed; duplicates are absorbed by the unique index; unlink removes exactly one row.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  type ActorContext,
  createActorContext,
  Permissions
} from '../../../src/lib/server/core/context';
import type { WorkRelationshipType } from '../../../src/lib/server/db/schema';
import { workflowItemRelationships } from '../../../src/lib/server/db/schema';
import {
  linkWorkItemsSync,
  unlinkWorkItemsSync
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createUser,
  createWorkflow,
  createWorkflowItem,
  createWorkspace,
  memberActor,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let owner: ActorContext;
let workflow: WorkflowFixture;

function actorWith(permissions: string[]): ActorContext {
  return createActorContext({
    workspaceId,
    actorType: 'user',
    actorId: 'custom-user',
    actorLabel: 'Custom',
    role: 'member',
    permissions
  });
}

async function makeItem(title = 'Item') {
  return createWorkflowItem(handle.db, { workspaceId, workflow, title });
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Relationships Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Owner' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId, 'Owner');
  workflow = await createWorkflow(handle.db, workspaceId, { name: 'Delivery' });
});

describe('work relationships', () => {
  test('links two work items for every supported relationship type', async () => {
    const from = await makeItem('Parent');
    const to = await makeItem('Child');
    const types: WorkRelationshipType[] = ['parent', 'child', 'related', 'blocks'];

    for (const type of types) {
      linkWorkItemsSync(handle.db, owner, {
        fromWorkflowItemId: from.id,
        toWorkflowItemId: to.id,
        type,
        note: `linked as ${type}`
      });
    }

    const rows = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(eq(workflowItemRelationships.fromWorkflowItemId, from.id))
      .all();
    expect(rows).toHaveLength(types.length);
    expect(rows.map((row) => row.type).sort()).toEqual([...types].sort());
    expect(rows.every((row) => row.workspaceId === workspaceId)).toBe(true);
    expect(rows.every((row) => row.createdById === ownerId)).toBe(true);
    expect(rows.map((row) => row.note)).toContain('linked as blocks');
  });

  test('a relationship is directional: from/to are preserved exactly', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: b.id,
      type: 'blocks'
    });
    const row = handle.db.select().from(workflowItemRelationships).all()[0];
    expect(row?.fromWorkflowItemId).toBe(a.id);
    expect(row?.toWorkflowItemId).toBe(b.id);
  });

  test('rejects a self-link', async () => {
    const item = await makeItem('Self');
    expect(() =>
      linkWorkItemsSync(handle.db, owner, {
        fromWorkflowItemId: item.id,
        toWorkflowItemId: item.id,
        type: 'related'
      })
    ).toThrow(/cannot relate to itself/i);
    expect(handle.db.select().from(workflowItemRelationships).all()).toHaveLength(0);
  });

  test('absorbs duplicate links via the unique index', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: b.id,
      type: 'related'
    });
    // Same edge + type again: no throw, still one row.
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: b.id,
      type: 'related',
      note: 'second attempt'
    });
    const rows = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(eq(workflowItemRelationships.fromWorkflowItemId, a.id))
      .all();
    expect(rows).toHaveLength(1);

    // The reverse direction is a distinct edge and is allowed.
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: b.id,
      toWorkflowItemId: a.id,
      type: 'related'
    });
    expect(handle.db.select().from(workflowItemRelationships).all()).toHaveLength(2);
  });

  test('unlinks exactly one relationship by id', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    const c = await makeItem('C');
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: b.id,
      type: 'blocks'
    });
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: c.id,
      type: 'blocks'
    });
    const target = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(eq(workflowItemRelationships.toWorkflowItemId, b.id))
      .all()[0];

    unlinkWorkItemsSync(handle.db, owner, { relationshipId: target?.id as string });

    const remaining = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(eq(workflowItemRelationships.fromWorkflowItemId, a.id))
      .all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.toWorkflowItemId).toBe(c.id);
  });

  test('unlinking an unknown relationship fails with not-found', async () => {
    expect(() => unlinkWorkItemsSync(handle.db, owner, { relationshipId: 'nope' })).toThrow(
      /not found/i
    );
  });

  test('linking a missing work item fails with not-found', async () => {
    const item = await makeItem('Present');
    expect(() =>
      linkWorkItemsSync(handle.db, owner, {
        fromWorkflowItemId: item.id,
        toWorkflowItemId: 'missing-item',
        type: 'related'
      })
    ).toThrow(/not found/i);
  });

  test('work relationships never leak across workspaces', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const otherUser = await createUser(handle.db, { name: 'Other Owner' });
    const otherOwner = ownerActor(other.id, otherUser.id, 'Other Owner');
    const mine = await makeItem('Mine');
    const theirs = await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Theirs'
    });

    // Cannot link to an item owned by another workspace.
    expect(() =>
      linkWorkItemsSync(handle.db, owner, {
        fromWorkflowItemId: mine.id,
        toWorkflowItemId: theirs.id,
        type: 'related'
      })
    ).toThrow(/not found/i);

    // Nor can an actor from another workspace link our item.
    expect(() =>
      linkWorkItemsSync(handle.db, otherOwner, {
        fromWorkflowItemId: mine.id,
        toWorkflowItemId: theirs.id,
        type: 'related'
      })
    ).toThrow(/not found/i);
    expect(handle.db.select().from(workflowItemRelationships).all()).toHaveLength(0);
  });

  test('a relationship from another workspace is not unlinkable', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const otherUser = await createUser(handle.db, { name: 'Other Owner' });
    const otherOwner = ownerActor(other.id, otherUser.id, 'Other Owner');
    const theirsA = await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'A'
    });
    const theirsB = await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'B'
    });
    linkWorkItemsSync(handle.db, otherOwner, {
      fromWorkflowItemId: theirsA.id,
      toWorkflowItemId: theirsB.id,
      type: 'blocks'
    });
    const relationship = handle.db.select().from(workflowItemRelationships).all()[0];

    expect(() =>
      unlinkWorkItemsSync(handle.db, owner, { relationshipId: relationship?.id as string })
    ).toThrow(/not found/i);
    expect(handle.db.select().from(workflowItemRelationships).all()).toHaveLength(1);
  });

  test('linking and unlinking require the workflow-item write permission', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    const nobody = actorWith([]);
    expect(() =>
      linkWorkItemsSync(handle.db, nobody, {
        fromWorkflowItemId: a.id,
        toWorkflowItemId: b.id,
        type: 'related'
      })
    ).toThrow(/not permitted/i);

    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: b.id,
      type: 'related'
    });
    const relationship = handle.db.select().from(workflowItemRelationships).all()[0];
    expect(() =>
      unlinkWorkItemsSync(handle.db, nobody, { relationshipId: relationship?.id as string })
    ).toThrow(/not permitted/i);
    expect(handle.db.select().from(workflowItemRelationships).all()).toHaveLength(1);
  });

  test('a member may link and unlink work', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    const member = memberActor(workspaceId, 'member-1', 'Member');
    linkWorkItemsSync(handle.db, member, {
      fromWorkflowItemId: a.id,
      toWorkflowItemId: b.id,
      type: 'parent'
    });
    const rows = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(
        and(
          eq(workflowItemRelationships.fromWorkflowItemId, a.id),
          eq(workflowItemRelationships.type, 'parent')
        )
      )
      .all();
    expect(rows).toHaveLength(1);
    unlinkWorkItemsSync(handle.db, member, { relationshipId: rows[0]?.id as string });
    expect(handle.db.select().from(workflowItemRelationships).all()).toHaveLength(0);
  });

  test('Permissions.workflowItemWrite gates relationship mutation', () => {
    expect(Permissions.workflowItemWrite).toBe('workflow_item:write');
  });
});
