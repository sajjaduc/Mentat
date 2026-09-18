import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { isAppError } from '../../../src/lib/server/core/errors';
import type { Executor } from '../../../src/lib/server/db/client';
import { workflowItems } from '../../../src/lib/server/db/schema';
import { andOf, describeFilter, type FilterAst, orOf } from '../../../src/lib/server/filters/ast';
import {
  compileWorkflowItemFilter,
  compileWorkflowItemFilterDetailed,
  decodeWorkflowItemCursor,
  encodeWorkflowItemCursor,
  filterWorkflowItems
} from '../../../src/lib/server/filters/compile';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  addFileSource,
  addWorkflowItemLabel,
  createAgentRun,
  createApprovalRequest,
  createField,
  createFileRecord,
  createLabel,
  createTeam,
  createUser,
  createWorkflow,
  createWorkflowItem,
  createWorkspace,
  linkWorkflowItemFile,
  setFileFieldValueTyped,
  setTypedFieldValue,
  updateRecordRow,
  updateWorkflowItemRow,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let workflow: WorkflowFixture;

async function matches(filter: FilterAst | null, now?: number): Promise<string[]> {
  const condition = await compileWorkflowItemFilter(db, { workspaceId, filter, now });
  const rows = await db.all<{ id: string }>(
    sql`SELECT workflow_items.id AS id FROM workflow_items JOIN records ON records.id = workflow_items.record_id WHERE ${condition} ORDER BY records.number`
  );
  return rows.map((row) => row.id);
}

async function ticketByTitle(title: string): Promise<string> {
  const rows = await db.all<{ id: string }>(
    sql`SELECT workflow_items.id AS id FROM workflow_items JOIN records ON records.id = workflow_items.record_id WHERE workflow_items.workspace_id = ${workspaceId} AND records.display_name = ${title}`
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Filter WS');
  workspaceId = workspace.id;
  workflow = await createWorkflow(db, workspaceId, {
    states: [
      { name: 'Backlog', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Review', kind: 'manual', category: 'review' },
      { name: 'Done', kind: 'manual', category: 'done', isTerminal: true }
    ]
  });
});

afterEach(() => {
  handle.cleanup();
});

describe('compileWorkflowItemFilter: system columns', () => {
  test('an empty filter compiles to an unconditional truth', async () => {
    await createWorkflowItem(db, { workspaceId, workflow, title: 'One' });
    const compiled = await compileWorkflowItemFilterDetailed(db, { workspaceId, filter: null });
    expect(compiled.unresolved).toEqual([]);
    expect(await matches(null)).toHaveLength(1);
  });

  test('matches priority with in and not_in', async () => {
    const highItem = await createWorkflowItem(db, { workspaceId, workflow, title: 'High' });
    await updateRecordRow(db, highItem.recordId, { structuredData: { priority: 'high' } });
    const lowItem = await createWorkflowItem(db, { workspaceId, workflow, title: 'Low' });
    await updateRecordRow(db, lowItem.recordId, { structuredData: { priority: 'low' } });

    const high = await matches({
      type: 'condition',
      kind: 'system',
      key: 'priority',
      operator: 'in',
      value: ['high', 'urgent']
    });
    expect(high).toHaveLength(1);
    expect(high[0]).toBe(await ticketByTitle('High'));

    const notHigh = await matches({
      type: 'condition',
      kind: 'system',
      key: 'priority',
      operator: 'not_in',
      value: ['high', 'urgent']
    });
    expect(notHigh).toHaveLength(1);
    expect(notHigh[0]).toBe(await ticketByTitle('Low'));
  });

  test('searches title with contains, starts_with and ends_with', async () => {
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Claim for ACME' });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Invoice for Beta' });

    const contains = await matches({
      type: 'condition',
      kind: 'system',
      key: 'title',
      operator: 'contains',
      value: 'acme'
    });
    expect(contains).toHaveLength(1); // text matching is case-insensitive
    const exactCase = await matches({
      type: 'condition',
      kind: 'system',
      key: 'title',
      operator: 'eq',
      value: 'Claim for ACME'
    });
    expect(exactCase).toHaveLength(1);
    const starts = await matches({
      type: 'condition',
      kind: 'system',
      key: 'title',
      operator: 'starts_with',
      value: 'Claim'
    });
    expect(starts).toHaveLength(1);
    const ends = await matches({
      type: 'condition',
      kind: 'system',
      key: 'title',
      operator: 'ends_with',
      value: 'Beta'
    });
    expect(ends).toHaveLength(1);
    const notContains = await matches({
      type: 'condition',
      kind: 'system',
      key: 'title',
      operator: 'not_contains',
      value: 'ACME'
    });
    expect(notContains).toHaveLength(1);
  });

  test('treats LIKE wildcards in the value as literal text', async () => {
    await createWorkflowItem(db, { workspaceId, workflow, title: '100% done' });
    await createWorkflowItem(db, { workspaceId, workflow, title: '100x done' });
    const result = await matches({
      type: 'condition',
      kind: 'system',
      key: 'title',
      operator: 'contains',
      value: '%'
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(await ticketByTitle('100% done'));
  });

  test('compares numbers, dates and unassigned state', async () => {
    const first = await createWorkflowItem(db, { workspaceId, workflow, title: 'First' });
    const second = await createWorkflowItem(db, { workspaceId, workflow, title: 'Second' });
    await updateWorkflowItemRow(db, second.id, {
      dueAt: Date.UTC(2024, 5, 1),
      closedAt: null
    });
    await updateRecordRow(db, second.recordId, { number: 20 });

    const numbers = await matches({
      type: 'condition',
      kind: 'system',
      key: 'number',
      operator: 'gt',
      value: 5
    });
    expect(numbers).toEqual([second.id]);

    const dueBefore = await matches({
      type: 'condition',
      kind: 'system',
      key: 'dueAt',
      operator: 'before',
      value: Date.UTC(2024, 6, 1)
    });
    expect(dueBefore).toEqual([second.id]);

    const unassigned = await matches({
      type: 'condition',
      kind: 'system',
      key: 'isUnassigned',
      operator: 'is_true'
    });
    expect(unassigned.sort()).toEqual([first.id, second.id].sort());
  });

  test('joins workflow_states for stateName, stateKind and stateCategory', async () => {
    const backlog = workflow.stateIds.Backlog!;
    const done = workflow.stateIds.Done!;
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Backlog', stateId: backlog });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Done', stateId: done });

    expect(
      await matches({
        type: 'condition',
        kind: 'system',
        key: 'stateName',
        operator: 'eq',
        value: 'Done'
      })
    ).toHaveLength(1);
    expect(
      await matches({
        type: 'condition',
        kind: 'system',
        key: 'stateKind',
        operator: 'eq',
        value: 'manual'
      })
    ).toHaveLength(2);
    expect(
      await matches({
        type: 'condition',
        kind: 'system',
        key: 'stateCategory',
        operator: 'in',
        value: ['done', 'cancelled']
      })
    ).toHaveLength(1);
  });

  test('reads sourceType from ticket provenance JSON', async () => {
    const fromEmail = await createWorkflowItem(db, { workspaceId, workflow, title: 'Email' });
    await updateWorkflowItemRow(db, fromEmail.id, { provenance: { sourceType: 'incoming_email' } });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Manual' });

    const matched = await matches({
      type: 'condition',
      kind: 'system',
      key: 'sourceType',
      operator: 'eq',
      value: 'incoming_email'
    });
    expect(matched).toEqual([fromEmail.id]);
  });

  test('resolves runStatus through the latest agent run', async () => {
    const ticket = await createWorkflowItem(db, { workspaceId, workflow, title: 'Run' });
    await createAgentRun(db, {
      workspaceId,
      workflowItemId: ticket.id,
      workflowId: workflow.id,
      stateId: workflow.states[0]!,
      status: 'failed',
      createdAt: 1_000
    });
    await createAgentRun(db, {
      workspaceId,
      workflowItemId: ticket.id,
      workflowId: workflow.id,
      stateId: workflow.states[0]!,
      status: 'succeeded',
      createdAt: 2_000
    });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'No run' });

    const matched = await matches({
      type: 'condition',
      kind: 'system',
      key: 'runStatus',
      operator: 'eq',
      value: 'succeeded'
    });
    expect(matched).toEqual([ticket.id]);
  });

  test('resolves approvalStatus through the latest approval request', async () => {
    const ticket = await createWorkflowItem(db, { workspaceId, workflow, title: 'Approval' });
    await createApprovalRequest(db, {
      workspaceId,
      workflowItemId: ticket.id,
      status: 'pending',
      createdAt: 1_000
    });
    await createApprovalRequest(db, {
      workspaceId,
      workflowItemId: ticket.id,
      status: 'rejected',
      createdAt: 2_000
    });

    expect(
      await matches({
        type: 'condition',
        kind: 'system',
        key: 'approvalStatus',
        operator: 'eq',
        value: 'rejected'
      })
    ).toEqual([ticket.id]);
    expect(
      await matches({
        type: 'condition',
        kind: 'system',
        key: 'approvalStatus',
        operator: 'eq',
        value: 'pending'
      })
    ).toEqual([]);
  });

  test('derives timeInStateSeconds from entered_state_at', async () => {
    const now = Date.UTC(2024, 2, 10, 12, 0, 0);
    const old = await createWorkflowItem(db, { workspaceId, workflow, title: 'Old' });
    await updateWorkflowItemRow(db, old.id, { enteredStateAt: now - 4 * 3_600_000 });
    const fresh = await createWorkflowItem(db, { workspaceId, workflow, title: 'Fresh' });
    await updateWorkflowItemRow(db, fresh.id, { enteredStateAt: now - 60_000 });

    const matched = await matches(
      {
        type: 'condition',
        kind: 'system',
        key: 'timeInStateSeconds',
        operator: 'gt',
        value: 3_600
      },
      now
    );
    expect(matched).toEqual([old.id]);
  });

  test('supports the remaining system field keys', async () => {
    const parent = await createWorkflowItem(db, { workspaceId, workflow, title: 'Parent' });
    const child = await createWorkflowItem(db, { workspaceId, workflow, title: 'Child ticket' });
    await updateWorkflowItemRow(db, parent.id, { lastActivityAt: Date.UTC(2024, 3, 1) });
    await updateRecordRow(db, child.recordId, {
      structuredData: { description: 'Needs legal review' }
    });
    await updateWorkflowItemRow(db, child.id, {
      waitingOn: 'approval',
      originWorkflowItemId: parent.id,
      stateRunCount: 3,
      closedAt: null,
      lastActivityAt: Date.UTC(2024, 5, 1)
    });

    const condition = (key: string, operator: string, value?: unknown): FilterAst => ({
      type: 'condition',
      kind: 'system',
      key,
      operator: operator as never,
      value
    });

    expect(await matches(condition('key', 'contains', parent.key))).toEqual([parent.id]);
    expect(await matches(condition('description', 'contains', 'legal'))).toEqual([child.id]);
    expect(await matches(condition('waitingOn', 'eq', 'approval'))).toEqual([child.id]);
    expect(await matches(condition('originWorkflowItemId', 'eq', parent.id))).toEqual([child.id]);
    expect(await matches(condition('stateRunCount', 'gte', 3))).toEqual([child.id]);
    expect((await matches(condition('closedAt', 'is_empty'))).sort()).toEqual(
      [parent.id, child.id].sort()
    );
    expect(await matches(condition('lastActivityAt', 'after', Date.UTC(2024, 4, 1)))).toEqual([
      child.id
    ]);
    expect((await matches(condition('createdAt', 'is_not_empty'))).sort()).toEqual(
      [parent.id, child.id].sort()
    );
  });
});

describe('compileWorkflowItemFilter: custom fields', () => {
  test('compares text, number, date and boolean fields with typed columns', async () => {
    const text = await createField(db, { workspaceId, key: 'customer', type: 'short_text' });
    const amount = await createField(db, { workspaceId, key: 'amount', type: 'currency' });
    const due = await createField(db, { workspaceId, key: 'review_date', type: 'date' });
    const urgent = await createField(db, { workspaceId, key: 'urgent', type: 'boolean' });

    const a = await createWorkflowItem(db, { workspaceId, workflow, title: 'A' });
    const b = await createWorkflowItem(db, { workspaceId, workflow, title: 'B' });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: a.id,
      fieldDefinitionId: text,
      type: 'short_text',
      value: 'Acme Pty Ltd'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: b.id,
      fieldDefinitionId: text,
      type: 'short_text',
      value: 'Beta Corp'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: a.id,
      fieldDefinitionId: amount,
      type: 'currency',
      value: 12_500
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: b.id,
      fieldDefinitionId: amount,
      type: 'currency',
      value: 400
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: a.id,
      fieldDefinitionId: due,
      type: 'date',
      value: Date.UTC(2024, 0, 15)
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: a.id,
      fieldDefinitionId: urgent,
      type: 'boolean',
      value: true
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: b.id,
      fieldDefinitionId: urgent,
      type: 'boolean',
      value: false
    });

    const condition = (key: string, operator: string, value?: unknown): FilterAst => ({
      type: 'condition',
      kind: 'field',
      key,
      operator: operator as never,
      value
    });

    expect(await matches(condition('customer', 'contains', 'acme'))).toEqual([a.id]);
    expect(await matches(condition('customer', 'eq', 'Beta Corp'))).toEqual([b.id]);
    expect(await matches(condition('amount', 'between', [1_000, 20_000]))).toEqual([a.id]);
    expect(await matches(condition('amount', 'lte', 400))).toEqual([b.id]);
    expect(await matches(condition('review_date', 'before', Date.UTC(2024, 1, 1)))).toEqual([a.id]);
    expect(await matches(condition('urgent', 'is_true'))).toEqual([a.id]);
    expect(await matches(condition('urgent', 'is_false'))).toEqual([b.id]);
    // A ticket with no value row is empty for both truth values.
    const c = await createWorkflowItem(db, { workspaceId, workflow, title: 'C' });
    expect(await matches(condition('urgent', 'is_false'))).toHaveLength(1);
    expect(await matches(condition('urgent', 'is_empty'))).toEqual([c.id]);
    expect(await matches(condition('urgent', 'is_not_empty')).then((ids) => ids.sort())).toEqual(
      [a.id, b.id].sort()
    );
  });

  test('handles select and multi-select membership', async () => {
    const select = await createField(db, {
      workspaceId,
      key: 'claim_type',
      type: 'select',
      options: { choices: [{ value: 'motor', label: 'Motor' }] }
    });
    const multi = await createField(db, {
      workspaceId,
      key: 'channels',
      type: 'multi_select',
      options: { choices: [] }
    });
    const a = await createWorkflowItem(db, { workspaceId, workflow, title: 'A' });
    const b = await createWorkflowItem(db, { workspaceId, workflow, title: 'B' });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: a.id,
      fieldDefinitionId: select,
      type: 'select',
      value: 'motor'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: b.id,
      fieldDefinitionId: select,
      type: 'select',
      value: 'property'
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: a.id,
      fieldDefinitionId: multi,
      type: 'multi_select',
      value: ['email', 'phone']
    });

    const condition = (key: string, operator: string, value?: unknown): FilterAst => ({
      type: 'condition',
      kind: 'field',
      key,
      operator: operator as never,
      value
    });
    expect(await matches(condition('claim_type', 'in', ['motor']))).toEqual([a.id]);
    // A chosen value must match an element of the stored array.
    expect(await matches(condition('channels', 'in', ['phone']))).toEqual([a.id]);
    expect(await matches(condition('channels', 'in', ['sms']))).toEqual([]);
    expect(await matches(condition('channels', 'not_in', ['phone']))).toEqual([b.id]);
  });

  test('within_last_days is evaluated against the supplied now', async () => {
    const due = await createField(db, { workspaceId, key: 'opened', type: 'date' });
    const now = Date.UTC(2024, 2, 10);
    const recent = await createWorkflowItem(db, { workspaceId, workflow, title: 'Recent' });
    const stale = await createWorkflowItem(db, { workspaceId, workflow, title: 'Stale' });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: recent.id,
      fieldDefinitionId: due,
      type: 'date',
      value: now - 3 * 86_400_000
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: stale.id,
      fieldDefinitionId: due,
      type: 'date',
      value: now - 30 * 86_400_000
    });

    const condition: FilterAst = {
      type: 'condition',
      kind: 'field',
      key: 'opened',
      operator: 'within_last_days',
      value: 7
    };
    expect(await matches(condition, now)).toEqual([recent.id]);

    const notWithin: FilterAst = { ...condition, operator: 'not_within_last_days' };
    expect(await matches(notWithin, now)).toEqual([stale.id]);
  });
});

describe('compileWorkflowItemFilter: relations', () => {
  test('filters by label in and not_in', async () => {
    const urgent = await createLabel(db, workspaceId, 'urgent');
    const vip = await createLabel(db, workspaceId, 'vip');
    const labelled = await createWorkflowItem(db, { workspaceId, workflow, title: 'Labelled' });
    const plain = await createWorkflowItem(db, { workspaceId, workflow, title: 'Plain' });
    await addWorkflowItemLabel(db, { workspaceId, workflowItemId: labelled.id, labelId: urgent });
    await addWorkflowItemLabel(db, { workspaceId, workflowItemId: labelled.id, labelId: vip });

    const inUrgent: FilterAst = {
      type: 'condition',
      kind: 'label',
      key: urgent,
      operator: 'in'
    };
    expect(await matches(inUrgent)).toEqual([labelled.id]);

    const notIn: FilterAst = { type: 'condition', kind: 'label', key: urgent, operator: 'not_in' };
    expect(await matches(notIn)).toEqual([plain.id]);

    const none: FilterAst = { type: 'condition', kind: 'label', key: 'x', operator: 'is_empty' };
    expect(await matches(none)).toEqual([plain.id]);
    const some: FilterAst = {
      type: 'condition',
      kind: 'label',
      key: 'x',
      operator: 'is_not_empty'
    };
    expect(await matches(some)).toEqual([labelled.id]);

    // A label is addressable by id or by its human name.
    const stored = await db.all<{ name: string }>(
      sql`SELECT name FROM labels WHERE id = ${urgent}`
    );
    const byName: FilterAst = {
      type: 'condition',
      kind: 'label',
      key: stored[0]!.name,
      operator: 'in'
    };
    expect(await matches(byName)).toEqual([labelled.id]);

    // An unknown label name is reported, not thrown.
    const compiled = await compileWorkflowItemFilterDetailed(db, {
      workspaceId,
      filter: { type: 'condition', kind: 'label', key: 'ghost', operator: 'in' }
    });
    expect(compiled.unresolved).toEqual(['ghost']);
    expect(
      await matches({ type: 'condition', kind: 'label', key: 'ghost', operator: 'in' })
    ).toEqual([]);
  });

  test('filters by owner and team membership and emptiness', async () => {
    const user = await createUser(db, { name: 'Ada' });
    const other = await createUser(db, { name: 'Bob' });
    const team = await createTeam(db, workspaceId, 'Claims');
    const mine = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'Mine',
      ownerUserId: user.id
    });
    const theirs = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'Theirs',
      ownerUserId: other.id
    });
    const teamTicket = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'Team',
      ownerTeamId: team
    });
    const unassigned = await createWorkflowItem(db, { workspaceId, workflow, title: 'Nobody' });

    expect(
      await matches({
        type: 'condition',
        kind: 'owner',
        key: 'owner',
        operator: 'in',
        value: [user.id]
      })
    ).toEqual([mine.id]);
    expect(
      (
        await matches({ type: 'condition', kind: 'owner', key: 'owner', operator: 'is_empty' })
      ).sort()
    ).toEqual([teamTicket.id, unassigned.id].sort());
    expect(
      await matches({ type: 'condition', kind: 'team', key: 'team', operator: 'in', value: [team] })
    ).toEqual([teamTicket.id]);
    expect(
      (await matches({ type: 'condition', kind: 'team', key: 'team', operator: 'is_empty' })).sort()
    ).toEqual([mine.id, theirs.id, unassigned.id].sort());
  });

  test('filters by workflow membership', async () => {
    const other = await createWorkflow(db, workspaceId, { name: 'Other' });
    const here = await createWorkflowItem(db, { workspaceId, workflow, title: 'Here' });
    await createWorkflowItem(db, { workspaceId, workflow: other, title: 'There' });
    expect(
      await matches({
        type: 'condition',
        kind: 'workflow',
        key: 'workflowId',
        operator: 'in',
        value: [workflow.id]
      })
    ).toEqual([here.id]);
  });

  test('filters files through ticket_files, file fields and provenance', async () => {
    const invoice = await createFileRecord(db, {
      workspaceId,
      originalFilename: 'invoice-2024.pdf',
      mimeType: 'application/pdf',
      status: 'ready'
    });
    const photo = await createFileRecord(db, {
      workspaceId,
      originalFilename: 'photo.png',
      mimeType: 'image/png',
      status: 'quarantined'
    });
    const withInvoice = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'With invoice'
    });
    const withPhoto = await createWorkflowItem(db, { workspaceId, workflow, title: 'With photo' });
    const noFiles = await createWorkflowItem(db, { workspaceId, workflow, title: 'No files' });
    await linkWorkflowItemFile(db, {
      workspaceId,
      workflowItemId: withInvoice.id,
      fileId: invoice
    });
    await linkWorkflowItemFile(db, { workspaceId, workflowItemId: withPhoto.id, fileId: photo });
    await addFileSource(db, { workspaceId, fileId: invoice, sourceType: 'incoming_email' });

    const filenameContains: FilterAst = {
      type: 'condition',
      kind: 'file',
      key: 'filename',
      operator: 'contains',
      value: 'invoice'
    };
    expect(await matches(filenameContains)).toEqual([withInvoice.id]);

    const mimeIn: FilterAst = {
      type: 'condition',
      kind: 'file',
      key: 'mimeType',
      operator: 'in',
      value: ['image/png']
    };
    expect(await matches(mimeIn)).toEqual([withPhoto.id]);

    const statusEq: FilterAst = {
      type: 'condition',
      kind: 'file',
      key: 'status',
      operator: 'eq',
      value: 'quarantined'
    };
    expect(await matches(statusEq)).toEqual([withPhoto.id]);

    const sourceEq: FilterAst = {
      type: 'condition',
      kind: 'file',
      key: 'sourceType',
      operator: 'eq',
      value: 'incoming_email'
    };
    expect(await matches(sourceEq)).toEqual([withInvoice.id]);

    const hasFiles: FilterAst = {
      type: 'condition',
      kind: 'file',
      key: 'file',
      operator: 'is_not_empty'
    };
    expect((await matches(hasFiles)).sort()).toEqual([withInvoice.id, withPhoto.id].sort());

    const noFilesFilter: FilterAst = {
      type: 'condition',
      kind: 'file',
      key: 'file',
      operator: 'is_empty'
    };
    expect(await matches(noFilesFilter)).toEqual([noFiles.id]);
  });

  test('compares file field values', async () => {
    const amount = await createField(db, {
      workspaceId,
      key: 'invoice_total',
      type: 'currency',
      scope: 'file'
    });
    const file = await createFileRecord(db, { workspaceId, originalFilename: 'a.pdf' });
    await setFileFieldValueTyped(db, {
      workspaceId,
      fileId: file,
      fieldDefinitionId: amount,
      type: 'currency',
      value: 980
    });
    const ticket = await createWorkflowItem(db, { workspaceId, workflow, title: 'Has file' });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Other' });
    await linkWorkflowItemFile(db, { workspaceId, workflowItemId: ticket.id, fileId: file });

    const condition: FilterAst = {
      type: 'condition',
      kind: 'file_field',
      key: 'invoice_total',
      operator: 'gte',
      value: 900
    };
    expect(await matches(condition)).toEqual([ticket.id]);
  });
});

describe('compileWorkflowItemFilter: groups and failure modes', () => {
  test('nested AND/OR keeps explicit grouping instead of flattening', async () => {
    const keepHigh = await createWorkflowItem(db, { workspaceId, workflow, title: 'keep me' });
    await updateRecordRow(db, keepHigh.recordId, { structuredData: { priority: 'high' } });
    const keepDone = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'keep me',
      stateId: workflow.stateIds.Done!
    });
    await updateRecordRow(db, keepDone.recordId, { structuredData: { priority: 'low' } });
    const flatWouldMatch = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'other',
      stateId: workflow.stateIds.Done!
    });
    await updateRecordRow(db, flatWouldMatch.recordId, { structuredData: { priority: 'low' } });
    const otherHigh = await createWorkflowItem(db, { workspaceId, workflow, title: 'other' });
    await updateRecordRow(db, otherHigh.recordId, { structuredData: { priority: 'high' } });

    const filter = andOf([
      { type: 'condition', kind: 'system', key: 'title', operator: 'contains', value: 'keep' },
      orOf([
        { type: 'condition', kind: 'system', key: 'priority', operator: 'eq', value: 'high' },
        {
          type: 'condition',
          kind: 'system',
          key: 'stateId',
          operator: 'eq',
          value: workflow.stateIds.Done!
        }
      ])
    ]);
    const ids = await matches(filter);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(flatWouldMatch.id);
  });

  test('OR of two system conditions returns the union', async () => {
    const high = await createWorkflowItem(db, { workspaceId, workflow, title: 'High' });
    await updateRecordRow(db, high.recordId, { structuredData: { priority: 'high' } });
    const done = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'Done',
      stateId: workflow.stateIds.Done!
    });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'Neither' });
    const ids = await matches(
      orOf([
        { type: 'condition', kind: 'system', key: 'priority', operator: 'eq', value: 'high' },
        {
          type: 'condition',
          kind: 'system',
          key: 'stateId',
          operator: 'eq',
          value: workflow.stateIds.Done!
        }
      ])
    );
    expect(ids.sort()).toEqual([high.id, done.id].sort());
  });

  test('an unknown field key matches nothing and is reported', async () => {
    const kept = await createWorkflowItem(db, { workspaceId, workflow, title: 'keep me' });
    await createWorkflowItem(db, { workspaceId, workflow, title: 'other' });

    const withUnknown = andOf([
      { type: 'condition', kind: 'system', key: 'title', operator: 'contains', value: 'keep' },
      { type: 'condition', kind: 'field', key: 'ghost_field', operator: 'eq', value: 'x' }
    ]);
    const compiled = await compileWorkflowItemFilterDetailed(db, {
      workspaceId,
      filter: withUnknown
    });
    expect(compiled.unresolved).toEqual(['ghost_field']);
    expect(await matches(withUnknown)).toEqual([]);

    // In an OR, the resolvable branch still matches.
    const orFilter = orOf([
      { type: 'condition', kind: 'field', key: 'ghost_field', operator: 'eq', value: 'x' },
      { type: 'condition', kind: 'system', key: 'title', operator: 'contains', value: 'keep' }
    ]);
    expect(await matches(orFilter)).toEqual([kept.id]);
  });

  test('an unknown system key is also reported rather than throwing', async () => {
    await createWorkflowItem(db, { workspaceId, workflow, title: 'One' });
    const compiled = await compileWorkflowItemFilterDetailed(db, {
      workspaceId,
      filter: { type: 'condition', kind: 'system', key: 'nope', operator: 'eq', value: 1 }
    });
    expect(compiled.unresolved).toEqual(['nope']);
    expect(
      await matches({ type: 'condition', kind: 'system', key: 'nope', operator: 'eq', value: 1 })
    ).toEqual([]);
  });

  test('describeFilter reuses the AST summary for saved-view chips', () => {
    const filter = andOf([
      { type: 'condition', kind: 'system', key: 'priority', operator: 'eq', value: 'high' },
      orOf([
        { type: 'condition', kind: 'system', key: 'stateName', operator: 'is_empty' },
        { type: 'condition', kind: 'label', key: 'urgent', operator: 'in', value: ['urgent'] }
      ])
    ]);
    expect(describeFilter(filter)).toBe(
      'priority = high and (stateName is empty or urgent is one of urgent)'
    );
    expect(describeFilter(null)).toBe('All items');
  });
});

describe('compileWorkflowItemFilter: SQL shape and parameterization', () => {
  test('relation filters compile to EXISTS and never interpolate values', async () => {
    const label = await createLabel(db, workspaceId, 'urgent');
    const filter = andOf([
      {
        type: 'condition',
        kind: 'label',
        key: label,
        operator: 'in',
        value: [label]
      },
      {
        type: 'condition',
        kind: 'system',
        key: 'sourceType',
        operator: 'eq',
        value: 'incoming_email'
      }
    ]);
    const condition = await compileWorkflowItemFilter(db, { workspaceId, filter });
    const rendered = db
      .select({ id: workflowItems.id })
      .from(workflowItems)
      .where(condition)
      .toSQL();
    expect(rendered.sql).toContain('EXISTS');
    expect(rendered.sql).toContain('json_extract');
    expect(rendered.sql).toContain('workflow_item_labels');
    // Values are bound parameters, never spliced into the SQL text.
    expect(rendered.params).toContain(label);
    expect(rendered.params).toContain('incoming_email');
    expect(rendered.sql).not.toContain('incoming_email');
  });
});

describe('filterWorkflowItems: sorting and pagination', () => {
  test('rejects a sort on an unknown field with a validation error', async () => {
    await createWorkflowItem(db, { workspaceId, workflow, title: 'One' });
    let code: string | undefined;
    try {
      await filterWorkflowItems(db, {
        workspaceId,
        filter: null,
        sort: [{ field: 'not_a_field', direction: 'asc' }]
      });
    } catch (error) {
      code = isAppError(error) ? error.code : 'other';
    }
    expect(code).toBe('validation_failed');
  });

  test('sorts by a custom number field using its typed column', async () => {
    const amount = await createField(db, { workspaceId, key: 'score', type: 'number' });
    const low = await createWorkflowItem(db, { workspaceId, workflow, title: 'Low' });
    const high = await createWorkflowItem(db, { workspaceId, workflow, title: 'High' });
    const none = await createWorkflowItem(db, { workspaceId, workflow, title: 'None' });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: low.id,
      fieldDefinitionId: amount,
      type: 'number',
      value: 1
    });
    await setTypedFieldValue(db, {
      workspaceId,
      workflowItemId: high.id,
      fieldDefinitionId: amount,
      type: 'number',
      value: 9
    });

    const page = await filterWorkflowItems(db, {
      workspaceId,
      filter: null,
      sort: [
        { field: 'score', direction: 'desc' },
        { field: 'updatedAt', direction: 'asc' }
      ]
    });
    expect(page.rows.map((row) => row.id)).toEqual([high.id, low.id, none.id]);
  });

  test('walks every ticket exactly once with keyset pagination by (updatedAt, id)', async () => {
    const base = Date.UTC(2024, 0, 1);
    const created: string[] = [];
    for (let index = 0; index < 5; index++) {
      const ticket = await createWorkflowItem(db, { workspaceId, workflow, title: `T${index}` });
      await updateWorkflowItemRow(db, ticket.id, { updatedAt: base + index * 1_000 });
      created.push(ticket.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof filterWorkflowItems>> = await filterWorkflowItems(db, {
        workspaceId,
        filter: null,
        limit: 2,
        cursor
      });
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    // Descending by updated_at: newest five first.
    expect(seen).toEqual([...created].reverse());
    expect(new Set(seen).size).toBe(5);
  });

  test('pagination cursor round-trips and composes with a filter', async () => {
    const base = Date.UTC(2024, 0, 1);
    const first = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'Keep A'
    });
    await updateRecordRow(db, first.recordId, { structuredData: { priority: 'high' } });
    const second = await createWorkflowItem(db, {
      workspaceId,
      workflow,
      title: 'Keep B'
    });
    await updateRecordRow(db, second.recordId, { structuredData: { priority: 'high' } });
    const dropped = await createWorkflowItem(db, { workspaceId, workflow, title: 'Drop' });
    await updateRecordRow(db, dropped.recordId, { structuredData: { priority: 'low' } });
    await updateWorkflowItemRow(db, first.id, { updatedAt: base + 2_000 });
    await updateWorkflowItemRow(db, second.id, { updatedAt: base + 1_000 });

    const filter: FilterAst = {
      type: 'condition',
      kind: 'system',
      key: 'priority',
      operator: 'eq',
      value: 'high'
    };
    const pageA = await filterWorkflowItems(db, { workspaceId, filter, limit: 1 });
    expect(pageA.rows.map((row) => row.id)).toEqual([first.id]);
    const decoded = decodeWorkflowItemCursor(pageA.nextCursor!);
    expect(decoded.updatedAt).toBe(base + 2_000);
    expect(encodeWorkflowItemCursor(decoded)).toBe(pageA.nextCursor!);
    const pageB = await filterWorkflowItems(db, {
      workspaceId,
      filter,
      limit: 1,
      cursor: pageA.nextCursor
    });
    expect(pageB.rows.map((row) => row.id)).toEqual([second.id]);
    expect(pageB.nextCursor).toBeNull();
  });

  test('never returns another workspace’s rows', async () => {
    const otherWorkspace = await createWorkspace(db, 'Other');
    const otherWorkflow = await createWorkflow(db, otherWorkspace.id, { name: 'Other' });
    const mine = await createWorkflowItem(db, { workspaceId, workflow, title: 'Mine' });
    await createWorkflowItem(db, {
      workspaceId: otherWorkspace.id,
      workflow: otherWorkflow,
      title: 'Theirs'
    });
    const page = await filterWorkflowItems(db, { workspaceId, filter: null });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.id).toBe(mine.id);
  });
});
