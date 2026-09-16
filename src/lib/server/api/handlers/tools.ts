/**
 * Tool management.
 *
 * The catalogue endpoint and the write paths that keep it honest: enable/disable a
 * tool or a whole group, import HTTP operations from an OpenAPI document, and
 * register/discover MCP servers. Every mutation goes through a service that checks a
 * permission and writes its audit row in the same transaction; the handlers only
 * validate and shape.
 */
import { z } from 'zod';
import { Permissions } from '../../core/context';
import { errors } from '../../core/errors';
import type { Executor } from '../../db/client';
import type { HttpBodyMapping, HttpParameterMapping } from '../../db/schema';
import { createHttpOperation, createHttpService } from '../../http/service';
import {
  allToolRows,
  catalogToolRows,
  ensureNativeToolRows,
  setToolEnabled,
  setToolsEnabled
} from '../../tools/catalog';
import {
  archiveMcpServer,
  createMcpServer,
  getMcpServer,
  listMcpServers,
  previewMcpServer,
  syncMcpServerTools,
  updateMcpServer
} from '../../tools/mcp';
import { type OpenApiOperationDraft, previewOpenApi } from '../../tools/openapi';
import { getDefaultToolRegistry } from '../../tools/registry';
import { route } from '../types';

const mcpAuthSchema = z.object({
  secretId: z.string().optional(),
  headerName: z.string().max(120).optional(),
  template: z.string().max(500).optional()
});

const mcpServerFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  url: z.string().url().max(2000),
  authType: z.enum(['none', 'bearer', 'custom_header']).optional(),
  authConfig: mcpAuthSchema.nullish(),
  defaultHeaders: z.record(z.string(), z.string()).nullish(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional()
};

/**
 * The native list is registry-derived (it is the source of truth for what the runner
 * can enforce) but carries the row's id and enabled flag so the catalogue can toggle
 * availability without a second lookup.
 */
function nativeDescriptors(db: Executor, workspaceId: string) {
  ensureNativeToolRows(db, workspaceId);
  const byKey = new Map(allToolRows(db, workspaceId).map((row) => [row.key, row]));
  return getDefaultToolRegistry()
    .list()
    .map((tool) => {
      const row = byKey.get(tool.key);
      return {
        id: null,
        rowId: row?.id ?? null,
        key: tool.key,
        name: tool.name,
        description: tool.description,
        kind: 'native' as const,
        inputSchema: tool.inputSchema,
        permission: tool.permission ?? null,
        enabled: row?.enabled ?? true
      };
    });
}

function draftToOperationInput(serviceId: string, draft: OpenApiOperationDraft) {
  return {
    serviceId,
    key: draft.key,
    name: draft.name,
    description: draft.description,
    method: draft.method,
    path: draft.path,
    parameters: draft.parameters as HttpParameterMapping[],
    body: (draft.body ?? null) as HttpBodyMapping | null,
    outputSchema: draft.outputSchema ?? undefined,
    exposeAsTool: true,
    enabled: true
  };
}

export const toolRoutes = [
  route({
    method: 'GET',
    path: '/tools',
    permission: Permissions.agentRead,
    summary: 'Every tool an agent can be granted, grouped by namespace for management',
    handler: ({ db, actor }) => ({
      body: {
        native: nativeDescriptors(db, actor.workspaceId),
        // The catalogue shows disabled rows too; the pickers filter them out.
        stored: catalogToolRows(db, actor)
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/tools/:id',
    permission: Permissions.agentWrite,
    summary: 'Enable or disable a single tool',
    body: z.object({ enabled: z.boolean() }),
    handler: ({ db, actor, params, body }) => ({
      body: { tool: setToolEnabled(db, actor, params.id as string, body.enabled) }
    })
  }),

  route({
    method: 'POST',
    path: '/tools/enabled',
    permission: Permissions.agentWrite,
    summary: 'Enable or disable a set of tools together (a group)',
    body: z.object({ ids: z.array(z.string()).max(500), enabled: z.boolean() }),
    handler: ({ db, actor, body }) => ({
      body: { tools: setToolsEnabled(db, actor, body.ids, body.enabled) }
    })
  }),

  // ------------------------------------------------------------ OpenAPI import
  route({
    method: 'POST',
    path: '/openapi/preview',
    permission: Permissions.agentRead,
    summary: 'Parse an OpenAPI document and describe the operations an import would create',
    body: z.object({
      document: z.string().min(1).max(2_000_000),
      namespace: z.string().max(60).optional()
    }),
    handler: ({ body }) => ({
      body: { preview: previewOpenApi(body.document, { namespace: body.namespace }) }
    })
  }),

  route({
    method: 'POST',
    path: '/openapi/import',
    permission: Permissions.httpWrite,
    summary: 'Import selected OpenAPI operations as HTTP tools',
    body: z.object({
      document: z.string().min(1).max(2_000_000),
      namespace: z.string().max(60).optional(),
      keys: z.array(z.string()).min(1).max(200),
      serviceId: z.string().nullish(),
      service: z
        .object({
          name: z.string().trim().min(1).max(120),
          description: z.string().max(2000).nullish(),
          baseUrl: z.string().url(),
          authType: z
            .enum(['none', 'bearer', 'api_key_header', 'api_key_query', 'basic', 'custom_header'])
            .optional(),
          authConfig: z.record(z.string(), z.unknown()).nullish()
        })
        .nullish()
    }),
    handler: async ({ db, actor, body }) => {
      const preview = previewOpenApi(body.document, { namespace: body.namespace });
      let serviceId = body.serviceId ?? null;
      if (!serviceId) {
        if (!body.service) {
          // Without an existing service the import must be told where to point.
          throw errors.validation('An import needs a serviceId or a new service definition');
        }
        const service = await createHttpService(db, actor, {
          name: body.service.name,
          description: body.service.description ?? null,
          baseUrl: body.service.baseUrl,
          authType: body.service.authType ?? 'none',
          authConfig: (body.service.authConfig ?? null) as never
        });
        serviceId = service.id;
      }

      const wanted = new Set(body.keys);
      const drafts = preview.operations.filter((operation) => wanted.has(operation.key));
      const operations = [];
      for (const draft of drafts) {
        operations.push(
          await createHttpOperation(db, actor, draftToOperationInput(serviceId, draft))
        );
      }
      return {
        status: 201,
        body: { serviceId, imported: operations.length, operations }
      };
    }
  }),

  // ------------------------------------------------------------------- MCP
  route({
    method: 'GET',
    path: '/mcp/servers',
    permission: Permissions.mcpRead,
    summary: 'Registered MCP servers with their discovery state',
    handler: ({ db, actor }) => ({ body: { servers: listMcpServers(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/mcp/servers/preview',
    permission: Permissions.mcpWrite,
    summary: 'Connect to an MCP server and list the tools it advertises (no writes)',
    body: z.object(mcpServerFields),
    handler: async ({ db, actor, body }) => ({
      body: { server: await previewMcpServer(db, actor, body as never) }
    })
  }),

  route({
    method: 'POST',
    path: '/mcp/servers',
    permission: Permissions.mcpWrite,
    summary: 'Register an MCP server and materialise the tools it advertises',
    body: z.object({
      ...mcpServerFields,
      /** When present, only these advertised tools are imported. */
      toolNames: z.array(z.string()).max(500).optional()
    }),
    handler: async ({ db, actor, body }) => {
      const { toolNames, ...serverInput } = body;
      const server = await createMcpServer(db, actor, serverInput as never);
      const sync = await syncMcpServerTools(db, actor, server.id, {
        includeToolNames: toolNames
      });
      return {
        status: 201,
        body: {
          server: sync.server,
          tools: sync.tools,
          created: sync.created,
          updated: sync.updated
        }
      };
    }
  }),

  route({
    method: 'PATCH',
    path: '/mcp/servers/:id',
    permission: Permissions.mcpWrite,
    summary: 'Update an MCP server connection',
    body: z.object({ ...mcpServerFields, enabled: z.boolean().optional() }).partial(),
    handler: async ({ db, actor, params, body }) => ({
      body: { server: await updateMcpServer(db, actor, params.id as string, body as never) }
    })
  }),

  route({
    method: 'POST',
    path: '/mcp/servers/:id/discover',
    permission: Permissions.mcpWrite,
    summary: 'Re-sync the tools advertised by an MCP server',
    handler: async ({ db, actor, params }) => {
      const sync = await syncMcpServerTools(db, actor, params.id as string);
      return {
        body: {
          server: sync.server,
          tools: sync.tools,
          created: sync.created,
          updated: sync.updated
        }
      };
    }
  }),

  route({
    method: 'GET',
    path: '/mcp/servers/:id',
    permission: Permissions.mcpRead,
    summary: 'MCP server detail',
    handler: ({ db, actor, params }) => ({
      body: { server: getMcpServer(db, actor, params.id as string) }
    })
  }),

  route({
    method: 'DELETE',
    path: '/mcp/servers/:id',
    permission: Permissions.mcpWrite,
    summary: 'Remove an MCP server and disable its tools',
    handler: async ({ db, actor, params }) => {
      await archiveMcpServer(db, actor, params.id as string);
      return { status: 204 };
    }
  })
];
