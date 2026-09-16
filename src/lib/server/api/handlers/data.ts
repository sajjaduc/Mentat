/**
 * Files, approvals, saved views, dashboards, collections, agent state, cache,
 * secrets, environment, overrides and operational views.
 *
 * These are grouped in one module because they are all "read the workspace's
 * configuration and derived data" surfaces with small, uniform handlers. Keeping
 * them together makes the API surface easy to audit in one read.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  addWidget,
  createDashboard,
  deleteDashboard,
  deleteWidget,
  getDashboard,
  listDashboards,
  runDashboard,
  updateDashboard,
  updateWidget
} from '../../analytics/dashboards';
import {
  countPendingApprovals,
  decideApprovalSync,
  listApprovals,
  requireApproval
} from '../../approvals/service';
import { queryAudit } from '../../audit/ledger';
import { cacheClear, cacheGet, cacheList, cacheSet, cacheStats } from '../../cache/service';
import {
  archiveCollection,
  createCollection,
  deleteRecord,
  findRecords,
  getCollection,
  insertRecord,
  listCollections,
  updateRecord,
  upsertByExternalKey
} from '../../collections/service';
import {
  deleteEnvironmentVariable,
  listEffectiveEnvironment,
  setEnvironmentVariable
} from '../../config/environment';
import {
  listEffectiveConfiguration,
  listOverrides,
  removeOverride,
  setOverride
} from '../../config/overrides';
import { Permissions } from '../../core/context';
import { errors } from '../../core/errors';
import { enqueueApprovalResumeSync } from '../../execution/engine';
import { listWorkflowFields } from '../../fields/service';
import { fileService, hasFileService } from '../../files/contracts';
import { setFileFieldValues } from '../../files/fields';
import {
  deleteBlob,
  deleteFile,
  removeWorkflowContext,
  unlinkFromTicket
} from '../../files/lifecycle';
import { findFiles, searchFileContent } from '../../files/retrieval';
import { andOf, combineFilters, type FilterCondition } from '../../filters/ast';
import {
  applySavedView,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  updateSavedView
} from '../../filters/views';
import { getJobAttempts, listJobs } from '../../jobs/queue';
import { createSecret, deleteSecret, listSecrets, rotateSecret } from '../../secrets/service';
import { deleteStateValue, getStateValue, listState, setStateValue } from '../../state/service';
import { parseFilterInput } from '../../tickets/query';
import { mutate, queryBool, queryInt, queryString } from '../helpers';
import { route } from '../types';

const stateScopeSchema = z.enum(['workspace', 'workflow', 'ticket', 'agent', 'run']);

export const dataRoutes = [
  // ------------------------------------------------------------------- files
  route({
    method: 'GET',
    path: '/files',
    permission: Permissions.fileRead,
    summary: 'Find files by metadata and typed file fields, expressed as a filter AST',
    handler: async ({ db, actor, query, request }) => {
      const params = new URL(request.url).searchParams;
      // Metadata shortcuts are translated into the same filter AST the ticket list
      // uses, rather than being passed as ad-hoc query fields the retrieval layer
      // would silently ignore (ADR-0012).
      const conditions: FilterCondition[] = [];
      const text = (name: string, key: string) => {
        const value = params.get(name);
        if (value)
          conditions.push({ type: 'condition', kind: 'system', key, operator: 'contains', value });
      };
      const exact = (name: string, key: string) => {
        const value = params.get(name);
        if (value)
          conditions.push({ type: 'condition', kind: 'system', key, operator: 'eq', value });
      };

      text('filename', 'filename');
      exact('mimeType', 'mimeType');
      exact('status', 'status');
      exact('workflowId', 'workflowId');
      exact('ticketId', 'ticketId');
      exact('sourceType', 'sourceType');
      exact('language', 'language');
      exact('contentHash', 'contentHash');

      const explicit = parseFilterInput(params.get('filter'));
      const filter = combineFilters(explicit, conditions.length > 0 ? andOf(conditions) : null);

      return {
        body: await findFiles(
          actor,
          {
            filter,
            sort: params.get('sort')
              ? (JSON.parse(params.get('sort') as string) as never)
              : undefined,
            limit: queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 }),
            cursor: params.get('cursor')
          },
          db
        )
      };
    }
  }),

  route({
    method: 'POST',
    path: '/files',
    permission: Permissions.fileWrite,
    summary: 'Upload a file: hashed, deduplicated, provenanced and queued for processing',
    handler: async ({ db, actor, request }) => {
      if (!hasFileService()) {
        throw errors.unsupported('File ingestion is unavailable');
      }
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        throw errors.validation('Attach a file under the "file" field');
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ticketId =
        typeof form.get('ticketId') === 'string' ? String(form.get('ticketId')) : null;
      const workflowId =
        typeof form.get('workflowId') === 'string' ? String(form.get('workflowId')) : null;
      const sourceType =
        typeof form.get('sourceType') === 'string'
          ? String(form.get('sourceType'))
          : 'human_upload';

      const result = await fileService().ingest(
        actor,
        {
          filename: file.name,
          bytes,
          mimeType: file.type || undefined,
          kind: 'upload',
          workflowId,
          ticketId,
          // Ingest links to the ticket inside the same transaction.
          source: {
            type: sourceType as never,
            label: actor.actorLabel,
            reference: null
          }
        },
        db
      );
      return { status: 201, body: result };
    }
  }),

  route({
    method: 'GET',
    path: '/files/:id',
    permission: Permissions.fileRead,
    summary: 'File detail with provenance, workflow contexts and linked tickets',
    handler: async ({ db, actor, params }) => {
      if (!hasFileService()) throw errors.unsupported('File service is unavailable');
      return { body: { file: await fileService().requireFile(actor, params.id as string, db) } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/files/:id',
    permission: Permissions.fileDelete,
    summary: 'Soft-delete a logical file; its blob is reclaimed only when unreferenced',
    handler: async ({ db, actor, params }) => {
      await deleteFile(actor, params.id as string, db);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/files/:id/content',
    permission: Permissions.fileRead,
    summary: 'Extracted content with page/span segments',
    handler: async ({ db, actor, params }) => {
      // Resolve the file first so an unknown or foreign id is a 404 rather than an
      // empty content payload.
      if (!hasFileService()) throw errors.unsupported('File service is unavailable');
      await fileService().requireFile(actor, params.id as string, db);
      const content = await db.all(
        sql`select id, content_kind, text, char_count, page_count, language, segments, truncated, created_at
            from file_extracted_content
            where workspace_id = ${actor.workspaceId} and file_id = ${params.id}
            order by created_at desc limit 1`
      );
      const row = content[0] as Record<string, unknown> | undefined;
      return { body: { content: row ?? null, pending: !row } };
    }
  }),

  route({
    method: 'GET',
    path: '/files/:id/fields',
    permission: Permissions.fileRead,
    summary: 'File field values for a workflow context',
    handler: async ({ db, actor, params, query }) => {
      if (!hasFileService()) throw errors.unsupported('File service is unavailable');
      const workflowId = queryString({ query } as never, 'workflowId');
      const file = await fileService().requireFile(actor, params.id as string, db);
      void file;
      const values = await db.all(
        sql`select v.*, d.key, d.name, d.type, d.options
            from file_field_values v
            join field_definitions d on d.id = v.field_definition_id
            where v.workspace_id = ${actor.workspaceId} and v.file_id = ${params.id}
            ${workflowId ? sql`and v.workflow_id = ${workflowId}` : sql``}`
      );
      return { body: { fields: values } };
    }
  }),

  route({
    method: 'PUT',
    path: '/files/:id/fields',
    permission: Permissions.fileWrite,
    summary: 'Correct file field values with history and audit',
    body: z.object({
      workflowId: z.string().nullish(),
      values: z.record(z.string(), z.unknown())
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as { workflowId?: string | null; values: Record<string, unknown> };
      return {
        body: await setFileFieldValues(
          actor,
          {
            fileId: params.id as string,
            workflowId: input.workflowId ?? null,
            values: input.values,
            source: 'human'
          },
          db
        )
      };
    }
  }),

  route({
    method: 'POST',
    path: '/files/:id/process',
    permission: Permissions.fileWrite,
    summary: 'Queue (or force) durable processing for a file',
    body: z.object({ workflowId: z.string().nullish(), force: z.boolean().optional() }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as { workflowId?: string | null; force?: boolean };
      if (!hasFileService()) throw errors.unsupported('File service is unavailable');
      await fileService().queueProcessing(
        actor,
        { fileId: params.id as string, workflowId: input.workflowId ?? null, force: input.force },
        db
      );
      return { body: { queued: true } };
    }
  }),

  route({
    method: 'POST',
    path: '/files/:id/workflow-context',
    permission: Permissions.fileWrite,
    summary: 'Add a workflow interpretation (context label) for a file',
    body: z.object({ workflowId: z.string(), contextLabel: z.string().max(120).nullish() }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as { workflowId: string; contextLabel?: string | null };
      if (!hasFileService()) throw errors.unsupported('File service is unavailable');
      await fileService().addWorkflowContext(
        actor,
        {
          fileId: params.id as string,
          workflowId: input.workflowId,
          contextLabel: input.contextLabel ?? null
        },
        db
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/files/:id/workflow-context/:workflowId',
    permission: Permissions.fileWrite,
    summary: 'Remove a workflow context without touching the file',
    handler: async ({ db, actor, params }) => {
      await removeWorkflowContext(
        actor,
        {
          fileId: params.id as string,
          workflowId: params.workflowId as string
        },
        db
      );
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/files/:id/unlink',
    permission: Permissions.fileWrite,
    summary: 'Unlink a file from a ticket, keeping the file and its other links',
    body: z.object({ ticketId: z.string() }),
    handler: async ({ db, actor, params, body }) => {
      await unlinkFromTicket(
        actor,
        { fileId: params.id as string, ticketId: (body as { ticketId: string }).ticketId },
        db
      );
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/files/search',
    permission: Permissions.fileRead,
    summary: 'Text search across extracted file content (FTS with LIKE fallback)',
    handler: async ({ db, actor, query, request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      return {
        body: await searchFileContent(
          actor,
          {
            query: q,
            workflowId: queryString({ query } as never, 'workflowId') ?? undefined,
            limit: queryInt({ query } as never, 'limit', 20, { min: 1, max: 100 })
          },
          db
        )
      };
    }
  }),

  route({
    method: 'DELETE',
    path: '/blobs/:id',
    permission: Permissions.fileDelete,
    summary: 'Reclaim a blob’s bytes when no retained reference needs them',
    handler: async ({ db, actor, params }) => {
      await deleteBlob(actor, { blobId: params.id as string }, db);
      return { status: 204 };
    }
  }),

  // --------------------------------------------------------------- approvals
  route({
    method: 'GET',
    path: '/approvals',
    permission: Permissions.approvalRead,
    summary: 'Approval inbox with pending counts',
    handler: ({ db, actor, query, request }) => {
      const params = new URL(request.url).searchParams;
      const status = params.getAll('status');
      return {
        body: {
          approvals: listApprovals(db, actor, {
            status: status.length > 0 ? (status as never) : ['pending'],
            ticketId: params.get('ticketId') ?? undefined,
            assignedToMe: params.get('mine') === 'true',
            limit: queryInt({ query } as never, 'limit', 100, { min: 1, max: 300 })
          }),
          pendingCount: countPendingApprovals(db, actor.workspaceId)
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/approvals/:id',
    permission: Permissions.approvalRead,
    summary: 'Approval detail including the exact, redacted action to be taken',
    handler: ({ db, actor, params }) => ({
      body: { approval: requireApproval(db, actor.workspaceId, params.id as string) }
    })
  }),

  route({
    method: 'POST',
    path: '/approvals/:id/decide',
    permission: Permissions.approvalDecide,
    summary: 'Approve or reject; the decision and the resumption commit together',
    body: z.object({
      decision: z.enum(['approved', 'rejected']),
      comment: z.string().max(2000).nullish(),
      decisionData: z.record(z.string(), z.unknown()).optional()
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as {
        decision: 'approved' | 'rejected';
        comment?: string | null;
        decisionData?: Record<string, unknown>;
      };
      return {
        body: await mutate(db, (tx) => {
          const result = decideApprovalSync(tx, actor, {
            approvalId: params.id as string,
            decision: input.decision,
            comment: input.comment ?? null,
            decisionData: input.decisionData
          });
          if (result.shouldResume) {
            enqueueApprovalResumeSync(tx, {
              workspaceId: actor.workspaceId,
              approvalId: result.approval.id,
              runId: result.approval.runId,
              ticketId: result.approval.ticketId
            });
          }
          return { approval: result.approval, resumeQueued: result.shouldResume };
        })
      };
    }
  }),

  // ------------------------------------------------------------- saved views
  route({
    method: 'GET',
    path: '/views',
    permission: Permissions.ticketRead,
    summary: 'Saved views for tickets or files',
    handler: ({ db, actor, request }) => {
      const scope = new URL(request.url).searchParams.get('scope');
      return {
        body: {
          views: listSavedViews(db, actor, {
            scope: scope === 'files' ? 'files' : scope === 'tickets' ? 'tickets' : undefined
          })
        }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/views',
    permission: Permissions.ticketRead,
    summary: 'Create a saved view (serializable filter AST)',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      scope: z.enum(['tickets', 'files']).optional(),
      workflowId: z.string().nullish(),
      /** Serializable filter AST; `null` means "all items". */
      filter: z.unknown().nullish(),
      sort: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) })).nullish(),
      columns: z.array(z.string()).nullish(),
      isShared: z.boolean().optional(),
      isPinned: z.boolean().optional()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { view: await createSavedView(db, actor, body as never) }
    })
  }),

  route({
    method: 'PATCH',
    path: '/views/:id',
    permission: Permissions.ticketRead,
    summary: 'Update a saved view',
    body: z.record(z.string(), z.unknown()),
    handler: async ({ db, actor, params, body }) => ({
      body: { view: await updateSavedView(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/views/:id',
    permission: Permissions.ticketRead,
    summary: 'Delete a saved view',
    handler: async ({ db, actor, params }) => {
      await deleteSavedView(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/views/:id/apply',
    permission: Permissions.ticketRead,
    summary: 'Resolve a saved view into filter, sort and columns',
    handler: ({ db, actor, params }) => ({
      body: applySavedView(db, actor, params.id as string)
    })
  }),

  // -------------------------------------------------------------- dashboards
  route({
    method: 'GET',
    path: '/dashboards',
    permission: Permissions.analyticsRead,
    summary: 'Dashboards',
    handler: async ({ db, actor }) => ({ body: { dashboards: await listDashboards(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/dashboards',
    permission: Permissions.analyticsWrite,
    summary: 'Create a dashboard',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      globalFilters: z.unknown().nullish(),
      isShared: z.boolean().optional()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { dashboard: await createDashboard(db, actor, body as never) }
    })
  }),

  route({
    method: 'GET',
    path: '/dashboards/:id',
    permission: Permissions.analyticsRead,
    summary: 'Dashboard with its widgets',
    handler: async ({ db, actor, params }) => ({
      body: await getDashboard(db, actor, params.id as string)
    })
  }),

  route({
    method: 'PATCH',
    path: '/dashboards/:id',
    permission: Permissions.analyticsWrite,
    summary: 'Update a dashboard, its layout or global filters',
    body: z.record(z.string(), z.unknown()),
    handler: async ({ db, actor, params, body }) => ({
      body: { dashboard: await updateDashboard(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/dashboards/:id',
    permission: Permissions.analyticsWrite,
    summary: 'Delete a dashboard',
    handler: async ({ db, actor, params }) => {
      await deleteDashboard(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/dashboards/:id/widgets',
    permission: Permissions.analyticsWrite,
    summary: 'Add a widget',
    body: z.record(z.string(), z.unknown()),
    handler: async ({ db, actor, params, body }) => ({
      status: 201,
      body: {
        widget: await addWidget(db, actor, params.id as string, body as never)
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/widgets/:id',
    permission: Permissions.analyticsWrite,
    summary: 'Update a widget',
    body: z.record(z.string(), z.unknown()),
    handler: async ({ db, actor, params, body }) => ({
      body: { widget: await updateWidget(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/widgets/:id',
    permission: Permissions.analyticsWrite,
    summary: 'Delete a widget',
    handler: async ({ db, actor, params }) => {
      await deleteWidget(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/dashboards/:id/run',
    permission: Permissions.analyticsRead,
    summary: 'Execute every widget, combining dashboard and widget filters',
    handler: async ({ db, actor, params }) => ({
      body: await runDashboard(db, {
        workspaceId: actor.workspaceId,
        dashboardId: params.id as string
      })
    })
  }),

  // ------------------------------------------------------------- collections
  route({
    method: 'GET',
    path: '/collections',
    permission: Permissions.dataRead,
    summary: 'Structured collections',
    handler: ({ db, actor, request }) => {
      const workflowId = new URL(request.url).searchParams.get('workflowId');
      return {
        body: { collections: listCollections(db, actor, { workflowId: workflowId ?? undefined }) }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/collections',
    permission: Permissions.dataWrite,
    summary: 'Create a collection',
    body: z.object({
      key: z.string().trim().min(1).max(60),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      workflowId: z.string().nullish(),
      schema: z.unknown().nullish()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { collection: await createCollection(db, actor, body as never) }
    })
  }),

  route({
    method: 'GET',
    path: '/collections/:id',
    permission: Permissions.dataRead,
    summary: 'Collection detail',
    handler: ({ db, actor, params }) => ({
      body: { collection: getCollection(db, actor, params.id as string) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/collections/:id',
    permission: Permissions.dataWrite,
    summary: 'Archive a collection',
    handler: async ({ db, actor, params }) => {
      await archiveCollection(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/collections/:id/records',
    permission: Permissions.dataRead,
    summary: 'Find collection records',
    handler: ({ db, actor, params, query, request }) => {
      const url = new URL(request.url);
      const filterParam = url.searchParams.get('filter');
      return {
        body: findRecords(db, actor, {
          collectionId: params.id as string,
          filter: filterParam ? (JSON.parse(filterParam) as never) : undefined,
          sort: url.searchParams.get('sort')
            ? (JSON.parse(url.searchParams.get('sort') as string) as never)
            : undefined,
          limit: queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 }),
          cursor: url.searchParams.get('cursor')
        } as never)
      };
    }
  }),

  route({
    method: 'POST',
    path: '/collections/:id/records',
    permission: Permissions.dataWrite,
    summary: 'Insert a record (or upsert by external key)',
    body: z.object({
      data: z.record(z.string(), z.unknown()),
      externalKey: z.string().max(200).nullish()
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as { data: Record<string, unknown>; externalKey?: string | null };
      if (input.externalKey) {
        return {
          status: 201,
          body: await upsertByExternalKey(db, actor, {
            collectionId: params.id as string,
            externalKey: input.externalKey,
            data: input.data
          })
        };
      }
      return {
        status: 201,
        body: {
          record: await insertRecord(db, actor, {
            collectionId: params.id as string,
            data: input.data
          })
        }
      };
    }
  }),

  route({
    method: 'PATCH',
    path: '/records/:id',
    permission: Permissions.dataWrite,
    summary: 'Update a record with optimistic concurrency',
    body: z.object({
      data: z.record(z.string(), z.unknown()),
      expectedVersion: z.number().int().optional()
    }),
    handler: async ({ db, actor, params, body }) => ({
      body: {
        record: await updateRecord(db, actor, {
          recordId: params.id as string,
          ...(body as object)
        } as never)
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/records/:id',
    permission: Permissions.dataWrite,
    summary: 'Soft-delete a record',
    handler: async ({ db, actor, params }) => {
      await deleteRecord(db, actor, { recordId: params.id as string });
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------- agent state
  route({
    method: 'GET',
    path: '/state',
    permission: Permissions.dataRead,
    summary: 'List scoped agent state',
    handler: ({ db, actor, query, request }) => {
      const url = new URL(request.url);
      return {
        body: {
          entries: listState(db, actor, {
            scope: (url.searchParams.get('scope') as never) ?? 'workspace',
            workflowId: url.searchParams.get('workflowId') ?? undefined,
            ticketId: url.searchParams.get('ticketId') ?? undefined,
            agentId: url.searchParams.get('agentId') ?? undefined,
            runId: url.searchParams.get('runId') ?? undefined,
            namespace: url.searchParams.get('namespace') ?? undefined,
            prefix: url.searchParams.get('prefix') ?? undefined,
            limit: queryInt({ query } as never, 'limit', 100, { min: 1, max: 300 })
          } as never)
        }
      };
    }
  }),

  route({
    method: 'PUT',
    path: '/state',
    permission: Permissions.dataWrite,
    summary: 'Set a scoped state value',
    body: z.object({
      scope: stateScopeSchema,
      namespace: z.string().max(60).optional(),
      key: z.string().trim().min(1).max(200),
      value: z.unknown(),
      ttlSeconds: z.number().int().min(1).optional(),
      workflowId: z.string().nullish(),
      ticketId: z.string().nullish(),
      agentId: z.string().nullish(),
      runId: z.string().nullish()
    }),
    handler: ({ db, actor, body }) => ({
      body: setStateValue(db, actor, body as never)
    })
  }),

  route({
    method: 'DELETE',
    path: '/state',
    permission: Permissions.dataWrite,
    summary: 'Delete a scoped state value',
    handler: ({ db, actor, request }) => {
      const url = new URL(request.url);
      return {
        body: {
          deleted: deleteStateValue(db, actor, {
            scope: (url.searchParams.get('scope') as never) ?? 'workspace',
            key: url.searchParams.get('key') as string,
            namespace: url.searchParams.get('namespace') ?? undefined,
            workflowId: url.searchParams.get('workflowId') ?? undefined,
            ticketId: url.searchParams.get('ticketId') ?? undefined,
            agentId: url.searchParams.get('agentId') ?? undefined,
            runId: url.searchParams.get('runId') ?? undefined
          } as never)
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/state/value',
    permission: Permissions.dataRead,
    summary: 'Read one scoped state value',
    handler: ({ db, actor, request }) => {
      const url = new URL(request.url);
      const value = getStateValue(db, actor, {
        scope: (url.searchParams.get('scope') as never) ?? 'workspace',
        key: url.searchParams.get('key') as string,
        namespace: url.searchParams.get('namespace') ?? undefined,
        workflowId: url.searchParams.get('workflowId') ?? undefined,
        ticketId: url.searchParams.get('ticketId') ?? undefined,
        agentId: url.searchParams.get('agentId') ?? undefined,
        runId: url.searchParams.get('runId') ?? undefined
      } as never);
      return { body: { value } };
    }
  }),

  // ------------------------------------------------------------------- cache
  route({
    method: 'GET',
    path: '/cache',
    permission: Permissions.cacheRead,
    summary: 'Inspect cache entries (values only when requested)',
    handler: ({ db, actor, query, request }) => {
      const url = new URL(request.url);
      return {
        body: {
          entries: cacheList(db, {
            workspaceId: actor.workspaceId,
            namespace: url.searchParams.get('namespace') ?? undefined,
            prefix: url.searchParams.get('prefix') ?? undefined,
            includeValues: queryBool({ query } as never, 'includeValues', false),
            actor,
            limit: queryInt({ query } as never, 'limit', 100, { min: 1, max: 300 })
          }),
          stats: cacheStats(db, { workspaceId: actor.workspaceId })
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/cache/value',
    permission: Permissions.cacheRead,
    summary: 'Read one cache entry',
    handler: ({ db, actor, request }) => {
      const url = new URL(request.url);
      return {
        body: cacheGet(db, {
          workspaceId: actor.workspaceId,
          namespace: url.searchParams.get('namespace') ?? 'default',
          key: url.searchParams.get('key') as string,
          authScope: url.searchParams.get('authScope') ?? ''
        })
      };
    }
  }),

  route({
    method: 'PUT',
    path: '/cache',
    permission: Permissions.cacheWrite,
    summary: 'Write a cache entry',
    body: z.object({
      namespace: z.string().max(60).optional(),
      key: z.string().trim().min(1).max(300),
      value: z.unknown(),
      ttlSeconds: z.number().int().min(1).optional(),
      tags: z.array(z.string()).optional()
    }),
    handler: ({ db, actor, body }) => ({
      body: cacheSet(db, { workspaceId: actor.workspaceId, ...(body as object) } as never)
    })
  }),

  route({
    method: 'DELETE',
    path: '/cache',
    permission: Permissions.cacheWrite,
    summary: 'Clear cache by namespace or tag',
    handler: async ({ db, actor, request }) => {
      const url = new URL(request.url);
      const removed = await cacheClear(db, {
        workspaceId: actor.workspaceId,
        namespace: url.searchParams.get('namespace') ?? undefined,
        tag: url.searchParams.get('tag') ?? undefined
      });
      return { body: { removed } };
    }
  }),

  // ------------------------------------------------------- secrets and config
  route({
    method: 'GET',
    path: '/secrets',
    permission: Permissions.secretRead,
    summary: 'Secrets as non-sensitive metadata only',
    handler: ({ db, actor, request }) => {
      const workflowId = new URL(request.url).searchParams.get('workflowId');
      return {
        body: { secrets: listSecrets(db, actor, { workflowId: workflowId ?? null }) }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/secrets',
    permission: Permissions.secretWrite,
    summary: 'Create an encrypted secret (never readable back)',
    body: z.object({
      key: z.string().trim().min(1).max(64),
      name: z.string().trim().max(120).optional(),
      value: z.string().min(1).max(20_000),
      description: z.string().max(500).nullish(),
      scope: z.enum(['workspace', 'workflow']).optional(),
      workflowId: z.string().nullish()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: { secret: mutate(db, (tx) => createSecret(tx, actor, body as never)) }
    })
  }),

  route({
    method: 'POST',
    path: '/secrets/:id/rotate',
    permission: Permissions.secretWrite,
    summary: 'Rotate a secret value, keeping prior ciphertext readable',
    body: z.object({ value: z.string().min(1).max(20_000) }),
    handler: ({ db, actor, params, body }) => ({
      body: {
        secret: mutate(db, (tx) =>
          rotateSecret(tx, actor, params.id as string, (body as { value: string }).value)
        )
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/secrets/:id',
    permission: Permissions.secretWrite,
    summary: 'Soft-delete a secret so history stays auditable',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => deleteSecret(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/environment',
    permission: Permissions.configRead,
    summary: 'Effective environment with inherited/overridden/local provenance',
    handler: ({ db, actor, request }) => {
      const workflowId = new URL(request.url).searchParams.get('workflowId');
      return {
        body: {
          variables: listEffectiveEnvironment(db, {
            workspaceId: actor.workspaceId,
            workflowId: workflowId ?? null
          })
        }
      };
    }
  }),

  route({
    method: 'PUT',
    path: '/environment',
    permission: Permissions.configWrite,
    summary: 'Set an environment variable at workspace or workflow scope',
    body: z.object({
      key: z.string().trim().min(1).max(64),
      value: z.string().max(20_000).nullish(),
      isSecret: z.boolean().optional(),
      description: z.string().max(500).nullish(),
      workflowId: z.string().nullish()
    }),
    handler: async ({ db, actor, body }) => ({
      body: { variable: await setEnvironmentVariable(db, actor, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/environment/:id',
    permission: Permissions.configWrite,
    summary: 'Delete a variable; a workflow override removal resumes inheritance',
    handler: async ({ db, actor, params }) => {
      await deleteEnvironmentVariable(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/overrides',
    permission: Permissions.configRead,
    summary: 'Effective configuration: inherited, overridden, forked and local',
    handler: ({ db, actor, request }) => {
      const workflowId = new URL(request.url).searchParams.get('workflowId');
      if (workflowId) {
        return { body: listEffectiveConfiguration(db, actor, workflowId) };
      }
      return { body: { overrides: listOverrides(db, actor, {}) } };
    }
  }),

  route({
    method: 'PUT',
    path: '/overrides',
    permission: Permissions.configWrite,
    summary: 'Bind a resource as use-as-is, override or fork',
    body: z.object({
      workflowId: z.string().nullish(),
      resourceType: z.string().min(1),
      resourceId: z.string(),
      sourceResourceId: z.string().nullish(),
      mode: z.enum(['use_asis', 'override', 'fork']),
      overriddenFields: z.array(z.string()).optional()
    }),
    handler: async ({ db, actor, body }) => ({
      body: { override: await setOverride(db, actor, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/overrides/:id',
    permission: Permissions.configWrite,
    summary: 'Remove an override so the resource resumes inheritance',
    handler: async ({ db, actor, params }) => {
      const existing = listOverrides(db, actor, {}).find((row) => row.id === params.id);
      if (!existing) throw errors.notFound('Override', params.id as string);
      await removeOverride(db, actor, {
        workflowId: existing.workflowId ?? '',
        resourceType: existing.resourceType,
        resourceId: existing.resourceId
      });
      return { status: 204 };
    }
  }),

  // -------------------------------------------------------------- operational
  route({
    method: 'GET',
    path: '/jobs',
    permission: Permissions.jobRead,
    summary: 'Durable jobs with status, attempts and lease information',
    handler: async ({ db, actor, query, request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.getAll('status');
      return {
        body: {
          jobs: await listJobs(db, {
            workspaceId: actor.workspaceId,
            status: status.length > 0 ? (status as never) : undefined,
            type: (url.searchParams.get('type') as never) ?? undefined,
            ticketId: url.searchParams.get('ticketId') ?? undefined,
            runId: url.searchParams.get('runId') ?? undefined,
            limit: queryInt({ query } as never, 'limit', 100, { min: 1, max: 300 })
          })
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/jobs/:id/attempts',
    permission: Permissions.jobRead,
    summary: 'Attempt history for a job, including lease expiry',
    handler: async ({ db, actor, params }) => {
      // A job id from another workspace must not be confirmable, so the job is
      // resolved workspace-scoped before its attempts are returned.
      const rows = await db.all(
        sql`select id from jobs where id = ${params.id} and workspace_id = ${actor.workspaceId}`
      );
      if (rows.length === 0) throw errors.notFound('Job', params.id as string);
      return { body: { attempts: await getJobAttempts(db, params.id as string) } };
    }
  }),

  route({
    method: 'GET',
    path: '/audit',
    permission: Permissions.auditRead,
    summary: 'Append-only ledger query',
    handler: async ({ db, actor, query, request }) => {
      const url = new URL(request.url);
      return {
        body: {
          events: await queryAudit(db, {
            workspaceId: actor.workspaceId,
            ticketId: url.searchParams.get('ticketId') ?? undefined,
            runId: url.searchParams.get('runId') ?? undefined,
            fileId: url.searchParams.get('fileId') ?? undefined,
            entityType: url.searchParams.get('entityType') ?? undefined,
            entityId: url.searchParams.get('entityId') ?? undefined,
            actions: url.searchParams.getAll('action'),
            since: url.searchParams.get('since')
              ? Number(url.searchParams.get('since'))
              : undefined,
            cursor: url.searchParams.get('cursor')
              ? Number(url.searchParams.get('cursor'))
              : undefined,
            limit: queryInt({ query } as never, 'limit', 100, { min: 1, max: 500 })
          })
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/config',
    permission: Permissions.configRead,
    summary: 'Workflow configuration summary (states, fields, agents, resources)',
    handler: ({ db, actor, request }) => {
      const workflowId = new URL(request.url).searchParams.get('workflowId');
      if (!workflowId) throw errors.validation('workflowId is required');
      return {
        body: {
          fields: listWorkflowFields(db, actor, workflowId),
          configuration: listEffectiveConfiguration(db, actor, workflowId),
          environment: listEffectiveEnvironment(db, { workspaceId: actor.workspaceId, workflowId })
        }
      };
    }
  })
];
