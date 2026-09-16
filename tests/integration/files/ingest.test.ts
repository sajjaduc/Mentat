/**
 * Content-addressed ingestion.
 *
 * These tests pin the invariants the files brief treats as non-negotiable: bytes
 * are hashed and stored once per workspace, every appearance keeps its provenance,
 * tenant isolation survives hash equality, and ticket links are written in the
 * same transaction as the file.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AuditActions } from '../../../src/lib/server/audit/ledger';
import { createActorContext } from '../../../src/lib/server/core/context';
import { sha256Hex } from '../../../src/lib/server/core/hash';
import { blobs, fileSources, files, ticketFiles } from '../../../src/lib/server/db/schema';
import { createFileService, type FileService } from '../../../src/lib/server/files/service';
import { LocalBlobStore } from '../../../src/lib/server/storage/local-blob-store';
import { configureLocalStorage } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createTicket,
  createUser,
  createWorkflow,
  createWorkspace,
  memberActor,
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
let ticket: TicketFixture;

async function counts() {
  const blobRows = await handle.db
    .select()
    .from(blobs)
    .where(eq(blobs.workspaceId, workspaceId))
    .all();
  const fileRows = await handle.db
    .select()
    .from(files)
    .where(eq(files.workspaceId, workspaceId))
    .all();
  const sourceRows = await handle.db
    .select()
    .from(fileSources)
    .where(eq(fileSources.workspaceId, workspaceId))
    .all();
  return { blobRows, fileRows, sourceRows };
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Files Workspace');
  workspaceId = workspace.id;
  await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  workflow = await createWorkflow(handle.db, workspaceId);
  ticket = await createTicket(handle.db, { workspaceId, workflow });
  service = createFileService({ db: handle.db });
});

describe('file ingestion', () => {
  test('hashes and stores bytes, records provenance and audits the ingest', async () => {
    const result = await service.ingest(actor, {
      filename: 'policy.pdf',
      bytes: encoder.encode('%PDF-1.7 policy bytes'),
      mimeType: 'application/pdf',
      source: { type: 'human_upload', label: 'Upload form' },
      process: false
    });

    expect(result.contentHash).toBe(await sha256Hex(encoder.encode('%PDF-1.7 policy bytes')));
    expect(result.deduplicated).toBe(false);
    expect(result.reusedFile).toBe(false);

    const { blobRows, fileRows, sourceRows } = await counts();
    expect(blobRows).toHaveLength(1);
    expect(fileRows).toHaveLength(1);
    expect(sourceRows).toHaveLength(1);

    const blob = blobRows[0]!;
    expect(blob.contentHash).toBe(result.contentHash);
    expect(blob.size).toBe(21);
    expect(blob.storageProvider).toBe('local');
    expect(blob.storageKey).toContain(workspaceId);

    // The bytes are on disk under the content-addressed key, not in the database.
    const store = new LocalBlobStore({ root: handle.tempDir });
    expect(new TextDecoder().decode(await store.get(blob.storageKey))).toBe(
      '%PDF-1.7 policy bytes'
    );

    const sourceRow = sourceRows[0]!;
    expect(sourceRow.sourceType).toBe('human_upload');
    expect(sourceRow.deduplicated).toBe(false);
    expect(sourceRow.observedContentHash).toBe(result.contentHash);
    expect(sourceRow.occurredAt).toBeGreaterThan(0);

    const audit = (await handle.sqlite
      .query('SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY seq')
      .all(workspaceId)) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toContain(AuditActions.fileIngested);
  });

  test('identical bytes ingest once as a blob but keep both provenances', async () => {
    const bytes = encoder.encode('duplicate me');
    const first = await service.ingest(actor, {
      filename: 'invoice.csv',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });
    const second = await service.ingest(actor, {
      filename: 'invoice.csv',
      bytes,
      source: { type: 'human_upload', reference: 'second-appearance' },
      process: false
    });

    expect(second.deduplicated).toBe(true);
    expect(second.reusedFile).toBe(true);
    expect(second.fileId).toBe(first.fileId);
    expect(second.blobId).toBe(first.blobId);

    const { blobRows, fileRows, sourceRows } = await counts();
    expect(blobRows).toHaveLength(1);
    expect(fileRows).toHaveLength(1);
    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.filter((row) => row.deduplicated)).toHaveLength(1);

    const audit = (await handle.sqlite
      .query('SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY seq')
      .all(workspaceId)) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toContain(AuditActions.fileBlobDeduplicated);
  });

  test('the same bytes from a different source channel become a distinct logical file', async () => {
    const bytes = encoder.encode('shared bytes');
    const upload = await service.ingest(actor, {
      filename: 'statement.pdf',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });
    const email = await service.ingest(actor, {
      filename: 'statement.pdf',
      bytes,
      source: { type: 'incoming_email', reference: 'msg-1' },
      process: false
    });

    expect(email.deduplicated).toBe(true);
    expect(email.reusedFile).toBe(false);
    expect(email.fileId).not.toBe(upload.fileId);
    expect(email.blobId).toBe(upload.blobId);

    const { blobRows, fileRows, sourceRows } = await counts();
    expect(blobRows).toHaveLength(1);
    expect(fileRows).toHaveLength(2);
    expect(sourceRows).toHaveLength(2);
  });

  test('a second workspace gets its own blob and cannot see the first file', async () => {
    const bytes = encoder.encode('cross tenant bytes');
    const first = await service.ingest(actor, {
      filename: 'secret.txt',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });

    const other = await createWorkspace(handle.db, 'Other Workspace');
    await configureLocalStorage(handle.db, other.id, handle.tempDir);
    const otherUser = await createUser(handle.db);
    const otherActor = ownerActor(other.id, otherUser.id);

    const second = await service.ingest(otherActor, {
      filename: 'secret.txt',
      bytes,
      source: { type: 'human_upload' },
      process: false
    });

    expect(second.deduplicated).toBe(false);
    expect(second.blobId).not.toBe(first.blobId);

    const allBlobs = await handle.db.select().from(blobs).all();
    expect(allBlobs).toHaveLength(2);
    expect(new Set(allBlobs.map((row) => row.contentHash)).size).toBe(1);

    await expect(service.requireFile(otherActor, first.fileId)).rejects.toThrow();
    await expect(service.requireFile(actor, second.fileId)).rejects.toThrow();
  });

  test('sanitises filenames and falls back to MIME detection', async () => {
    const result = await service.ingest(actor, {
      filename: '../../etc/Invoice.CSV',
      bytes: encoder.encode('a,b\n1,2\n'),
      source: { type: 'human_upload' },
      process: false
    });
    const row = await handle.db.select().from(files).where(eq(files.id, result.fileId)).all();
    expect(row[0]?.originalFilename).toBe('Invoice.CSV');
    expect(row[0]?.mimeType).toBe('text/csv');
  });

  test('rejects files over the workspace size limit before storing anything', async () => {
    const small = await createWorkspace(handle.db, 'Small Limit');
    await configureLocalStorage(handle.db, small.id, handle.tempDir, { maxFileBytes: 8 });
    const user = await createUser(handle.db);
    const smallActor = ownerActor(small.id, user.id);

    await expect(
      service.ingest(smallActor, {
        filename: 'big.txt',
        bytes: encoder.encode('more than eight bytes'),
        source: { type: 'human_upload' },
        process: false
      })
    ).rejects.toThrow();
    expect(
      await handle.db.select().from(blobs).where(eq(blobs.workspaceId, small.id)).all()
    ).toHaveLength(0);
  });
});

describe('ticket and workflow linkage', () => {
  test('ingest with a ticket link writes file and link in one transaction', async () => {
    const result = await service.ingest(actor, {
      filename: 'evidence.txt',
      bytes: encoder.encode('evidence'),
      source: { type: 'incoming_email', reference: 'msg-9' },
      ticketId: ticket.id,
      relationship: 'evidence',
      process: false
    });

    const links = await handle.db
      .select()
      .from(ticketFiles)
      .where(and(eq(ticketFiles.fileId, result.fileId), eq(ticketFiles.ticketId, ticket.id)))
      .all();
    expect(links).toHaveLength(1);
    expect(links[0]?.relationship).toBe('evidence');

    const view = await service.requireFile(actor, result.fileId);
    expect(view.ticketIds).toEqual([ticket.id]);
  });

  test('a failing ticket link rolls the whole ingest back', async () => {
    await expect(
      service.ingest(actor, {
        filename: 'orphan.txt',
        bytes: encoder.encode('should not persist'),
        source: { type: 'human_upload' },
        ticketId: 'does-not-exist',
        process: false
      })
    ).rejects.toThrow();

    const { fileRows, sourceRows } = await counts();
    expect(fileRows).toHaveLength(0);
    expect(sourceRows).toHaveLength(0);
    const blobRows = await handle.db
      .select()
      .from(blobs)
      .where(eq(blobs.workspaceId, workspaceId))
      .all();
    expect(blobRows).toHaveLength(0);
  });

  test('one file supports many tickets and one ticket many files', async () => {
    const secondTicket = await createTicket(handle.db, { workspaceId, workflow });
    const fileA = await service.ingest(actor, {
      filename: 'a.txt',
      bytes: encoder.encode('file-a'),
      source: { type: 'human_upload' },
      process: false
    });
    const fileB = await service.ingest(actor, {
      filename: 'b.txt',
      bytes: encoder.encode('file-b'),
      source: { type: 'human_upload' },
      process: false
    });

    await service.linkToTicket(actor, { fileId: fileA.fileId, ticketId: ticket.id });
    await service.linkToTicket(actor, { fileId: fileA.fileId, ticketId: secondTicket.id });
    await service.linkToTicket(actor, { fileId: fileB.fileId, ticketId: ticket.id });

    const ticketFilesForTicket = await service.listForTicket(actor, ticket.id);
    expect(ticketFilesForTicket.map((view) => view.id).sort()).toEqual(
      [fileA.fileId, fileB.fileId].sort()
    );
    const viewA = await service.requireFile(actor, fileA.fileId);
    expect(viewA.ticketIds.sort()).toEqual([ticket.id, secondTicket.id].sort());
  });

  test('workflow context is recorded and never overwrites another workflow', async () => {
    const otherWorkflow = await createWorkflow(handle.db, workspaceId, { name: 'Compliance' });
    const result = await service.ingest(actor, {
      filename: 'shared.txt',
      bytes: encoder.encode('shared context'),
      source: { type: 'human_upload' },
      workflowId: workflow.id,
      process: false
    });
    await service.addWorkflowContext(actor, {
      fileId: result.fileId,
      workflowId: otherWorkflow.id,
      contextLabel: 'Evidence'
    });

    const view = await service.requireFile(actor, result.fileId);
    expect(view.workflowIds.sort()).toEqual([workflow.id, otherWorkflow.id].sort());
  });
});

describe('permissions', () => {
  test('a member may ingest but an ungranted agent may not', async () => {
    const memberUser = await createUser(handle.db);
    const member = memberActor(workspaceId, memberUser.id);
    const result = await service.ingest(member, {
      filename: 'member.txt',
      bytes: encoder.encode('member upload'),
      source: { type: 'human_upload' },
      process: false
    });
    expect(result.fileId).toBeTruthy();

    const restricted = createActorContext({
      workspaceId,
      actorType: 'agent',
      actorId: 'agent-1',
      actorLabel: 'Agent',
      role: 'agent',
      permissions: []
    });
    await expect(
      service.ingest(restricted, {
        filename: 'denied.txt',
        bytes: encoder.encode('denied'),
        source: { type: 'agent_run' },
        process: false
      })
    ).rejects.toThrow();
    await expect(service.requireFile(restricted, result.fileId)).rejects.toThrow();
  });
});
