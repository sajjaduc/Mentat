/**
 * AI execution contract for Record-bound work (ADR-0023).
 *
 * Input is always the record the agent is working on. Output is the same record
 * plus a workflow directive: the next state/transition, or a different target
 * Workflow when the agent judges the work belongs elsewhere. The record is
 * validated against the *target* Object Type schema — base fields plus that
 * workflow's overlay — before anything is persisted, so data is clean in and
 * clean out. Invalid submissions come back as validation issues for repair.
 *
 * State schemas layer on top of that contract. The state the submission is made
 * from is checked against the submission itself; the state the work lands in is
 * checked against the resulting record, so work cannot enter a state whose schema
 * it does not satisfy.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorContext } from '../core/context';
import { errors } from '../core/errors';
import { type Executor, withTransaction } from '../db/client';
import { records, workflowStates } from '../db/schema';
import {
  buildRecordContract,
  type RecordContract,
  type RecordContractIssue,
  validateRecordAgainstContract
} from '../records/contract';
import { validateAgainstZodSource } from '../schemas/zod-source';
import { workflowItemFieldValuesByKey, writeWorkflowItemFieldValues } from './fields';
import {
  addWorkflowItemNoteSync,
  requestWorkflowItemTransitionSync,
  requireWorkflowItemRow,
  transferWorkflowItemSync
} from './service';
import type { FieldChange } from './types';

export const WORK_SUBMISSION_TOOL_KEY = 'workflowItems.submit';

/** The wrapping information: what should happen to the work next. */
export interface WorkDirective {
  /** Move the work to another Workflow (transfer) when different. */
  workflowId?: string;
  transitionId?: string;
  stateId?: string;
  reason?: string;
  note?: string;
}

export interface WorkSubmission {
  record?: Record<string, unknown>;
  workflow?: WorkDirective;
}

const directiveSchema = z
  .object({
    workflowId: z.string().min(1).optional(),
    transitionId: z.string().min(1).optional(),
    stateId: z.string().min(1).optional(),
    reason: z.string().max(2000).optional(),
    note: z.string().max(20_000).optional()
  })
  .strict()
  .refine((value) => !(value.stateId && value.transitionId), {
    message: 'Provide either stateId or transitionId, not both'
  });

const submissionSchema = z
  .object({
    record: z.record(z.string(), z.unknown()).optional(),
    workflow: directiveSchema.optional()
  })
  .strict();

export type SubmissionParse =
  | { ok: true; submission: WorkSubmission }
  | { ok: false; issues: RecordContractIssue[] };

export function parseWorkSubmission(raw: unknown): SubmissionParse {
  const parsed = submissionSchema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, submission: parsed.data as WorkSubmission };
  return { ok: false, issues: zodIssues(parsed.error.issues) };
}

function zodIssues(
  issues: Array<{ code?: string; keys?: string[]; path: PropertyKey[]; message: string }>
): RecordContractIssue[] {
  return issues.flatMap((detail) => {
    if (detail.code === 'unrecognized_keys' && Array.isArray(detail.keys)) {
      return detail.keys.map((key) => ({
        path: key,
        message: `Unrecognized field: ${key}`
      }));
    }
    return [{ path: detail.path.map(String).join('.'), message: detail.message }];
  });
}

export interface ApplyWorkSubmissionInput {
  workflowItemId: string;
  record?: Record<string, unknown>;
  workflow?: WorkDirective;
  runId?: string | null;
  /** When false a submission naming another Workflow is rejected. */
  allowWorkflowChange?: boolean;
}

export interface AppliedWorkSubmission {
  workflowItemId: string;
  recordId: string;
  objectTypeId: string;
  targetWorkflowId: string;
  stateId: string;
  transferred: boolean;
  changes: Array<{ key: string; previous: unknown; next: unknown }>;
  contract: { objectTypeId: string; objectTypeKey: string; workflowId: string | null };
  directive: WorkDirective | null;
}

export async function applyWorkSubmission(
  db: Executor,
  actor: ActorContext,
  input: ApplyWorkSubmissionInput
): Promise<AppliedWorkSubmission> {
  const item = requireWorkflowItemRow(db, actor.workspaceId, input.workflowItemId);
  const record = db
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, actor.workspaceId), eq(records.id, item.recordId)))
    .all()[0];
  if (!record) throw errors.notFound('Record', item.recordId);

  const targetWorkflowId = input.workflow?.workflowId ?? item.workflowId;
  if (targetWorkflowId !== item.workflowId && input.allowWorkflowChange === false) {
    throw errors.forbidden('This state does not permit moving work to another workflow', {
      targetWorkflowId
    });
  }

  // A state may declare its own Zod schema; the same source that was tested while
  // authoring is compiled and run here. It is additive to the Object Type contract:
  // a state can demand data the record schema does not, without widening the record.
  const currentState = db
    .select({ id: workflowStates.id, name: workflowStates.name, config: workflowStates.config })
    .from(workflowStates)
    .where(eq(workflowStates.id, item.stateId))
    .all()[0];
  const stateSchema = currentState?.config?.zodSchema;
  if (stateSchema) {
    const stateValidation = validateAgainstZodSource(stateSchema, input.record ?? {});
    if (!stateValidation.ok) {
      throw errors.validation(
        `Record submission failed the schema for state ${currentState?.name ?? item.stateId}`,
        {
          issues: stateValidation.issues,
          stateId: currentState?.id ?? item.stateId,
          source: 'state_schema'
        }
      );
    }
  }

  // Validate against the *target* workflow's effective schema (base + overlay).
  const contract = await buildRecordContract(
    db,
    actor.workspaceId,
    record.objectTypeId,
    targetWorkflowId
  );
  const validation = validateRecordAgainstContract(contract, input.record ?? {});
  if (!validation.ok) {
    throw errors.validation('Record submission failed validation', {
      issues: validation.issues,
      objectTypeId: contract.objectTypeId,
      objectTypeKey: contract.objectTypeKey,
      workflowId: targetWorkflowId,
      fields: contract.fields.map((field) => field.key)
    });
  }

  return withTransaction(db, (tx) =>
    applyValidatedSync(tx, actor, input, contract, targetWorkflowId, validation.data)
  );
}

function applyValidatedSync(
  tx: Executor,
  actor: ActorContext,
  input: ApplyWorkSubmissionInput,
  contract: RecordContract,
  targetWorkflowId: string,
  values: Record<string, unknown>
): AppliedWorkSubmission {
  const item = requireWorkflowItemRow(tx, actor.workspaceId, input.workflowItemId);
  const directive = input.workflow ?? null;
  const changes: Array<{ key: string; previous: unknown; next: unknown }> = [];

  if (targetWorkflowId !== item.workflowId) {
    // Transfer first (source closed, destination opened), then persist the record
    // against the destination's schema so overlay values land on the new item.
    const transferred = transferWorkflowItemSync(tx, actor, {
      workflowItemId: item.id,
      targetWorkflowId,
      targetStateId: directive?.stateId ?? null,
      reason: directive?.reason ?? null,
      // The submission is validated against the destination schema but written
      // after the transfer; count it now so destination requirements pass.
      fieldValues: values
    });
    const destination = requireWorkflowItemRow(tx, actor.workspaceId, transferred.workflowItem.id);
    const written = writeWorkflowItemFieldValues(tx, {
      workspaceId: actor.workspaceId,
      workflowItemId: destination.id,
      workflowId: destination.workflowId,
      recordId: destination.recordId,
      objectTypeId: contract.objectTypeId,
      values,
      actor,
      source: inferSource(actor),
      runId: input.runId ?? null
    });
    changes.push(...written.map(toChange));
    if (directive?.note) {
      addWorkflowItemNoteSync(tx, actor, { workflowItemId: destination.id, body: directive.note });
    }
    assertStateSchemaOnEntry(tx, actor, contract, {
      workflowItemId: destination.id,
      recordId: destination.recordId,
      stateId: destination.stateId,
      submitted: values
    });
    return {
      workflowItemId: destination.id,
      recordId: destination.recordId,
      objectTypeId: contract.objectTypeId,
      targetWorkflowId: destination.workflowId,
      stateId: destination.stateId,
      transferred: true,
      changes,
      contract: {
        objectTypeId: contract.objectTypeId,
        objectTypeKey: contract.objectTypeKey,
        workflowId: destination.workflowId
      },
      directive
    };
  }

  if (directive && (directive.stateId || directive.transitionId)) {
    const applied = requestWorkflowItemTransitionSync(tx, actor, {
      workflowItemId: item.id,
      transitionId: directive.transitionId ?? null,
      targetStateId: directive.stateId ?? null,
      comment: directive.reason ?? null,
      fieldValues: values,
      runId: input.runId ?? null
    });
    if (directive.note) {
      addWorkflowItemNoteSync(tx, actor, { workflowItemId: item.id, body: directive.note });
    }
    assertStateSchemaOnEntry(tx, actor, contract, {
      workflowItemId: item.id,
      recordId: item.recordId,
      stateId: applied.toStateId,
      submitted: values
    });
    return {
      workflowItemId: item.id,
      recordId: item.recordId,
      objectTypeId: contract.objectTypeId,
      targetWorkflowId: item.workflowId,
      stateId: applied.toStateId,
      transferred: false,
      changes,
      contract: {
        objectTypeId: contract.objectTypeId,
        objectTypeKey: contract.objectTypeKey,
        workflowId: item.workflowId
      },
      directive
    };
  }

  const written = writeWorkflowItemFieldValues(tx, {
    workspaceId: actor.workspaceId,
    workflowItemId: item.id,
    workflowId: item.workflowId,
    recordId: item.recordId,
    objectTypeId: contract.objectTypeId,
    values,
    actor,
    source: inferSource(actor),
    runId: input.runId ?? null
  });
  changes.push(...written.map(toChange));
  if (directive?.note) {
    addWorkflowItemNoteSync(tx, actor, { workflowItemId: item.id, body: directive.note });
  }
  assertStateSchemaOnEntry(tx, actor, contract, {
    workflowItemId: item.id,
    recordId: item.recordId,
    stateId: item.stateId,
    submitted: values
  });
  return {
    workflowItemId: item.id,
    recordId: item.recordId,
    objectTypeId: contract.objectTypeId,
    targetWorkflowId: item.workflowId,
    stateId: item.stateId,
    transferred: false,
    changes,
    contract: {
      objectTypeId: contract.objectTypeId,
      objectTypeKey: contract.objectTypeKey,
      workflowId: item.workflowId
    },
    directive
  };
}

function toChange(change: FieldChange): { key: string; previous: unknown; next: unknown } {
  return { key: change.key, previous: change.previous, next: change.next };
}

/**
 * Enforce the schema of the state the work has landed in (ADR-0023 layering).
 *
 * A submission's current-state schema is checked against the submission itself
 * before it is applied; this runs after the transition or transfer and checks the
 * resulting record instead, so work cannot enter a state whose schema it does not
 * satisfy — including values already on the record that the submission omitted.
 */
function assertStateSchemaOnEntry(
  tx: Executor,
  actor: ActorContext,
  contract: RecordContract,
  options: {
    workflowItemId: string;
    recordId: string;
    stateId: string;
    submitted: Record<string, unknown>;
  }
): void {
  const state = tx
    .select({ id: workflowStates.id, name: workflowStates.name, config: workflowStates.config })
    .from(workflowStates)
    .where(eq(workflowStates.id, options.stateId))
    .all()[0];
  const source = state?.config?.zodSchema;
  if (!source) return;
  const values = workflowItemFieldValuesByKey(
    tx,
    actor.workspaceId,
    options.workflowItemId,
    options.recordId
  );
  // Submitted values are already in contract shape and win over stored ones; any
  // stored date values are epoch milliseconds, so render them as ISO.
  Object.assign(values, options.submitted);
  const types = new Map(contract.fields.map((field) => [field.key, field.type]));
  for (const [key, value] of Object.entries(values)) {
    const type = types.get(key);
    if ((type === 'date' || type === 'datetime') && typeof value === 'number') {
      const iso = new Date(value).toISOString();
      values[key] = type === 'date' ? iso.slice(0, 10) : iso;
    }
  }
  const validation = validateAgainstZodSource(source, values);
  if (!validation.ok) {
    throw errors.validation(
      `The record does not satisfy the schema for state ${state?.name ?? options.stateId}`,
      {
        issues: validation.issues,
        stateId: options.stateId,
        workflowId: contract.workflowId,
        source: 'state_schema'
      }
    );
  }
}

function inferSource(actor: ActorContext): 'human' | 'agent' | 'system' | 'extraction' {
  if (actor.actorType === 'agent') return 'agent';
  if (actor.actorType === 'user') return 'human';
  if (actor.actorType === 'extraction') return 'extraction';
  return 'system';
}
