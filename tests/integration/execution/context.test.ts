/**
 * Agent context assembly.
 *
 * The follow-up brief (§18) requires that not every note, field and document is
 * injected into every prompt: agent, skill and state configuration control what the
 * model sees. That is a token-efficiency requirement and a data-minimisation one, so
 * it is tested by asserting what is *absent* as much as what is present.
 *
 * ADR-0021 replaced the legacy ticket primitive: context is now assembled for a
 * Record + WorkflowItem (`buildRecordRunContext`), and the effective contract is the
 * Object Type schema plus the workflow overlay.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import {
  type ActorContext,
  createActorContext,
  permissionsForRole
} from '../../../src/lib/server/core/context';
import { uuidv7 } from '../../../src/lib/server/core/ids';
import {
  clearSecretRegistry,
  registerSecretValue
} from '../../../src/lib/server/core/secret-registry';
import type { AgentSnapshot } from '../../../src/lib/server/db/schema';
import {
  blobs,
  fileExtractedContent,
  fileProcessingRuns,
  files as filesTable,
  fileWorkflowItems,
  users
} from '../../../src/lib/server/db/schema';
import { buildRecordRunContext } from '../../../src/lib/server/execution/context';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { createObjectType, setBaseFields } from '../../../src/lib/server/records/object-types';
import { addRecordNote, createRecord, updateRecord } from '../../../src/lib/server/records/service';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import {
  addWorkflowItemNote,
  createWorkflowItem
} from '../../../src/lib/server/workflow-items/service';
import { createWorkflow } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let actor: ActorContext;
let workflowId: string;
let stateId: string;
let recordId: string;
let workflowItemId: string;

const agent: AgentSnapshot = {
  id: 'agent-1',
  workspaceId: 'placeholder',
  name: 'Assessment Agent',
  instructions: 'Assess the claim.',
  skillIds: [],
  toolIds: [],
  version: 1
};

async function build(config: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return buildRecordRunContext(handle.db, {
    workspaceId: actor.workspaceId,
    workflowItemId,
    recordId,
    workflowId,
    stateId,
    stateName: 'Investigation',
    agent,
    config: config as never,
    ...extra
  });
}

function promptOf(context: { messages: Array<{ content: string }> }): string {
  return context.messages.map((message) => message.content).join('\n');
}

beforeEach(async () => {
  handle = createTestDatabase();
  resetBootstrap();
  resetToolRegistry();
  clearProviderOverrides();
  clearSecretRegistry();

  const workspace = await createWorkspace(handle.db, 'Context Co');
  const userId = uuidv7();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@context.test`,
      name: 'Context Owner',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
  await addMember(handle.db, workspace.id, userId, 'owner');
  actor = createActorContext({
    workspaceId: workspace.id,
    actorType: 'user',
    actorId: userId,
    actorLabel: 'Context Owner',
    role: 'owner',
    permissions: permissionsForRole('owner')
  });

  await runBootstrap({
    db: handle.db,
    sqlite: handle.sqlite,
    seed: undefined,
    skipMigrations: true,
    startWorker: false
  } as never);

  const objectType = createObjectType(handle.db, actor, { name: 'Claim' });
  await setBaseFields(handle.db, actor, objectType.id, [
    {
      key: 'customer',
      name: 'Customer',
      type: 'short_text',
      isPrimaryDisplay: true
    },
    { key: 'claim_amount', name: 'Claim Amount', type: 'currency' }
  ] as never);

  const workflow = createWorkflow(handle.db, actor, {
    name: 'Claims',
    template: 'claims',
    objectTypeId: objectType.id
  });
  workflowId = workflow.workflow.id;
  stateId = workflow.states.find((state) => state.name === 'Investigation')!.id;

  const record = await createRecord(handle.db, actor, {
    objectTypeId: objectType.id,
    fields: { customer: 'ACME Pty Ltd', claim_amount: 12_500 }
  });
  recordId = record.id;

  const item = await createWorkflowItem(handle.db, actor, {
    workflowId,
    recordId,
    stateId,
    deferExecution: true
  });
  workflowItemId = item.id;

  await addRecordNote(handle.db, actor, {
    recordId,
    body: 'Called the customer to confirm access.'
  });
  await addWorkflowItemNote(handle.db, actor, {
    workflowItemId,
    body: 'Waiting on the assessor to return.'
  });

  // A linked file with extracted content, so file context selection is exercised.
  const now = Date.now();
  const blobId = uuidv7(now);
  handle.db
    .insert(blobs)
    .values({
      id: blobId,
      workspaceId: actor.workspaceId,
      contentHash: 'a'.repeat(64),
      size: 120,
      mimeType: 'text/plain',
      storageProvider: 'local',
      storageKey: `workspaces/${actor.workspaceId}/blobs/aa/aa/${'a'.repeat(64)}`,
      createdAt: now,
      updatedAt: now
    })
    .run();
  const fileId = uuidv7(now);
  handle.db
    .insert(filesTable)
    .values({
      id: fileId,
      workspaceId: actor.workspaceId,
      blobId,
      originalFilename: 'assessment.txt',
      mimeType: 'text/plain',
      size: 120,
      kind: 'upload',
      status: 'ready',
      summary: 'Engineer assessment: roof replacement required.',
      createdAt: now,
      updatedAt: now
    })
    .run();
  handle.db
    .insert(fileWorkflowItems)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      workflowItemId,
      fileId,
      relationship: 'attachment',
      createdAt: now
    })
    .run();
  const processingRunId = uuidv7(now);
  handle.db
    .insert(fileProcessingRuns)
    .values({
      id: processingRunId,
      workspaceId: actor.workspaceId,
      fileId,
      processorType: 'plain_text',
      processorVersion: '1',
      configurationFingerprint: 'fp',
      processingKey: 'pk',
      status: 'succeeded',
      createdAt: now
    })
    .run();
  handle.db
    .insert(fileExtractedContent)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      fileId,
      processingRunId,
      contentKind: 'text',
      text: 'The engineer recommends full roof replacement at a cost of $12,500.',
      charCount: 68,
      createdAt: now
    })
    .run();
});

describe('context selection', () => {
  test('assembles the record, its contract and a namespaced system prompt', async () => {
    const context = await build({});
    const prompt = promptOf(context);

    // The header names the Object Type and the record's display value.
    expect(prompt).toContain('# Claim ACME Pty Ltd');
    expect(prompt).toContain('Customer');
    expect(prompt).toContain('ACME Pty Ltd');
    expect(prompt).toContain('Claim Amount');
    expect(context.sections).toContain('fields');
    expect(context.sections).toContain('record_contract');

    const system = context.messages[0]?.content ?? '';
    expect(system).toContain('Assessment Agent');
    expect(system).toContain('Investigation');
    expect(system).toContain('Assess the claim.');
    // The model is told it must not invent ids it has not been given.
    expect(system).toContain('Never invent');
  });

  test('the record contract can be omitted while the field values remain', async () => {
    const context = await build({ includeRecordSchema: false });
    const prompt = promptOf(context);
    expect(context.sections).not.toContain('record_contract');
    expect(prompt).not.toContain('Record contract');
    expect(prompt).toContain('ACME Pty Ltd');
    expect(context.sections).toContain('fields');
  });

  test('an enforced submission contract is stated in the system prompt', async () => {
    const context = await build(
      {},
      { requiredSubmission: { toolKey: 'workflowItems.submit', allowWorkflowChange: false } }
    );
    const system = context.messages[0]?.content ?? '';
    expect(system).toContain('workflowItems.submit');
    expect(system).toContain('record');
    expect(system).toContain('workflow');
  });

  test('notes are included only when requested, and bounded', async () => {
    for (let index = 0; index < 5; index++) {
      await addRecordNote(handle.db, actor, { recordId, body: `Follow-up note ${index}` });
    }

    const none = await build({ includeRecentNotes: 0 });
    const nonePrompt = promptOf(none);
    expect(nonePrompt).not.toContain('Follow-up note');
    expect(nonePrompt).not.toContain('Called the customer');

    const recent = await build({ includeRecentNotes: 2 });
    const prompt = promptOf(recent);
    expect(prompt).toContain('Follow-up note 4');
    expect(prompt).toContain('Follow-up note 3');
    // Only the two most recent notes, so an older one is absent.
    expect(prompt).not.toContain('Follow-up note 0');
    expect(recent.sections).toContain('record_notes');
  });

  test('record notes and work notes are assembled as distinguishable sections', async () => {
    const context = await build({ includeRecentNotes: 5 });
    const prompt = promptOf(context);
    expect(prompt).toContain('## Record notes');
    expect(prompt).toContain('Called the customer to confirm access.');
    expect(prompt).toContain('## Work notes');
    expect(prompt).toContain('Waiting on the assessor to return.');
    expect(context.sections).toContain('record_notes');
    expect(context.sections).toContain('work_notes');
  });

  test('a file summary is included, but extracted content never is', async () => {
    const summary = await build({ includeFileSummaries: true });
    const summaryPrompt = promptOf(summary);
    expect(summaryPrompt).toContain('assessment.txt');
    expect(summaryPrompt).toContain('roof replacement required');
    // Full extracted file content is never assembled into the prompt.
    expect(summaryPrompt).not.toContain('at a cost of $12,500');
    expect(summary.sections).toContain('files');

    const without = await build({ includeFileSummaries: false });
    const withoutPrompt = promptOf(without);
    expect(withoutPrompt).not.toContain('assessment.txt');
    expect(without.sections).not.toContain('files');
  });

  test('state history is opt-in', async () => {
    const without = await build({ includeStateHistory: false });
    expect(promptOf(without)).not.toContain('State history');

    const withHistory = await build({ includeStateHistory: true });
    expect(promptOf(withHistory)).toContain('State history');
  });

  test('the persisted snapshot is redacted and records what was assembled', async () => {
    registerSecretValue('sk-context-canary-123456');
    const context = await build({});

    expect(context.snapshot).toHaveProperty('sections');
    expect(context.snapshot).toHaveProperty('system');
    expect(context.snapshot).toHaveProperty('user');
    const serialized = JSON.stringify(context.snapshot);
    expect(serialized).not.toContain('sk-context-canary-123456');
    // The snapshot is what an operator inspects, so it must not contain secrets or
    // anything that was not deliberately assembled.
    expect(Array.isArray(context.snapshot.sections)).toBe(true);
    expect((context.snapshot as { workflowItemId?: string }).workflowItemId).toBe(workflowItemId);
    expect((context.snapshot as { recordId?: string }).recordId).toBe(recordId);
  });

  test('a secret value that somehow reached the record is still masked', async () => {
    const canary = 'sk-record-canary-abcdef';
    registerSecretValue(canary);
    await updateRecord(handle.db, actor, { recordId, fields: { customer: canary } });

    const context = await build({});
    const prompt = promptOf(context);
    expect(prompt).not.toContain(canary);
    expect(prompt).toContain('[redacted]');
  });
});
