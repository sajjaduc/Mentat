/**
 * Native state tools (`mentat.state.*`).
 *
 * These are the model-facing surface over `src/lib/server/state`. The runner checks
 * the declared `permission` before the handler runs; the handler additionally
 * asserts it so a caller that bypasses the runner (tests, internal reuse) cannot
 * skip authorization. `mentat.state.set` with `scope: 'workspace'` is refused by
 * Mentat — not by the model — unless the actor holds `config:write`, the permission
 * the execution engine derives from `AgentPermissions.canWriteWorkspaceState`.
 */
import { z } from 'zod';
import { assertPermission, hasPermission, Permissions } from '../../core/context';
import {
  deleteStateValue,
  getStateValue,
  listState,
  type StateEntryView,
  setStateValue
} from '../../state/service';
import { defineNativeTool, type ToolInvocationContext, toolFailure, toolSuccess } from '../types';
import { inputJsonSchema, outputJsonSchema, parseToolInput } from './schema';

export const stateScopeSchema = z.enum(['workspace', 'workflow', 'workflowItem', 'agent', 'run']);

const ownerFields = {
  workflowId: z.string().min(1).optional(),
  workflowItemId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  runId: z.string().min(1).optional()
};

const stateEntrySchema = z.object({
  id: z.string(),
  scope: stateScopeSchema,
  workflowId: z.string().nullable(),
  workflowItemId: z.string().nullable(),
  agentId: z.string().nullable(),
  runId: z.string().nullable(),
  namespace: z.string(),
  key: z.string(),
  value: z.unknown(),
  version: z.number().int(),
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});

const getInput = z.object({
  scope: stateScopeSchema,
  key: z.string().min(1),
  namespace: z.string().min(1).optional(),
  ...ownerFields
});

const getOutput = z.object({
  found: z.boolean(),
  entry: stateEntrySchema.nullable()
});

const setInput = z.object({
  scope: stateScopeSchema,
  key: z.string().min(1),
  value: z.unknown(),
  namespace: z.string().min(1).optional(),
  ttlSeconds: z.number().positive().optional(),
  ...ownerFields
});

const setOutput = z.object({ entry: stateEntrySchema });

const deleteInput = z.object({
  scope: stateScopeSchema,
  key: z.string().min(1),
  namespace: z.string().min(1).optional(),
  ...ownerFields
});

const deleteOutput = z.object({ deleted: z.boolean(), scope: stateScopeSchema, key: z.string() });

const listInput = z.object({
  scope: stateScopeSchema,
  namespace: z.string().min(1).optional(),
  prefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  ...ownerFields
});

const listOutput = z.object({ entries: z.array(stateEntrySchema) });

type OwnerInput = {
  workflowId?: string;
  workflowItemId?: string;
  agentId?: string;
  runId?: string;
};

/**
 * Owner ids default from the invocation context so an agent running on a work item
 * can address workflow-item-scoped state without echoing ids the runner already knows.
 */
function resolveOwners(input: OwnerInput, context: ToolInvocationContext) {
  return {
    workflowId: input.workflowId ?? context.workflowId ?? undefined,
    workflowItemId: input.workflowItemId ?? context.workflowItemId ?? undefined,
    agentId:
      input.agentId ??
      (context.actor.actorType === 'agent' ? (context.actor.actorId ?? undefined) : undefined),
    runId: input.runId ?? context.runId ?? undefined
  };
}

export const stateGetTool = defineNativeTool({
  key: 'mentat.state.get',
  name: 'Get agent state',
  description:
    'Read a scoped state value by key. Scopes are workspace, workflow, workflowItem, agent and run; ' +
    'the owner id for the scope is taken from the call or from the current run context. ' +
    'Returns found=false when the key is absent or expired. Idempotent.',
  inputSchema: inputJsonSchema(getInput),
  outputSchema: outputJsonSchema(getOutput),
  permission: Permissions.dataRead,
  async execute(input, context) {
    const parsed = parseToolInput(getInput, input);
    assertPermission(context.actor, Permissions.dataRead, 'Not permitted to read state');
    const entry = getStateValue(context.db, context.actor, {
      scope: parsed.scope,
      key: parsed.key,
      namespace: parsed.namespace,
      ...resolveOwners(parsed, context)
    });
    return toolSuccess({ found: entry !== null, entry: entry as StateEntryView | null });
  }
});

export const stateSetTool = defineNativeTool({
  key: 'mentat.state.set',
  name: 'Set agent state',
  description:
    'Create or replace a scoped state value, optionally with a TTL in seconds. Repeating the ' +
    'same call converges on one row and bumps its version. Workspace-scope writes are refused ' +
    'unless the actor holds the explicit workspace grant.',
  inputSchema: inputJsonSchema(setInput),
  outputSchema: outputJsonSchema(setOutput),
  permission: Permissions.dataWrite,
  async execute(input, context) {
    const parsed = parseToolInput(setInput, input);
    assertPermission(context.actor, Permissions.dataWrite, 'Not permitted to write state');
    if (parsed.scope === 'workspace' && !hasPermission(context.actor, Permissions.configWrite)) {
      return toolFailure({
        code: 'policy_denied',
        message: 'Workspace-scoped state writes require an explicit workspace grant',
        details: { scope: 'workspace', requiredPermission: Permissions.configWrite }
      });
    }
    const entry = setStateValue(context.db, context.actor, {
      scope: parsed.scope,
      key: parsed.key,
      value: parsed.value,
      namespace: parsed.namespace,
      ttlSeconds: parsed.ttlSeconds,
      ...resolveOwners(parsed, context)
    });
    return toolSuccess({ entry });
  }
});

export const stateDeleteTool = defineNativeTool({
  key: 'mentat.state.delete',
  name: 'Delete agent state',
  description:
    'Delete a scoped state value. Idempotent: a missing or already-expired key returns ' +
    'deleted=false rather than failing.',
  inputSchema: inputJsonSchema(deleteInput),
  outputSchema: outputJsonSchema(deleteOutput),
  permission: Permissions.dataWrite,
  async execute(input, context) {
    const parsed = parseToolInput(deleteInput, input);
    assertPermission(context.actor, Permissions.dataWrite, 'Not permitted to delete state');
    if (parsed.scope === 'workspace' && !hasPermission(context.actor, Permissions.configWrite)) {
      return toolFailure({
        code: 'policy_denied',
        message: 'Workspace-scoped state deletes require an explicit workspace grant',
        details: { scope: 'workspace', requiredPermission: Permissions.configWrite }
      });
    }
    const deleted = deleteStateValue(context.db, context.actor, {
      scope: parsed.scope,
      key: parsed.key,
      namespace: parsed.namespace,
      ...resolveOwners(parsed, context)
    });
    return toolSuccess({ deleted, scope: parsed.scope, key: parsed.key });
  }
});

export const stateListTool = defineNativeTool({
  key: 'mentat.state.list',
  name: 'List agent state',
  description:
    'List the newest state entries in a scope, optionally filtered by namespace and key ' +
    'prefix. Non-workspace scopes require their owner id. Never returns another workspace ' +
    'or another work item’s values. Idempotent.',
  inputSchema: inputJsonSchema(listInput),
  outputSchema: outputJsonSchema(listOutput),
  permission: Permissions.dataRead,
  async execute(input, context) {
    const parsed = parseToolInput(listInput, input);
    assertPermission(context.actor, Permissions.dataRead, 'Not permitted to read state');
    const entries = listState(context.db, context.actor, {
      scope: parsed.scope,
      namespace: parsed.namespace,
      prefix: parsed.prefix,
      limit: parsed.limit,
      ...resolveOwners(parsed, context)
    });
    return toolSuccess({ entries });
  }
});

export const stateTools = [stateGetTool, stateSetTool, stateDeleteTool, stateListTool];

/** Guard used by the index test to keep the documented surface honest. */
export function stateToolKeys(): string[] {
  return stateTools.map((tool) => tool.key).sort();
}
