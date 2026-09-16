/**
 * Retrieval parity and structured file filtering.
 *
 * ADR-0018 promises that FTS5 and the portable `LIKE` fallback answer the same
 * question. This suite processes real files, then asserts both indexes return the
 * same file ids, and that the frozen filter AST compiles correctly over system
 * fields and workflow file fields.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createActorContext } from '../../../src/lib/server/core/context';
import { fileFieldValues } from '../../../src/lib/server/db/schema';
import {
  applyFileFieldsToWorkflow,
  createFileFieldDefinition,
  setFileFieldValues
} from '../../../src/lib/server/files/fields';
import { runProcessing } from '../../../src/lib/server/files/processing/pipeline';
import {
  findFiles,
  ftsFileSearchIndex,
  hasFileContentFts,
  likeFileSearchIndex,
  searchFileContent
} from '../../../src/lib/server/files/retrieval';
import { createFileService, type FileService } from '../../../src/lib/server/files/service';
import type { FilterAst, FilterCondition } from '../../../src/lib/server/filters/ast';
import { resolveBlobStore } from '../../../src/lib/server/storage/index';
import { configureLocalStorage } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createUser,
  createWorkflow,
  createWorkspace,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';

const encoder = new TextEncoder();

let handle: TestDatabase;
let service: FileService;
let workspaceId: string;
let actor: ReturnType<typeof ownerActor>;
let workflow: WorkflowFixture;

function condition(
  key: string,
  operator: FilterCondition['operator'],
  value?: unknown,
  kind: FilterCondition['kind'] = 'system'
): FilterCondition {
  return { type: 'condition', kind, key, operator, value };
}

function group(children: FilterCondition[]): FilterAst {
  return { type: 'group', op: 'and', children };
}

async function ingestProcessed(filename: string, text: string, mimeType?: string) {
  const result = await service.ingest(actor, {
    filename,
    bytes: encoder.encode(text),
    mimeType,
    source: { type: 'human_upload' },
    workflowId: workflow.id,
    process: false
  });
  const blobStore = await resolveBlobStore(handle.db, workspaceId);
  await runProcessing(
    { db: handle.db, blobStore, workspaceId },
    { fileId: result.fileId, workflowId: workflow.id }
  );
  return result;
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Retrieval Workspace');
  workspaceId = workspace.id;
  await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  workflow = await createWorkflow(handle.db, workspaceId);
  service = createFileService({ db: handle.db });
});

describe('content search parity', () => {
  test('FTS and LIKE return the same files for a term', async () => {
    await ingestProcessed('a.txt', 'The ACME invoice total is 4200 dollars');
    await ingestProcessed('b.txt', 'A globex policy renewal notice');
    await ingestProcessed('c.txt', 'An initech receipt for office supplies');

    expect(hasFileContentFts(handle.db)).toBe(true);

    for (const query of ['invoice', 'globex', 'receipt', 'ACME']) {
      const fts = ftsFileSearchIndex.search(handle.db, { workspaceId, query });
      const like = likeFileSearchIndex.search(handle.db, { workspaceId, query });
      expect(fts.map((hit) => hit.fileId).sort()).toEqual(like.map((hit) => hit.fileId).sort());
    }
  });

  test('searchFileContent finds extracted text and respects workflow scope', async () => {
    const invoice = await ingestProcessed('invoice.txt', 'ACME invoice 4200');
    await ingestProcessed('policy.txt', 'Globex policy renewal');

    const hits = await searchFileContent(actor, { query: 'ACME invoice' }, handle.db);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.fileId).toBe(invoice.fileId);
    expect(hits[0]?.filename).toBe('invoice.txt');

    const scoped = await searchFileContent(
      actor,
      { query: 'ACME', workflowId: workflow.id },
      handle.db
    );
    expect(scoped).toHaveLength(1);

    const otherWorkflow = await createWorkflow(handle.db, workspaceId, { name: 'Other' });
    const outOfScope = await searchFileContent(
      actor,
      { query: 'ACME', workflowId: otherWorkflow.id },
      handle.db
    );
    expect(outOfScope).toHaveLength(0);
  });

  test('an empty query is a no-op', async () => {
    await ingestProcessed('a.txt', 'anything');
    expect(await searchFileContent(actor, { query: '   ' }, handle.db)).toHaveLength(0);
  });
});

describe('structured file listing', () => {
  test('filters on system fields with the frozen AST', async () => {
    await ingestProcessed('invoice.txt', 'one');
    await ingestProcessed('policy.txt', 'two');
    await ingestProcessed('receipt.txt', 'three');

    const byName = await findFiles(
      actor,
      { filter: group([condition('filename', 'contains', 'invoice')]) },
      handle.db
    );
    expect(byName.items.map((item) => item.filename)).toEqual(['invoice.txt']);

    const byStatus = await findFiles(
      actor,
      { filter: group([condition('status', 'eq', 'ready')]) },
      handle.db
    );
    expect(byStatus.items).toHaveLength(3);

    const byMime = await findFiles(
      actor,
      { filter: group([condition('mimeType', 'starts_with', 'text/')]) },
      handle.db
    );
    expect(byMime.items).toHaveLength(3);

    const noMatch = await findFiles(
      actor,
      { filter: group([condition('filename', 'eq', 'missing.txt')]) },
      handle.db
    );
    expect(noMatch.items).toHaveLength(0);
  });

  test('filters on workflow file fields', async () => {
    const fieldId = await createFileFieldDefinition(
      actor,
      {
        key: 'document_type',
        name: 'Document Type',
        type: 'select',
        options: { choices: [{ value: 'invoice', label: 'Invoice' }] }
      },
      handle.db
    );
    await applyFileFieldsToWorkflow(
      actor,
      {
        workflowId: workflow.id,
        fieldKeys: ['document_type']
      },
      handle.db
    );

    const invoice = await ingestProcessed('invoice.txt', 'an invoice');
    await ingestProcessed('evidence.txt', 'some evidence');
    await setFileFieldValues(
      actor,
      {
        fileId: invoice.fileId,
        workflowId: workflow.id,
        values: { document_type: 'invoice' },
        source: 'human'
      },
      handle.db
    );

    const rows = await handle.db
      .select()
      .from(fileFieldValues)
      .where(eq(fileFieldValues.fieldDefinitionId, fieldId))
      .all();
    expect(rows).toHaveLength(1);

    const matched = await findFiles(
      actor,
      { filter: group([condition('document_type', 'eq', 'invoice', 'file_field')]) },
      handle.db
    );
    expect(matched.items.map((item) => item.filename)).toEqual(['invoice.txt']);
  });

  test('paginates with a keyset cursor', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      await service.ingest(actor, {
        filename: name,
        bytes: encoder.encode(name),
        source: { type: 'human_upload' },
        process: false
      });
    }
    const first = await findFiles(actor, { limit: 2 }, handle.db);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await findFiles(actor, { limit: 2, cursor: first.nextCursor }, handle.db);
    expect(second.items).toHaveLength(2);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);

    const seen = new Set([
      ...first.items.map((item) => item.id),
      ...second.items.map((item) => item.id)
    ]);
    expect(seen.size).toBe(4);
  });

  test('rejects an unknown field key instead of broadening the result', async () => {
    await expect(
      findFiles(
        actor,
        { filter: group([condition('not_a_field', 'eq', 'x', 'file_field')]) },
        handle.db
      )
    ).rejects.toThrow();
  });
});

describe('retrieval permissions', () => {
  test('an actor without file:read cannot list or search', async () => {
    await ingestProcessed('a.txt', 'secret content');
    const restricted = createActorContext({
      workspaceId,
      actorType: 'agent',
      actorId: 'agent-x',
      actorLabel: 'Agent',
      role: 'agent',
      permissions: []
    });
    await expect(findFiles(restricted, {}, handle.db)).rejects.toThrow();
    await expect(searchFileContent(restricted, { query: 'secret' }, handle.db)).rejects.toThrow();
  });
});
