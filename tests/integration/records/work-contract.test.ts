/**
 * Work-submission contract tests (ADR-0023).
 *
 * An agent must return the record plus a workflow directive; the record is
 * validated against the target workflow's Object Type schema before anything is
 * persisted. Invalid output is rejected with field issues; a different target
 * workflow re-validates against that workflow.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import { workflowItemFieldValues, workflows } from '../../../src/lib/server/db/schema';
import { setWorkflowFields } from '../../../src/lib/server/fields/service';
import { createObjectType, setBaseFields } from '../../../src/lib/server/records/object-types';
import { createRecord, getRecordDetail } from '../../../src/lib/server/records/service';
import {
  applyWorkSubmission,
  parseWorkSubmission
} from '../../../src/lib/server/workflow-items/contract';
import {
  createWorkflowItem,
  getWorkflowItemDetail
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createUser,
  createWorkflow as createWorkflowFixture,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Work Contracts');
  workspaceId = workspace.id;
  const user = await createUser(db, { name: 'Owner' });
  owner = ownerActor(workspaceId, user.id);
});

async function policyType() {
  const objectType = createObjectType(db, owner, { name: 'Policy' });
  await setBaseFields(db, owner, objectType.id, [
    {
      key: 'policy_number',
      name: 'Policy Number',
      type: 'short_text',
      isPrimaryDisplay: true,
      required: true
    },
    { key: 'premium', name: 'Premium', type: 'number' }
  ] as never);
  return objectType;
}

async function workflowFor(name: string, objectTypeId: string) {
  const fixture = await createWorkflowFixture(db, workspaceId, { name });
  db.update(workflows).set({ objectTypeId }).where(eq(workflows.id, fixture.id)).run();
  return fixture;
}

describe('work submission: parsing', () => {
  test('accepts a record plus directive and rejects both stateId and transitionId', () => {
    expect(parseWorkSubmission({ record: { a: 1 }, workflow: { stateId: 's1' } }).ok).toBe(true);
    expect(parseWorkSubmission({ record: { a: 1 } }).ok).toBe(true);
    const conflict = parseWorkSubmission({ workflow: { stateId: 's', transitionId: 't' } });
    expect(conflict.ok).toBe(false);
    const unknown = parseWorkSubmission({ record: { a: 1 }, surprise: true });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.some((issue) => issue.path === 'surprise')).toBe(true);
  });
});

describe('work submission: same workflow', () => {
  test('persists the validated record and applies the requested transition', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1', premium: 10 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });

    const applied = await applyWorkSubmission(db, owner, {
      workflowItemId: item.id,
      record: { policy_number: 'P1', premium: 42 },
      workflow: { stateId: workflow.stateIds['In Progress'] as string, reason: 'reviewed' }
    });

    expect(applied.transferred).toBe(false);
    expect(applied.stateId).toBe(workflow.stateIds['In Progress'] as string);
    const detail = await getRecordDetail(db, owner, record.id);
    expect(detail.fields.premium).toBe(42);
    const itemDetail = await getWorkflowItemDetail(db, owner, item.id);
    expect(itemDetail.stateId).toBe(workflow.stateIds['In Progress'] as string);
  });

  test('rejects wrong types, unknown fields and missing required fields without persisting', async () => {
    const policy = await policyType();
    const workflow = await workflowFor('Lifecycle', policy.id);
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1', premium: 10 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id
    });

    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'P1', premium: 'not-a-number' },
        workflow: { stateId: workflow.stateIds['In Progress'] as string }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'P1', bogus: 1 }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { premium: 5 }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    // Nothing changed on rejection.
    const detail = await getRecordDetail(db, owner, record.id);
    expect(detail.fields.premium).toBe(10);
    const itemDetail = await getWorkflowItemDetail(db, owner, item.id);
    expect(itemDetail.stateId).toBe(workflow.stateIds.Backlog as string);
  });
});

describe('work submission: cross-workflow output', () => {
  test('validates against the target workflow and transfers the work', async () => {
    const policy = await policyType();
    const lifecycle = await workflowFor('Lifecycle', policy.id);
    const renewal = await workflowFor('Renewal', policy.id);
    const renewalQuote = await createField(db, {
      workspaceId,
      scope: 'record',
      key: 'renewal_quote',
      name: 'Renewal Quote',
      type: 'number'
    });
    setWorkflowFields(db, owner, renewal.id, [
      { fieldDefinitionId: renewalQuote, required: true, showOnCard: true }
    ]);

    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1', premium: 10 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: lifecycle.id,
      recordId: record.id
    });

    // Submitting the renewal-only overlay while targeting Lifecycle is rejected.
    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'P1', renewal_quote: 99 }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const applied = await applyWorkSubmission(db, owner, {
      workflowItemId: item.id,
      record: { policy_number: 'P1', premium: 12, renewal_quote: 99 },
      workflow: { workflowId: renewal.id, reason: 'renewal due' }
    });

    expect(applied.transferred).toBe(true);
    expect(applied.targetWorkflowId).toBe(renewal.id);

    // The source participation is closed.
    const source = await getWorkflowItemDetail(db, owner, item.id);
    expect(source.completedAt).not.toBeNull();
    // The destination carries the validated overlay value.
    const destination = await getWorkflowItemDetail(db, owner, applied.workflowItemId);
    expect(destination.workflowId).toBe(renewal.id);
    expect(destination.fields.renewal_quote).toBe(99);
    expect(destination.fields.premium).toBe(12);

    const overlayRows = db
      .select()
      .from(workflowItemFieldValues)
      .where(eq(workflowItemFieldValues.workflowItemId, applied.workflowItemId))
      .all();
    expect(overlayRows).toHaveLength(1);
  });

  test('rejects a required target overlay that is missing', async () => {
    const policy = await policyType();
    const lifecycle = await workflowFor('Lifecycle', policy.id);
    const renewal = await workflowFor('Renewal', policy.id);
    const renewalQuote = await createField(db, {
      workspaceId,
      scope: 'record',
      key: 'renewal_quote',
      name: 'Renewal Quote',
      type: 'number'
    });
    setWorkflowFields(db, owner, renewal.id, [{ fieldDefinitionId: renewalQuote, required: true }]);
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: lifecycle.id,
      recordId: record.id
    });
    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'P1' },
        workflow: { workflowId: renewal.id }
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('honours allowWorkflowChange=false', async () => {
    const policy = await policyType();
    const lifecycle = await workflowFor('Lifecycle', policy.id);
    const other = await workflowFor('Other', policy.id);
    const record = await createRecord(db, owner, {
      objectTypeId: policy.id,
      fields: { policy_number: 'P1' }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: lifecycle.id,
      recordId: record.id
    });
    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'P1' },
        workflow: { workflowId: other.id },
        allowWorkflowChange: false
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
