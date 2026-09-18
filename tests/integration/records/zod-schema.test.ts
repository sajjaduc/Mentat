/**
 * Zod-source integration tests (ADR-0023 revision).
 *
 * Authoring a schema as source makes it the contract the engine runs: the typed
 * fields are a projection, and validation applies constraints the projection cannot
 * express (minimum length, coercion, enum membership). These tests prove the stored
 * source — not the derived field types — decides what is valid, for Object Types,
 * workflow overlays and workflow states.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '../../../src/lib/server/core/context';
import type { Executor } from '../../../src/lib/server/db/client';
import { workflowStates, workflows } from '../../../src/lib/server/db/schema';
import { setWorkflowFields, setWorkflowZodSchema } from '../../../src/lib/server/fields/service';
import {
  buildRecordContract,
  validateRecordAgainstContract
} from '../../../src/lib/server/records/contract';
import {
  createObjectType,
  listBaseFields,
  requireObjectType,
  setBaseFields,
  setObjectTypeZodSchema
} from '../../../src/lib/server/records/object-types';
import {
  createRecord,
  getRecordDetail,
  updateRecord
} from '../../../src/lib/server/records/service';
import { applyWorkSubmission } from '../../../src/lib/server/workflow-items/contract';
import {
  createWorkflowItem,
  getWorkflowItemDetail
} from '../../../src/lib/server/workflow-items/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createUser,
  createWorkflow as createWorkflowFixture,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';

type Actor = ActorContext;

const OBJECT_SOURCE = `z.object({
  policy_number: z.string().min(3),
  premium: z.number().min(0),
  quantity: z.coerce.number(),
  reviewer_note: z.string().optional()
})`;

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let owner: Actor;

beforeEach(async () => {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Zod Schemas');
  workspaceId = workspace.id;
  const user = await createUser(db, { name: 'Owner' });
  owner = ownerActor(workspaceId, user.id) as Actor;
});

async function policyType() {
  const objectType = createObjectType(db, owner, { name: 'Policy' });
  await setObjectTypeZodSchema(db, owner, objectType.id, OBJECT_SOURCE);
  return objectType;
}

describe('object type schemas authored as Zod source', () => {
  test('projects the schema into typed fields and stores the source verbatim', async () => {
    const objectType = createObjectType(db, owner, { name: 'Policy' });
    const saved = await setObjectTypeZodSchema(db, owner, objectType.id, OBJECT_SOURCE);

    expect(saved.fields.map((field) => field.key)).toEqual([
      'policy_number',
      'premium',
      'quantity',
      'reviewer_note'
    ]);
    const policyNumber = saved.fields[0];
    expect(policyNumber?.type).toBe('short_text');
    expect(policyNumber?.required).toBe(true);

    const stored = requireObjectType(db, workspaceId, objectType.id);
    expect(stored.settings?.zodSchema).toBe(saved.source);
  });

  test('validates against the source, applying constraints the field types cannot express', async () => {
    const objectType = await policyType();
    const contract = await buildRecordContract(db, workspaceId, objectType.id, null);
    expect(contract.baseZodSchema).not.toBeNull();

    const tooShort = validateRecordAgainstContract(contract, {
      policy_number: 'ab',
      premium: 1,
      quantity: 1
    });
    expect(tooShort.ok).toBe(false);

    // `quantity: z.coerce.number()` accepts the string "7"; the field-derived
    // schema would have rejected it because the projection stores `number`.
    const coerced = validateRecordAgainstContract(contract, {
      policy_number: 'abc',
      premium: 1,
      quantity: '7'
    });
    expect(coerced.ok).toBe(true);
    if (coerced.ok) expect(coerced.data.quantity).toBe(7);

    const unknownKey = validateRecordAgainstContract(contract, {
      policy_number: 'abc',
      premium: 1,
      quantity: 1,
      smuggled: true
    });
    expect(unknownKey.ok).toBe(false);
  });

  test('applies .meta() binding flags when projecting the schema', async () => {
    const objectType = createObjectType(db, owner, { name: 'Policy' });
    await setObjectTypeZodSchema(
      db,
      owner,
      objectType.id,
      `z.object({
        code: z.string().meta({ identity: true, primary: true, card: true, list: false }),
        note: z.string().optional()
      })`
    );

    const fields = await listBaseFields(db, workspaceId, objectType.id);
    const code = fields.find((field) => field.key === 'code');
    expect(code?.isIdentity).toBe(true);
    expect(code?.isPrimaryDisplay).toBe(true);
    expect(code?.showOnCard).toBe(true);
    expect(code?.showInList).toBe(false);
  });

  test('editing fields directly clears the stored source so the field set is authoritative again', async () => {
    const objectType = await policyType();
    await setBaseFields(db, owner, objectType.id, [
      { key: 'label', name: 'Label', type: 'short_text', isPrimaryDisplay: true }
    ] as never);

    const stored = requireObjectType(db, workspaceId, objectType.id);
    expect(stored.settings?.zodSchema).toBeUndefined();
  });

  test('saving an invalid schema is rejected without touching the stored source', async () => {
    const objectType = await policyType();
    await expect(
      setObjectTypeZodSchema(db, owner, objectType.id, 'z.object({ a: z.string() ')
    ).rejects.toThrow();

    const stored = requireObjectType(db, workspaceId, objectType.id);
    expect(stored.settings?.zodSchema).toBe(OBJECT_SOURCE.trim());
  });
});

describe('workflow overlay schemas authored as Zod source', () => {
  test('binds projected overlay fields and validates the combined contract', async () => {
    const objectType = await policyType();
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Renewal',
      objectTypeId: objectType.id
    });

    const saved = setWorkflowZodSchema(
      db,
      owner,
      workflow.id,
      `z.object({
      reviewer: z.string().min(3),
      decision: z.enum(['approve', 'reject'])
    })`
    );
    expect(saved.fields.map((view) => view.definition.key)).toEqual(['reviewer', 'decision']);
    expect(saved.fields[1]?.definition.options?.choices?.map((choice) => choice.value)).toEqual([
      'approve',
      'reject'
    ]);

    const stored = db.select().from(workflows).where(eq(workflows.id, workflow.id)).all()[0];
    expect(stored?.settings?.zodSchema).toContain('reviewer');

    const contract = await buildRecordContract(db, workspaceId, objectType.id, workflow.id);
    expect(contract.overlayZodSchema).not.toBeNull();
    expect(
      contract.fields.some((field) => field.key === 'reviewer' && field.source === 'workflow')
    ).toBe(true);

    const rejected = validateRecordAgainstContract(contract, {
      policy_number: 'abc',
      premium: 1,
      quantity: 1,
      reviewer: 'ab',
      decision: 'approve'
    });
    expect(rejected.ok).toBe(false);

    const accepted = validateRecordAgainstContract(contract, {
      policy_number: 'abc',
      premium: 1,
      quantity: 1,
      reviewer: 'abc',
      decision: 'approve'
    });
    expect(accepted.ok).toBe(true);
  });

  test('re-saving a schema preserves display and state flags set on the same key', async () => {
    const objectType = await policyType();
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Renewal',
      objectTypeId: objectType.id
    });
    const source = `z.object({ reviewer: z.string().min(3) })`;
    const first = setWorkflowZodSchema(db, owner, workflow.id, source);

    const attached = setWorkflowFields(db, owner, workflow.id, [
      {
        fieldDefinitionId: first.fields[0]!.fieldDefinitionId,
        requiredInStates: [workflow.states[1] as string],
        showOnCard: true,
        requiredForTransfer: true
      }
    ]);
    expect(attached[0]?.requiredInStates).toEqual([workflow.states[1] as string]);

    const resaved = setWorkflowZodSchema(db, owner, workflow.id, source);
    expect(resaved.fields[0]?.requiredInStates).toEqual([workflow.states[1] as string]);
    expect(resaved.fields[0]?.showOnCard).toBe(true);
    expect(resaved.fields[0]?.requiredForTransfer).toBe(true);
  });
});

describe('workflow state schemas authored as Zod source', () => {
  test('rejects a submission that does not satisfy the state schema and accepts one that does', async () => {
    const objectType = await policyType();
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Review',
      objectTypeId: objectType.id
    });
    const reviewStateId = workflow.states[1] as string;
    db.update(workflowStates)
      .set({ config: { zodSchema: `z.object({ reviewer_note: z.string().min(1) })` } as never })
      .where(eq(workflowStates.id, reviewStateId))
      .run();

    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 5, quantity: 1 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: reviewStateId
    });

    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'POL-1', premium: 5, quantity: 1 }
      })
    ).rejects.toThrow(/state In Progress/);

    const applied = await applyWorkSubmission(db, owner, {
      workflowItemId: item.id,
      record: {
        policy_number: 'POL-1',
        premium: 5,
        quantity: 1,
        reviewer_note: 'looks good'
      }
    });
    expect(applied.changes.some((change) => change.key === 'reviewer_note')).toBe(true);

    const detail = await getRecordDetail(db, owner, record.id);
    expect(detail.fields.reviewer_note).toBe('looks good');
  });
});

describe('schema layering: Object Type + overlay + state', () => {
  const LAYERED_SOURCE = `z.object({
  policy_number: z.string().min(3),
  premium: z.number().min(0),
  quantity: z.coerce.number(),
  stage_a_note: z.string().optional(),
  stage_b_note: z.string().optional()
})`;

  async function layeredType() {
    const objectType = createObjectType(db, owner, { name: 'Layered Policy' });
    await setObjectTypeZodSchema(db, owner, objectType.id, LAYERED_SOURCE);
    return objectType;
  }

  function setStateSchema(stateId: string, source: string) {
    db.update(workflowStates)
      .set({ config: { zodSchema: source } as never })
      .where(eq(workflowStates.id, stateId))
      .run();
  }

  test('checks the Object Type schema on submissions from every state', async () => {
    const objectType = await layeredType();
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Layered',
      objectTypeId: objectType.id
    });
    const backlog = workflow.states[0] as string;
    const inProgress = workflow.states[1] as string;
    setStateSchema(backlog, `z.object({ stage_a_note: z.string().min(1) })`);
    setStateSchema(inProgress, `z.object({ stage_b_note: z.string().min(1) })`);

    const cases = [
      { stateId: backlog, noteKey: 'stage_a_note', note: 'a' },
      { stateId: inProgress, noteKey: 'stage_b_note', note: 'b' }
    ] as const;

    for (const entry of cases) {
      const record = await createRecord(db, owner, {
        objectTypeId: objectType.id,
        fields: { policy_number: 'POL-1', premium: 1, quantity: 1 }
      });
      const item = await createWorkflowItem(db, owner, {
        workflowId: workflow.id,
        recordId: record.id,
        stateId: entry.stateId
      });

      // The state schema is satisfied, but the Object Type's `min(3)` still runs.
      await expect(
        applyWorkSubmission(db, owner, {
          workflowItemId: item.id,
          record: {
            policy_number: 'ab',
            premium: 1,
            quantity: 1,
            [entry.noteKey]: entry.note
          }
        })
      ).rejects.toThrow(/failed validation/);

      // Satisfying the base and the state schema passes.
      const applied = await applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: {
          policy_number: 'POL-1',
          premium: 1,
          quantity: 1,
          [entry.noteKey]: entry.note
        }
      });
      expect(applied.changes.some((change) => change.key === entry.noteKey)).toBe(true);
    }
  });

  test('a workflow overlay can only tighten, never loosen, the Object Type schema', async () => {
    const objectType = createObjectType(db, owner, { name: 'Overlay Policy' });
    await setObjectTypeZodSchema(
      db,
      owner,
      objectType.id,
      `z.object({ code: z.string().min(3), note: z.string().optional() })`
    );
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Overlay',
      objectTypeId: objectType.id
    });

    // An overlay cannot loosen the base: `z.string()` over the base `min(3)` is
    // intersected with it, so three characters are still required.
    setWorkflowZodSchema(db, owner, workflow.id, `z.object({ code: z.string() })`);
    let contract = await buildRecordContract(db, workspaceId, objectType.id, workflow.id);
    expect(validateRecordAgainstContract(contract, { code: 'ab' }).ok).toBe(false);
    expect(validateRecordAgainstContract(contract, { code: 'abc' }).ok).toBe(true);
    expect(validateRecordAgainstContract(contract, { code: 'abc', note: 'n' }).ok).toBe(true);
    expect(validateRecordAgainstContract(contract, { code: 'abc', smuggled: 1 }).ok).toBe(false);

    // An overlay can tighten: the stronger rule declared there also runs.
    setWorkflowZodSchema(db, owner, workflow.id, `z.object({ code: z.string().min(5) })`);
    contract = await buildRecordContract(db, workspaceId, objectType.id, workflow.id);
    expect(validateRecordAgainstContract(contract, { code: 'abc' }).ok).toBe(false);
    expect(validateRecordAgainstContract(contract, { code: 'abcde' }).ok).toBe(true);
  });

  test('a state schema can only require keys the contract already declares', async () => {
    const objectType = await layeredType();
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Ghost keys',
      objectTypeId: objectType.id
    });
    const start = workflow.states[0] as string;
    setStateSchema(start, `z.object({ ghost_note: z.string().min(1) })`);

    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 1, quantity: 1 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: start
    });

    // The state schema accepts `ghost_note`, but the strict Object Type contract
    // rejects the undeclared key, so a state schema cannot widen the contract.
    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'POL-1', premium: 1, quantity: 1, ghost_note: 'x' }
      })
    ).rejects.toThrow(/failed validation/);
  });
});

describe('direct record writes enforce the Object Type schema', () => {
  test('a partial update cannot persist a value the base schema rejects', async () => {
    const objectType = await policyType();
    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 5, quantity: 1 }
    });

    await expect(
      updateRecord(db, owner, { recordId: record.id, fields: { policy_number: 'ab' } })
    ).rejects.toThrow(/Object Type schema/);
    await expect(
      updateRecord(db, owner, { recordId: record.id, fields: { premium: -1 } })
    ).rejects.toThrow(/Object Type schema/);

    const detail = await getRecordDetail(db, owner, record.id);
    expect(detail.fields.policy_number).toBe('POL-1');
    expect(detail.fields.premium).toBe(5);
  });

  test('a valid update is accepted and clearing an optional field is not a violation', async () => {
    const objectType = await policyType();
    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 5, quantity: 1, reviewer_note: 'note' }
    });

    await updateRecord(db, owner, { recordId: record.id, fields: { premium: 9 } });
    const cleared = await updateRecord(db, owner, {
      recordId: record.id,
      fields: { reviewer_note: null }
    });

    expect(cleared.changes.some((change) => change.key === 'reviewer_note')).toBe(true);
    const detail = await getRecordDetail(db, owner, record.id);
    expect(detail.fields.premium).toBe(9);
    expect(detail.fields.reviewer_note ?? null).toBeNull();
  });

  test('create rejects a value the base schema rejects', async () => {
    const objectType = await policyType();
    await expect(
      createRecord(db, owner, {
        objectTypeId: objectType.id,
        fields: { policy_number: 'ab', premium: 5, quantity: 1 }
      })
    ).rejects.toThrow(/Object Type schema/);
  });

  test('normalises datetime input to ISO before validating', async () => {
    const objectType = createObjectType(db, owner, { name: 'Appointment' });
    await setObjectTypeZodSchema(
      db,
      owner,
      objectType.id,
      `z.object({ title: z.string(), starts_at: z.iso.datetime() })`
    );

    // The browser editor sends `datetime-local` values without seconds or zone.
    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { title: 'Kickoff', starts_at: '2030-01-02T10:30' }
    });
    const detail = await getRecordDetail(db, owner, record.id);
    expect(typeof detail.fields.starts_at).toBe('number');
  });
});

describe('destination state schemas', () => {
  function setStateSchema(stateId: string, source: string) {
    db.update(workflowStates)
      .set({ config: { zodSchema: source } as never })
      .where(eq(workflowStates.id, stateId))
      .run();
  }

  test('a submission must satisfy the schema of the state it enters', async () => {
    const objectType = await policyType();
    const workflow = await createWorkflowFixture(db, workspaceId, {
      name: 'Entry',
      objectTypeId: objectType.id
    });
    const backlog = workflow.states[0] as string;
    const inProgress = workflow.states[1] as string;
    setStateSchema(inProgress, `z.object({ reviewer_note: z.string().min(1) })`);

    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 5, quantity: 1 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: workflow.id,
      recordId: record.id,
      stateId: backlog
    });

    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'POL-1', premium: 5, quantity: 1 },
        workflow: { stateId: inProgress }
      })
    ).rejects.toThrow(/state In Progress/);
    // The rejected transition rolled back, so the work never left Backlog.
    expect((await getWorkflowItemDetail(db, owner, item.id)).stateId).toBe(backlog);

    const applied = await applyWorkSubmission(db, owner, {
      workflowItemId: item.id,
      record: { policy_number: 'POL-1', premium: 5, quantity: 1, reviewer_note: 'ready' },
      workflow: { stateId: inProgress }
    });
    expect(applied.stateId).toBe(inProgress);
    expect((await getWorkflowItemDetail(db, owner, item.id)).stateId).toBe(inProgress);
  });

  test('a transfer must satisfy the destination state schema', async () => {
    const objectType = await policyType();
    const lifecycle = await createWorkflowFixture(db, workspaceId, {
      name: 'Transfer source',
      objectTypeId: objectType.id
    });
    const renewal = await createWorkflowFixture(db, workspaceId, {
      name: 'Transfer target',
      objectTypeId: objectType.id
    });
    setWorkflowZodSchema(
      db,
      owner,
      renewal.id,
      `z.object({ approval_note: z.string().optional() })`
    );
    setStateSchema(renewal.states[0] as string, `z.object({ approval_note: z.string().min(1) })`);

    const record = await createRecord(db, owner, {
      objectTypeId: objectType.id,
      fields: { policy_number: 'POL-1', premium: 5, quantity: 1 }
    });
    const item = await createWorkflowItem(db, owner, {
      workflowId: lifecycle.id,
      recordId: record.id
    });

    await expect(
      applyWorkSubmission(db, owner, {
        workflowItemId: item.id,
        record: { policy_number: 'POL-1', premium: 5, quantity: 1 },
        workflow: { workflowId: renewal.id }
      })
    ).rejects.toThrow(/state Backlog/);
    expect((await getWorkflowItemDetail(db, owner, item.id)).completedAt).toBeNull();

    const applied = await applyWorkSubmission(db, owner, {
      workflowItemId: item.id,
      record: { policy_number: 'POL-1', premium: 5, quantity: 1, approval_note: 'approved' },
      workflow: { workflowId: renewal.id }
    });
    expect(applied.transferred).toBe(true);
    expect(applied.targetWorkflowId).toBe(renewal.id);
  });
});
