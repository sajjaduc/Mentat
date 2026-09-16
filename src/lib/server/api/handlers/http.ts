/**
 * HTTP platform and triggers.
 *
 * The HTTP editor needs the same execution path a model would use, plus a test
 * console that deliberately bypasses approval and cache so an operator can iterate
 * on an operation safely — while still logging what it did.
 */
import { z } from 'zod';
import { getStorageConfig, setStorageConfig } from '../../config/storage';
import { Permissions } from '../../core/context';
import { executeOperation } from '../../http/runtime';
import {
  archiveHttpOperation,
  archiveHttpService,
  createHttpOperation,
  createHttpService,
  getHttpOperation,
  getHttpService,
  inferOutputSchemaFromSample,
  listHttpOperations,
  listHttpServices,
  updateHttpOperation,
  updateHttpService
} from '../../http/service';
import { testRequest } from '../../http/testing';
import { scheduleDueTriggers } from '../../triggers/cron';
import { fireManual } from '../../triggers/manual';
import {
  archiveTrigger,
  createTrigger,
  findTriggerByWebhookToken,
  listTriggers,
  updateTrigger
} from '../../triggers/service';
import { receiveWebhook } from '../../triggers/webhook';
import { queryInt, queryString } from '../helpers';
import { route } from '../types';

const parameterSchema = z.object({
  name: z.string(),
  location: z.enum(['path', 'query', 'header', 'body']),
  wireName: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().max(500).optional(),
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional(),
  default: z.unknown().optional(),
  constant: z.unknown().optional()
});

const operationBody = z.object({
  serviceId: z.string(),
  key: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional(),
  path: z.string().min(1).max(500),
  parameters: z.array(parameterSchema).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.unknown()).nullish(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  successRules: z.record(z.string(), z.unknown()).nullish(),
  responseMapping: z.record(z.string(), z.unknown()).nullish(),
  timeoutMs: z.number().int().min(100).max(120_000).nullish(),
  retryPolicy: z.record(z.string(), z.unknown()).nullish(),
  cachePolicy: z.record(z.string(), z.unknown()).nullish(),
  approvalPolicy: z.record(z.string(), z.unknown()).nullish(),
  rateLimitOverride: z.record(z.string(), z.unknown()).nullish(),
  exposeAsTool: z.boolean().optional(),
  enabled: z.boolean().optional()
});

export const httpRoutes = [
  route({
    method: 'GET',
    path: '/http/services',
    permission: Permissions.httpRead,
    summary: 'HTTP services with their operation counts',
    handler: ({ db, actor }) => ({ body: { services: listHttpServices(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/http/services',
    permission: Permissions.httpWrite,
    summary: 'Create an HTTP service (base URL, auth, defaults, rate limits)',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      baseUrl: z.string().url(),
      authType: z
        .enum(['none', 'bearer', 'api_key_header', 'api_key_query', 'basic', 'custom_header'])
        .optional(),
      authConfig: z.record(z.string(), z.unknown()).nullish(),
      defaultHeaders: z.record(z.string(), z.string()).nullish(),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
      retryPolicy: z.record(z.string(), z.unknown()).nullish(),
      cachePolicy: z.record(z.string(), z.unknown()).nullish(),
      rateLimit: z.record(z.string(), z.unknown()).nullish(),
      defaultApprovalPolicy: z.record(z.string(), z.unknown()).nullish(),
      allowedHosts: z.array(z.string()).nullish(),
      workflowId: z.string().nullish()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { service: await createHttpService(db, actor, body as never) }
    })
  }),

  route({
    method: 'GET',
    path: '/http/services/:id',
    permission: Permissions.httpRead,
    summary: 'Service detail with operations and recent request logs',
    handler: ({ db, actor, params }) => ({
      body: {
        service: getHttpService(db, actor, params.id as string),
        operations: listHttpOperations(db, actor, { serviceId: params.id as string }),
        logs: recentRequestLogs(db, actor.workspaceId, {
          serviceId: params.id as string,
          limit: 25
        })
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/http/services/:id',
    permission: Permissions.httpWrite,
    summary: 'Update a service',
    body: z.record(z.string(), z.unknown()),
    handler: async ({ db, actor, params, body }) => ({
      body: { service: await updateHttpService(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/http/services/:id',
    permission: Permissions.httpWrite,
    summary: 'Archive a service and its operations',
    handler: async ({ db, actor, params }) => {
      await archiveHttpService(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/http/operations',
    permission: Permissions.httpRead,
    summary: 'Operations, optionally filtered by service',
    handler: ({ db, actor, query }) => ({
      body: {
        operations: listHttpOperations(db, actor, {
          serviceId: queryString({ query } as never, 'serviceId') ?? undefined
        })
      }
    })
  }),

  route({
    method: 'POST',
    path: '/http/operations',
    permission: Permissions.httpWrite,
    summary: 'Create a semantic operation on a service',
    body: operationBody,
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { operation: await createHttpOperation(db, actor, body as never) }
    })
  }),

  route({
    method: 'GET',
    path: '/http/operations/:id',
    permission: Permissions.httpRead,
    summary: 'Operation detail',
    handler: ({ db, actor, params }) => ({
      body: { operation: getHttpOperation(db, actor, params.id as string) }
    })
  }),

  route({
    method: 'PATCH',
    path: '/http/operations/:id',
    permission: Permissions.httpWrite,
    summary: 'Update an operation (including its tool exposure)',
    body: operationBody.partial(),
    handler: async ({ db, actor, params, body }) => ({
      body: { operation: await updateHttpOperation(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/http/operations/:id',
    permission: Permissions.httpWrite,
    summary: 'Archive an operation and disable its tool',
    handler: async ({ db, actor, params }) => {
      await archiveHttpOperation(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/http/operations/:id/test',
    permission: Permissions.httpInvoke,
    summary: 'Test Request from the editor: bypasses approval and cache, still audited',
    body: z.object({
      input: z.record(z.string(), z.unknown()).optional(),
      inferSchemaFromResponse: z.boolean().optional()
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = (body as { input?: Record<string, unknown> }).input ?? {};
      const result = await testRequest({
        db,
        actor,
        operationId: params.id as string,
        input
      });
      const inferred =
        (body as { inferSchemaFromResponse?: boolean }).inferSchemaFromResponse && result.ok
          ? inferOutputSchemaFromSample(result.body)
          : null;
      return { body: { ...result, inferredOutputSchema: inferred } };
    }
  }),

  route({
    method: 'POST',
    path: '/http/operations/:id/invoke',
    permission: Permissions.httpInvoke,
    summary: 'Invoke an operation with full policy (cache, limits, retries, approval)',
    body: z.object({ input: z.record(z.string(), z.unknown()).optional() }),
    handler: async ({ db, actor, params, body }) => ({
      body: await executeOperation({
        db,
        actor,
        operationId: params.id as string,
        input: (body as { input?: Record<string, unknown> }).input ?? {}
      })
    })
  }),

  route({
    method: 'GET',
    path: '/http/logs',
    permission: Permissions.httpRead,
    summary: 'HTTP request logs (redacted) for diagnostics',
    handler: ({ db, actor, query }) => ({
      body: {
        logs: recentRequestLogs(db, actor.workspaceId, {
          serviceId: queryString({ query } as never, 'serviceId') ?? undefined,
          operationId: queryString({ query } as never, 'operationId') ?? undefined,
          limit: queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 })
        })
      }
    })
  }),

  // ---------------------------------------------------------------- triggers
  route({
    method: 'GET',
    path: '/triggers',
    permission: Permissions.triggerRead,
    summary: 'Triggers, optionally filtered by workflow',
    handler: ({ db, actor, query }) => ({
      body: {
        triggers: listTriggers(db, actor, {
          workflowId: queryString({ query } as never, 'workflowId') ?? undefined
        })
      }
    })
  }),

  route({
    method: 'POST',
    path: '/triggers',
    permission: Permissions.triggerWrite,
    summary: 'Create a webhook, cron or manual trigger',
    body: z.object({
      workflowId: z.string(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      type: z.enum(['webhook', 'cron', 'manual', 'api']),
      enabled: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).nullish(),
      targetStateId: z.string().nullish(),
      upsertOnDedupe: z.boolean().optional()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { trigger: await createTrigger(db, actor, body as never) }
    })
  }),

  route({
    method: 'PATCH',
    path: '/triggers/:id',
    permission: Permissions.triggerWrite,
    summary: 'Update a trigger',
    body: z.record(z.string(), z.unknown()),
    handler: async ({ db, actor, params, body }) => ({
      body: { trigger: await updateTrigger(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/triggers/:id',
    permission: Permissions.triggerWrite,
    summary: 'Archive a trigger',
    handler: async ({ db, actor, params }) => {
      await archiveTrigger(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/triggers/:id/fire',
    permission: Permissions.triggerWrite,
    summary: 'Fire a trigger manually through the same path as webhook/cron',
    body: z.object({
      input: z.record(z.string(), z.unknown()).optional(),
      idempotencyKey: z.string().max(200).optional()
    }),
    handler: async ({ db, actor, params, body }) => ({
      body: await fireManual(db, actor, {
        triggerId: params.id as string,
        ...(body as object)
      } as never)
    })
  }),

  route({
    method: 'POST',
    path: '/triggers/schedule/tick',
    permission: Permissions.triggerWrite,
    summary: 'Run the cron scheduler once (worker-safe; useful for local demos)',
    handler: async ({ db }) => ({
      body: { fired: await scheduleDueTriggers(db) }
    })
  }),

  route({
    method: 'GET',
    path: '/triggers/:id/events',
    permission: Permissions.triggerRead,
    summary: 'Recent trigger events with their processing status',
    handler: ({ db, actor, params }) => ({
      body: { events: recentTriggerEvents(db, actor.workspaceId, params.id as string, 50) }
    })
  }),

  route({
    method: 'GET',
    path: '/triggers/:id/webhook-url',
    permission: Permissions.triggerRead,
    summary: 'The public webhook URL for a trigger',
    handler: ({ db, actor, params, request }) => {
      const trigger = listTriggers(db, actor).find((row) => row.id === params.id);
      if (!trigger?.webhookToken) return { body: { url: null } };
      const origin = new URL(request.url).origin;
      return { body: { url: `${origin}/api/webhooks/${trigger.webhookToken}` } };
    }
  }),

  // ----------------------------------------------------------------- storage
  route({
    method: 'GET',
    path: '/storage',
    permission: Permissions.configRead,
    summary: 'Workspace storage configuration (no credentials returned)',
    handler: ({ db, actor }) => ({ body: { storage: getStorageConfig(db, actor.workspaceId) } })
  }),

  route({
    method: 'PUT',
    path: '/storage',
    permission: Permissions.configWrite,
    summary: 'Configure local or GCS storage for the workspace',
    body: z.object({
      provider: z.enum(['local', 'gcs']),
      bucket: z.string().max(200).nullish(),
      prefix: z.string().max(300).nullish(),
      credentialsSecretId: z.string().nullish(),
      localRoot: z.string().max(500).nullish(),
      maxFileBytes: z.number().int().min(1024).max(1_073_741_824).optional()
    }),
    handler: async ({ db, actor, body }) => ({
      body: { storage: await setStorageConfig(db, actor, body as never) }
    })
  })
];

/** Public webhook endpoint: no session, authenticity comes from the trigger token. */
export const publicWebhookRoutes = [
  route({
    method: 'POST',
    path: '/webhooks/:token',
    public: true,
    summary: 'Receive a webhook delivery for a trigger',
    handler: async ({ db, params, request }) => {
      const rawBody = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      // The actor is built from the trigger's workspace because a webhook has no
      // session: the token IS the credential, and the signature proves provenance.
      const trigger = findTriggerByWebhookToken(db, params.token as string);
      if (!trigger)
        return { status: 404, body: { error: { code: 'not_found', message: 'Unknown webhook' } } };
      const { systemActor } = await import('../../core/context');
      const actor = systemActor(trigger.workspaceId, `webhook:${trigger.name}`);
      const result = await receiveWebhook(db, actor, {
        token: params.token as string,
        rawBody,
        headers,
        source: 'webhook'
      });
      return { status: result.duplicate ? 200 : 202, body: result };
    }
  }),

  route({
    method: 'GET',
    path: '/webhooks/:token',
    public: true,
    summary: 'Webhook probe (used by providers that verify endpoints)',
    handler: ({ db, params }) => {
      const trigger = findTriggerByWebhookToken(db, params.token as string);
      if (!trigger) return { status: 404, body: { ok: false } };
      return {
        body: { ok: true, trigger: { id: trigger.id, name: trigger.name, type: trigger.type } }
      };
    }
  })
];

/**
 * Recent HTTP request logs for the editor's diagnostics pane. The stored rows are
 * already redacted at write time, so they are safe to return to an operator.
 */
function recentRequestLogs(
  db: Parameters<typeof getHttpService>[0],
  workspaceId: string,
  options: { serviceId?: string; operationId?: string; limit: number }
) {
  const conditions = [eq(httpRequestLogs.workspaceId, workspaceId)];
  if (options.serviceId) conditions.push(eq(httpRequestLogs.serviceId, options.serviceId));
  if (options.operationId) conditions.push(eq(httpRequestLogs.operationId, options.operationId));
  return db
    .select()
    .from(httpRequestLogs)
    .where(and(...conditions))
    .orderBy(desc(httpRequestLogs.createdAt))
    .limit(options.limit)
    .all();
}

/** Recent events for one trigger, with their durable processing status. */
function recentTriggerEvents(
  db: Parameters<typeof getHttpService>[0],
  workspaceId: string,
  triggerId: string,
  limit: number
) {
  return db
    .select()
    .from(triggerEvents)
    .where(and(eq(triggerEvents.workspaceId, workspaceId), eq(triggerEvents.triggerId, triggerId)))
    .orderBy(desc(triggerEvents.receivedAt))
    .limit(limit)
    .all();
}

import { and, desc, eq } from 'drizzle-orm';
import { httpRequestLogs, triggerEvents } from '../../db/schema';
