/**
 * File and blob lifecycle.
 *
 * Unlinking a ticket, removing workflow context, deleting a logical file and
 * deleting a blob are distinct operations. These tests pin the safe semantics:
 * shared files survive one ticket being detached, and a blob is only physically
 * removed once no retained file references it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { AuditActions } from '../../../src/lib/server/audit/ledger';
import { blobs, files, ticketFiles, workflowFiles } from '../../../src/lib/server/db/schema';
import {
  deleteBlob,
  deleteFile,
  isBlobReferenced,
  removeWorkflowContext,
  unlinkFromTicket
} from '../../../src/lib/server/files/lifecycle';
import { runProcessing } from '../../../src/lib/server/files/processing/pipeline';
import { searchFileContent } from '../../../src/lib/server/files/retrieval';
import { createFileService, type FileService } from '../../../src/lib/server/files/service';
import { resolveBlobStore } from '../../../src/lib/server/storage/index';
import { LocalBlobStore } from '../../../src/lib/server/storage/local-blob-store';
import { configureLocalStorage } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createTicket,
  createUser,
  createWorkflow,
  createWorkspace,
  ownerActor,
  type TicketFixture,
  type WorkflowFixture
} from '../../helpers/factories';

const encoder = new TextEncoder();

let handle: TestDatabase;
let service: FileService;
let workspaceId: string;
let actor: ReturnType<typeof ownerActor>;
let workflow: WorkflowFixture;
let otherWorkflow: WorkflowFixture;
let ticketA: TicketFixture;
let ticketB: TicketFixture;

async function auditActions(): Promise<string[]> {
  const rows = (await handle.sqlite
    .query('SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY seq')
    .all(workspaceId)) as Array<{ action: string }>;
  return rows.map((row) => row.action);
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Lifecycle Workspace');
  workspaceId = workspace.id;
  await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  workflow = await createWorkflow(handle.db, workspaceId);
  otherWorkflow = await createWorkflow(handle.db, workspaceId, { name: 'Compliance' });
  ticketA = await createTicket(handle.db, { workspaceId, workflow });
  ticketB = await createTicket(handle.db, { workspaceId, workflow });
  service = createFileService({ db: handle.db });
});

describe('unlinking', () => {
  test('one ticket can be detached without affecting the other', async () => {
    const result = await service.ingest(actor, {
      filename: 'shared.txt',
      bytes: encoder.encode('shared'),
      source: { type: 'human_upload' },
      ticketId: ticketA.id,
      process: false
    });
    await service.linkToTicket(actor, { fileId: result.fileId, ticketId: ticketB.id });

    await unlinkFromTicket(actor, { fileId: result.fileId, ticketId: ticketA.id }, handle.db);

    expect(await service.listForTicket(actor, ticketA.id)).toHaveLength(0);
    expect(await service.listForTicket(actor, ticketB.id)).toHaveLength(1);
    // The file itself is untouched.
    const view = await service.requireFile(actor, result.fileId);
    expect(view.id).toBe(result.fileId);
    expect(await auditActions()).toContain(AuditActions.fileUnlinkedFromTicket);
  });
});

describe('workflow context removal', () => {
  test('removing context keeps the file and other contexts', async () => {
    const result = await service.ingest(actor, {
      filename: 'context.txt',
      bytes: encoder.encode('context'),
      source: { type: 'human_upload' },
      workflowId: workflow.id,
      process: false
    });
    await service.addWorkflowContext(actor, {
      fileId: result.fileId,
      workflowId: otherWorkflow.id
    });

    await removeWorkflowContext(
      actor,
      { fileId: result.fileId, workflowId: otherWorkflow.id },
      handle.db
    );

    const view = await service.requireFile(actor, result.fileId);
    expect(view.workflowIds).toEqual([workflow.id]);
  });
});

describe('logical file deletion', () => {
  test('soft-deletes the file, clears links and the content index', async () => {
    const result = await service.ingest(actor, {
      filename: 'deletable.txt',
      bytes: encoder.encode('findable token xyzzy'),
      source: { type: 'human_upload' },
      workflowId: workflow.id,
      ticketId: ticketA.id,
      process: false
    });
    const blobStore = await resolveBlobStore(handle.db, workspaceId);
    await runProcessing({ db: handle.db, blobStore, workspaceId }, { fileId: result.fileId });
    expect(await searchFileContent(actor, { query: 'xyzzy' }, handle.db)).toHaveLength(1);

    await deleteFile(actor, result.fileId, handle.db);

    const row = await handle.db.select().from(files).where(eq(files.id, result.fileId)).all();
    expect(row[0]?.deletedAt).toBeGreaterThan(0);
    await expect(service.requireFile(actor, result.fileId)).rejects.toThrow();

    const links = await handle.db
      .select()
      .from(ticketFiles)
      .where(eq(ticketFiles.fileId, result.fileId))
      .all();
    expect(links.every((link) => link.removedAt !== null)).toBe(true);
    const contexts = await handle.db
      .select()
      .from(workflowFiles)
      .where(eq(workflowFiles.fileId, result.fileId))
      .all();
    expect(contexts.every((context) => context.removedAt !== null)).toBe(true);

    expect(await searchFileContent(actor, { query: 'xyzzy' }, handle.db)).toHaveLength(0);
    expect(await auditActions()).toContain(AuditActions.fileDeleted);
  });
});

describe('blob deletion safety', () => {
  test('refuses while a retained file references the blob, then succeeds', async () => {
    const result = await service.ingest(actor, {
      filename: 'referenced.txt',
      bytes: encoder.encode('referenced bytes'),
      source: { type: 'human_upload' },
      process: false
    });

    expect(isBlobReferenced(handle.db, result.blobId)).toBe(true);
    await expect(deleteBlob(actor, { blobId: result.blobId }, handle.db)).rejects.toThrow();

    const beforeDelete = await handle.db
      .select()
      .from(blobs)
      .where(eq(blobs.id, result.blobId))
      .all();
    expect(beforeDelete).toHaveLength(1);
    const store = new LocalBlobStore({ root: handle.tempDir });
    expect(await store.exists(beforeDelete[0]!.storageKey)).toBe(true);

    await deleteFile(actor, result.fileId, handle.db);
    expect(isBlobReferenced(handle.db, result.blobId)).toBe(false);

    await deleteBlob(actor, { blobId: result.blobId }, handle.db);
    const tombstone = await handle.db.select().from(blobs).where(eq(blobs.id, result.blobId)).all();
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]?.orphanedAt).toBeGreaterThan(0);
    expect(await store.exists(beforeDelete[0]!.storageKey)).toBe(false);
    expect(await auditActions()).toContain(AuditActions.blobDeleted);
  });

  test('re-ingesting reclaimed bytes revives the tombstone and re-stores them', async () => {
    const bytes = encoder.encode('revive me');
    const first = await service.ingest(actor, {
      filename: 'revive.txt',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });
    await deleteFile(actor, first.fileId, handle.db);
    await deleteBlob(actor, { blobId: first.blobId }, handle.db);

    const second = await service.ingest(actor, {
      filename: 'revive.txt',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });
    expect(second.blobId).toBe(first.blobId);
    expect(second.deduplicated).toBe(false);

    const blob = await handle.db.select().from(blobs).where(eq(blobs.id, first.blobId)).all();
    expect(blob[0]?.orphanedAt).toBeNull();
    const store = new LocalBlobStore({ root: handle.tempDir });
    expect(new TextDecoder().decode(await store.get(blob[0]!.storageKey))).toBe('revive me');
  });

  test('a blob shared by two logical files survives until both are gone', async () => {
    const bytes = encoder.encode('shared blob bytes');
    const upload = await service.ingest(actor, {
      filename: 'a.txt',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });
    const email = await service.ingest(actor, {
      filename: 'a.txt',
      bytes,
      source: { type: 'incoming_email' },
      process: false
    });
    expect(email.blobId).toBe(upload.blobId);

    await deleteFile(actor, upload.fileId, handle.db);
    expect(isBlobReferenced(handle.db, email.blobId)).toBe(true);
    await expect(deleteBlob(actor, { blobId: email.blobId }, handle.db)).rejects.toThrow();

    await deleteFile(actor, email.fileId, handle.db);
    await deleteBlob(actor, { blobId: email.blobId }, handle.db);
  });

  test('cannot see or delete another workspace’s blob', async () => {
    const result = await service.ingest(actor, {
      filename: 'tenant.txt',
      bytes: encoder.encode('tenant bytes'),
      source: { type: 'human_upload' },
      process: false
    });

    const other = await createWorkspace(handle.db, 'Other Tenant');
    await configureLocalStorage(handle.db, other.id, handle.tempDir);
    const otherUser = await createUser(handle.db);
    const otherActor = ownerActor(other.id, otherUser.id);

    await expect(deleteBlob(otherActor, { blobId: result.blobId }, handle.db)).rejects.toThrow();
    const retained = await handle.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.id, result.blobId), isNull(blobs.orphanedAt)))
      .all();
    expect(retained).toHaveLength(1);
  });
});
