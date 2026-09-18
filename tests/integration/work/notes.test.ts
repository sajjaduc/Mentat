/**
 * Work notes integration tests (ADR-0021 port of the ticket note lifecycle).
 *
 * Notes belong to a WorkflowItem participation, not the durable Record. Adding a
 * note is attributed to the actor and audited; editing one records the previous
 * body as a revision so the note's history is never lost.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  type ActorContext,
  createActorContext,
  Permissions
} from '../../../src/lib/server/core/context';
import { workflowItemNoteRevisions, workflowItemNotes } from '../../../src/lib/server/db/schema';
import {
  addWorkflowItemNote,
  addWorkflowItemNoteSync,
  editWorkflowItemNoteSync,
  getWorkflowItemDetail
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

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Notes Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Sarah Reviewer' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId, 'Sarah Reviewer');
  workflow = await createWorkflow(handle.db, workspaceId, { name: 'Support' });
});

describe('work notes', () => {
  test('adds a note attributed to the actor and returns its id', async () => {
    const item = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Needs a note'
    });

    const { noteId } = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: '  Called the customer  '
    });

    const row = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.id, noteId))
      .all()[0];
    expect(row?.workflowItemId).toBe(item.id);
    expect(row?.workspaceId).toBe(workspaceId);
    expect(row?.body).toBe('Called the customer');
    expect(row?.authorType).toBe('user');
    expect(row?.authorId).toBe(ownerId);
    expect(row?.authorLabel).toBe('Sarah Reviewer');
    expect(row?.editedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();

    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.notes.map((note) => note.body)).toEqual(['Called the customer']);
    expect(detail.notes[0]?.authorId).toBe(ownerId);
  });

  test('the async wrapper writes the same note inside a transaction', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Async' });
    const { noteId } = await addWorkflowItemNote(handle.db, owner, {
      workflowItemId: item.id,
      body: 'Async note'
    });
    const rows = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.id, noteId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('Async note');
  });

  test('rejects an empty note body', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Blank' });
    expect(() =>
      addWorkflowItemNoteSync(handle.db, owner, { workflowItemId: item.id, body: '   ' })
    ).toThrow(/body is required/i);
    const rows = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.workflowItemId, item.id))
      .all();
    expect(rows).toHaveLength(0);
  });

  test('requires the workflow-item write permission to add a note', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Locked' });
    const nobody = actorWith([]);
    expect(() =>
      addWorkflowItemNoteSync(handle.db, nobody, {
        workflowItemId: item.id,
        body: 'should not land'
      })
    ).toThrow(/not permitted/i);
    expect(
      handle.db
        .select()
        .from(workflowItemNotes)
        .where(eq(workflowItemNotes.workflowItemId, item.id))
        .all()
    ).toHaveLength(0);
  });

  test('a member can add a note', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Member' });
    const member = memberActor(workspaceId, 'member-1', 'Member');
    addWorkflowItemNoteSync(handle.db, member, { workflowItemId: item.id, body: 'Member note' });
    const rows = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.workflowItemId, item.id))
      .all();
    expect(rows.map((row) => row.body)).toEqual(['Member note']);
  });

  test('edits a note and records the previous body as a revision', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Edited' });
    const { noteId } = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: 'First draft'
    });

    editWorkflowItemNoteSync(handle.db, owner, { noteId, body: 'Second draft' });

    const note = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.id, noteId))
      .all()[0];
    expect(note?.body).toBe('Second draft');
    expect(note?.editedAt).toBeGreaterThan(0);
    expect(note?.editedById).toBe(ownerId);

    const revisions = handle.db
      .select()
      .from(workflowItemNoteRevisions)
      .where(eq(workflowItemNoteRevisions.noteId, noteId))
      .all();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.body).toBe('First draft');
    expect(revisions[0]?.editedById).toBe(ownerId);
    expect(revisions[0]?.workspaceId).toBe(workspaceId);

    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.notes[0]?.body).toBe('Second draft');
    expect(detail.notes[0]?.editedAt).not.toBeNull();
  });

  test('a second edit appends a second revision, preserving every previous body', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'History' });
    const { noteId } = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: 'v1'
    });
    editWorkflowItemNoteSync(handle.db, owner, { noteId, body: 'v2' });
    editWorkflowItemNoteSync(handle.db, owner, { noteId, body: 'v3' });

    const revisions = handle.db
      .select()
      .from(workflowItemNoteRevisions)
      .where(eq(workflowItemNoteRevisions.noteId, noteId))
      .all();
    expect(revisions.map((row) => row.body)).toEqual(['v1', 'v2']);
  });

  test('editing rejects an empty body and leaves the note untouched', async () => {
    const item = await createWorkflowItem(handle.db, {
      workspaceId,
      workflow,
      title: 'Empty edit'
    });
    const { noteId } = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: 'Keep me'
    });
    expect(() => editWorkflowItemNoteSync(handle.db, owner, { noteId, body: '  ' })).toThrow(
      /body is required/i
    );
    const note = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.id, noteId))
      .all()[0];
    expect(note?.body).toBe('Keep me');
    expect(note?.editedAt).toBeNull();
  });

  test('editing a missing note fails and editing requires permission', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Missing' });
    expect(() =>
      editWorkflowItemNoteSync(handle.db, owner, { noteId: 'does-not-exist', body: 'x' })
    ).toThrow(/not found/i);

    const { noteId } = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: 'Guarded'
    });
    const nobody = actorWith([]);
    expect(() => editWorkflowItemNoteSync(handle.db, nobody, { noteId, body: 'sneaky' })).toThrow(
      /not permitted/i
    );
    const note = handle.db
      .select()
      .from(workflowItemNotes)
      .where(eq(workflowItemNotes.id, noteId))
      .all()[0];
    expect(note?.body).toBe('Guarded');
  });

  test('a note from another workspace cannot be read or edited', async () => {
    const other = await createWorkspace(handle.db, 'Other Co');
    const otherWorkflow = await createWorkflow(handle.db, other.id, { name: 'Theirs' });
    const otherUser = await createUser(handle.db, { name: 'Other Owner' });
    const otherOwner = ownerActor(other.id, otherUser.id, 'Other Owner');
    const otherItem = await createWorkflowItem(handle.db, {
      workspaceId: other.id,
      workflow: otherWorkflow,
      title: 'Theirs'
    });
    const { noteId } = addWorkflowItemNoteSync(handle.db, otherOwner, {
      workflowItemId: otherItem.id,
      body: 'theirs'
    });

    expect(() => editWorkflowItemNoteSync(handle.db, owner, { noteId, body: 'hijacked' })).toThrow(
      /not found/i
    );

    const rows = handle.db
      .select()
      .from(workflowItemNotes)
      .where(and(eq(workflowItemNotes.id, noteId), eq(workflowItemNotes.workspaceId, other.id)))
      .all();
    expect(rows[0]?.body).toBe('theirs');
  });

  test('soft-deleted notes are excluded from the detail view', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Deleted' });
    const { noteId } = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: 'Visible then hidden'
    });
    handle.db
      .update(workflowItemNotes)
      .set({ deletedAt: Date.now() })
      .where(eq(workflowItemNotes.id, noteId))
      .run();

    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.notes).toHaveLength(0);
    expect(
      handle.db.select().from(workflowItemNotes).where(eq(workflowItemNotes.id, noteId)).all()
    ).toHaveLength(1);
  });

  test('notes are ordered newest-first in the detail view', async () => {
    const item = await createWorkflowItem(handle.db, { workspaceId, workflow, title: 'Ordered' });
    const first = addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: item.id,
      body: 'first'
    });
    // Force distinct createdAt ordering regardless of clock granularity.
    handle.db
      .update(workflowItemNotes)
      .set({ createdAt: Date.now() - 60_000 })
      .where(eq(workflowItemNotes.id, first.noteId))
      .run();
    addWorkflowItemNoteSync(handle.db, owner, { workflowItemId: item.id, body: 'second' });

    const detail = await getWorkflowItemDetail(handle.db, owner, item.id);
    expect(detail.notes.map((note) => note.body)).toEqual(['second', 'first']);
  });

  test('Permissions.workflowItemWrite is the only gate for notes', () => {
    expect(Permissions.workflowItemWrite).toBe('workflow_item:write');
  });
});
