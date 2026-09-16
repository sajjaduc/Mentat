/**
 * Workflow API: workflows, states, transitions, fields, transfer rules and boards.
 *
 * Workflow configuration is what makes a workflow a state machine, so this module
 * exposes the full configuration surface the state designer and the workflow
 * configuration tabs need — and nothing that bypasses the services.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Permissions } from '../../core/context';
import { workflowStates } from '../../db/schema';
import {
  archiveFieldDefinition,
  createFieldDefinition,
  fieldUsage,
  listFieldDefinitions,
  listWorkflowFields,
  setWorkflowFields,
  updateFieldDefinition
} from '../../fields/service';
import { compileTicketFilterDetailed } from '../../filters/compile';
import { getBoard, parseFilterInput } from '../../tickets/query';
import { previewTransfer } from '../../tickets/service';
import {
  archiveWorkflow,
  availableTransitions,
  createState,
  createTransition,
  createWorkflow,
  deleteState,
  deleteTransferRule,
  deleteTransition,
  getWorkflowDetail,
  listStates,
  listTransferRules,
  listTransitions,
  listWorkflows,
  reorderStates,
  setTransferRule,
  updateState,
  updateWorkflow,
  WORKFLOW_TEMPLATES
} from '../../workflows/service';
import { mutate } from '../helpers';
import { route } from '../types';

const humanGateSchema = z.object({
  enabled: z.boolean(),
  allowedTransitionIds: z.array(z.string()).optional(),
  requiredFieldKeys: z.array(z.string()).optional(),
  requiredComment: z.boolean().optional(),
  allowedRoles: z.array(z.enum(['owner', 'admin', 'member'])).optional(),
  allowedTeamIds: z.array(z.string()).optional(),
  instructions: z.string().max(2000).optional()
});

const stateConfigSchema = z
  .object({
    systemAction: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    allowedToolKeys: z.array(z.string()).optional(),
    runOncePerEntry: z.boolean().optional(),
    wipLimit: z.number().int().min(0).optional(),
    slaSeconds: z.number().int().min(0).optional()
  })
  .nullish();

const stateBody = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  kind: z.enum(['manual', 'agent', 'system', 'terminal']).optional(),
  category: z.enum(['backlog', 'active', 'review', 'done', 'cancelled']).optional(),
  color: z.string().max(40).nullish(),
  position: z.number().int().min(0).optional(),
  isStart: z.boolean().optional(),
  isTerminal: z.boolean().optional(),
  agentId: z.string().nullish(),
  autoExecute: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).nullish(),
  failureStateId: z.string().nullish(),
  humanGate: humanGateSchema.nullish(),
  config: stateConfigSchema
};

export const workflowRoutes = [
  route({
    method: 'GET',
    path: '/workflow-templates',
    permission: Permissions.workflowRead,
    summary: 'Available workflow templates',
    handler: () => ({
      body: {
        templates: Object.entries(WORKFLOW_TEMPLATES).map(([key, template]) => ({
          key,
          label: template.label,
          description: template.description,
          stateCount: template.states.length
        }))
      }
    })
  }),

  route({
    method: 'GET',
    path: '/workflows',
    permission: Permissions.workflowRead,
    summary: 'List workflows with ticket and state counts',
    handler: ({ db, actor, request }) => {
      const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
      return { body: { workflows: listWorkflows(db, actor, { includeArchived }) } };
    }
  }),

  route({
    method: 'POST',
    path: '/workflows',
    permission: Permissions.workflowWrite,
    summary: 'Create a workflow from a template',
    body: z.object({
      name: z.string().trim().min(1).max(120),
      key: z.string().trim().max(12).optional(),
      description: z.string().max(2000).nullish(),
      icon: z.string().max(60).nullish(),
      color: z.string().max(40).nullish(),
      template: z.enum(['blank', 'basic', 'intake', 'claims', 'support']).optional(),
      settings: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: mutate(db, (tx) => createWorkflow(tx, actor, body as never))
    })
  }),

  route({
    method: 'GET',
    path: '/workflows/:id',
    permission: Permissions.workflowRead,
    summary: 'Workflow detail with states, transitions and transfer rules',
    handler: ({ db, actor, params }) => ({
      body: getWorkflowDetail(db, actor, params.id as string)
    })
  }),

  route({
    method: 'PATCH',
    path: '/workflows/:id',
    permission: Permissions.workflowWrite,
    summary: 'Update workflow metadata, settings or default state',
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(2000).nullish(),
      icon: z.string().max(60).nullish(),
      color: z.string().max(40).nullish(),
      settings: z.record(z.string(), z.unknown()).nullish(),
      defaultStateId: z.string().nullish()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: {
        workflow: mutate(db, (tx) =>
          updateWorkflow(tx, actor, {
            workflowId: params.id as string,
            ...(body as object)
          } as never)
        )
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/workflows/:id',
    permission: Permissions.workflowAdmin,
    summary: 'Archive a workflow (soft delete)',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => archiveWorkflow(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/workflows/:id/board',
    permission: Permissions.ticketRead,
    summary: 'Board columns with tickets, honouring a filter AST',
    handler: async ({ db, actor, params, query }) => {
      const options = (query ?? {}) as { filter?: unknown; search?: unknown; limit?: unknown };
      const filter = parseFilterInput(options.filter ?? null);
      const board = await getBoard(db, {
        workspaceId: actor.workspaceId,
        workflowId: params.id as string,
        filter,
        search: typeof options.search === 'string' ? options.search : null,
        perColumnLimit: typeof options.limit === 'number' ? options.limit : 50
      });
      const compiled = await compileTicketFilterDetailed(db, {
        workspaceId: actor.workspaceId,
        filter
      });
      return { body: { ...board, unresolvedFields: compiled.unresolved } };
    }
  }),

  route({
    method: 'GET',
    path: '/workflows/:id/states',
    permission: Permissions.workflowRead,
    summary: 'States in board order',
    handler: ({ db, actor, params }) => ({
      body: { states: listStates(db, actor.workspaceId, params.id as string) }
    })
  }),

  route({
    method: 'POST',
    path: '/workflows/:id/states',
    permission: Permissions.workflowWrite,
    summary: 'Create a state',
    body: z.object(stateBody),
    handler: ({ db, actor, params, body }) => ({
      status: 201,
      body: {
        state: mutate(db, (tx) => createState(tx, actor, params.id as string, body as never))
      }
    })
  }),

  route({
    method: 'PATCH',
    path: '/states/:id',
    permission: Permissions.workflowWrite,
    summary: 'Update a state, including its human gate and agent binding',
    body: z.object(stateBody).partial(),
    handler: ({ db, actor, params, body }) => ({
      body: {
        state: mutate(db, (tx) =>
          updateState(tx, actor, { stateId: params.id as string, ...(body as object) } as never)
        )
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/states/:id',
    permission: Permissions.workflowWrite,
    summary: 'Delete a state that holds no tickets',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => deleteState(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  route({
    method: 'PUT',
    path: '/workflows/:id/states/order',
    permission: Permissions.workflowWrite,
    summary: 'Reorder board columns',
    body: z.object({ stateIds: z.array(z.string()) }),
    handler: async ({ db, actor, params, body }) => {
      await mutate(db, (tx) =>
        reorderStates(tx, actor, params.id as string, (body as { stateIds: string[] }).stateIds)
      );
      return { body: { ok: true } };
    }
  }),

  route({
    method: 'GET',
    path: '/workflows/:id/transitions',
    permission: Permissions.workflowRead,
    summary: 'All transitions in a workflow',
    handler: ({ db, actor, params }) => ({
      body: { transitions: listTransitions(db, actor.workspaceId, params.id as string) }
    })
  }),

  route({
    method: 'POST',
    path: '/workflows/:id/transitions',
    permission: Permissions.workflowWrite,
    summary: 'Create a transition',
    body: z.object({
      fromStateId: z.string().nullish(),
      toStateId: z.string(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      requiresComment: z.boolean().optional(),
      requiredFieldKeys: z.array(z.string()).optional(),
      allowedRoles: z.array(z.string()).optional(),
      condition: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: ({ db, actor, params, body }) => ({
      status: 201,
      body: {
        transition: mutate(db, (tx) =>
          createTransition(tx, actor, params.id as string, body as never)
        )
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/transitions/:id',
    permission: Permissions.workflowWrite,
    summary: 'Delete a transition',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => deleteTransition(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/states/:id/transitions',
    permission: Permissions.ticketRead,
    summary: 'Transitions available to the caller from a state',
    handler: ({ db, actor, params }) => ({
      body: { transitions: availableTransitionsForState(db, actor, params.id as string) }
    })
  }),

  // ------------------------------------------------------------------ fields
  route({
    method: 'GET',
    path: '/fields',
    permission: Permissions.workspaceRead,
    summary: 'Workspace field definitions',
    handler: ({ db, actor, request }) => {
      const scope = new URL(request.url).searchParams.get('scope');
      return {
        body: {
          fields: listFieldDefinitions(db, actor, {
            scope: scope === 'file' ? 'file' : scope === 'ticket' ? 'ticket' : undefined
          })
        }
      };
    }
  }),

  route({
    method: 'POST',
    path: '/fields',
    permission: Permissions.workflowWrite,
    summary: 'Create a reusable field definition',
    body: z.object({
      key: z.string().trim().max(48).optional(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2000).nullish(),
      type: z.enum([
        'short_text',
        'long_text',
        'number',
        'currency',
        'boolean',
        'date',
        'datetime',
        'select',
        'multi_select',
        'user',
        'team',
        'url',
        'email',
        'phone',
        'json'
      ]),
      scope: z.enum(['ticket', 'file']).optional(),
      options: z.record(z.string(), z.unknown()).nullish(),
      defaultValue: z.unknown().optional(),
      validation: z.record(z.string(), z.unknown()).nullish(),
      display: z.record(z.string(), z.unknown()).nullish()
    }),
    handler: ({ db, actor, body }) => ({
      status: 201,
      body: { field: mutate(db, (tx) => createFieldDefinition(tx, actor, body as never)) }
    })
  }),

  route({
    method: 'PATCH',
    path: '/fields/:id',
    permission: Permissions.workflowWrite,
    summary: 'Update a field definition',
    body: z.record(z.string(), z.unknown()),
    handler: ({ db, actor, params, body }) => ({
      body: {
        field: mutate(db, (tx) =>
          updateFieldDefinition(tx, actor, {
            fieldId: params.id as string,
            ...(body as object)
          } as never)
        )
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/fields/:id',
    permission: Permissions.workflowWrite,
    summary: 'Archive a field definition (values and history are retained)',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => archiveFieldDefinition(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  route({
    method: 'GET',
    path: '/fields/:id/usage',
    permission: Permissions.workspaceRead,
    summary: 'How many ticket values reference a field',
    handler: ({ db, actor, params }) => ({
      body: { usage: fieldUsage(db, actor.workspaceId, params.id as string) }
    })
  }),

  route({
    method: 'GET',
    path: '/workflows/:id/fields',
    permission: Permissions.workflowRead,
    summary: 'Fields configured on a workflow',
    handler: ({ db, actor, params }) => ({
      body: { fields: listWorkflowFields(db, actor, params.id as string) }
    })
  }),

  route({
    method: 'PUT',
    path: '/workflows/:id/fields',
    permission: Permissions.workflowWrite,
    summary: 'Replace a workflow’s field configuration',
    body: z.object({
      fields: z.array(
        z.object({
          fieldDefinitionId: z.string(),
          position: z.number().int().min(0).optional(),
          required: z.boolean().optional(),
          visible: z.boolean().optional(),
          editable: z.boolean().optional(),
          defaultValue: z.unknown().optional(),
          requiredInStates: z.array(z.string()).nullish(),
          showOnCard: z.boolean().optional(),
          showInList: z.boolean().optional(),
          filterable: z.boolean().optional(),
          requiredForTransfer: z.boolean().optional()
        })
      )
    }),
    handler: ({ db, actor, params, body }) => ({
      body: {
        fields: mutate(db, (tx) =>
          setWorkflowFields(tx, actor, params.id as string, (body as { fields: never[] }).fields)
        )
      }
    })
  }),

  // -------------------------------------------------------- transfer rules
  route({
    method: 'GET',
    path: '/workflows/:id/transfer-rules',
    permission: Permissions.workflowRead,
    summary: 'Cross-workflow transfer rules defined by a workflow',
    handler: ({ db, actor, params }) => ({
      body: { rules: listTransferRules(db, actor.workspaceId, params.id as string) }
    })
  }),

  route({
    method: 'PUT',
    path: '/workflows/:id/transfer-rules',
    permission: Permissions.workflowWrite,
    summary: 'Create or replace a transfer rule',
    body: z.object({
      targetWorkflowId: z.string(),
      defaultTargetStateId: z.string().nullish(),
      fieldMappings: z.record(z.string(), z.string()).optional(),
      requiredTargetFieldKeys: z.array(z.string()).optional(),
      allowAgents: z.boolean().optional(),
      allowHumans: z.boolean().optional(),
      requiresApproval: z.boolean().optional(),
      carryLabels: z.boolean().optional()
    }),
    handler: ({ db, actor, params, body }) => ({
      body: {
        rule: mutate(db, (tx) => setTransferRule(tx, actor, params.id as string, body as never))
      }
    })
  }),

  route({
    method: 'DELETE',
    path: '/transfer-rules/:id',
    permission: Permissions.workflowWrite,
    summary: 'Remove a transfer rule',
    handler: async ({ db, actor, params }) => {
      await mutate(db, (tx) => deleteTransferRule(tx, actor, params.id as string));
      return { status: 204 };
    }
  }),

  route({
    method: 'POST',
    path: '/tickets/:id/transfer-preview',
    permission: Permissions.ticketTransfer,
    summary: 'Preview a cross-workflow move: policy, mappings and missing fields',
    body: z.object({ targetWorkflowId: z.string() }),
    handler: ({ db, actor, params, body }) => ({
      body: previewTransfer(db, actor, {
        ticketId: params.id as string,
        targetWorkflowId: (body as { targetWorkflowId: string }).targetWorkflowId
      })
    })
  })
];

/** Transitions available from a state, resolved through the workflow service. */
function availableTransitionsForState(
  db: Parameters<typeof availableTransitions>[0],
  actor: Parameters<typeof availableTransitions>[1],
  stateId: string
) {
  const state = db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.id, stateId))
    .limit(1)
    .all()[0];
  if (!state) return [];
  return availableTransitions(db, actor, state.workflowId, stateId);
}
