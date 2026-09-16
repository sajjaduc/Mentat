/**
 * Workflow-interpreted file fields.
 *
 * The same document must be able to be a `Policy Schedule` in one workflow and
 * `Evidence` in another, and a human correction must leave before/after history.
 * These tests cover the typed columns, history rows, extraction metadata and
 * permission boundary.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AuditActions } from '../../../src/lib/server/audit/ledger';
import { createActorContext } from '../../../src/lib/server/core/context';
import { fieldValueHistory, fileFieldValues } from '../../../src/lib/server/db/schema';
import {
  applyFileFieldsToWorkflow,
  createFileFieldDefinition,
  extractFileFields,
  listFileFieldValues,
  setFileExtractionProvider,
  setFileFieldValues
} from '../../../src/lib/server/files/fields';
import { runProcessing } from '../../../src/lib/server/files/processing/pipeline';
import { createFileService, type FileService } from '../../../src/lib/server/files/service';
import { resolveBlobStore } from '../../../src/lib/server/storage/index';
import { configureLocalStorage, createFakeProvider } from '../../helpers/blobs';
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
let underwriting: WorkflowFixture;
let compliance: WorkflowFixture;
let fileId: string;

async function auditActions(): Promise<string[]> {
  const rows = (await handle.sqlite
    .query('SELECT action FROM audit_events WHERE workspace_id = ? ORDER BY seq')
    .all(workspaceId)) as Array<{ action: string }>;
  return rows.map((row) => row.action);
}

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Fields Workspace');
  workspaceId = workspace.id;
  await configureLocalStorage(handle.db, workspaceId, handle.tempDir);
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
  underwriting = await createWorkflow(handle.db, workspaceId, { name: 'Underwriting' });
  compliance = await createWorkflow(handle.db, workspaceId, { name: 'Compliance' });
  service = createFileService({ db: handle.db });

  await createFileFieldDefinition(
    actor,
    {
      key: 'document_type',
      name: 'Document Type',
      type: 'select',
      options: {
        choices: [
          { value: 'invoice', label: 'Invoice' },
          { value: 'evidence', label: 'Evidence' },
          { value: 'policy_schedule', label: 'Policy Schedule' }
        ]
      }
    },
    handle.db
  );
  await createFileFieldDefinition(
    actor,
    { key: 'policy_number', name: 'Policy Number', type: 'short_text' },
    handle.db
  );
  await createFileFieldDefinition(
    actor,
    { key: 'premium', name: 'Premium', type: 'currency' },
    handle.db
  );
  await createFileFieldDefinition(
    actor,
    { key: 'expiry_date', name: 'Expiry Date', type: 'date' },
    handle.db
  );
  const keys = ['document_type', 'policy_number', 'premium', 'expiry_date'];
  await applyFileFieldsToWorkflow(
    actor,
    { workflowId: underwriting.id, fieldKeys: keys },
    handle.db
  );
  await applyFileFieldsToWorkflow(actor, { workflowId: compliance.id, fieldKeys: keys }, handle.db);

  const result = await service.ingest(actor, {
    filename: 'policy.txt',
    bytes: encoder.encode('Policy PN-1 with premium 4200 expiring 2026-04-01'),
    source: { type: 'human_upload' },
    workflowId: underwriting.id,
    process: false
  });
  fileId = result.fileId;
  await service.addWorkflowContext(actor, { fileId, workflowId: compliance.id });
  const blobStore = await resolveBlobStore(handle.db, workspaceId);
  await runProcessing({ db: handle.db, blobStore, workspaceId }, { fileId });
});

afterEach(() => {
  setFileExtractionProvider(null);
});

describe('workflow-specific interpretation', () => {
  test('the same file holds different values in two workflows', async () => {
    await setFileFieldValues(
      actor,
      {
        fileId,
        workflowId: underwriting.id,
        values: { document_type: 'policy_schedule', policy_number: 'PN-1', premium: '1,200.50' },
        source: 'human'
      },
      handle.db
    );
    await setFileFieldValues(
      actor,
      {
        fileId,
        workflowId: compliance.id,
        values: { document_type: 'evidence' },
        source: 'human'
      },
      handle.db
    );

    const underwritingValues = await listFileFieldValues(
      actor,
      { fileId, workflowId: underwriting.id },
      handle.db
    );
    const complianceValues = await listFileFieldValues(
      actor,
      { fileId, workflowId: compliance.id },
      handle.db
    );
    expect(underwritingValues.find((value) => value.key === 'document_type')?.value).toBe(
      'policy_schedule'
    );
    expect(complianceValues.find((value) => value.key === 'document_type')?.value).toBe('evidence');

    // Typed columns, not an opaque JSON blob.
    const premiumRow = await handle.db
      .select()
      .from(fileFieldValues)
      .where(
        and(eq(fileFieldValues.fileId, fileId), eq(fileFieldValues.workflowId, underwriting.id))
      )
      .all();
    const premium = premiumRow.find((row) => row.valueNumber !== null);
    expect(premium?.valueNumber).toBe(1200.5);

    const dateValue = underwritingValues.find((value) => value.key === 'expiry_date');
    expect(dateValue).toBeUndefined();
  });
});

describe('correction history', () => {
  test('a correction appends history with before and after values', async () => {
    await setFileFieldValues(
      actor,
      {
        fileId,
        workflowId: underwriting.id,
        values: { document_type: 'policy_schedule' },
        source: 'human'
      },
      handle.db
    );
    const corrected = await setFileFieldValues(
      actor,
      {
        fileId,
        workflowId: underwriting.id,
        values: { document_type: 'invoice' },
        source: 'human'
      },
      handle.db
    );
    expect(corrected.changed).toHaveLength(1);
    expect(corrected.changed[0]?.previous).toBe('policy_schedule');
    expect(corrected.changed[0]?.next).toBe('invoice');

    const history = await handle.db
      .select()
      .from(fieldValueHistory)
      .where(and(eq(fieldValueHistory.ownerId, fileId), eq(fieldValueHistory.ownerType, 'file')))
      .all();
    // One history row per write — including the first set — never overwritten.
    expect(history).toHaveLength(2);
    const latest = history[history.length - 1];
    expect(latest?.previousValue).toBe('policy_schedule');
    expect(latest?.newValue).toBe('invoice');
    expect(latest?.source).toBe('human');
    expect(await auditActions()).toContain(AuditActions.fileFieldCorrected);
  });

  test('typed validation rejects an invalid value', async () => {
    await expect(
      setFileFieldValues(
        actor,
        {
          fileId,
          workflowId: underwriting.id,
          values: { document_type: 'not_a_choice' },
          source: 'human'
        },
        handle.db
      )
    ).rejects.toThrow();
    await expect(
      setFileFieldValues(
        actor,
        {
          fileId,
          workflowId: underwriting.id,
          values: { premium: 'not money' },
          source: 'human'
        },
        handle.db
      )
    ).rejects.toThrow();
    await expect(
      setFileFieldValues(
        actor,
        { fileId, workflowId: underwriting.id, values: { unknown_field: 'x' }, source: 'human' },
        handle.db
      )
    ).rejects.toThrow();
  });
});

describe('field extraction', () => {
  test('extracts configured fields through the provider seam with confidence', async () => {
    const provider = createFakeProvider(() =>
      JSON.stringify({
        document_type: { value: 'policy_schedule', confidence: 0.92, page: 1, span: 'top' },
        policy_number: { value: 'PN-1', confidence: 0.8 },
        premium: { value: '4200' }
      })
    );
    setFileExtractionProvider(provider);

    const result = await extractFileFields(
      actor,
      { fileId, workflowId: underwriting.id },
      handle.db
    );
    expect(result.extracted).toBe(3);
    expect(provider.calls).toBe(1);

    const values = await listFileFieldValues(
      actor,
      { fileId, workflowId: underwriting.id },
      handle.db
    );
    const type = values.find((value) => value.key === 'document_type');
    expect(type?.value).toBe('policy_schedule');
    expect(type?.confidence).toBe(0.92);
    expect(type?.sourcePage).toBe(1);
    expect(type?.sourceSpan).toBe('top');

    const rows = await handle.db
      .select()
      .from(fileFieldValues)
      .where(eq(fileFieldValues.fileId, fileId))
      .all();
    const premium = rows.find((row) => row.valueNumber !== null);
    expect(premium?.valueNumber).toBe(4200);

    const history = await handle.db
      .select()
      .from(fieldValueHistory)
      .where(eq(fieldValueHistory.ownerId, fileId))
      .all();
    expect(history.every((row) => row.source === 'extraction')).toBe(true);
    expect(await auditActions()).toContain(AuditActions.fileFieldExtracted);
  });

  test('fails loudly when no provider or no extracted content exists', async () => {
    await expect(
      extractFileFields(actor, { fileId, workflowId: underwriting.id }, handle.db)
    ).rejects.toThrow();

    setFileExtractionProvider(createFakeProvider(() => '{}'));
    const unprocessed = await service.ingest(actor, {
      filename: 'raw.txt',
      bytes: encoder.encode('raw'),
      source: { type: 'human_upload' },
      workflowId: underwriting.id,
      process: false
    });
    await expect(
      extractFileFields(
        actor,
        { fileId: unprocessed.fileId, workflowId: underwriting.id },
        handle.db
      )
    ).rejects.toThrow();
  });

  test('requires a configured workflow field set', async () => {
    setFileExtractionProvider(createFakeProvider(() => '{}'));
    const empty = await createWorkflow(handle.db, workspaceId, { name: 'Empty' });
    await expect(
      extractFileFields(actor, { fileId, workflowId: empty.id }, handle.db)
    ).rejects.toThrow();
  });
});

describe('field permissions', () => {
  test('an actor without file:write cannot set or extract fields', async () => {
    const restricted = createActorContext({
      workspaceId,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: ['file:read']
    });
    await expect(
      setFileFieldValues(
        restricted,
        { fileId, workflowId: underwriting.id, values: { policy_number: 'X' }, source: 'agent' },
        handle.db
      )
    ).rejects.toThrow();
    await expect(
      extractFileFields(restricted, { fileId, workflowId: underwriting.id }, handle.db)
    ).rejects.toThrow();
    // Reading is allowed with file:read.
    await expect(
      listFileFieldValues(restricted, { fileId, workflowId: underwriting.id }, handle.db)
    ).resolves.toBeInstanceOf(Array);
  });
});
