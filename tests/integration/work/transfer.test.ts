/**
 * Cross-workflow transfer integration tests (ADR-0021 port of ticket transfer).
 *
 * Transfer moves *work*, not identity: the Record (key, number, notes' home) is
 * preserved, the source participation is closed, and a new destination
 * participation is created with `transferred`. Field mappings, transfer rules and
 * the preview surface are covered here.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type ActorContext, agentActor, Permissions } from '../../../src/lib/server/core/context';
import {
  records,
  workflowItemRelationships,
  workflowItemStateHistory,
  workflowItemWorkflowHistory
} from '../../../src/lib/server/db/schema';
import { setWorkflowFields } from '../../../src/lib/server/fields/service';
import {
  addWorkflowItemNoteSync,
  createWorkflowItemSync,
  evaluateWorkflowTransferPolicy,
  getWorkflowItemDetail,
  linkWorkItemsSync,
  previewTransfer,
  transferWorkflowItemSync
} from '../../../src/lib/server/workflow-items/service';
import { setTransferRule } from '../../../src/lib/server/workflows/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createField,
  createObjectType,
  createUser,
  createWorkflow,
  createWorkspace,
  memberActor,
  type ObjectTypeFixture,
  ownerActor,
  type WorkflowFixture
} from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let ownerId: string;
let owner: ActorContext;

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Transfer Co');
  workspaceId = workspace.id;
  const user = await createUser(handle.db, { name: 'Sarah Reviewer' });
  ownerId = user.id;
  owner = ownerActor(workspaceId, ownerId, 'Sarah Reviewer');
});

async function intakeAndClaims(): Promise<{
  objectType: ObjectTypeFixture;
  intake: WorkflowFixture;
  claims: WorkflowFixture;
}> {
  // Transfer requires both workflows to process the SAME Object Type.
  const objectType = await createObjectType(handle.db, {
    workspaceId,
    key: 'claim',
    name: 'Claim'
  });
  const intake = await createWorkflow(handle.db, workspaceId, {
    name: 'Intake',
    key: 'INT',
    objectTypeId: objectType.id
  });
  const claims = await createWorkflow(handle.db, workspaceId, {
    name: 'Claims',
    key: 'CLM',
    objectTypeId: objectType.id
  });
  return { objectType, intake, claims };
}

function newItem(workflowId: string, title: string, fields?: Record<string, unknown>) {
  return createWorkflowItemSync(handle.db, owner, {
    workflowId,
    record: { displayName: title },
    fields
  });
}

describe('cross-workflow transfer', () => {
  test('moves the work, preserving Record identity, notes and history', async () => {
    const { intake, claims } = await intakeAndClaims();
    const source = newItem(intake.id, 'Inbound claim');
    addWorkflowItemNoteSync(handle.db, owner, {
      workflowItemId: source.id,
      body: 'Classified as a claim'
    });
    const recordBefore = handle.db
      .select()
      .from(records)
      .where(eq(records.id, source.recordId))
      .all()[0];

    const result = transferWorkflowItemSync(handle.db, owner, {
      workflowItemId: source.id,
      targetWorkflowId: claims.id,
      reason: 'Classified as claim'
    });

    expect(result.sourceWorkflowItemId).toBe(source.id);
    expect(result.workflowItem.id).not.toBe(source.id);
    expect(result.workflowItem.participation).toBe('transferred');

    const destination = await getWorkflowItemDetail(handle.db, owner, result.workflowItem.id);
    expect(destination.workflowId).toBe(claims.id);
    expect(destination.stateId).toBe(claims.states[0] as string);
    expect(destination.recordId).toBe(source.recordId);
    expect(destination.record.id).toBe(recordBefore?.id as string);
    expect(destination.record.key).toBe(recordBefore?.key ?? null);

    // The source participation is closed, not deleted, and keeps its notes.
    const sourceAfter = await getWorkflowItemDetail(handle.db, owner, source.id);
    expect(sourceAfter.completedAt).not.toBeNull();
    expect(sourceAfter.closedAt).not.toBeNull();
    expect(sourceAfter.waitingOn).toBe('none');
    expect(sourceAfter.notes.map((note) => note.body)).toEqual(['Classified as a claim']);

    const transfers = handle.db
      .select()
      .from(workflowItemWorkflowHistory)
      .where(eq(workflowItemWorkflowHistory.workflowItemId, destination.id))
      .all();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.kind).toBe('transfer');
    expect(transfers[0]?.toWorkflowId).toBe(claims.id);
    expect(transfers[0]?.toStateId).toBe(claims.states[0] as string);
    expect(transfers[0]?.sourceWorkflowItemId).toBe(source.id);
    expect(transfers[0]?.reason).toBe('Classified as claim');

    // Every source interval is closed; the destination opens exactly one.
    const sourceIntervals = handle.db
      .select()
      .from(workflowItemStateHistory)
      .where(eq(workflowItemStateHistory.workflowItemId, source.id))
      .all();
    expect(sourceIntervals.length).toBeGreaterThanOrEqual(1);
    expect(sourceIntervals.every((interval) => interval.exitedAt !== null)).toBe(true);
    const destinationIntervals = handle.db
      .select()
      .from(workflowItemStateHistory)
      .where(eq(workflowItemStateHistory.workflowItemId, destination.id))
      .all();
    expect(destinationIntervals).toHaveLength(1);
    expect(destinationIntervals[0]?.workflowId).toBe(claims.id);
    expect(destinationIntervals[0]?.exitedAt).toBeNull();

    const actions = handle.sqlite
      .query('SELECT action FROM audit_events WHERE record_id = ? ORDER BY seq')
      .all(source.recordId) as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toContain('workflow_item.transferred');
  });

  test('applies configured field mappings on transfer', async () => {
    const { intake, claims } = await intakeAndClaims();
    const sourceFieldId = await createField(handle.db, {
      workspaceId,
      key: 'reference_number',
      name: 'Reference',
      type: 'short_text'
    });
    const targetFieldId = await createField(handle.db, {
      workspaceId,
      key: 'external_reference',
      name: 'External Ref',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, intake.id, [{ fieldDefinitionId: sourceFieldId }]);
    setWorkflowFields(handle.db, owner, claims.id, [{ fieldDefinitionId: targetFieldId }]);
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      fieldMappings: { reference_number: 'external_reference' }
    });

    const source = newItem(intake.id, 'Mapped', { reference_number: 'REF-9' });
    const result = transferWorkflowItemSync(handle.db, owner, {
      workflowItemId: source.id,
      targetWorkflowId: claims.id
    });

    const destination = await getWorkflowItemDetail(handle.db, owner, result.workflowItem.id);
    expect(destination.fields.external_reference).toBe('REF-9');
  });

  test('carries shared base field keys automatically', async () => {
    // In the universal model a field shared by both workflows should be a base
    // Object Type field: it lives on the Record, so it survives the transfer with
    // the Record's identity. Workflow-overlay keys are only carried when mapped.
    const objectType = await createObjectType(handle.db, {
      workspaceId,
      key: 'account',
      name: 'Account',
      fields: [{ key: 'customer_email', name: 'Customer Email', type: 'email' }]
    });
    const intake = await createWorkflow(handle.db, workspaceId, {
      name: 'Intake',
      key: 'INTA',
      objectTypeId: objectType.id
    });
    const claims = await createWorkflow(handle.db, workspaceId, {
      name: 'Claims',
      key: 'CLMA',
      objectTypeId: objectType.id
    });

    const source = createWorkflowItemSync(handle.db, owner, {
      workflowId: intake.id,
      record: { displayName: 'Shared', fields: { customer_email: 'ap@acme.test' } }
    });
    const result = transferWorkflowItemSync(handle.db, owner, {
      workflowItemId: source.id,
      targetWorkflowId: claims.id
    });

    const destination = await getWorkflowItemDetail(handle.db, owner, result.workflowItem.id);
    expect(destination.fields.customer_email).toBe('ap@acme.test');

    // The value is durable on the Record, not re-created per participation.
    const record = handle.db.select().from(records).where(eq(records.id, source.recordId)).all()[0];
    expect(record?.id).toBe(source.recordId);
  });

  test('refuses a transfer when a destination required field is missing', async () => {
    // NOTE (migration gap): `transferWorkflowItemSync` currently does not enforce a
    // destination workflow field marked `required`, nor a rule's
    // `requiredTargetFieldKeys`. `previewTransfer` reports it, but the transfer
    // itself proceeds. This test asserts the intended lifecycle behaviour.
    const { intake, claims } = await intakeAndClaims();
    const requiredId = await createField(handle.db, {
      workspaceId,
      key: 'claim_type',
      name: 'Claim Type',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, claims.id, [
      { fieldDefinitionId: requiredId, required: true }
    ]);

    const source = newItem(intake.id, 'Missing');
    expect(() =>
      transferWorkflowItemSync(handle.db, owner, {
        workflowItemId: source.id,
        targetWorkflowId: claims.id
      })
    ).toThrow(/destination requires/i);

    // The failed transfer must not have moved the work.
    const unchanged = await getWorkflowItemDetail(handle.db, owner, source.id);
    expect(unchanged.workflowId).toBe(intake.id);
    expect(unchanged.completedAt).toBeNull();
  });

  test('agents may not transfer when the rule disallows it', async () => {
    const { intake, claims } = await intakeAndClaims();
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      allowAgents: false
    });
    const source = newItem(intake.id, 'Agent transfer');
    const agent = agentActor(workspaceId, 'agent-1', 'Triage Agent', [
      Permissions.workflowItemTransfer,
      Permissions.workflowItemRead,
      Permissions.recordRead
    ]);
    expect(() =>
      transferWorkflowItemSync(handle.db, agent, {
        workflowItemId: source.id,
        targetWorkflowId: claims.id
      })
    ).toThrow(/Agents may not transfer/i);
  });

  test('humans may not transfer when the rule disallows it', async () => {
    const { intake, claims } = await intakeAndClaims();
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      allowHumans: false
    });
    const source = newItem(intake.id, 'Human transfer');
    expect(() =>
      transferWorkflowItemSync(handle.db, owner, {
        workflowItemId: source.id,
        targetWorkflowId: claims.id
      })
    ).toThrow(/Humans may not transfer/i);
  });

  test('the transfer policy reports that approval is required', async () => {
    const { intake, claims } = await intakeAndClaims();
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      requiresApproval: true
    });
    const source = newItem(intake.id, 'Needs approval');
    const policy = evaluateWorkflowTransferPolicy(handle.db, owner, {
      workflowItemId: source.id,
      targetWorkflowId: claims.id
    });
    expect(policy.allowed).toBe(true);
    expect(policy.requiresApproval).toBe(true);
    expect(policy.rule?.requiresApproval).toBe(true);
  });

  test('a transfer requiring approval is refused without one', async () => {
    // NOTE (migration gap): a rule with `requiresApproval: true` is reported by
    // `evaluateWorkflowTransferPolicy`, and the execution engine can apply an
    // approved `transfer` approval request, but `transferWorkflowItemSync` does not
    // itself refuse an unapproved move. This test asserts the intended lifecycle.
    const { intake, claims } = await intakeAndClaims();
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      requiresApproval: true
    });
    const source = newItem(intake.id, 'Needs approval');
    expect(() =>
      transferWorkflowItemSync(handle.db, owner, {
        workflowItemId: source.id,
        targetWorkflowId: claims.id
      })
    ).toThrow(/requires approval/i);
  });

  test('transfer preview reports compatible, mapped and missing fields', async () => {
    const { intake, claims } = await intakeAndClaims();
    const sharedId = await createField(handle.db, {
      workspaceId,
      key: 'customer',
      name: 'Customer',
      type: 'short_text'
    });
    const sourceId = await createField(handle.db, {
      workspaceId,
      key: 'source_ref',
      name: 'Source Ref',
      type: 'short_text'
    });
    const targetRequiredId = await createField(handle.db, {
      workspaceId,
      key: 'claim_type',
      name: 'Claim Type',
      type: 'short_text'
    });
    setWorkflowFields(handle.db, owner, intake.id, [
      { fieldDefinitionId: sharedId },
      { fieldDefinitionId: sourceId }
    ]);
    setWorkflowFields(handle.db, owner, claims.id, [
      { fieldDefinitionId: sharedId },
      { fieldDefinitionId: targetRequiredId, required: true }
    ]);
    setTransferRule(handle.db, owner, intake.id, {
      targetWorkflowId: claims.id,
      fieldMappings: { source_ref: 'source_ref_mapped' }
    });

    const source = newItem(intake.id, 'Preview', {
      customer: 'ACME',
      source_ref: 'REF-1'
    });
    const preview = previewTransfer(handle.db, owner, {
      workflowItemId: source.id,
      targetWorkflowId: claims.id
    });

    expect(preview.targetWorkflow.id).toBe(claims.id);
    expect(preview.defaultTargetStateId).toBe(claims.states[0] as string);
    expect(preview.compatible).toContain('customer');
    expect(preview.mapped).toEqual([{ source: 'source_ref', target: 'source_ref_mapped' }]);
    expect(preview.destinationRequired.map((entry) => entry.key)).toContain('claim_type');
    expect(preview.destinationRequired.find((entry) => entry.key === 'claim_type')?.satisfied).toBe(
      false
    );
    // Both source-only keys are accounted for: customer is compatible, source_ref is mapped.
    expect(preview.sourceOnly).toEqual([]);
  });

  test('refuses a transfer to a workflow processing a different Object Type', async () => {
    const { intake } = await intakeAndClaims();
    const otherType = await createObjectType(handle.db, {
      workspaceId,
      key: 'policy',
      name: 'Policy'
    });
    const policyWorkflow = await createWorkflow(handle.db, workspaceId, {
      name: 'Policies',
      key: 'POL',
      objectTypeId: otherType.id
    });
    const source = newItem(intake.id, 'Wrong type');
    expect(() =>
      transferWorkflowItemSync(handle.db, owner, {
        workflowItemId: source.id,
        targetWorkflowId: policyWorkflow.id
      })
    ).toThrow(/processes/i);
  });

  test('transfer requires the workflow-item transfer permission', async () => {
    const { intake, claims } = await intakeAndClaims();
    const source = newItem(intake.id, 'Guarded');
    const nobody: ActorContext = {
      ...memberActor(workspaceId, 'member-1', 'Member'),
      permissions: new Set([Permissions.workflowItemRead])
    };
    expect(() =>
      transferWorkflowItemSync(handle.db, nobody, {
        workflowItemId: source.id,
        targetWorkflowId: claims.id
      })
    ).toThrow(/not permitted to transfer/i);
  });

  test('a workflow cannot transfer work to itself', async () => {
    const { intake } = await intakeAndClaims();
    const source = newItem(intake.id, 'Same workflow');
    expect(() =>
      transferWorkflowItemSync(handle.db, owner, {
        workflowItemId: source.id,
        targetWorkflowId: intake.id
      })
    ).toThrow(/different target workflow/i);
  });

  test('transfer does not touch work relationships on the source', async () => {
    const { intake, claims } = await intakeAndClaims();
    const source = newItem(intake.id, 'Linked');
    const other = newItem(intake.id, 'Neighbour');
    linkWorkItemsSync(handle.db, owner, {
      fromWorkflowItemId: source.id,
      toWorkflowItemId: other.id,
      type: 'related'
    });

    transferWorkflowItemSync(handle.db, owner, {
      workflowItemId: source.id,
      targetWorkflowId: claims.id
    });

    const relationships = handle.db
      .select()
      .from(workflowItemRelationships)
      .where(eq(workflowItemRelationships.fromWorkflowItemId, source.id))
      .all();
    expect(relationships).toHaveLength(1);
  });
});
