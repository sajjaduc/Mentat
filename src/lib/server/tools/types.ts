/**
 * Tool contract.
 *
 * A tool is the only way an agent affects the world. Every tool declares its
 * schemas, permissions, timeout, retry policy, approval policy and cache policy up
 * front; the runner enforces all of them *outside* the model's control. Approval
 * is therefore a Mentat decision, never a model promise (ADR-0019).
 *
 * Initial implementation kinds are `native` (an in-process handler) and `http`
 * (an `http_operations` row). The interface leaves room for MCP/sandbox/plugin
 * tools without changing the runner.
 */

import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';
import type { ApprovalPolicy, CachePolicy, RetryPolicy } from '../db/schema';

/** JSON Schema fragment used for tool input/output contracts. */
export type JsonSchema = Record<string, unknown>;

export interface ToolInvocationContext {
  /** Fully resolved actor, including run and tool-call attribution. */
  actor: ActorContext;
  /** Database executor: a transaction when the call must be atomic with its step. */
  db: Executor;
  ticketId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  /** File ids in scope for this call (files.* tools). */
  fileIds?: string[];
  /** Secrets resolved for this invocation, never serialized into model context. */
  signal?: AbortSignal;
  /** Wall-clock budget for the whole tool call. */
  timeoutMs?: number;
}

export interface ToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  output?: T;
  error?: ToolError;
  /** Set when the result came from (or was stored in) the native cache. */
  cacheStatus?: 'hit' | 'miss' | 'bypass' | 'stored';
  durationMs?: number;
  /** Structured metadata persisted on the run step: status code, retries, etc. */
  metadata?: Record<string, unknown>;
}

export interface NativeToolHandler<TInput = unknown, TOutput = unknown> {
  key: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** Permission key the actor must hold, e.g. `ticket:write`. */
  permission?: string;
  /** Extra policy check evaluated by Mentat, not by the model. */
  approvalPolicy?: ApprovalPolicy;
  /** Executes the tool. Implementations receive an already-authorized context. */
  execute(input: TInput, context: ToolInvocationContext): Promise<ToolResult<TOutput>>;
}

export interface ToolDescriptor {
  id?: string;
  key: string;
  name: string;
  description: string;
  kind: 'native' | 'http';
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permissions?: string[];
  timeoutSeconds: number;
  retryPolicy?: RetryPolicy | null;
  approvalPolicy?: ApprovalPolicy | null;
  cachePolicy?: CachePolicy | null;
  enabled: boolean;
}

/** Registry of in-process native tools. HTTP tools are loaded from the database. */
export class ToolRegistry {
  private readonly handlers = new Map<string, NativeToolHandler>();

  register(handler: NativeToolHandler): void {
    if (this.handlers.has(handler.key)) {
      throw new Error(`Duplicate native tool registration: ${handler.key}`);
    }
    this.handlers.set(handler.key, handler);
  }

  registerAll(handlers: NativeToolHandler[]): void {
    for (const handler of handlers) this.register(handler);
  }

  get(key: string): NativeToolHandler | undefined {
    return this.handlers.get(key);
  }

  has(key: string): boolean {
    return this.handlers.has(key);
  }

  list(): NativeToolHandler[] {
    return [...this.handlers.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  /** Model-facing descriptors, stripped of anything not needed for tool calling. */
  modelDefinitions(
    keys?: string[]
  ): Array<{ name: string; description: string; parameters: JsonSchema }> {
    const selected = keys ? keys.map((key) => this.handlers.get(key)).filter(Boolean) : this.list();
    return (selected as NativeToolHandler[]).map((handler) => ({
      name: handler.key,
      description: handler.description,
      parameters: handler.inputSchema
    }));
  }
}

/** Convenience helpers so handlers stay small and consistently shaped. */
export function toolSuccess<T>(
  output: T,
  extra: Omit<ToolResult<T>, 'ok' | 'output'> = {}
): ToolResult<T> {
  return { ok: true, output, ...extra };
}

export function toolFailure(
  error: ToolError,
  extra: Omit<ToolResult, 'ok' | 'error'> = {}
): ToolResult {
  return { ok: false, error, ...extra };
}

/**
 * Wrap a handler so thrown `AppError`s become structured tool failures instead of
 * crashing a run. The runner records the structured error on the step.
 */
export function defineNativeTool<TInput, TOutput>(
  handler: NativeToolHandler<TInput, TOutput>
): NativeToolHandler<TInput, TOutput> {
  const execute = handler.execute.bind(handler);
  return {
    ...handler,
    async execute(input, context) {
      const startedAt = Date.now();
      try {
        const result = await execute(input, context);
        return {
          ...result,
          durationMs: result.durationMs ?? Date.now() - startedAt
        };
      } catch (error) {
        const appError = toToolError(error);
        return {
          ok: false,
          error: appError,
          durationMs: Date.now() - startedAt
        };
      }
    }
  };
}

function toToolError(error: unknown): ToolError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as { code: unknown; message: unknown; details?: unknown };
    return {
      code: String(candidate.code),
      message: String(candidate.message),
      details: (candidate.details as Record<string, unknown>) ?? undefined
    };
  }
  if (error instanceof Error) return { code: 'tool_error', message: error.message };
  return { code: 'tool_error', message: 'Tool execution failed' };
}
