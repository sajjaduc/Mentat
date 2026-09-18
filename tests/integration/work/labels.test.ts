/**
 * Work label integration tests (ADR-0021 port of ticket labels).
 *
 * Labels are workspace-scoped vocabulary attached to a WorkflowItem through
 * `workflow_item_labels`. Adding is idempotent, names are created on demand, and
 * removal detaches exactly one label from one participation.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  type ActorContext,
  createActorContext,
  Permissions
} from '../../../src/lib/server/core/context';
import { labels, workflowItemLabels } from '../../../src/lib/server/db/schema';
import {
  addWorkflowItemLabelsSync,
  removeWorkflowItemLabelSync
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createLabel,
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

function labelNamesFor(workflowItemId: string): string[] {
  return handle.db
    .select({ name: labels.name })
    .from(workflowItemLabels)
    .innerJoin(labels, eq(labels.id, workflowItemLabels.labelId))
    .where(eq(workflowItemLabels.workflowItemId, workflowItemId))
    .all()
    .map((row) => row.name)
    .sort();
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Labels Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Owner' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId, 'Owner');
  workflow = await createWorkflow(handle.db, workspaceId, { name: 'Triage' });
});

describe('work labels', () => {
  test('adds labels by existing id and by name, creating names on demand', async () => {
    const item = await makeItem('Labelled');
    const existing = await createLabel(handle.db, workspaceId, 'vip');
    const existingName = handle.db
      .select({ name: labels.name })
      .from(labels)
      .where(eq(labels.id, existing))
      .all()[0]?.name as string;

    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelIds: [existing],
      labelNames: ['urgent']
    });

    expect(labelNamesFor(item.id)).toEqual([existingName, 'urgent'].sort());
    const rows = handle.db
      .select()
      .from(workflowItemLabels)
      .where(eq(workflowItemLabels.workflowItemId, item.id))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.workspaceId === workspaceId)).toBe(true);
  });

  test('adding the same labels twice is idempotent', async () => {
    const item = await makeItem('Idempotent');
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelNames: ['vip', 'urgent']
    });
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelNames: ['urgent', 'vip']
    });
    expect(labelNamesFor(item.id)).toEqual(['urgent', 'vip']);
    expect(
      handle.db
        .select()
        .from(workflowItemLabels)
        .where(eq(workflowItemLabels.workflowItemId, item.id))
        .all()
    ).toHaveLength(2);
  });

  test('a label name is created once and reused across items', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: a.id,
      labelNames: ['billing']
    });
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: b.id,
      labelNames: ['billing']
    });

    const billing = handle.db
      .select()
      .from(labels)
      .where(and(eq(labels.workspaceId, workspaceId), eq(labels.name, 'billing')))
      .all();
    expect(billing).toHaveLength(1);
    expect(labelNamesFor(a.id)).toEqual(['billing']);
    expect(labelNamesFor(b.id)).toEqual(['billing']);
  });

  test('blank label names are ignored', async () => {
    const item = await makeItem('Blank');
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelNames: ['   ', '']
    });
    expect(
      handle.db
        .select()
        .from(workflowItemLabels)
        .where(eq(workflowItemLabels.workflowItemId, item.id))
        .all()
    ).toHaveLength(0);
  });

  test('an unknown label id in this workspace is rejected', async () => {
    const item = await makeItem('Unknown label');
    expect(() =>
      addWorkflowItemLabelsSync(handle.db, owner, {
        workflowItemId: item.id,
        labelIds: ['not-a-label']
      })
    ).toThrow(/do not exist/i);
    expect(
      handle.db
        .select()
        .from(workflowItemLabels)
        .where(eq(workflowItemLabels.workflowItemId, item.id))
        .all()
    ).toHaveLength(0);
  });

  test('a label from another workspace is rejected', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const foreignLabel = await createLabel(handle.db, other.id, 'foreign');
    const item = await makeItem('Foreign label');
    expect(() =>
      addWorkflowItemLabelsSync(handle.db, owner, {
        workflowItemId: item.id,
        labelIds: [foreignLabel]
      })
    ).toThrow(/do not exist/i);
  });

  test('removes one label from one participation', async () => {
    const item = await makeItem('Remove me');
    const kept = await createLabel(handle.db, workspaceId, 'kept');
    const keptName = handle.db
      .select({ name: labels.name })
      .from(labels)
      .where(eq(labels.id, kept))
      .all()[0]?.name as string;
    const dropped = await createLabel(handle.db, workspaceId, 'dropped');

    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelIds: [kept, dropped]
    });
    expect(labelNamesFor(item.id)).toHaveLength(2);

    removeWorkflowItemLabelSync(handle.db, owner, {
      workflowItemId: item.id,
      labelId: dropped
    });
    expect(labelNamesFor(item.id)).toEqual([keptName]);

    // Removing again is a harmless no-op.
    removeWorkflowItemLabelSync(handle.db, owner, {
      workflowItemId: item.id,
      labelId: dropped
    });
    expect(labelNamesFor(item.id)).toEqual([keptName]);
  });

  test('removing a label from one item leaves it on another', async () => {
    const a = await makeItem('A');
    const b = await makeItem('B');
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: a.id,
      labelNames: ['shared']
    });
    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: b.id,
      labelNames: ['shared']
    });
    const sharedId = handle.db
      .select()
      .from(labels)
      .where(and(eq(labels.workspaceId, workspaceId), eq(labels.name, 'shared')))
      .all()[0]?.id as string;

    removeWorkflowItemLabelSync(handle.db, owner, { workflowItemId: a.id, labelId: sharedId });
    expect(labelNamesFor(a.id)).toEqual([]);
    expect(labelNamesFor(b.id)).toEqual(['shared']);
  });

  test('labelling requires the workflow-item write permission', async () => {
    const item = await makeItem('Guarded');
    const nobody = actorWith([]);
    expect(() =>
      addWorkflowItemLabelsSync(handle.db, nobody, {
        workflowItemId: item.id,
        labelNames: ['vip']
      })
    ).toThrow(/not permitted/i);

    addWorkflowItemLabelsSync(handle.db, owner, {
      workflowItemId: item.id,
      labelNames: ['vip']
    });
    const vipId = handle.db
      .select()
      .from(labels)
      .where(and(eq(labels.workspaceId, workspaceId), eq(labels.name, 'vip')))
      .all()[0]?.id as string;
    expect(() =>
      removeWorkflowItemLabelSync(handle.db, nobody, { workflowItemId: item.id, labelId: vipId })
    ).toThrow(/not permitted/i);
    expect(labelNamesFor(item.id)).toEqual(['vip']);
  });

  test('labelling an item from another workspace fails with not-found', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const otherItem = await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Theirs'
    });
    expect(() =>
      addWorkflowItemLabelsSync(handle.db, owner, {
        workflowItemId: otherItem.id,
        labelNames: ['vip']
      })
    ).toThrow(/not found/i);
  });

  test('a member may label work', async () => {
    const item = await makeItem('Member');
    const member = memberActor(workspaceId, 'member-1', 'Member');
    addWorkflowItemLabelsSync(handle.db, member, {
      workflowItemId: item.id,
      labelNames: ['member-label']
    });
    expect(labelNamesFor(item.id)).toEqual(['member-label']);
  });

  test('Permissions.workflowItemWrite gates label mutation', () => {
    expect(Permissions.workflowItemWrite).toBe('workflow_item:write');
  });
});
