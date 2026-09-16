/**
 * Summary generation and reuse.
 *
 * A summary is only reused when the bytes *and* the processing run *and* the
 * model/prompt identity match. These tests pin that behaviour and that a human
 * edit becomes the current summary without destroying the generated history.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createActorContext } from '../../../src/lib/server/core/context';
import { files } from '../../../src/lib/server/db/schema';
import { setFileExtractionProvider } from '../../../src/lib/server/files/fields';
import { runProcessing } from '../../../src/lib/server/files/processing/pipeline';
import { createFileService, type FileService } from '../../../src/lib/server/files/service';
import {
  editFileSummary,
  generateSummary,
  listFileSummaries
} from '../../../src/lib/server/files/summary';
import { resolveBlobStore } from '../../../src/lib/server/storage/index';
import { configureLocalStorage, createFakeProvider } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, ownerActor } from '../../helpers/factories';

const encoder = new TextEncoder();

let handle: TestDatabase;
let service: FileService;
let workspaceId: string;
let actor: ReturnType<typeof ownerActor>;

async function processedFile(text: string): Promise<string> {
  const result = await service.ingest(actor, {
    filename: 'report.txt',
    bytes: encoder.encode(text),
    source: { type: 'human_upload' },
    process: false
  });
  const blobStore = await resolveBlobStore(handle.db, workspaceId);
  await runProcessing({ db: handle.db, blobStore, workspaceId }, { fileId: result.fileId });
  return result.fileId;
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Summary Workspace');
  workspaceId = workspace.id;
  await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  service = createFileService({ db: handle.db });
});

afterEach(() => {
  setFileExtractionProvider(null);
});

describe('generateSummary', () => {
  test('generates once and reuses the compatible summary', async () => {
    const fileId = await processedFile('The policy renews on 2026-04-01 with a 4200 premium.');
    const provider = createFakeProvider(() => 'A policy renewing 2026-04-01 for 4200.');
    setFileExtractionProvider(provider);

    const first = await generateSummary(actor, { fileId }, handle.db);
    expect(first.reused).toBe(false);
    expect(first.summary).toContain('4200');
    expect(provider.calls).toBe(1);

    const second = await generateSummary(actor, { fileId }, handle.db);
    expect(second.reused).toBe(true);
    expect(second.summaryId).toBe(first.summaryId);
    expect(provider.calls).toBe(1);

    const rows = await handle.db.select().from(files).where(eq(files.id, fileId)).all();
    expect(rows[0]?.summary).toContain('4200');
  });

  test('force regenerates and a new prompt version is a different identity', async () => {
    const fileId = await processedFile('Some document text');
    const provider = createFakeProvider((_request, call) => `summary ${call}`);
    setFileExtractionProvider(provider);

    await generateSummary(actor, { fileId }, handle.db);
    await generateSummary(actor, { fileId, force: true }, handle.db);
    expect(provider.calls).toBe(2);

    const versioned = await generateSummary(actor, { fileId, promptVersion: 'v2' }, handle.db);
    expect(versioned.reused).toBe(false);
    expect(provider.calls).toBe(3);

    const reused = await generateSummary(actor, { fileId, promptVersion: 'v2' }, handle.db);
    expect(reused.reused).toBe(true);
    expect(provider.calls).toBe(3);
  });

  test('requires extracted content and an installed provider', async () => {
    const result = await service.ingest(actor, {
      filename: 'raw.txt',
      bytes: encoder.encode('not processed'),
      source: { type: 'human_upload' },
      process: false
    });
    setFileExtractionProvider(createFakeProvider(() => 'x'));
    await expect(generateSummary(actor, { fileId: result.fileId }, handle.db)).rejects.toThrow();

    const fileId = await processedFile('processed text');
    setFileExtractionProvider(null);
    await expect(generateSummary(actor, { fileId }, handle.db)).rejects.toThrow();
  });
});

describe('human edits preserve generated history', () => {
  test('an edit becomes current and keeps the generated row', async () => {
    const fileId = await processedFile('A document worth summarising');
    const provider = createFakeProvider(() => 'Machine summary');
    setFileExtractionProvider(provider);
    await generateSummary(actor, { fileId }, handle.db);

    const edit = await editFileSummary(actor, { fileId, summary: 'Human summary' }, handle.db);
    expect(edit.summaryId).toBeTruthy();

    const history = await listFileSummaries(actor, fileId, handle.db);
    expect(history).toHaveLength(2);
    const current = history.filter((row) => row.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]?.summary).toBe('Human summary');
    expect(current[0]?.editedByType).toBe('user');
    expect(history.some((row) => row.summary === 'Machine summary' && !row.isCurrent)).toBe(true);

    const rows = await handle.db.select().from(files).where(eq(files.id, fileId)).all();
    expect(rows[0]?.summary).toBe('Human summary');
  });

  test('rejects an empty edit', async () => {
    const fileId = await processedFile('text');
    await expect(editFileSummary(actor, { fileId, summary: '   ' }, handle.db)).rejects.toThrow();
  });
});

describe('summary permissions', () => {
  test('reading summaries requires file:read', async () => {
    const fileId = await processedFile('text');
    const restricted = createActorContext({
      workspaceId,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: []
    });
    await expect(listFileSummaries(restricted, fileId, handle.db)).rejects.toThrow();
  });
});
