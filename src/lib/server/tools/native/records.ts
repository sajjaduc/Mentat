/**
 * Native Record tools (ADR-0021).
 *
 * These are the controlled operations an agent uses to manage durable knowledge
 * (`records.*`). Every operation goes through the same service layer a human uses,
 * so validation, history and audit are identical.
 *
 * Work participation (`workflowItems.*`) lives in `native/workflow-items.ts`.
 * `records.create` makes domain data; `workflowItems.create` puts a Record into a
 * Workflow. They are never collapsed into one ambiguous call.
 */
import { and, eq } from 'drizzle-orm';
import { assertNativeCapability } from '../../agents/permissions';
import { errors } from '../../core/errors';
import { withTransaction } from '../../db/client';
import { fileRecords } from '../../db/schema';
import { findObjectTypeByKey, listObjectTypes } from '../../records/object-types';
import { listRecords } from '../../records/query';
import {
  linkRecordsSync,
  listRecordRelationships,
  unlinkRecordsSync
} from '../../records/relationships';
import {
  addRecordNote,
  createRecord,
  getRecordDetail,
  listRecordNotes,
  updateRecord
} from '../../records/service';
import { recordFieldHistory } from '../../records/values';
import { defineNativeTool, type NativeToolHandler, toolSuccess } from '../types';

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

// ---------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------

export const objectTypesListTool = defineNativeTool({
  key: 'objectTypes.list',
  name: 'List object types',
  description:
    'List the workspace Object Types (schemas) and how many records each holds. Use the returned key with records.search.',
  inputSchema: objectSchema({}),
  permission: 'object_type:read',
  async execute(_input: unknown, context) {
    const objectTypes = await listObjectTypes(context.db, context.actor);
    return toolSuccess({ objectTypes });
  }
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const recordsSearchTool = defineNativeTool({
  key: 'records.search',
  name: 'Search records',
  description:
    'Search durable Records of one Object Type by display name or key. Returns record ids for records.get.',
  inputSchema: objectSchema({
    objectTypeKey: stringProp('Object Type key, e.g. business, policy, claim.'),
    objectTypeId: idProp('Object Type id (alternative to objectTypeKey).'),
    search: stringProp('Free-text match on display name or key.'),
    limit: { type: 'number', description: 'Maximum results (1-200).' }
  }),
  permission: 'record:read',
  async execute(
    input: { objectTypeKey?: string; objectTypeId?: string; search?: string; limit?: number },
    context
  ) {
    const objectTypeId =
      input.objectTypeId ??
      (input.objectTypeKey
        ? findObjectTypeByKey(context.db, context.actor.workspaceId, input.objectTypeKey)?.id
        : undefined);
    if (input.objectTypeKey && !objectTypeId) {
      throw errors.notFound('Object type', input.objectTypeKey);
    }
    const page = await listRecords(context.db, {
      workspaceId: context.actor.workspaceId,
      objectTypeId: objectTypeId ?? null,
      search: input.search ?? null,
      limit: input.limit ?? 25
    });
    return toolSuccess({ records: page.rows, total: page.total });
  }
});

export const recordsGetTool = defineNativeTool({
  key: 'records.get',
  name: 'Get a record',
  description:
    'Read one Record: durable fields, external ids and notes. Defaults to the record in scope.',
  inputSchema: objectSchema({ recordId: idProp('Record id. Defaults to the record in scope.') }),
  permission: 'record:read',
  async execute(input: { recordId?: string } | undefined, context) {
    const recordId = resolveRecordId(context, input?.recordId);
    const detail = await getRecordDetail(context.db, context.actor, recordId);
    return toolSuccess({ record: detail });
  }
});

export const recordsCreateTool = defineNativeTool({
  key: 'records.create',
  name: 'Create a record',
  description:
    'Create durable domain data (a Business, Policy, Vehicle, ...). This does NOT start work; use workflowItems.create for that.',
  inputSchema: objectSchema(
    {
      objectTypeKey: stringProp('Object Type key, e.g. policy.'),
      objectTypeId: idProp('Object Type id (alternative to objectTypeKey).'),
      displayName: stringProp('Optional display name; otherwise derived from the primary field.'),
      fields: { type: 'object', description: 'Typed field values keyed by field key.' },
      externalIds: {
        type: 'array',
        description: 'External identities, e.g. [{ system, externalId }].',
        items: { type: 'object' }
      }
    },
    []
  ),
  permission: 'record:create',
  async execute(
    input: {
      objectTypeKey?: string;
      objectTypeId?: string;
      displayName?: string;
      fields?: Record<string, unknown>;
      externalIds?: Array<{ system: string; externalId: string; label?: string }>;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      ['records.create', 'record.create'],
      'create records'
    );
    const record = await createRecord(context.db, context.actor, {
      objectTypeId: input.objectTypeId ?? null,
      objectTypeKey: input.objectTypeKey ?? null,
      displayName: input.displayName ?? null,
      fields: input.fields ?? {},
      externalIds: input.externalIds
    });
    return toolSuccess({
      record: { id: record.id, displayName: record.displayName, key: record.key }
    });
  }
});

export const recordsUpdateTool = defineNativeTool({
  key: 'records.update',
  name: 'Update a record',
  description:
    'Update durable Record field values. Prefer records.setFields when you only change fields.',
  inputSchema: objectSchema(
    {
      recordId: idProp('Record id. Defaults to the record in scope.'),
      displayName: stringProp('Optional new display name.'),
      fields: { type: 'object', description: 'Typed field values keyed by field key.' }
    },
    []
  ),
  permission: 'record:write',
  async execute(
    input: { recordId?: string; displayName?: string; fields?: Record<string, unknown> },
    context
  ) {
    assertNativeCapability(context.actor.permissions, ['records.update'], 'update records');
    const recordId = resolveRecordId(context, input.recordId);
    const result = await updateRecord(context.db, context.actor, {
      recordId,
      displayName: input.displayName ?? null,
      fields: input.fields ?? {},
      runId: context.runId ?? null
    });
    return toolSuccess({ recordId: result.record.id, changes: result.changes });
  }
});

export const recordsGetFieldsTool = defineNativeTool({
  key: 'records.getFields',
  name: 'Get record fields',
  description: 'Read the Record schema and current base field values.',
  inputSchema: objectSchema({ recordId: idProp('Record id. Defaults to the record in scope.') }),
  permission: 'record:read',
  async execute(input: { recordId?: string } | undefined, context) {
    const recordId = resolveRecordId(context, input?.recordId);
    const detail = await getRecordDetail(context.db, context.actor, recordId);
    return toolSuccess({ fields: detail.fields, schema: detail.effectiveFields });
  }
});

export const recordsSetFieldsTool = defineNativeTool({
  key: 'records.setFields',
  name: 'Set record fields',
  description: 'Write several typed Record base fields in one validated call.',
  inputSchema: objectSchema(
    { recordId: idProp('Record id. Defaults to the record in scope.'), values: { type: 'object' } },
    ['values']
  ),
  permission: 'record:write',
  async execute(input: { recordId?: string; values: Record<string, unknown> }, context) {
    assertNativeCapability(
      context.actor.permissions,
      ['records.setFields'],
      'change record fields'
    );
    const recordId = resolveRecordId(context, input.recordId);
    const result = await updateRecord(context.db, context.actor, {
      recordId,
      fields: input.values,
      runId: context.runId ?? null
    });
    return toolSuccess({ changes: result.changes });
  }
});

export const recordsAddNoteTool = defineNativeTool({
  key: 'records.addNote',
  name: 'Add a record note',
  description:
    'Append durable knowledge to the Record (preferences, confirmed facts). For work-specific context use workflowItems.addNote.',
  inputSchema: objectSchema(
    {
      recordId: idProp('Record id. Defaults to the record in scope.'),
      body: stringProp('Note text.')
    },
    ['body']
  ),
  permission: 'record:write',
  async execute(input: { recordId?: string; body: string }, context) {
    assertNativeCapability(context.actor.permissions, ['records.addNote'], 'add record notes');
    const recordId = resolveRecordId(context, input.recordId);
    const note = await addRecordNote(context.db, context.actor, {
      recordId,
      body: input.body,
      runId: context.runId ?? null
    });
    return toolSuccess({ noteId: note.noteId });
  }
});

export const recordsGetHistoryTool = defineNativeTool({
  key: 'records.getHistory',
  name: 'Get record history',
  description: 'Read field-change provenance and notes for a Record.',
  inputSchema: objectSchema({
    recordId: idProp('Record id. Defaults to the record in scope.'),
    limit: { type: 'number' }
  }),
  permission: 'record:read',
  async execute(input: { recordId?: string; limit?: number } | undefined, context) {
    const recordId = resolveRecordId(context, input?.recordId);
    const history = await recordFieldHistory(context.db, context.actor.workspaceId, recordId, {
      limit: input?.limit ?? 100
    });
    const notes = await listRecordNotes(context.db, context.actor, recordId);
    return toolSuccess({ history, notes });
  }
});

export const recordsGetRelatedTool = defineNativeTool({
  key: 'records.getRelated',
  name: 'Get related records',
  description: 'List domain relationships (both directions) for a Record.',
  inputSchema: objectSchema({ recordId: idProp('Record id. Defaults to the record in scope.') }),
  permission: 'record:read',
  async execute(input: { recordId?: string } | undefined, context) {
    const recordId = resolveRecordId(context, input?.recordId);
    const related = await listRecordRelationships(context.db, context.actor, recordId);
    return toolSuccess({ related });
  }
});

export const recordsLinkTool = defineNativeTool({
  key: 'records.link',
  name: 'Link records',
  description: 'Create a domain relationship between two Records.',
  inputSchema: objectSchema(
    {
      fromRecordId: idProp('Source record id. Defaults to the record in scope.'),
      toRecordId: idProp('Target record id.'),
      relationshipKey: stringProp('Relationship definition key, e.g. HAS_POLICY.'),
      note: stringProp('Optional note.')
    },
    ['toRecordId', 'relationshipKey']
  ),
  permission: 'record:write',
  async execute(
    input: { fromRecordId?: string; toRecordId: string; relationshipKey: string; note?: string },
    context
  ) {
    assertNativeCapability(context.actor.permissions, ['records.link'], 'link records');
    const fromRecordId = resolveRecordId(context, input.fromRecordId);
    const relationship = await withTransaction(context.db, (tx) =>
      linkRecordsSync(tx, context.actor, {
        fromRecordId,
        toRecordId: input.toRecordId,
        definitionKey: input.relationshipKey,
        note: input.note ?? null,
        runId: context.runId ?? null
      })
    );
    return toolSuccess({ relationshipId: relationship.id });
  }
});

export const recordsUnlinkTool = defineNativeTool({
  key: 'records.unlink',
  name: 'Unlink records',
  description: 'Remove a domain relationship by id.',
  inputSchema: objectSchema({ relationshipId: idProp('Relationship id.') }, ['relationshipId']),
  permission: 'record:write',
  async execute(input: { relationshipId: string }, context) {
    assertNativeCapability(context.actor.permissions, ['records.unlink'], 'unlink records');
    await withTransaction(context.db, (tx) =>
      unlinkRecordsSync(tx, context.actor, { relationshipId: input.relationshipId })
    );
    return toolSuccess({ removed: true });
  }
});

export const recordsLinkFileTool = defineNativeTool({
  key: 'records.linkFile',
  name: 'Link a file to a record',
  description: 'Durably attach a File to a Record as evidence/knowledge.',
  inputSchema: objectSchema(
    {
      recordId: idProp('Record id. Defaults to the record in scope.'),
      fileId: idProp('File id.'),
      relationship: {
        type: 'string',
        enum: ['attachment', 'reference', 'output', 'evidence', 'source']
      }
    },
    ['fileId']
  ),
  permission: 'record:write',
  async execute(input: { recordId?: string; fileId: string; relationship?: string }, context) {
    assertNativeCapability(
      context.actor.permissions,
      ['records.linkFile', 'files.linkToRecord'],
      'link files to records'
    );
    const recordId = resolveRecordId(context, input.recordId);
    const relationship = input.relationship ?? 'attachment';
    const existing = context.db
      .select({ id: fileRecords.id })
      .from(fileRecords)
      .where(
        and(
          eq(fileRecords.workspaceId, context.actor.workspaceId),
          eq(fileRecords.fileId, input.fileId),
          eq(fileRecords.recordId, recordId),
          eq(fileRecords.relationship, relationship as never)
        )
      )
      .all()[0];
    if (existing) {
      context.db
        .update(fileRecords)
        .set({ removedAt: null })
        .where(eq(fileRecords.id, existing.id))
        .run();
    } else {
      context.db
        .insert(fileRecords)
        .values({
          workspaceId: context.actor.workspaceId,
          fileId: input.fileId,
          recordId,
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

export const recordTools: NativeToolHandler[] = [
  objectTypesListTool,
  recordsSearchTool,
  recordsGetTool,
  recordsCreateTool,
  recordsUpdateTool,
  recordsGetFieldsTool,
  recordsSetFieldsTool,
  recordsAddNoteTool,
  recordsGetHistoryTool,
  recordsGetRelatedTool,
  recordsLinkTool,
  recordsUnlinkTool,
  recordsLinkFileTool
];
