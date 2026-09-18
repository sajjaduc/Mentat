/**
 * Work API (ADR-0021): WorkflowItems and the Records they are about.
 *
 * This is the successor to the removed `/tickets` surface. Everything the board,
 * the work list, the item drawer and the Agent Work surface need is here, and
 * every mutation routes through the workflow-items / records services so the
 * browser cannot do anything an agent or trigger could not — and vice versa.
 *
 * Creation accepts both a `recordId` (start work on existing durable knowledge)
 * and an inline `record` payload (`objectTypeId`/`objectTypeKey` + `fields`), so
 * a Record-first caller and a Work-first caller share one endpoint.
 */
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../../audit/ledger';
import type { ActorContext } from '../../core/context';
import { Permissions } from '../../core/context';
import { errors } from '../../core/errors';
import { uuidv7 } from '../../core/ids';
import type { Executor } from '../../db/client';
import { agentRuns, labels, workflowItemNotes } from '../../db/schema';
import { cancelAgentRunSync } from '../../execution/engine';
import { listRunEvents } from '../../execution/events';
import { listWorkflowFields } from '../../fields/service';
import { fileService, hasFileService } from '../../files/contracts';
import { unlinkFromWorkflowItem } from '../../files/lifecycle';
import { parseFilterAst } from '../../filters/ast';
import { filterWorkflowItems } from '../../filters/compile';
import { dispatchWorkflowItemEntrySync } from '../../workflow-items/dispatch';
import { getWorkflowBoard } from '../../workflow-items/query';
import type { TimelineFilter } from '../../workflow-items/service';
import {
  addWorkflowItemLabelsSync,
  addWorkflowItemNote,
  attachFileToWorkflowItemSync,
  createWorkflowItemSync,
  editWorkflowItemNoteSync,
  getWorkflowItemDetail,
  linkWorkItemsSync,
  myWork,
  previewTransfer,
  removeWorkflowItemLabelSync,
  requestWorkflowItemTransition,
  requireWorkflowItemRow,
  searchWorkflowItems,
  setWorkflowItemFields,
  summarize,
  transferWorkflowItem,
  unlinkWorkItemsSync,
  updateWorkflowItemSync,
  workflowItemFieldChanges,
  workflowItemTimeline
} from '../../workflow-items/service';
import { mutate, queryBool, queryInt, queryString } from '../helpers';
import { route } from '../types';

const prioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const relationshipSchema = z.enum([
  'parent',
  'child',
  'related',
  'duplicate',
  'blocks',
  'blocked_by'
]);
const fileRelationshipSchema = z.enum(['attachment', 'reference', 'output', 'evidence', 'source']);
const fieldValueRecord = z.record(z.string(), z.unknown());

const recordInputSchema = z.object({
  objectTypeId: z.string().nullish(),
  objectTypeKey: z.string().nullish(),
  displayName: z.string().max(500).nullish(),
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
});

function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return undefined;
}

function parseSort(
  value: unknown
): Array<{ field: string; direction: 'asc' | 'desc' }> | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value as Array<{ field: string; direction: 'asc' | 'desc' }>;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? (parsed as Array<{ field: string; direction: 'asc' | 'desc' }>)
        : undefined;
    } catch {
      throw errors.validation('sort must be valid JSON');
    }
  }
  return undefined;
}

/**
 * Soft-delete a work note. Only the author (or a workspace admin) may delete.
 *
 * The service owns note creation/editing; deletion is kept here until the service
 * exposes it, so the endpoint does not disappear in the migration.
 */
function deleteWorkflowItemNoteSync(tx: Executor, actor: ActorContext, noteId: string): void {
  const note = tx
    .select()
    .from(workflowItemNotes)
    .where(
      and(eq(workflowItemNotes.workspaceId, actor.workspaceId), eq(workflowItemNotes.id, noteId))
    )
    .limit(1)
    .all()[0];
  if (!note || note.deletedAt) throw errors.notFound('Work note', noteId);
  const isAuthor = note.authorId !== null && note.authorId === actor.actorId;
  if (!isAuthor && !actor.permissions.has(Permissions.workspaceAdmin)) {
    throw errors.forbidden('Only the author can delete this note');
  }
  const now = Date.now();
  tx.update(workflowItemNotes)
    .set({ deletedAt: now })
    .where(eq(workflowItemNotes.id, noteId))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowItemNoteEdited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow_item',
    entityId: note.workflowItemId,
    workflowItemId: note.workflowItemId,
    runId: actor.runId ?? null,
    summary: 'Work note deleted',
    data: { noteId, deleted: true },
    occurredAt: now
  });
}

export const workflowItemRoutes = [
  // -------------------------------------------------------------------- list
  route({
    method: 'GET',
    path: '/workflow-items',
    permission: Permissions.workflowItemRead,
    summary: 'List or search work items with filter AST, sort and keyset pagination',
    handler: async ({ db, actor, query }) => {
      const options = (query ?? {}) as {
        workflowId?: string;
        recordId?: string;
        stateIds?: unknown;
        ownerUserId?: string;
        waitingOn?: string;
        filter?: unknown;
        sort?: unknown;
        limit?: unknown;
        cursor?: string;
        search?: string;
        includeCompleted?: unknown;
        includeArchived?: unknown;
      };
      const limit = queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 });
      const cursor = options.cursor ?? null;
      const stateIds = asStringList(options.stateIds);
      const filter = parseFilterAst(options.filter ?? null);

      if (filter) {
        const page = await filterWorkflowItems(db, {
          workspaceId: actor.workspaceId,
          filter,
          sort: parseSort(options.sort),
          limit,
          cursor
        });
        return {
          body: {
            items: page.rows,
            rows: page.rows,
            nextCursor: page.nextCursor,
            total: page.rows.length,
            unresolved: page.unresolved
          }
        };
      }

      return {
        body: await searchWorkflowItems(db, actor, {
          workflowId: options.workflowId ?? null,
          recordId: options.recordId ?? null,
          stateIds,
          ownerUserId: options.ownerUserId ?? null,
          waitingOn: options.waitingOn ?? null,
          includeCompleted: queryBool({ query } as never, 'includeCompleted', false),
          includeArchived: queryBool({ query } as never, 'includeArchived', false),
          search: options.search ?? null,
          limit,
          cursor
        })
      };
    }
  }),

  route({
    method: 'GET',
    path: '/workflow-items/board',
    permission: Permissions.workflowItemRead,
    summary: 'Kanban board: workflow states as columns over WorkflowItems',
    handler: async ({ db, actor, query }) => {
      const boardQuery = query as { workflowId?: string; filter?: string } | undefined;
      const workflowId = boardQuery?.workflowId;
      if (!workflowId) {
        return {
          status: 400,
          body: { error: { code: 'validation', message: 'workflowId is required' } }
        };
      }
      // A board filter is the same AST the list and saved views use, so the board
      // narrows through the one shared compiler instead of a second query language.
      let allowedIds: ReadonlySet<string> | null = null;
      const filter = boardQuery?.filter ? parseFilterAst(boardQuery.filter) : null;
      if (filter) {
        const page = await filterWorkflowItems(db, {
          workspaceId: actor.workspaceId,
          filter,
          limit: 200
        } as never);
        allowedIds = new Set(page.rows.map((row) => row.id));
      }
      return {
        body: await getWorkflowBoard(db, {
          workspaceId: actor.workspaceId,
          workflowId,
          allowedIds,
          perColumnLimit: queryInt({ query } as never, 'limit', 100, { min: 1, max: 500 })
        })
      };
    }
  }),

  // ------------------------------------------------------------------ create
  route({
    method: 'POST',
    path: '/workflow-items',
    permission: Permissions.workflowItemCreate,
    summary:
      'Start work: put a Record into a Workflow (existing recordId or inline objectTypeId/key + fields)',
    body: z.object({
      workflowId: z.string().min(1),
      recordId: z.string().nullish(),
      record: recordInputSchema.nullish(),
      /** Flat records-friendly alternative to `record` (ADR-0021). */
      objectTypeId: z.string().nullish(),
      objectTypeKey: z.string().nullish(),
      displayName: z.string().max(500).nullish(),
      title: z.string().max(500).nullish(),
      stateId: z.string().nullish(),
      ownerUserId: z.string().nullish(),
      ownerTeamId: z.string().nullish(),
      fields: fieldValueRecord.optional(),
      structuredData: fieldValueRecord.optional(),
      labelIds: z.array(z.string()).optional(),
      labelNames: z.array(z.string()).optional(),
      fileIds: z.array(z.string()).optional(),
      parentWorkflowItemId: z.string().nullish(),
      participation: z.enum(['primary', 'additional', 'transferred']).optional(),
      provenance: z.record(z.string(), z.unknown()).nullish(),
      reason: z.string().max(2000).nullish()
    }),
    handler: ({ db, actor, body }) =>
      mutate(db, (tx) => {
        const inlineRecord =
          body.record ??
          (body.objectTypeId || body.objectTypeKey
            ? {
                objectTypeId: body.objectTypeId ?? null,
                objectTypeKey: body.objectTypeKey ?? null,
                displayName: body.displayName ?? body.title ?? null,
                fields: body.fields ?? {}
              }
            : null);
        const item = createWorkflowItemSync(tx, actor, {
          workflowId: body.workflowId,
          recordId: body.recordId ?? null,
          record: inlineRecord as never,
          stateId: body.stateId ?? null,
          ownerUserId: body.ownerUserId ?? null,
          ownerTeamId: body.ownerTeamId ?? null,
          fields: body.fields ?? {},
          structuredData: body.structuredData,
          participation: body.participation,
          provenance: (body.provenance ?? null) as never,
          reason: body.reason ?? null
        });
        if (body.labelIds || body.labelNames) {
          addWorkflowItemLabelsSync(tx, actor, {
            workflowItemId: item.id,
            labelIds: body.labelIds,
            labelNames: body.labelNames
          });
        }
        for (const fileId of body.fileIds ?? []) {
          attachFileToWorkflowItemSync(tx, actor, {
            workflowItemId: item.id,
            fileId,
            relationship: 'attachment'
          });
        }
        if (body.parentWorkflowItemId) {
          linkWorkItemsSync(tx, actor, {
            fromWorkflowItemId: item.id,
            toWorkflowItemId: body.parentWorkflowItemId,
            type: 'parent',
            note: 'Created from the work API'
          });
        }
        return { status: 201, body: { workflowItem: summarize(tx, item) } };
      })
  }),

  // ------------------------------------------------- records-first work start
  route({
    method: 'POST',
    path: '/records/:id/work',
    permission: Permissions.workflowItemCreate,
    summary: 'Start work on an existing Record (records-first entry point)',
    body: z.object({
      workflowId: z.string().min(1),
      stateId: z.string().nullish(),
      ownerUserId: z.string().nullish(),
      ownerTeamId: z.string().nullish(),
      fields: fieldValueRecord.optional(),
      structuredData: fieldValueRecord.optional(),
      labelIds: z.array(z.string()).optional(),
      labelNames: z.array(z.string()).optional(),
      participation: z.enum(['primary', 'additional', 'transferred']).optional(),
      reason: z.string().max(2000).nullish()
    }),
    handler: ({ db, actor, params, body }) =>
      mutate(db, (tx) => {
        const item = createWorkflowItemSync(tx, actor, {
          workflowId: body.workflowId,
          recordId: params.id as string,
          stateId: body.stateId ?? null,
          ownerUserId: body.ownerUserId ?? null,
          ownerTeamId: body.ownerTeamId ?? null,
          fields: body.fields ?? {},
          structuredData: body.structuredData,
          participation: body.participation,
          reason: body.reason ?? null
        });
        if (body.labelIds || body.labelNames) {
          addWorkflowItemLabelsSync(tx, actor, {
            workflowItemId: item.id,
            labelIds: body.labelIds,
            labelNames: body.labelNames
          });
        }
        return { status: 201, body: { workflowItem: summarize(tx, item) } };
      })
  }),

  // ------------------------------------------------------------------ read
  route({
    method: 'GET',
    path: '/workflow-items/:id',
    permission: Permissions.workflowItemRead,
    summary: 'Work item detail: Record, state, fields, transitions, notes, history and files',
    handler: async ({ db, actor, params }) => {
      const detail = await getWorkflowItemDetail(db, actor, params.id as string);
      const files = hasFileService()
        ? await fileService().listForWorkflowItem(actor, params.id as string, db)
        : [];
      return { body: { ...detail, files } };
    }
  }),

  route({
    method: 'PATCH',
    path: '/workflow-items/:id',
    permission: Permissions.workflowItemWrite,
    summary: 'Update ownership, due dates, Record display name and field values',
    body: z.object({
      title: z.string().trim().min(1).max(500).optional(),
      displayName: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(20_000).nullish(),
      priority: prioritySchema.optional(),
      ownerUserId: z.string().nullish(),
      ownerTeamId: z.string().nullish(),
      dueAt: z.number().int().nullish(),
      slaDueAt: z.number().int().nullish(),
      fields: fieldValueRecord.optional(),
      structuredData: fieldValueRecord.nullish(),
      expectedVersion: z.number().int().optional()
    }),
    handler: ({ db, actor, params, body }) =>
      mutate(db, (tx) => ({
        body: {
          workflowItem: summarize(
            tx,
            updateWorkflowItemSync(tx, actor, {
              workflowItemId: params.id as string,
              ...(body as object)
            } as never)
          )
        }
      }))
  }),

  // ----------------------------------------------------------------- fields
  route({
    method: 'GET',
    path: '/workflow-items/:id/fields',
    permission: Permissions.workflowItemRead,
    summary: 'Field values plus the workflow’s field configuration',
    handler: async ({ db, actor, params }) => {
      const detail = await getWorkflowItemDetail(db, actor, params.id as string);
      return {
        body: {
          fields: detail.fields,
          config: listWorkflowFields(db, actor, detail.workflowId).map((view) => ({
            key: view.definition.key,
            name: view.definition.name,
            type: view.definition.type,
            required: view.required,
            editable: view.editable,
            visible: view.visible,
            showOnCard: view.showOnCard,
            showInList: view.showInList,
            requiredInStates: view.requiredInStates,
            options: view.definition.options
          }))
        }
      };
    }
  }),

  route({
    method: 'PUT',
    path: '/workflow-items/:id/fields',
    permission: Permissions.workflowItemWrite,
    summary: 'Set base and/or workflow-overlay field values with validation and history',
    body: z.object({ values: fieldValueRecord }),
    handler: async ({ db, actor, params, body }) => ({
      body: await setWorkflowItemFields(db, actor, {
        workflowItemId: params.id as string,
        values: body.values
      })
    })
  }),

  route({
    method: 'GET',
    path: '/workflow-items/:id/field-history',
    permission: Permissions.workflowItemRead,
    summary: 'Append-only base + overlay field change history',
    handler: async ({ db, actor, params }) => ({
      body: {
        history: await workflowItemFieldChanges(db, actor, params.id as string)
      }
    })
  }),

  route({
    method: 'GET',
    path: '/workflow-items/:id/file-values',
    permission: Permissions.workflowItemRead,
    summary: 'Typed field values only (used by the optimistic field editor)',
    handler: async ({ db, actor, params }) => {
      const detail = await getWorkflowItemDetail(db, actor, params.id as string);
      return { body: { fields: detail.fields } };
    }
  }),

  // ------------------------------------------------------------------ notes
  route({
    method: 'POST',
    path: '/workflow-items/:id/notes',
    permission: Permissions.workflowItemWrite,
    summary: 'Add a note to the work journal',
    body: z.object({ body: z.string().trim().min(1).max(20_000) }),
    handler: async ({ db, actor, params, body }) => ({
      status: 201,
      body: {
        note: await addWorkflowItemNote(db, actor, {
          workflowItemId: params.id as string,
          body: body.body
        })
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/notes/:id',
    permission: Permissions.workflowItemWrite,
    summary: 'Edit a note, retaining the previous revision',
    body: z.object({ body: z.string().trim().min(1).max(20_000) }),
    handler: ({ db, actor, params, body }) => {
      mutate(db, (tx) =>
        editWorkflowItemNoteSync(tx, actor, {
          noteId: params.id as string,
          body: body.body
        })
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/notes/:id',
    permission: Permissions.workflowItemWrite,
    summary: 'Delete a note (soft delete, audited)',
    handler: ({ db, actor, params }) => {
      mutate(db, (tx) => deleteWorkflowItemNoteSync(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------ transitions
  route({
    method: 'POST',
    path: '/workflow-items/:id/transitions',
    permission: Permissions.workflowItemWrite,
    summary: 'Request a state transition; human gates are enforced here',
    body: z.object({
      transitionId: z.string().nullish(),
      targetStateId: z.string().nullish(),
      comment: z.string().max(20_000).nullish(),
      fieldValues: fieldValueRecord.optional()
    }),
    handler: async ({ db, actor, params, body }) => ({
      body: await requestWorkflowItemTransition(db, actor, {
        workflowItemId: params.id as string,
        transitionId: body.transitionId ?? null,
        targetStateId: body.targetStateId ?? null,
        comment: body.comment ?? null,
        fieldValues: body.fieldValues ?? {}
      })
    })
  }),

  route({
    method: 'POST',
    path: '/workflow-items/:id/transfer-preview',
    permission: Permissions.workflowItemTransfer,
    summary: 'Preview a cross-workflow move: policy, mappings and missing fields',
    body: z.object({ targetWorkflowId: z.string().min(1) }),
    handler: ({ db, actor, params, body }) => ({
      body: previewTransfer(db, actor, {
        workflowItemId: params.id as string,
        targetWorkflowId: body.targetWorkflowId
      })
    })
  }),

  route({
    method: 'POST',
    path: '/workflow-items/:id/transfer',
    permission: Permissions.workflowItemTransfer,
    summary: 'Move the work to another workflow, preserving Record identity and lineage',
    body: z.object({
      targetWorkflowId: z.string().min(1),
      targetStateId: z.string().nullish(),
      reason: z.string().max(2000).nullish(),
      fieldMappings: z.record(z.string(), z.string()).optional()
    }),
    handler: async ({ db, actor, params, body }) => ({
      body: await transferWorkflowItem(db, actor, {
        workflowItemId: params.id as string,
        targetWorkflowId: body.targetWorkflowId,
        targetStateId: body.targetStateId ?? null,
        reason: body.reason ?? null,
        fieldMappings: body.fieldMappings ?? null
      })
    })
  }),

  route({
    method: 'POST',
    path: '/workflow-items/:id/participation',
    permission: Permissions.workflowItemCreate,
    summary: 'Add the same Record to another Workflow while this work stays active',
    body: z.object({
      workflowId: z.string().min(1),
      stateId: z.string().nullish(),
      fields: fieldValueRecord.optional()
    }),
    handler: ({ db, actor, params, body }) =>
      mutate(db, (tx) => {
        const current = requireWorkflowItemRow(tx, actor.workspaceId, params.id as string);
        const item = createWorkflowItemSync(tx, actor, {
          workflowId: body.workflowId,
          recordId: current.recordId,
          stateId: body.stateId ?? null,
          fields: body.fields ?? {},
          participation: 'additional'
        });
        return { status: 201, body: { workflowItem: summarize(tx, item) } };
      })
  }),

  // ---------------------------------------------------------- relationships
  route({
    method: 'POST',
    path: '/workflow-items/:id/relationships',
    permission: Permissions.workflowItemWrite,
    summary: 'Link two work items (parent/child/related/duplicate/blocks)',
    body: z.object({
      toWorkflowItemId: z.string().min(1),
      type: relationshipSchema,
      note: z.string().max(2000).nullish()
    }),
    handler: ({ db, actor, params, body }) => {
      mutate(db, (tx) =>
        linkWorkItemsSync(tx, actor, {
          fromWorkflowItemId: params.id as string,
          toWorkflowItemId: body.toWorkflowItemId,
          type: body.type,
          note: body.note ?? null
        })
      );
      return { status: 201, body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/relationships/:id',
    permission: Permissions.workflowItemWrite,
    summary: 'Remove a work relationship',
    handler: ({ db, actor, params }) => {
      mutate(db, (tx) => unlinkWorkItemsSync(tx, actor, { relationshipId: params.id as string }));
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------------ files
  route({
    method: 'POST',
    path: '/workflow-items/:id/files',
    permission: Permissions.workflowItemWrite,
    summary: 'Link an existing file to this work item',
    body: z.object({
      fileId: z.string().min(1),
      relationship: fileRelationshipSchema.optional(),
      caption: z.string().max(500).nullish()
    }),
    handler: ({ db, actor, params, body }) => {
      mutate(db, (tx) =>
        attachFileToWorkflowItemSync(tx, actor, {
          workflowItemId: params.id as string,
          fileId: body.fileId,
          relationship: body.relationship ?? 'attachment',
          caption: body.caption ?? null
        })
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/workflow-items/:id/files/:fileId',
    permission: Permissions.workflowItemWrite,
    summary: 'Unlink a file from this work item without deleting the file',
    handler: async ({ db, actor, params }) => {
      await unlinkFromWorkflowItem(
        actor,
        {
          workflowItemId: params.id as string,
          fileId: params.fileId as string
        },
        db
      );
      return { status: 204 };
    }
  }),

  // ----------------------------------------------------------------- labels
  route({
    method: 'GET',
    path: '/labels',
    permission: Permissions.workflowItemRead,
    summary: 'Workspace labels',
    handler: ({ db, actor }) => ({
      body: {
        labels: db
          .select()
          .from(labels)
          .where(eq(labels.workspaceId, actor.workspaceId))
          .orderBy(asc(labels.name))
          .all()
      }
    })
  }),

  route({
    method: 'POST',
    path: '/labels',
    permission: Permissions.workflowItemWrite,
    summary: 'Create a label',
    body: z.object({
      name: z.string().trim().min(1).max(60),
      color: z.string().max(40).nullish(),
      description: z.string().max(500).nullish()
    }),
    handler: ({ db, actor, body }) => {
      const existing = db
        .select()
        .from(labels)
        .where(and(eq(labels.workspaceId, actor.workspaceId), eq(labels.name, body.name)))
        .limit(1)
        .all()[0];
      if (existing) return { body: { label: existing } };
      const now = Date.now();
      const row = db
        .insert(labels)
        .values({
          id: uuidv7(now),
          workspaceId: actor.workspaceId,
          name: body.name,
          color: body.color ?? null,
          description: body.description ?? null,
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .all()[0];
      return { status: 201, body: { label: row } };
    }
  }),

  route({
    method: 'POST',
    path: '/workflow-items/:id/labels',
    permission: Permissions.workflowItemWrite,
    summary: 'Add labels to a work item',
    body: z.object({
      labelIds: z.array(z.string()).optional(),
      labelNames: z.array(z.string()).optional()
    }),
    handler: ({ db, actor, params, body }) => {
      mutate(db, (tx) =>
        addWorkflowItemLabelsSync(tx, actor, {
          workflowItemId: params.id as string,
          labelIds: body.labelIds,
          labelNames: body.labelNames
        })
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/workflow-items/:id/labels/:labelId',
    permission: Permissions.workflowItemWrite,
    summary: 'Remove a label from a work item',
    handler: ({ db, actor, params }) => {
      mutate(db, (tx) =>
        removeWorkflowItemLabelSync(tx, actor, {
          workflowItemId: params.id as string,
          labelId: params.labelId as string
        })
      );
      return { status: 204 };
    }
  }),

  // -------------------------------------------------------------- execution
  route({
    method: 'POST',
    path: '/workflow-items/:id/dispatch',
    permission: Permissions.runExecute,
    summary: 'Run the current (or a specified) state now',
    body: z.object({
      stateId: z.string().nullish(),
      reason: z.string().max(500).nullish(),
      force: z.boolean().optional()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: dispatchWorkflowItemEntrySync(db, actor, {
        workflowItemId: params.id as string,
        stateId: body.stateId ?? null,
        reason: body.reason ?? null,
        force: body.force ?? false
      })
    })
  }),

  route({
    method: 'GET',
    path: '/workflow-items/:id/runs',
    permission: Permissions.runRead,
    summary: 'Agent runs for a work item, oldest first',
    handler: async ({ db, actor, params }) => {
      requireWorkflowItemRow(db, actor.workspaceId, params.id as string);
      const runs = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.workspaceId, actor.workspaceId),
            eq(agentRuns.workflowItemId, params.id as string)
          )
        )
        .orderBy(asc(agentRuns.createdAt))
        .limit(50)
        .all();
      return { body: { runs } };
    }
  }),

  route({
    method: 'POST',
    path: '/runs/:id/cancel',
    permission: Permissions.runCancel,
    summary: 'Cancel a run and its pending approvals',
    handler: ({ db, actor, params }) => {
      mutate(db, (tx) => cancelAgentRunSync(tx, actor, params.id as string));
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'GET',
    path: '/workflow-items/:id/timeline',
    permission: Permissions.workflowItemRead,
    summary: 'One coherent chronological work history, with filters',
    handler: async ({ db, actor, params, query }) => {
      const filter = (queryString({ query } as never, 'filter') ?? 'all') as TimelineFilter;
      const limit = queryInt({ query } as never, 'limit', 200, { min: 1, max: 500 });
      return {
        body: {
          events: await workflowItemTimeline(db, actor, params.id as string, { limit, filter })
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/workflow-items/:id/events',
    permission: Permissions.workflowItemRead,
    summary: 'Work-item-scoped run events for live-updating the drawer',
    handler: async ({ db, actor, params, query }) => {
      requireWorkflowItemRow(db, actor.workspaceId, params.id as string);
      const since = queryInt({ query } as never, 'since', 0);
      return {
        body: {
          events: await listRunEvents(db, {
            workspaceId: actor.workspaceId,
            workflowItemId: params.id as string,
            since
          })
        }
      };
    }
  }),

  // --------------------------------------------------------------- work views
  route({
    method: 'GET',
    path: '/my-work',
    permission: Permissions.workflowItemRead,
    summary: 'Assigned, waiting for me, waiting for agent, waiting for approval, needs attention',
    handler: async ({ db, actor, query }) => ({
      body: await myWork(db, actor, {
        limit: queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 })
      })
    })
  }),

  route({
    method: 'GET',
    path: '/search',
    permission: Permissions.workflowItemRead,
    summary: 'Command palette search across work items, workflows and files',
    handler: async ({ db, actor, query, request }) => {
      const term =
        queryString({ query } as never, 'q') ?? new URL(request.url).searchParams.get('q');
      if (!term || term.trim().length < 2) return { body: { results: [] } };
      const limit = queryInt({ query } as never, 'limit', 8, { min: 1, max: 25 });
      const page = await searchWorkflowItems(db, actor, { search: term, limit });
      const results = page.items.map((row) => ({
        kind: 'workflowItem',
        id: row.id,
        key: row.recordKey,
        title: row.recordDisplayName,
        subtitle: row.stateName,
        href: `/work-items/${row.id}`
      }));
      return { body: { results, total: page.total } };
    }
  })
];
