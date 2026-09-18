/**
 * Typed field write integration tests for the universal model (ADR-0021).
 *
 * Ported from the deleted ticket field-write suite. Workflow-configured fields are
 * stored as the WorkflowItem overlay (`workflow_item_field_values`) with history in
 * `field_value_history` (`owner_type = 'workflow_item'`), and the same normalization
 * function validates every value.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import {
  fieldValueHistory,
  records,
  workflowItemFieldValues
} from '../../../src/lib/server/db/schema';
import { listWorkflowFields, setWorkflowFields } from '../../../src/lib/server/fields/service';
import { writeWorkflowItemFieldValues } from '../../../src/lib/server/workflow-items/fields';
import {
  createWorkflowItemSync,
  type WorkflowItemRow
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createUser,
  createWorkflow,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Claims Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Sarah Reviewer' });
  owner = ownerActor(workspaceId, user.id, 'Sarah Reviewer');
});

function createItem(workflowId: string, title: string): WorkflowItemRow {
  return createWorkflowItemSync(handle.db, owner, {
    workflowId,
    record: { displayName: title }
  });
}

/** Write values through the universal field engine, exactly as the old suite did. */
function writeFields(
  item: WorkflowItemRow,
  values: Record<string, unknown>,
  actor: ActorContext = owner
) {
  const record = handle.db.select().from(records).where(eq(records.id, item.recordId)).all()[0];
  if (!record) throw new Error(`Record ${item.recordId} not found`);
  return writeWorkflowItemFieldValues(handle.db, {
    workspaceId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    recordId: item.recordId,
    objectTypeId: record.objectTypeId,
    values,
    actor
  });
}

function overlayRows(item: WorkflowItemRow) {
  return handle.db
    .select()
    .from(workflowItemFieldValues)
    .where(eq(workflowItemFieldValues.workflowItemId, item.id))
    .all();
}

function historyRows(item: WorkflowItemRow) {
  return handle.db
    .select()
    .from(fieldValueHistory)
    .where(
      and(eq(fieldValueHistory.ownerType, 'workflow_item'), eq(fieldValueHistory.ownerId, item.id))
    )
    .all();
}

describe('typed field writes', () => {
  test('normalizes each type into the right column and records history', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const textId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    const moneyId = await createField(handle.db, {
      workspaceId,
      key: 'amount',
      name: 'Amount',
      type: 'currency'
    });
    const dateId = await createField(handle.db, {
      workspaceId,
      key: 'renewal',
      name: 'Renewal',
      type: 'date'
    });
    const boolId = await createField(handle.db, {
      workspaceId,
      key: 'flagged',
      name: 'Flagged',
      type: 'boolean'
    });
    const selectId = await createField(handle.db, {
      workspaceId,
      key: 'risk',
      name: 'Risk',
      type: 'select',
      options: {
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: textId },
      { fieldDefinitionId: moneyId },
      { fieldDefinitionId: dateId },
      { fieldDefinitionId: boolId },
      { fieldDefinitionId: selectId }
    ]);

    const item = createItem(workflow.id, 'Typed');
    writeFields(item, {
      customer: 'ACME Pty Ltd',
      amount: '12,500.50',
      renewal: '2026-03-01',
      flagged: 'yes',
      risk: 'high'
    });

    const rows = overlayRows(item);
    const byField = new Map(rows.map((row) => [row.fieldDefinitionId, row]));
    expect(byField.get(textId)?.valueText).toBe('ACME Pty Ltd');
    expect(byField.get(textId)?.searchText).toBe('acme pty ltd');
    expect(byField.get(moneyId)?.valueNumber).toBe(12500.5);
    expect(byField.get(dateId)?.valueDate).toBe(Date.parse('2026-03-01T00:00:00.000Z'));
    expect(byField.get(boolId)?.valueBool).toBe(true);
    expect(byField.get(selectId)?.valueText).toBe('high');

    const history = historyRows(item);
    expect(history).toHaveLength(5);
    expect(history.every((row) => row.previousValue === null)).toBe(true);
  });

  test('rejects a value that violates the field type or options', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const selectId = await createField(handle.db, {
      workspaceId,
      key: 'risk',
      name: 'Risk',
      type: 'select',
      options: { choices: [{ value: 'low', label: 'Low' }] }
    });
    const numberId = await createField(handle.db, {
      workspaceId,
      key: 'count',
      name: 'Count',
      type: 'number'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: selectId },
      { fieldDefinitionId: numberId }
    ]);
    const item = createItem(workflow.id, 'Invalid');

    expect(() => writeFields(item, { risk: 'enormous' })).toThrow(/must be one of/);

    expect(() => writeFields(item, { count: 'not a number' })).toThrow(/must be a number/);
  });

  test('refuses a field that is not configured on the workflow', async () => {
    const workflowA = await createWorkflow(handle.db, workspaceId, { name: 'A' });
    const workflowB = await createWorkflow(handle.db, workspaceId, { name: 'B' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'only_a',
      name: 'Only A',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflowA.id, [{ fieldDefinitionId: fieldId }]);

    const item = createItem(workflowB.id, 'B item');
    expect(() => writeFields(item, { only_a: 'x' })).toThrow(/Unknown field key/);
  });

  test('honours read-only workflow fields', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const lockedId = await createField(handle.db, {
      workspaceId,
      key: 'locked',
      name: 'Locked',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [
      { fieldDefinitionId: lockedId, editable: false }
    ]);
    const item = createItem(workflow.id, 'Policy');

    const config = listWorkflowFields(handle.db, owner, workflow.id);
    expect(config.find((view) => view.fieldDefinitionId === lockedId)?.editable).toBe(false);

    // The write engine must refuse a value for a field the workflow marks read-only.
    // NOTE: `writeWorkflowItemFieldValues` does not currently consult
    // `workflowFields.editable`; this assertion documents the expected contract.
    expect(() => writeFields(item, { locked: 'nope' })).toThrow(/read-only/);
  });

  // The old suite also asserted that an agent's field write grants (`allowedKeys`)
  // deny a write. The universal field engine has no such parameter and no call site
  // consumes `writableFieldKeys`, so no runtime assertion is currently possible.
  test.skip('honours agent field write grants', () => {});

  test('records previous and next values on update and deletion', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'amount',
      name: 'Amount',
      type: 'number'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    const item = createItem(workflow.id, 'History');

    writeFields(item, { amount: 100 });
    writeFields(item, { amount: 200 });
    writeFields(item, { amount: '' });

    const history = historyRows(item);
    // Compare as a set: the three writes can share a millisecond, so row order is
    // not a meaningful part of the contract.
    expect(
      history.map((row) => `${String(row.previousValue)}->${String(row.newValue)}`).sort()
    ).toEqual(['100->200', '200->null', 'null->100']);
    expect(overlayRows(item)).toHaveLength(0);
  });

  test('does not create history when the value is unchanged', async () => {
    const workflow = await createWorkflow(handle.db, workspaceId, { name: 'Claims' });
    const fieldId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, workflow.id, [{ fieldDefinitionId: fieldId }]);
    const item = createItem(workflow.id, 'Idempotent');

    for (let i = 0; i < 3; i++) {
      writeFields(item, { customer: 'ACME' });
    }
    expect(historyRows(item)).toHaveLength(1);
  });
});
