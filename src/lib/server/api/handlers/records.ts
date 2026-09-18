/**
 * Universal-model API (ADR-0021): Object Types and Records.
 *
 * Mutations route through the same services the agent tools use, so the browser
 * cannot do anything an agent could not — and vice versa. Work itself (starting,
 * transitioning, notes, files, transfer) is served by
 * `handlers/workflow-items.ts`.
 */
import { z } from 'zod';
import { Permissions } from '../../core/context';
import {
  archiveObjectType,
  createObjectType,
  findObjectTypeByKey,
  listBaseFields,
  listObjectTypes,
  setBaseFields,
  setObjectTypeZodSchema,
  updateObjectType
} from '../../records/object-types';
import { listRecords } from '../../records/query';
import {
  linkRecordsSync,
  listRecordRelationships,
  unlinkRecordsSync
} from '../../records/relationships';
import {
  addRecordNote,
  archiveRecord,
  createRecord,
  getRecordDetail,
  listRecordFiles,
  listRecordNotes,
  requireRecordRow,
  updateRecord
} from '../../records/service';
import { recordFieldHistory } from '../../records/values';
import { mutate } from '../helpers';
import { route } from '../types';

const fieldValueRecord = z.record(z.string(), z.unknown());

export const recordRoutes = [
  // ---- Object Types -------------------------------------------------------
  route({
    method: 'GET',
    path: '/object-types',
    permission: Permissions.objectTypeRead,
    summary: 'List the workspace Object Types with field and record counts',
    handler: async ({ db, actor }) => ({ body: { objectTypes: await listObjectTypes(db, actor) } })
  }),
  route({
    method: 'POST',
    path: '/object-types',
    permission: Permissions.objectTypeAdmin,
    summary: 'Define a new Object Type',
    body: z.object({
      key: z.string().trim().min(2).max(48).nullish(),
      name: z.string().trim().min(1).max(120),
      pluralName: z.string().trim().max(120).nullish(),
      description: z.string().max(2000).nullish(),
      icon: z.string().max(64).nullish(),
      color: z.string().max(32).nullish(),
      settings: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: { objectType: createObjectType(db, actor, body) }
    })
  }),
  route({
    method: 'PATCH',
    path: '/object-types/:id',
    permission: Permissions.objectTypeAdmin,
    summary: 'Update an Object Type',
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      pluralName: z.string().trim().max(120).optional(),
      description: z.string().max(2000).nullish(),
      icon: z.string().max(64).nullish(),
      color: z.string().max(32).nullish(),
      settings: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: ({ db, actor, body, params }) => ({
      body: {
        objectType: updateObjectType(db, actor, { ...body, objectTypeId: params.id as string })
      }
    })
  }),
  route({
    method: 'POST',
    path: '/object-types/:id/archive',
    permission: Permissions.objectTypeAdmin,
    summary: 'Archive an unused Object Type',
    handler: ({ db, actor, params }) => {
      archiveObjectType(db, actor, params.id as string);
      return { body: { archived: true } };
    }
  }),
  route({
    method: 'GET',
    path: '/object-types/:id/fields',
    permission: Permissions.objectTypeRead,
    summary: 'List the base field schema of an Object Type',
    handler: async ({ db, actor, params }) => ({
      body: { fields: await listBaseFields(db, actor.workspaceId, params.id as string) }
    })
  }),
  route({
    method: 'PUT',
    path: '/object-types/:id/fields',
    permission: Permissions.objectTypeAdmin,
    summary: 'Replace the base field schema of an Object Type',
    body: z.object({ fields: z.array(z.record(z.string(), z.unknown())) }),
    handler: async ({ db, actor, body, params }) => ({
      body: {
        fields: await setBaseFields(db, actor, params.id as string, body.fields as never)
      }
    })
  }),
  route({
    method: 'PUT',
    path: '/object-types/:id/zod-schema',
    permission: Permissions.objectTypeAdmin,
    summary: 'Author an Object Type schema as Zod source (ADR-0023)',
    body: z.object({ source: z.string().min(1).max(20_000) }),
    handler: async ({ db, actor, body, params }) => ({
      body: await setObjectTypeZodSchema(db, actor, params.id as string, body.source)
    })
  }),

  // ---- Records ------------------------------------------------------------
  route({
    method: 'GET',
    path: '/records',
    permission: Permissions.recordRead,
    summary: 'List or search Records with structured filters',
    handler: async ({ db, actor, query }) => {
      const options = (query ?? {}) as {
        objectTypeId?: string;
        objectTypeKey?: string;
        search?: string;
        limit?: number;
        cursor?: string;
        includeArchived?: boolean;
      };
      const objectTypeId =
        options.objectTypeId ??
        (options.objectTypeKey
          ? findObjectTypeByKey(db, actor.workspaceId, options.objectTypeKey)?.id
          : null);
      return {
        body: await listRecords(db, {
          workspaceId: actor.workspaceId,
          objectTypeId,
          search: options.search ?? null,
          limit: options.limit ?? 50,
          cursor: options.cursor ?? null,
          includeArchived: options.includeArchived === true
        })
      };
    }
  }),
  route({
    method: 'POST',
    path: '/records',
    permission: Permissions.recordCreate,
    summary: 'Create a durable Record. Does not start work.',
    body: z.object({
      objectTypeId: z.string().nullish(),
      objectTypeKey: z.string().nullish(),
      displayName: z.string().trim().max(500).nullish(),
      fields: fieldValueRecord.optional(),
      structuredData: fieldValueRecord.optional(),
      externalIds: z
        .array(
          z.object({
            system: z.string().trim().min(1),
            externalId: z.string().trim().min(1),
            label: z.string().nullish(),
            url: z.string().nullish()
          })
        )
        .optional()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { record: await createRecord(db, actor, body) }
    })
  }),
  route({
    method: 'GET',
    path: '/records/:id',
    permission: Permissions.recordRead,
    summary: 'Full Record detail: fields, external ids and notes',
    handler: async ({ db, actor, params }) => ({
      body: await getRecordDetail(db, actor, params.id as string)
    })
  }),
  route({
    method: 'PATCH',
    path: '/records/:id',
    permission: Permissions.recordWrite,
    summary: 'Update Record fields/display name',
    body: z.object({
      displayName: z.string().trim().max(500).nullish(),
      fields: fieldValueRecord.optional(),
      structuredData: fieldValueRecord.optional(),
      expectedVersion: z.number().int().positive().nullish()
    }),
    handler: async ({ db, actor, body, params }) => ({
      body: await updateRecord(db, actor, {
        recordId: params.id as string,
        displayName: body.displayName ?? null,
        fields: body.fields,
        structuredData: body.structuredData,
        expectedVersion: body.expectedVersion ?? null
      })
    })
  }),
  route({
    method: 'POST',
    path: '/records/:id/archive',
    permission: Permissions.recordDelete,
    summary: 'Archive a Record without destroying history',
    handler: async ({ db, actor, params }) => {
      await archiveRecord(db, actor, params.id as string);
      return { body: { archived: true } };
    }
  }),
  route({
    method: 'GET',
    path: '/records/:id/history',
    permission: Permissions.recordRead,
    summary: 'Record field-change provenance',
    handler: async ({ db, actor, params }) => {
      requireRecordRow(db, actor.workspaceId, params.id as string);
      return {
        body: {
          history: await recordFieldHistory(db, actor.workspaceId, params.id as string, {
            limit: 200
          })
        }
      };
    }
  }),
  route({
    method: 'GET',
    path: '/records/:id/files',
    permission: Permissions.recordRead,
    summary: 'Durable File links for a Record',
    handler: async ({ db, actor, params }) => ({
      body: { files: await listRecordFiles(db, actor, params.id as string) }
    })
  }),
  route({
    method: 'GET',
    path: '/records/:id/notes',
    permission: Permissions.recordRead,
    summary: 'Durable notes about a Record',
    handler: async ({ db, actor, params }) => ({
      body: { notes: await listRecordNotes(db, actor, params.id as string) }
    })
  }),
  route({
    method: 'POST',
    path: '/records/:id/notes',
    permission: Permissions.recordWrite,
    summary: 'Add a durable Record note',
    body: z.object({ body: z.string().trim().min(1).max(20_000) }),
    handler: async ({ db, actor, body, params }) => ({
      status: 201,
      body: await addRecordNote(db, actor, { recordId: params.id as string, body: body.body })
    })
  }),
  route({
    method: 'GET',
    path: '/records/:id/related',
    permission: Permissions.recordRead,
    summary: 'Domain relationships for a Record (both directions)',
    handler: async ({ db, actor, params }) => ({
      body: { related: await listRecordRelationships(db, actor, params.id as string) }
    })
  }),
  route({
    method: 'POST',
    path: '/records/:id/related',
    permission: Permissions.recordWrite,
    summary: 'Link two Records through a relationship definition',
    body: z.object({
      toRecordId: z.string().min(1),
      relationshipKey: z.string().min(1),
      note: z.string().max(2000).nullish()
    }),
    handler: ({ db, actor, body, params }) => ({
      status: 201,
      body: mutate(db, (tx) =>
        linkRecordsSync(tx, actor, {
          fromRecordId: params.id as string,
          toRecordId: body.toRecordId,
          definitionKey: body.relationshipKey,
          note: body.note ?? null
        })
      )
    })
  }),
  route({
    method: 'DELETE',
    path: '/records/:id/related/:relationshipId',
    permission: Permissions.recordWrite,
    summary: 'Remove a domain relationship',
    handler: ({ db, actor, params }) => {
      mutate(db, (tx) =>
        unlinkRecordsSync(tx, actor, { relationshipId: params.relationshipId as string })
      );
      return { body: { removed: true } };
    }
  })
];
