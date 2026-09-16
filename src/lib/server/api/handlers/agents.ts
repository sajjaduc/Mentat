/**
 * Agents, skills, tools, providers and models.
 *
 * The configuration surface an operator uses to make agents runnable: define an
 * agent (with skills and tools), connect a provider (Ollama by default), discover
 * its models, and select one. Every mutation goes through the versioning services,
 * so an agent edit produces an immutable version rather than mutating history.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentView } from '../../agents/service';
import {
  agentRunStats,
  archiveAgent,
  archiveSkill,
  createAgent,
  createSkill,
  getAgentView,
  getSkillView,
  listAgents,
  listAgentVersions,
  listSkills,
  updateAgent,
  updateSkill
} from '../../agents/service';
import { env } from '../../config/env';
import { Permissions } from '../../core/context';
import type { Executor } from '../../db/client';
import {
  deleteModel,
  listModels,
  registerModel,
  setEnabled,
  setFavorite,
  updateModel
} from '../../providers/models';
import {
  checkHealth,
  deleteProvider,
  listProviders,
  refreshModels,
  registerProvider,
  updateProvider
} from '../../providers/service';
import { mutate, queryInt, queryString } from '../helpers';
import { route } from '../types';

const agentBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  instructions: z.string().max(20_000).optional(),
  workflowId: z.string().nullish(),
  providerId: z.string().nullish(),
  modelId: z.string().nullish(),
  skillIds: z.array(z.string()).optional(),
  toolIds: z.array(z.string()).optional(),
  outputSchema: z.unknown().optional(),
  executionConfig: z.record(z.string(), z.unknown()).nullish(),
  permissions: z.record(z.string(), z.unknown()).nullish(),
  bindingMode: z.enum(['use_asis', 'override', 'fork']).optional(),
  sourceAgentId: z.string().nullish()
});

/**
 * Attach run statistics to an agent row.
 *
 * Every agent the API returns carries `stats`, because the agents list renders them
 * and a client that appends a created or updated agent should not have to special-case
 * the missing field.
 */
function withRunStats(
  db: Executor,
  workspaceId: string,
  agent: AgentView
): AgentView & { stats: { runs: number; failures: number; lastRunAt: number | null } } {
  const stats = agentRunStats(db, workspaceId, [agent.id]);
  return {
    ...agent,
    stats: stats.get(agent.id) ?? { runs: 0, failures: 0, lastRunAt: null }
  };
}

export const agentRoutes = [
  route({
    method: 'GET',
    path: '/agents',
    permission: Permissions.agentRead,
    summary: 'Agents with skills, tools and run statistics',
    handler: ({ db, actor, query }) => {
      const workflowId = queryString({ query } as never, 'workflowId');
      const agents = listAgents(db, actor, {
        workflowId: workflowId === null ? undefined : workflowId
      });
      return {
        body: { agents: agents.map((agent) => withRunStats(db, actor.workspaceId, agent)) }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/agents',
    permission: Permissions.agentWrite,
    summary: 'Create an agent (version 1)',
    body: agentBody,
    handler: async ({ db, actor, body }) => {
      const agent = await mutate(db, (tx) => createAgent(tx, actor, body as never));
      return { status: 201, body: { agent: withRunStats(db, actor.workspaceId, agent) } };
    }
  }),

  route({
    method: 'GET',
    path: '/agents/:id',
    permission: Permissions.agentRead,
    summary: 'Agent detail with the current version snapshot',
    handler: ({ db, actor, params }) => {
      const agent = withRunStats(
        db,
        actor.workspaceId,
        getAgentView(db, actor, params.id as string)
      );
      const versions = listAgentVersions(db, actor, params.id as string);
      return { body: { agent, versions } };
    }
  }),

  route({
    method: 'PATCH',
    path: '/agents/:id',
    permission: Permissions.agentWrite,
    summary: 'Update an agent, producing a new immutable version',
    body: agentBody.partial().extend({ changeNote: z.string().max(500).optional() }),
    handler: async ({ db, actor, params, body }) => {
      const agent = await mutate(db, (tx) =>
        updateAgent(tx, actor, { agentId: params.id as string, ...(body as object) } as never)
      );
      return { body: { agent: withRunStats(db, actor.workspaceId, agent) } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/agents/:id',
    permission: Permissions.agentWrite,
    summary: 'Archive an agent that is not bound to a state',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => archiveAgent(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  // ------------------------------------------------------------------- skills
  route({
    method: 'GET',
    path: '/skills',
    permission: Permissions.agentRead,
    summary: 'Skills with their current version content',
    handler: ({ db, actor }) => ({ body: { skills: listSkills(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/skills',
    permission: Permissions.agentWrite,
    summary: 'Create a skill (version 1)',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      category: z.string().max(60).nullish(),
      workflowId: z.string().nullish(),
      instructions: z.string().max(50_000).optional(),
      examples: z
        .array(
          z.object({
            title: z.string(),
            input: z.string().optional(),
            output: z.string().optional(),
            notes: z.string().optional()
          })
        )
        .optional(),
      references: z
        .array(
          z.object({
            title: z.string(),
            url: z.string().optional(),
            content: z.string().optional()
          })
        )
        .optional(),
      recommendedToolKeys: z.array(z.string()).optional()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: { skill: mutate(db, (tx) => createSkill(tx, actor, body as never)) }
    })
  }),

  route({
    method: 'GET',
    path: '/skills/:id',
    permission: Permissions.agentRead,
    summary: 'Skill detail',
    handler: ({ db, actor, params }) => ({
      body: { skill: getSkillView(db, actor, params.id as string) }
    })
  }),

  route({
    method: 'PATCH',
    path: '/skills/:id',
    permission: Permissions.agentWrite,
    summary: 'Update a skill, producing a new version',
    body: z.record(z.string(), z.unknown()),
    handler: ({ db, actor, params, body }) => ({
      body: {
        skill: mutate(db, (tx) =>
          updateSkill(tx, actor, { skillId: params.id as string, ...(body as object) } as never)
        )
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/skills/:id',
    permission: Permissions.agentWrite,
    summary: 'Archive a skill that no agent references',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => archiveSkill(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  // -------------------------------------------------------------------- tools
  // The tool catalogue and its write paths live in `./tools`, because management
  // (enable/disable, OpenAPI import, MCP registration) is a surface of its own.

  // ---------------------------------------------------------------- providers
  route({
    method: 'GET',
    path: '/providers',
    permission: Permissions.providerRead,
    summary: 'Providers with health and model counts',
    handler: ({ db, actor }) => ({ body: { providers: listProviders(db, actor) } })
  }),

  route({
    method: 'POST',
    path: '/providers',
    permission: Permissions.providerWrite,
    summary: 'Register a provider (Ollama, OpenAI-compatible, Anthropic or fake)',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      type: z.enum(['ollama', 'openai', 'openai_compatible', 'anthropic', 'fake']),
      baseUrl: z.string().url().nullish(),
      apiKeySecretId: z.string().nullish(),
      config: z.record(z.string(), z.unknown()).nullish(),
      isDefault: z.boolean().optional()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { provider: await registerProvider(db, actor, body as never) }
    })
  }),

  route({
    method: 'POST',
    path: '/providers/suggest',
    permission: Permissions.providerRead,
    summary: 'Suggested defaults for a provider type (local Ollama URL)',
    body: z.object({ type: z.enum(['ollama', 'openai', 'openai_compatible', 'anthropic']) }),
    handler: ({ body }) => ({
      body: {
        baseUrl: (body as { type: string }).type === 'ollama' ? env().MENTAT_OLLAMA_URL : null
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/providers/:id',
    permission: Permissions.providerWrite,
    summary: 'Update provider configuration',
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      baseUrl: z.string().url().nullish(),
      apiKeySecretId: z.string().nullish(),
      config: z.record(z.string(), z.unknown()).nullish(),
      enabled: z.boolean().optional(),
      isDefault: z.boolean().optional()
    }),
    handler: async ({ db, actor, params, body }) => ({
      body: {
        provider: await updateProvider(db, actor, params.id as string, body as never)
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/providers/:id',
    permission: Permissions.providerWrite,
    summary: 'Delete a provider with no models',
    handler: async ({ db, actor, params }) => {
      await deleteProvider(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/providers/:id/health',
    permission: Permissions.providerRead,
    summary: 'Test connectivity and record a health check',
    handler: async ({ db, actor, params }) => ({
      body: await checkHealth(db, actor, params.id as string)
    })
  }),

  route({
    method: 'POST',
    path: '/providers/:id/refresh-models',
    permission: Permissions.providerWrite,
    summary: 'Discover installed models and upsert them',
    handler: async ({ db, actor, params }) => ({
      body: await refreshModels(db, actor, params.id as string)
    })
  }),

  // ------------------------------------------------------------------- models
  route({
    method: 'GET',
    path: '/models',
    permission: Permissions.providerRead,
    summary: 'Selectable models',
    handler: ({ db, actor, request }) => {
      const includeDisabled = new URL(request.url).searchParams.get('all') === 'true';
      return { body: { models: listModels(db, actor, { includeDisabled }) } };
    }
  }),

  route({
    method: 'POST',
    path: '/models',
    permission: Permissions.providerWrite,
    summary: 'Register a model by hand with explicit capabilities',
    body: z.object({
      providerId: z.string(),
      modelKey: z.string().trim().min(1).max(200),
      displayName: z.string().trim().min(1).max(200).optional(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
      contextWindow: z.number().int().min(0).nullish(),
      maxOutputTokens: z.number().int().min(0).nullish(),
      inferenceDefaults: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: async ({ db, actor, body }) => ({
      status: 201,
      body: { model: await registerModel(db, actor, body as never) }
    })
  }),

  route({
    method: 'PATCH',
    path: '/models/:id',
    permission: Permissions.providerWrite,
    summary: 'Update model defaults, capabilities or enabled state',
    body: z.object({
      displayName: z.string().trim().max(200).optional(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
      contextWindow: z.number().int().min(0).nullish(),
      maxOutputTokens: z.number().int().min(0).nullish(),
      inferenceDefaults: z.record(z.string(), z.unknown()).nullish(),
      enabled: z.boolean().optional(),
      isFavorite: z.boolean().optional()
    }),
    handler: async ({ db, actor, params, body }) => {
      const input = body as Record<string, unknown>;
      if (input.enabled !== undefined) {
        await setEnabled(db, actor, params.id as string, input.enabled as boolean);
      }
      if (input.isFavorite !== undefined) {
        await setFavorite(db, actor, params.id as string, input.isFavorite as boolean);
      }
      const patch: Record<string, unknown> = {};
      for (const key of [
        'displayName',
        'capabilities',
        'contextWindow',
        'maxOutputTokens',
        'inferenceDefaults'
      ]) {
        if (input[key] !== undefined) patch[key] = input[key];
      }
      if (Object.keys(patch).length > 0) {
        await updateModel(db, actor, params.id as string, patch as never);
      }
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'DELETE',
    path: '/models/:id',
    permission: Permissions.providerWrite,
    summary: 'Delete a model that no run references',
    handler: async ({ db, actor, params }) => {
      await deleteModel(db, actor, params.id as string);
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/agents/:id/versions',
    permission: Permissions.agentRead,
    summary: 'Immutable version history for an agent',
    handler: ({ db, actor, params }) => ({
      body: { versions: listAgentVersions(db, actor, params.id as string) }
    })
  }),

  route({
    method: 'GET',
    path: '/runs',
    permission: Permissions.runRead,
    summary: 'Recent runs across the workspace (operator view)',
    handler: async ({ db, actor, query }) => {
      const limit = queryInt({ query } as never, 'limit', 50, { min: 1, max: 200 });
      const rows = await db.all(
        // Drizzle's query builder would need five joins for a view this shallow; a
        // projection over the run table plus agent name is clearer as SQL.
        sql`select r.*, a.name as agent_name, t.key as ticket_key
            from agent_runs r
            left join agents a on a.id = r.agent_id
            left join tickets t on t.id = r.ticket_id
            where r.workspace_id = ${actor.workspaceId}
            order by r.created_at desc
            limit ${limit}`
      );
      return { body: { runs: rows } };
    }
  })
];
