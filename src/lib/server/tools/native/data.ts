/**
 * Native structured-data tools (`mentat.data.*`).
 *
 * Thin, validated wrappers over `src/lib/server/collections`. The model addresses a
 * collection by id; `mentat.data.insert` with an `externalKey` is idempotent, and
 * every mutation is audited as `collection.record.changed` by the service inside the
 * same transaction. Deletes are soft and idempotent, and additionally declare a
 * conditional approval policy so the runner can require a human decision for a
 * destructive call (ADR-0019: enforcement is Mentat's, not the model's).
 */
import { z } from 'zod';
import { recordFilterConditionSchema, recordSortSchema } from '../../collections/filter';
import {
  type CollectionRecordView,
  deleteRecord,
  findRecords,
  getRecord,
  insertRecord,
  updateRecord
} from '../../collections/service';
import { assertPermission, Permissions } from '../../core/context';
import { defineNativeTool, toolSuccess } from '../types';
import { inputJsonSchema, outputJsonSchema, parseToolInput } from './schema';

const recordDataSchema = z.record(z.string(), z.unknown());

const recordSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  externalKey: z.string().nullable(),
  data: recordDataSchema,
  searchText: z.string(),
  version: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable()
});

const getInput = z.object({ recordId: z.string().min(1) });
const getOutput = z.object({ record: recordSchema });

const findInput = z.object({
  collectionId: z.string().min(1),
  filter: z.array(recordFilterConditionSchema).max(50).optional(),
  sort: z.array(recordSortSchema).min(1).max(5).optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).optional()
});
const findOutput = z.object({
  records: z.array(recordSchema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean()
});

const insertInput = z.object({
  collectionId: z.string().min(1),
  data: recordDataSchema,
  externalKey: z.string().min(1).optional()
});
const insertOutput = z.object({ record: recordSchema });

const updateInput = z.object({
  recordId: z.string().min(1),
  data: recordDataSchema,
  expectedVersion: z.number().int().positive().optional(),
  replace: z.boolean().optional()
});
const updateOutput = z.object({ record: recordSchema });

const deleteInput = z.object({ recordId: z.string().min(1) });
const deleteOutput = z.object({ id: z.string(), deleted: z.boolean() });

export const dataGetTool = defineNativeTool({
  key: 'mentat.data.get',
  name: 'Get collection record',
  description:
    'Read one structured collection record by id. Returns not_found for a record in another ' +
    'workspace so probing cannot confirm existence. Idempotent.',
  inputSchema: inputJsonSchema(getInput),
  outputSchema: outputJsonSchema(getOutput),
  permission: Permissions.dataRead,
  async execute(input, context) {
    const parsed = parseToolInput(getInput, input);
    assertPermission(context.actor, Permissions.dataRead, 'Not permitted to read records');
    const record = getRecord(context.db, context.actor, parsed.recordId);
    return toolSuccess({ record: record as CollectionRecordView });
  }
});

export const dataFindTool = defineNativeTool({
  key: 'mentat.data.find',
  name: 'Find collection records',
  description:
    'Find records in a collection with a flat AND filter over JSON fields (eq, neq, gt, gte, ' +
    'lt, lte, contains, starts_with, ends_with, in, is_empty, is_not_empty), optional sort and ' +
    'cursor pagination. Read-only and idempotent.',
  inputSchema: inputJsonSchema(findInput),
  outputSchema: outputJsonSchema(findOutput),
  permission: Permissions.dataRead,
  async execute(input, context) {
    const parsed = parseToolInput(findInput, input);
    assertPermission(context.actor, Permissions.dataRead, 'Not permitted to read records');
    const result = findRecords(context.db, context.actor, {
      collectionId: parsed.collectionId,
      filter: parsed.filter,
      sort: parsed.sort,
      limit: parsed.limit,
      cursor: parsed.cursor
    });
    return toolSuccess({
      records: result.records,
      nextCursor: result.nextCursor,
      truncated: result.truncated
    });
  }
});

export const dataInsertTool = defineNativeTool({
  key: 'mentat.data.insert',
  name: 'Insert collection record',
  description:
    'Insert a record into a collection. Passing an externalKey makes the call idempotent: a ' +
    'live record with that key is a conflict, while a soft-deleted one is revived. Without an ' +
    'externalKey, repeated calls create independent records.',
  inputSchema: inputJsonSchema(insertInput),
  outputSchema: outputJsonSchema(insertOutput),
  permission: Permissions.dataWrite,
  async execute(input, context) {
    const parsed = parseToolInput(insertInput, input);
    assertPermission(context.actor, Permissions.dataWrite, 'Not permitted to insert records');
    const record = await insertRecord(context.db, context.actor, {
      collectionId: parsed.collectionId,
      data: parsed.data,
      externalKey: parsed.externalKey
    });
    return toolSuccess({ record });
  }
});

export const dataUpdateTool = defineNativeTool({
  key: 'mentat.data.update',
  name: 'Update collection record',
  description:
    'Merge a patch into a record (or replace it entirely with replace=true). Pass ' +
    'expectedVersion to fail with version_conflict when another writer changed the record ' +
    'first. Idempotent for a fixed patch and version.',
  inputSchema: inputJsonSchema(updateInput),
  outputSchema: outputJsonSchema(updateOutput),
  permission: Permissions.dataWrite,
  async execute(input, context) {
    const parsed = parseToolInput(updateInput, input);
    assertPermission(context.actor, Permissions.dataWrite, 'Not permitted to update records');
    const record = await updateRecord(context.db, context.actor, {
      recordId: parsed.recordId,
      data: parsed.data,
      expectedVersion: parsed.expectedVersion,
      replace: parsed.replace
    });
    return toolSuccess({ record });
  }
});

export const dataDeleteTool = defineNativeTool({
  key: 'mentat.data.delete',
  name: 'Delete collection record',
  description:
    'Soft-delete a record. Idempotent: a second call returns deleted=false. The call is ' +
    'destructive, so it declares a conditional approval policy the runner evaluates without ' +
    'asking the model.',
  inputSchema: inputJsonSchema(deleteInput),
  outputSchema: outputJsonSchema(deleteOutput),
  permission: Permissions.dataWrite,
  approvalPolicy: {
    mode: 'conditional',
    condition: 'destructive',
    reason: 'Deleting a collection record is destructive and may require approval'
  },
  async execute(input, context) {
    const parsed = parseToolInput(deleteInput, input);
    // Narrower defensive check: a delete must never run on a caller that merely
    // reached this handler without the write grant.
    assertPermission(context.actor, Permissions.dataWrite, 'Not permitted to delete records');
    const result = await deleteRecord(context.db, context.actor, { recordId: parsed.recordId });
    return toolSuccess(result);
  }
});

export const dataTools = [
  dataGetTool,
  dataFindTool,
  dataInsertTool,
  dataUpdateTool,
  dataDeleteTool
];

/** Guard used by the index test to keep the documented surface honest. */
export function dataToolKeys(): string[] {
  return dataTools.map((tool) => tool.key).sort();
}
