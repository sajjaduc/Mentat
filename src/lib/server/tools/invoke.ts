/**
 * Tool invocation.
 *
 * One place decides whether a tool call is allowed to happen and what it returns:
 *
 *  1. resolve the concrete tool (native handler, or an HTTP operation);
 *  2. assert the coarse service permission *and* the agent's specific native
 *     capability key;
 *  3. validate the arguments against the declared JSON Schema;
 *  4. execute with a timeout, converting thrown errors into structured failures.
 *
 * Approval and caching are *not* decided here: approval is a policy decision made
 * by the runner before invocation, and HTTP caching belongs to the HTTP runtime.
 * Keeping those out of this module is what makes the runner's pause/resume logic
 * easy to reason about.
 */

import { hasNativeCapability } from '../agents/permissions';
import { type ActorContext, hasPermission } from '../core/context';
import { errors, toAppError } from '../core/errors';
import type { Executor } from '../db/client';
import type { ToolImplementation } from '../db/schema';
import { httpToolInvoker } from './http-locator';
import type { NativeToolHandler, ToolRegistry } from './types';

export interface InvokeToolInput {
  key: string;
  toolId?: string | null;
  kind: 'native' | 'http';
  implementation: ToolImplementation;
  input: Record<string, unknown>;
  actor: ActorContext;
  workspaceId: string;
  ticketId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  timeoutSeconds?: number;
  /** Permission keys declared on the tool row. */
  permissions?: string[];
  registry: ToolRegistry;
  signal?: AbortSignal;
}

export interface InvokeToolResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  cacheStatus?: 'hit' | 'miss' | 'bypass' | 'stored';
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export async function invokeTool(db: Executor, input: InvokeToolInput): Promise<InvokeToolResult> {
  if (input.kind === 'native') {
    return invokeNative(db, input);
  }
  return invokeHttp(db, input);
}

async function invokeNative(db: Executor, input: InvokeToolInput): Promise<InvokeToolResult> {
  const handler = input.registry.get(input.key);
  if (!handler) {
    return failure('tool_not_found', `No native tool is registered as "${input.key}"`);
  }

  const denial = assertAllowed(input.actor, handler);
  if (denial) return denial;

  const issues = validateJsonSchema(handler.inputSchema, input.input);
  if (issues.length > 0) {
    return failure('validation_failed', 'Tool arguments failed validation', { issues });
  }

  const controller = new AbortController();
  const timeoutMs = (input.timeoutSeconds ?? 30) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalAbort = () => controller.abort();
  input.signal?.addEventListener('abort', externalAbort, { once: true });

  try {
    const result = await handler.execute(input.input, {
      actor: input.actor,
      db,
      ticketId: input.ticketId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      signal: controller.signal,
      timeoutMs
    });
    return {
      ok: result.ok,
      output: result.output,
      error: result.error,
      cacheStatus: result.cacheStatus,
      durationMs: result.durationMs,
      metadata: result.metadata
    };
  } catch (error) {
    const appError = toAppError(error);
    if (controller.signal.aborted && !input.signal?.aborted) {
      return failure(
        'timeout',
        `Tool "${input.key}" exceeded its ${input.timeoutSeconds ?? 30}s timeout`
      );
    }
    return failure(appError.code, appError.message, appError.details);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', externalAbort);
  }
}

async function invokeHttp(db: Executor, input: InvokeToolInput): Promise<InvokeToolResult> {
  const implementation = input.implementation;
  if (implementation.kind !== 'http') {
    return failure('tool_misconfigured', 'This tool has no HTTP implementation');
  }
  if (!hasPermission(input.actor, 'http:invoke')) {
    return failure('policy_denied', 'This agent is not permitted to call HTTP operations');
  }
  // The operation must have been explicitly granted to the agent.
  if (
    input.actor.actorType === 'agent' &&
    !hasNativeCapability(input.actor.permissions, `http.${implementation.operationId}`) &&
    !hasPermission(input.actor, 'http:write') &&
    input.permissions?.includes('http:write') !== true
  ) {
    const granted = input.actor.permissions.has('http:invoke');
    if (!granted) {
      return failure('policy_denied', 'This agent is not permitted to call that HTTP operation');
    }
  }

  const issues = validateJsonSchema(
    (input as { inputSchema?: Record<string, unknown> }).inputSchema ?? { type: 'object' },
    input.input
  );
  if (issues.length > 0) {
    return failure('validation_failed', 'Operation arguments failed validation', { issues });
  }

  try {
    const invoker = httpToolInvoker();
    const result = await invoker(db, {
      workspaceId: input.workspaceId,
      operationId: implementation.operationId,
      serviceId: implementation.serviceId,
      input: input.input,
      actor: input.actor,
      ticketId: input.ticketId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      approved: true,
      signal: input.signal
    });
    return result;
  } catch (error) {
    const appError = toAppError(error);
    return failure(appError.code, appError.message, appError.details);
  }
}

function assertAllowed(actor: ActorContext, handler: NativeToolHandler): InvokeToolResult | null {
  if (handler.permission && !hasPermission(actor, handler.permission)) {
    return failure('policy_denied', `Not permitted to use ${handler.name}`, {
      requiredPermission: handler.permission
    });
  }
  // Agents additionally need the exact capability key, so a coarse scope never
  // silently grants the whole native surface.
  if (actor.actorType === 'agent' && !hasNativeCapability(actor.permissions, handler.key)) {
    return failure('policy_denied', `This agent is not permitted to use ${handler.name}`, {
      requiredCapability: handler.key
    });
  }
  return null;
}

function failure(
  code: string,
  message: string,
  details?: Record<string, unknown>
): InvokeToolResult {
  return { ok: false, error: { code, message, details } };
}

export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Pragmatic JSON Schema validation covering the constructs Mentat's tools declare:
 * `type`, `required`, `properties`, `enum`, `items` and `additionalProperties`.
 *
 * It intentionally does not attempt to be a complete implementation. It exists so
 * that malformed model output is rejected *before* it reaches domain code, where a
 * wrong shape could otherwise cause a confusing partial write.
 */
export function validateJsonSchema(
  schema: Record<string, unknown> | null | undefined,
  value: unknown,
  path = ''
): SchemaIssue[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  const issues: SchemaIssue[] = [];

  const declared = schema.type;
  if (typeof declared === 'string' && !matchesType(declared, value)) {
    issues.push({ path: path || '(root)', message: `expected ${declared}` });
    return issues;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    issues.push({
      path: path || '(root)',
      message: `must be one of: ${(schema.enum as unknown[]).map((entry) => String(entry)).join(', ')}`
    });
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = (schema.oneOf as Array<Record<string, unknown>>).filter(
      (candidate) => validateJsonSchema(candidate, value, path).length === 0
    );
    if (matching.length === 0) {
      issues.push({ path: path || '(root)', message: 'does not match any allowed shape' });
    }
  }

  if (declared === 'object' || (declared === undefined && isPlainObject(value))) {
    if (!isPlainObject(value)) return issues;
    const properties =
      (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined || entry === null) {
        issues.push({ path: joinPath(path, key), message: 'is required' });
      }
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        issues.push(...validateJsonSchema(propertySchema, entry, joinPath(path, key)));
      } else if (schema.additionalProperties === false) {
        issues.push({ path: joinPath(path, key), message: 'is not an allowed property' });
      }
    }
  }

  if (declared === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({ path: path || '(root)', message: `needs at least ${schema.minItems} item(s)` });
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      value.forEach((entry, index) => {
        issues.push(...validateJsonSchema(items, entry, `${path || '(root)'}[${index}]`));
      });
    }
  }

  return issues;
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(declared: string, value: unknown): boolean {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

export { errors };
