/**
 * Agent context assembly.
 *
 * The follow-up brief (§18) requires that not every note, field and document is
 * injected into every prompt: agent, skill and state configuration control what the
 * model sees. That is a token-efficiency requirement and a data-minimisation one, so
 * it is tested by asserting what is *absent* as much as what is present.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
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
  files as filesTable,
  ticketFiles,
  ticketNotes,
  users
} from '../../../src/lib/server/db/schema';
import { buildAgentRunContext } from '../../../src/lib/server/execution/context';
import { createFieldDefinition, setWorkflowFields } from '../../../src/lib/server/fields/service';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { addNoteSync, createTicketSync } from '../../../src/lib/server/tickets/service';
import { writeTicketFieldValues } from '../../../src/lib/server/tickets/values';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { createWorkflow, updateState } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { addMember, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let actor: ActorContext;
let workflowId: string;
let stateId: string;
let ticketId: string;

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
  const ticket = handle.db
    .select()
    .from((await import('../../../src/lib/server/db/schema')).tickets)
    .where(eq((await import('../../../src/lib/server/db/schema')).tickets.id, ticketId))
    .all()[0]!;
  return buildAgentRunContext(handle.db, {
    workspaceId: actor.workspaceId,
    ticket,
    workflowId,
    stateId,
    stateName: 'Investigation',
    agent,
    config: config as never,
    ...extra
  });
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

  const workflow = createWorkflow(handle.db, actor, { name: 'Claims', template: 'claims' });
  workflowId = workflow.workflow.id;
  stateId = workflow.states.find((state) => state.name === 'Investigation')!.id;

  const customer = createFieldDefinition(handle.db, actor, {
    key: 'customer',
    name: 'Customer',
    type: 'short_text'
  });
  const amount = createFieldDefinition(handle.db, actor, {
    key: 'claim_amount',
    name: 'Claim Amount',
    type: 'currency'
  });
  setWorkflowFields(handle.db, actor, workflowId, [
    { fieldDefinitionId: customer.id },
    { fieldDefinitionId: amount.id }
  ]);

  const ticket = createTicketSync(handle.db, actor, {
    workflowId,
    stateId,
    title: 'Storm damage claim',
    description: 'Hail damage to the roof.',
    fields: { customer: 'ACME Pty Ltd', claim_amount: 12_500 }
  });
  ticketId = ticket.id;
  writeTicketFieldValues(handle.db, {
    workspaceId: actor.workspaceId,
    ticketId,
    workflowId,
    values: { customer: 'ACME Pty Ltd' },
    actor
  });
  addNoteSync(handle.db, actor, {
    ticketId,
    body: 'Called the customer to confirm access.',
    authorLabel: 'Context Owner'
  });

  // A linked file with extracted content, so file context selection is exercised.
  const now = Date.now();
  const { blobs } = await import('../../../src/lib/server/db/schema');
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
    .insert(ticketFiles)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      ticketId,
      fileId,
      relationship: 'attachment',
      createdAt: now
    })
    .run();
  const { fileExtractedContent } = await import('../../../src/lib/server/db/schema');
  const { fileProcessingRuns } = await import('../../../src/lib/server/db/schema');
  const runId = uuidv7(now);
  handle.db
    .insert(fileProcessingRuns)
    .values({
      id: runId,
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
      processingRunId: runId,
      contentKind: 'text',
      text: 'The engineer recommends full roof replacement at a cost of $12,500.',
      charCount: 68,
      createdAt: now
    })
    .run();

  void updateState;
  void ticketNotes;
});

describe('context selection', () => {
  test('a minimal configuration includes only the title', async () => {
    const context = await build({
      includeTitle: true,
      includeDescription: false,
      fieldKeys: [],
      includeRecentNotes: 0,
      includeFileSummaries: false,
      includeFileFields: [],
      includeFullFileContent: false
    });

    const prompt = context.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Storm damage claim');
    expect(prompt).not.toContain('Hail damage to the roof.');
    expect(prompt).not.toContain('ACME Pty Ltd');
    expect(prompt).not.toContain('Called the customer');
    expect(prompt).not.toContain('roof replacement');
    expect(context.sections).toEqual(['title']);
  });

  test('selected field keys are included and others are not', async () => {
    const context = await build({
      includeTitle: true,
      includeDescription: false,
      fieldKeys: ['customer'],
      includeRecentNotes: 0,
      includeFileSummaries: false
    });

    const prompt = context.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Customer');
    expect(prompt).toContain('ACME Pty Ltd');
    // `claim_amount` was not requested, so it must not be assembled.
    expect(prompt).not.toContain('12,500');
    expect(prompt).not.toContain('Claim Amount');
    expect(context.sections).toContain('fields');
  });

  test('notes are included only when requested, and bounded', async () => {
    for (let index = 0; index < 5; index++) {
      addNoteSync(handle.db, actor, { ticketId, body: `Follow-up note ${index}` });
    }

    const none = await build({ includeTitle: true, includeRecentNotes: 0 });
    expect(none.messages.map((m) => m.content).join('\n')).not.toContain('Follow-up note');

    const recent = await build({ includeTitle: true, includeRecentNotes: 2 });
    const prompt = recent.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('Follow-up note 4');
    expect(prompt).toContain('Follow-up note 3');
    // Only the two most recent notes, so an older one is absent.
    expect(prompt).not.toContain('Follow-up note 0');
    expect(recent.sections).toContain('notes');
  });

  test('a file summary is included, but not the full content, unless asked', async () => {
    const summaryOnly = await build({
      includeTitle: true,
      includeFileSummaries: true,
      includeFullFileContent: false
    });
    const summaryPrompt = summaryOnly.messages.map((m) => m.content).join('\n');
    expect(summaryPrompt).toContain('assessment.txt');
    expect(summaryPrompt).toContain('roof replacement required');
    expect(summaryPrompt).not.toContain('at a cost of $12,500');
    expect(summaryOnly.sections).toContain('files');

    const withContent = await build({
      includeTitle: true,
      includeFileSummaries: false,
      includeFullFileContent: true
    });
    const contentPrompt = withContent.messages.map((m) => m.content).join('\n');
    expect(contentPrompt).toContain('at a cost of $12,500');
  });

  test('full content is truncated at the configured budget', async () => {
    const context = await build(
      { includeTitle: true, includeFileSummaries: false, includeFullFileContent: true },
      { maxFileContentChars: 20 }
    );
    const prompt = context.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('…[truncated]');
    expect(prompt).not.toContain('at a cost of');
  });

  test('state history is opt-in', async () => {
    const without = await build({ includeTitle: true, includeStateHistory: false });
    expect(without.messages.map((m) => m.content).join('\n')).not.toContain('State history');

    const withHistory = await build({ includeTitle: true, includeStateHistory: true });
    expect(withHistory.messages.map((m) => m.content).join('\n')).toContain('State history');
  });

  test('the persisted snapshot is redacted and records what was assembled', async () => {
    registerSecretValue('sk-context-canary-123456');
    const context = await build({ includeTitle: true, includeDescription: true });

    expect(context.snapshot).toHaveProperty('sections');
    expect(context.snapshot).toHaveProperty('system');
    expect(context.snapshot).toHaveProperty('user');
    const serialized = JSON.stringify(context.snapshot);
    expect(serialized).not.toContain('sk-context-canary-123456');
    // The snapshot is what an operator inspects, so it must not contain secrets or
    // anything that was not deliberately assembled.
    expect(Array.isArray(context.snapshot.sections)).toBe(true);
  });

  test('a secret value that somehow reached the ticket is still masked', async () => {
    const canary = 'sk-ticket-canary-abcdef';
    registerSecretValue(canary);
    writeTicketFieldValues(handle.db, {
      workspaceId: actor.workspaceId,
      ticketId,
      workflowId,
      values: { customer: canary },
      actor
    });

    const context = await build({ includeTitle: true, fieldKeys: ['customer'] });
    const prompt = context.messages.map((m) => m.content).join('\n');
    expect(prompt).not.toContain(canary);
    expect(prompt).toContain('[redacted]');
  });

  test('the system prompt names the agent, the state and the ticket', async () => {
    const context = await build({ includeTitle: true });
    const system = context.messages[0]?.content ?? '';
    expect(system).toContain('Assessment Agent');
    expect(system).toContain('Investigation');
    expect(system).toContain('Assess the claim.');
    // The model is told it must not invent ids it has not been given.
    expect(system).toContain('Never invent');
  });
});
