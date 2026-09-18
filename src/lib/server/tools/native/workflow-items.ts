/**
 * Native WorkflowItem tools (ADR-0021).
 *
 * These are the controlled operations an agent uses to do work: put a Record into
 * a Workflow, read and change work-overlay fields, move it through workflow rules,
 * transfer or multiply participation, link related work, attach files and submit a
 * record result. Every operation goes through the same service layer a human uses,
 * so validation, workflow policy (including human gates and transfer rules),
 * history and audit are identical regardless of who is acting — an agent is a
 * participant, not a privileged back door.
 *
 * Durable domain data lives behind `records.*`; work participation lives here.
 * `workflowItems.create` and `records.create` are never collapsed into one
 * ambiguous call.
 */
import { and, eq } from 'drizzle-orm';
import { assertNativeCapability } from '../../agents/permissions';
import { errors } from '../../core/errors';
import { withTransaction } from '../../db/client';
import { fileWorkflowItems, type WorkRelationshipType } from '../../db/schema';
import { applyWorkSubmission } from '../../workflow-items/contract';
import { listWorkflowItems } from '../../workflow-items/query';
import {
  addWorkflowItemNote,
  addWorkflowParticipation,
  createWorkflowItem,
  getWorkflowItemDetail,
  linkWorkItemsSync,
  requestWorkflowItemTransition,
  setWorkflowItemFields,
  transferWorkflowItem
} from '../../workflow-items/service';
import { defineNativeTool, type NativeToolHandler, toolFailure, toolSuccess } from '../types';

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const stringProp = (description: string) => ({ type: 'string', description });
const idProp = (description: string) => ({ type: 'string', description });

/** Resolve a Record id: explicit, or the record in scope for the run. */
function resolveRecordId(
  context: Parameters<NativeToolHandler['execute']>[1],
  explicitId?: string | null
): string {
  if (explicitId) return explicitId;
  if (context.recordId) return context.recordId;
  throw errors.validation('This call needs a recordId: no record is in scope for the run');
}

/** Resolve a WorkflowItem id: explicit, or the work item in scope for the run. */
function resolveWorkItemId(
  context: Parameters<NativeToolHandler['execute']>[1],
  explicitId?: string | null
): string {
  if (explicitId) return explicitId;
  if (context.workflowItemId) return context.workflowItemId;
  throw errors.validation('This call needs a workflowItemId: none is in scope for the run');
}

export const workflowItemsSearchTool = defineNativeTool({
  key: 'workflowItems.search',
  name: 'Search work items',
  description: 'List WorkflowItems (work) in the workspace, optionally by workflow or record.',
  inputSchema: objectSchema({
    workflowId: idProp('Filter by workflow.'),
    recordId: idProp('Filter by record.'),
    limit: { type: 'number' }
  }),
  permission: 'workflow_item:read',
  async execute(
    input: { workflowId?: string; recordId?: string; limit?: number } | undefined,
    context
  ) {
    const page = await listWorkflowItems(context.db, {
      workspaceId: context.actor.workspaceId,
      workflowId: input?.workflowId ?? null,
      recordId: input?.recordId ?? null,
      limit: input?.limit ?? 50
    });
    return toolSuccess(page);
  }
});

export const workflowItemsGetTool = defineNativeTool({
  key: 'workflowItems.get',
  name: 'Get a work item',
  description:
    'Read one WorkflowItem: state, owner, effective fields, transitions, notes and history.',
  inputSchema: objectSchema({
    workflowItemId: idProp('Workflow item id. Defaults to the item in scope.')
  }),
  permission: 'workflow_item:read',
  async execute(input: { workflowItemId?: string } | undefined, context) {
    const workflowItemId = resolveWorkItemId(context, input?.workflowItemId);
    const detail = await getWorkflowItemDetail(context.db, context.actor, workflowItemId);
    return toolSuccess({ workflowItem: detail });
  }
});

export const workflowItemsCreateTool = defineNativeTool({
  key: 'workflowItems.create',
  name: 'Start work',
  description:
    'Put an existing Record into a Workflow, or create the Record inline. This is not records.create.',
  inputSchema: objectSchema(
    {
      workflowId: idProp('Target workflow id.'),
      recordId: idProp('Existing record id.'),
      objectTypeKey: stringProp('Object Type for an inline record, e.g. business, policy.'),
      displayName: stringProp('Display name when creating an inline record.'),
      stateId: idProp('Optional starting state.'),
      fields: { type: 'object', description: 'Field values (base and workflow overlay).' },
      ownerUserId: idProp('Optional owner user id.'),
      ownerTeamId: idProp('Optional owner team id.')
    },
    ['workflowId']
  ),
  permission: 'workflow_item:create',
  async execute(
    input: {
      workflowId: string;
      recordId?: string;
      objectTypeKey?: string;
      displayName?: string;
      stateId?: string;
      fields?: Record<string, unknown>;
      ownerUserId?: string;
      ownerTeamId?: string;
    },
    context
  ) {
    assertNativeCapability(context.actor.permissions, ['workflowItems.create'], 'start work');
    const item = await createWorkflowItem(context.db, context.actor, {
      workflowId: input.workflowId,
      recordId: input.recordId ?? null,
      stateId: input.stateId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      ownerTeamId: input.ownerTeamId ?? null,
      fields: input.fields ?? {},
      record:
        input.recordId || !input.objectTypeKey
          ? null
          : { objectTypeKey: input.objectTypeKey, displayName: input.displayName ?? null }
    });
    return toolSuccess({ workflowItem: item });
  }
});

export const workflowItemsGetFieldsTool = defineNativeTool({
  key: 'workflowItems.getFields',
  name: 'Get work item fields',
  description: 'Read the effective (base + workflow overlay) field values of a WorkflowItem.',
  inputSchema: objectSchema({
    workflowItemId: idProp('Workflow item id. Defaults to the item in scope.')
  }),
  permission: 'workflow_item:read',
  async execute(input: { workflowItemId?: string } | undefined, context) {
    const workflowItemId = resolveWorkItemId(context, input?.workflowItemId);
    const detail = await getWorkflowItemDetail(context.db, context.actor, workflowItemId);
    return toolSuccess({ fields: detail.fields, state: detail.state });
  }
});

export const workflowItemsSetFieldsTool = defineNativeTool({
  key: 'workflowItems.setFields',
  name: 'Set work item fields',
  description:
    'Write field values for a participation. Base fields update the Record; workflow overlay fields stay with the work.',
  inputSchema: objectSchema(
    {
      workflowItemId: idProp('Workflow item id. Defaults to the item in scope.'),
      values: { type: 'object' }
    },
    ['values']
  ),
  permission: 'workflow_item:write',
  async execute(input: { workflowItemId?: string; values: Record<string, unknown> }, context) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.setFields', 'workflowItems.fields.set'],
      'change work fields'
    );
    const workflowItemId = resolveWorkItemId(context, input.workflowItemId);
    const result = await setWorkflowItemFields(context.db, context.actor, {
      workflowItemId,
      values: input.values
    });
    return toolSuccess({ changes: result.changes });
  }
});

export const workflowItemsAddNoteTool = defineNativeTool({
  key: 'workflowItems.addNote',
  name: 'Add a work note',
  description: 'Append a note about this particular piece of work.',
  inputSchema: objectSchema(
    {
      workflowItemId: idProp('Workflow item id. Defaults to the item in scope.'),
      body: stringProp('Note text.')
    },
    ['body']
  ),
  permission: 'workflow_item:write',
  async execute(input: { workflowItemId?: string; body: string }, context) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.addNote', 'workflowItems.note.add'],
      'add work notes'
    );
    const workflowItemId = resolveWorkItemId(context, input.workflowItemId);
    const note = await addWorkflowItemNote(context.db, context.actor, {
      workflowItemId,
      body: input.body,
      runId: context.runId ?? null
    });
    return toolSuccess({ noteId: note.noteId });
  }
});

export const workflowItemsRequestTransitionTool = defineNativeTool({
  key: 'workflowItems.requestTransition',
  name: 'Move work',
  description:
    'Request a state transition through the workflow rules. A human gate will refuse an agent move.',
  inputSchema: objectSchema(
    {
      workflowItemId: idProp('Workflow item id. Defaults to the item in scope.'),
      transitionId: idProp('Transition id.'),
      targetStateId: idProp('Target state id (alternative to transitionId).'),
      comment: stringProp('Optional reason/comment.'),
      fields: { type: 'object', description: 'Field values required for the transition.' }
    },
    []
  ),
  permission: 'workflow_item:write',
  async execute(
    input: {
      workflowItemId?: string;
      transitionId?: string;
      targetStateId?: string;
      comment?: string;
      fields?: Record<string, unknown>;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.requestTransition', 'workflowItems.transition'],
      'move work'
    );
    const workflowItemId = resolveWorkItemId(context, input.workflowItemId);
    const result = await requestWorkflowItemTransition(context.db, context.actor, {
      workflowItemId,
      transitionId: input.transitionId ?? null,
      targetStateId: input.targetStateId ?? null,
      comment: input.comment ?? null,
      fieldValues: input.fields ?? {},
      runId: context.runId ?? null
    });
    return toolSuccess(result);
  }
});

export const workflowItemsTransferTool = defineNativeTool({
  key: 'workflowItems.transfer',
  name: 'Transfer work',
  description:
    'Move this work to another Workflow (the source item is closed and lineage preserved).',
  inputSchema: objectSchema(
    {
      workflowItemId: idProp('Workflow item id. Defaults to the item in scope.'),
      targetWorkflowId: idProp('Destination workflow id.'),
      targetStateId: idProp('Optional destination state.'),
      reason: stringProp('Why the work is moving.')
    },
    ['targetWorkflowId']
  ),
  permission: 'workflow_item:transfer',
  async execute(
    input: {
      workflowItemId?: string;
      targetWorkflowId: string;
      targetStateId?: string;
      reason?: string;
    },
    context
  ) {
    assertNativeCapability(context.actor.permissions, ['workflowItems.transfer'], 'transfer work');
    const workflowItemId = resolveWorkItemId(context, input.workflowItemId);
    const result = await transferWorkflowItem(context.db, context.actor, {
      workflowItemId,
      targetWorkflowId: input.targetWorkflowId,
      targetStateId: input.targetStateId ?? null,
      reason: input.reason ?? null
    });
    return toolSuccess(result);
  }
});

export const workflowItemsAddParticipationTool = defineNativeTool({
  key: 'workflowItems.addParticipation',
  name: 'Add work participation',
  description:
    'Put the same Record into another Workflow while existing participation stays active. Distinct from transfer.',
  inputSchema: objectSchema(
    {
      recordId: idProp('Record id. Defaults to the record in scope.'),
      workflowId: idProp('Additional workflow id.'),
      stateId: idProp('Optional starting state.'),
      fields: { type: 'object' }
    },
    ['workflowId']
  ),
  permission: 'workflow_item:create',
  async execute(
    input: {
      recordId?: string;
      workflowId: string;
      stateId?: string;
      fields?: Record<string, unknown>;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.addParticipation'],
      'add work participation'
    );
    const recordId = resolveRecordId(context, input.recordId);
    const item = await addWorkflowParticipation(context.db, context.actor, {
      recordId,
      workflowId: input.workflowId,
      stateId: input.stateId ?? null,
      fields: input.fields ?? {}
    });
    return toolSuccess({ workflowItem: item });
  }
});

export const workflowItemsLinkFileTool = defineNativeTool({
  key: 'workflowItems.linkFile',
  name: 'Link a file to work',
  description: 'Attach a File to this participation as work-specific context.',
  inputSchema: objectSchema(
    {
      workflowItemId: idProp('Workflow item id. Defaults to the item in scope.'),
      fileId: idProp('File id.'),
      relationship: {
        type: 'string',
        enum: ['attachment', 'reference', 'output', 'evidence', 'source']
      }
    },
    ['fileId']
  ),
  permission: 'workflow_item:write',
  async execute(
    input: { workflowItemId?: string; fileId: string; relationship?: string },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.linkFile'],
      'link files to work'
    );
    const workflowItemId = resolveWorkItemId(context, input.workflowItemId);
    const relationship = input.relationship ?? 'attachment';
    const existing = context.db
      .select({ id: fileWorkflowItems.id })
      .from(fileWorkflowItems)
      .where(
        and(
          eq(fileWorkflowItems.workspaceId, context.actor.workspaceId),
          eq(fileWorkflowItems.fileId, input.fileId),
          eq(fileWorkflowItems.workflowItemId, workflowItemId),
          eq(fileWorkflowItems.relationship, relationship as never)
        )
      )
      .all()[0];
    if (existing) {
      context.db
        .update(fileWorkflowItems)
        .set({ removedAt: null })
        .where(eq(fileWorkflowItems.id, existing.id))
        .run();
    } else {
      context.db
        .insert(fileWorkflowItems)
        .values({
          workspaceId: context.actor.workspaceId,
          fileId: input.fileId,
          workflowItemId,
          relationship: relationship as never,
          addedByType: context.actor.actorType,
          addedById: context.actor.actorId,
          addedByLabel: context.actor.actorLabel,
          runId: context.runId ?? null
        })
        .run();
    }
    return toolSuccess({ linked: true });
  }
});

export const workflowItemsLinkRelationshipTool = defineNativeTool({
  key: 'workflowItems.linkRelationship',
  name: 'Link two work items',
  description:
    'Create a first-class work relationship (parent, child, related, duplicate, blocks, blocked_by) between this work item and another.',
  inputSchema: objectSchema(
    {
      fromWorkflowItemId: idProp('Source work item id. Defaults to the work item in scope.'),
      toWorkflowItemId: idProp('The other work item id.'),
      type: stringProp('parent | child | related | duplicate | blocks | blocked_by'),
      note: stringProp('Optional note explaining the relationship.')
    },
    ['toWorkflowItemId', 'type']
  ),
  permission: 'workflow_item:write',
  async execute(
    input: { fromWorkflowItemId?: string; toWorkflowItemId: string; type: string; note?: string },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.linkRelationship', 'workflowItems.relationship.link'],
      'link work items'
    );
    const fromWorkflowItemId = resolveWorkItemId(context, input.fromWorkflowItemId);
    const allowed: WorkRelationshipType[] = [
      'parent',
      'child',
      'related',
      'duplicate',
      'blocks',
      'blocked_by'
    ];
    const type = allowed.find((entry) => entry === input.type);
    if (!type) {
      return toolFailure({
        code: 'validation_failed',
        message: `type must be one of: ${allowed.join(', ')}`
      });
    }
    await withTransaction(context.db, (tx) =>
      linkWorkItemsSync(tx, context.actor, {
        fromWorkflowItemId,
        toWorkflowItemId: input.toWorkflowItemId,
        type,
        note: input.note ?? null
      })
    );
    return toolSuccess({
      fromWorkflowItemId,
      toWorkflowItemId: input.toWorkflowItemId,
      type
    });
  }
});

export const workflowItemsSubmitTool = defineNativeTool({
  key: 'workflowItems.submit',
  name: 'Submit work result',
  description:
    'Submit the record you are working on together with the next workflow step. The record is validated against the Object Type schema (base fields plus the target workflow overlay); an invalid or incomplete submission is rejected with field issues so you can correct it. Set workflow.workflowId only when the work belongs in a different workflow — the record is then validated against that workflow.',
  inputSchema: objectSchema({
    workflowItemId: idProp('Workflow item id. Defaults to the item in scope.'),
    record: {
      type: 'object',
      description: 'Record field values (base + workflow overlay) to persist.'
    },
    workflow: {
      type: 'object',
      description: 'Next step: { stateId? or transitionId?, workflowId?, reason?, note? }.',
      additionalProperties: true
    }
  }),
  permission: 'workflow_item:write',
  async execute(
    input: {
      workflowItemId?: string;
      record?: Record<string, unknown>;
      workflow?: Record<string, unknown>;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      ['workflowItems.submit', 'workflowItems.transition'],
      'submit work results'
    );
    const workflowItemId = resolveWorkItemId(context, input.workflowItemId);
    const result = await applyWorkSubmission(context.db, context.actor, {
      workflowItemId,
      record: input.record,
      workflow: input.workflow as never,
      runId: context.runId ?? null
    });
    return toolSuccess(result);
  }
});

/** WorkflowItem tools owned by the execution workstream. */
export const workflowItemTools: NativeToolHandler[] = [
  workflowItemsSearchTool,
  workflowItemsGetTool,
  workflowItemsCreateTool,
  workflowItemsGetFieldsTool,
  workflowItemsSetFieldsTool,
  workflowItemsAddNoteTool,
  workflowItemsRequestTransitionTool,
  workflowItemsTransferTool,
  workflowItemsAddParticipationTool,
  workflowItemsLinkFileTool,
  workflowItemsLinkRelationshipTool,
  workflowItemsSubmitTool
];

export const workflowItemToolKeys = workflowItemTools.map((tool) => tool.key);
