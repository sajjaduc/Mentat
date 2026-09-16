/**
 * Durable processing pipeline and job handler.
 *
 * The pipeline has to be observable, versioned and idempotent: these tests run it
 * through the real durable queue (duplicate delivery included), force a processor
 * version change, and assert that an unsupported format is recorded explicitly
 * rather than appearing to succeed with empty content.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AuditActions } from '../../../src/lib/server/audit/ledger';
import { fileExtractedContent, fileProcessingRuns, files } from '../../../src/lib/server/db/schema';
import { registerFileJobHandlers } from '../../../src/lib/server/files/handlers';
import { extracted } from '../../../src/lib/server/files/processing/contracts';
import { runProcessing } from '../../../src/lib/server/files/processing/pipeline';
import { createProcessorRegistry } from '../../../src/lib/server/files/processing/registry';
import { searchFileContent } from '../../../src/lib/server/files/retrieval';
import { createFileService, type FileService } from '../../../src/lib/server/files/service';
import { listJobs, SqliteJobQueue } from '../../../src/lib/server/jobs/queue';
import { drainQueue } from '../../../src/lib/server/jobs/worker';
import { resolveBlobStore } from '../../../src/lib/server/storage/index';
import { buildPng, configureLocalStorage } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, ownerActor } from '../../helpers/factories';

const encoder = new TextEncoder();

let handle: TestDatabase;
let service: FileService;
let workspaceId: string;
let actor: ReturnType<typeof ownerActor>;

async function ingest(filename: string, bytes: Uint8Array, process = false) {
  return service.ingest(actor, {
    filename,
    bytes,
    source: { type: 'human_upload' },
    process
  });
}

async function auditActions(): Promise<string[]> {
  const rows = (await handle.sqlite
    .query('SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY seq')
    .all(workspaceId)) as Array<{ action: string }>;
  return rows.map((row) => row.action);
}

beforeAll(() => {
  registerFileJobHandlers();
});

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Processing Workspace');
  workspaceId = workspace.id;
  await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  service = createFileService({ db: handle.db });
});

describe('file.process job', () => {
  test('runs the pipeline end to end and is idempotent on duplicate delivery', async () => {
    const result = await ingest('notes.txt', encoder.encode('hello durable processing'), true);
    expect(result.processingQueued).toBe(true);

    const pending = await listJobs(handle.db, { workspaceId, status: ['pending'] });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe('file.process');

    // Duplicate delivery of the same unit of work, bypassing the dedupe key.
    const queue = new SqliteJobQueue(handle.db);
    await queue.enqueue({
      workspaceId,
      type: 'file.process',
      payload: { fileId: result.fileId, workflowId: null, force: false }
    });

    const processed = await drainQueue({
      db: handle.db,
      workspaceId,
      maxJobs: 10,
      pollMs: 25,
      idleTimeoutMs: 150
    });
    expect(processed).toBe(2);

    const jobs = await listJobs(handle.db, { workspaceId });
    expect(jobs.every((job) => job.status === 'completed')).toBe(true);

    const runs = await handle.db
      .select()
      .from(fileProcessingRuns)
      .where(eq(fileProcessingRuns.fileId, result.fileId))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('succeeded');

    const content = await handle.db
      .select()
      .from(fileExtractedContent)
      .where(eq(fileExtractedContent.fileId, result.fileId))
      .all();
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toContain('durable processing');

    const file = await handle.db.select().from(files).where(eq(files.id, result.fileId)).all();
    expect(file[0]?.status).toBe('ready');
    expect(file[0]?.metadata?.charCount).toBe(24);

    const actions = await auditActions();
    expect(actions).toContain(AuditActions.fileProcessingCompleted);
  });

  test('extracted content is findable by content search', async () => {
    const result = await ingest('invoice.txt', encoder.encode('ACME invoice 98765'), true);
    await drainQueue({ db: handle.db, workspaceId, maxJobs: 5, pollMs: 25, idleTimeoutMs: 150 });

    const hits = await searchFileContent(actor, { query: 'ACME invoice' }, handle.db);
    expect(hits.map((hit) => hit.fileId)).toContain(result.fileId);
  });
});

describe('processing identity and reuse', () => {
  test('reuses identical configuration and reprocesses when it changes', async () => {
    const result = await ingest('doc.txt', encoder.encode('configuration sensitive'));
    const blobStore = await resolveBlobStore(handle.db, workspaceId);

    const first = await runProcessing(
      { db: handle.db, blobStore, workspaceId, configuration: { maxChars: 100 } },
      { fileId: result.fileId }
    );
    expect(first.reused).toBe(false);

    const reused = await runProcessing(
      { db: handle.db, blobStore, workspaceId, configuration: { maxChars: 100 } },
      { fileId: result.fileId }
    );
    expect(reused.reused).toBe(true);
    expect(reused.runId).toBe(first.runId);

    const changed = await runProcessing(
      { db: handle.db, blobStore, workspaceId, configuration: { maxChars: 200 } },
      { fileId: result.fileId }
    );
    expect(changed.reused).toBe(false);
    expect(changed.runId).not.toBe(first.runId);
    expect(changed.processingKey).not.toBe(first.processingKey);

    const runs = await handle.db
      .select()
      .from(fileProcessingRuns)
      .where(eq(fileProcessingRuns.fileId, result.fileId))
      .all();
    expect(runs).toHaveLength(2);
  });

  test('a processor version change forces a new run and refreshes the index', async () => {
    const result = await ingest('versioned.txt', encoder.encode('version one'));
    const blobStore = await resolveBlobStore(handle.db, workspaceId);
    const first = await runProcessing(
      { db: handle.db, blobStore, workspaceId },
      { fileId: result.fileId }
    );
    expect(first.processorVersion).toBe('1');

    const versionTwo = createProcessorRegistry([
      {
        type: 'text',
        version: '2',
        supports: (mimeType: string) => mimeType === 'text/plain',
        process: async () => extracted({ text: 'version two output', contentKind: 'text' })
      }
    ]);
    const second = await runProcessing(
      { db: handle.db, blobStore, workspaceId, registry: versionTwo },
      { fileId: result.fileId }
    );
    expect(second.processorVersion).toBe('2');
    expect(second.reused).toBe(false);

    const hits = await searchFileContent(actor, { query: 'version two' }, handle.db);
    expect(hits.map((hit) => hit.fileId)).toContain(result.fileId);

    const runs = await handle.db
      .select()
      .from(fileProcessingRuns)
      .where(eq(fileProcessingRuns.fileId, result.fileId))
      .all();
    expect(runs).toHaveLength(2);
  });
});

describe('unsupported formats and failures', () => {
  test('an image is recorded as an explicit unsupported outcome with metadata', async () => {
    const result = await ingest('photo.png', buildPng(12, 34), true);
    await drainQueue({ db: handle.db, workspaceId, maxJobs: 5, pollMs: 25, idleTimeoutMs: 150 });

    const runs = await handle.db
      .select()
      .from(fileProcessingRuns)
      .where(eq(fileProcessingRuns.fileId, result.fileId))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.resultSummary).toContain('unsupported');

    const content = await handle.db
      .select()
      .from(fileExtractedContent)
      .where(eq(fileExtractedContent.fileId, result.fileId))
      .all();
    expect(content).toHaveLength(0);

    const file = await handle.db.select().from(files).where(eq(files.id, result.fileId)).all();
    expect(file[0]?.status).toBe('ready');
    expect(file[0]?.metadata?.imageWidth).toBe(12);
    expect(file[0]?.metadata?.imageHeight).toBe(34);
  });

  test('a processor failure marks the run and file failed and is audited', async () => {
    const result = await ingest('broken.txt', encoder.encode('will fail'));
    const blobStore = await resolveBlobStore(handle.db, workspaceId);
    const failing = createProcessorRegistry([
      {
        type: 'text',
        version: '9',
        supports: (mimeType: string) => mimeType === 'text/plain',
        process: async () => {
          throw new Error('parser exploded');
        }
      }
    ]);

    await expect(
      runProcessing(
        { db: handle.db, blobStore, workspaceId, registry: failing },
        { fileId: result.fileId }
      )
    ).rejects.toThrow();

    const runs = await handle.db
      .select()
      .from(fileProcessingRuns)
      .where(eq(fileProcessingRuns.fileId, result.fileId))
      .all();
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toContain('parser exploded');

    const file = await handle.db.select().from(files).where(eq(files.id, result.fileId)).all();
    expect(file[0]?.status).toBe('failed');
    expect(await auditActions()).toContain(AuditActions.fileProcessingFailed);
  });

  test('an unknown MIME type yields an unsupported registry outcome, not empty content', async () => {
    const result = await ingest('mystery.bin', new Uint8Array([0x00, 0x01, 0x02, 0xff]));
    const blobStore = await resolveBlobStore(handle.db, workspaceId);
    const outcome = await runProcessing(
      { db: handle.db, blobStore, workspaceId },
      { fileId: result.fileId }
    );
    expect(outcome.processorType).toBe('unsupported');
    expect(outcome.extracted).toBe(false);

    const runs = await handle.db
      .select()
      .from(fileProcessingRuns)
      .where(and(eq(fileProcessingRuns.fileId, result.fileId)))
      .all();
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.resultSummary).toContain('unsupported');
  });
});
