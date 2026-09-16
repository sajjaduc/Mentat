/**
 * HTTP tool dispatch seam.
 *
 * A `tools` row of kind `http` points at an `http_operations` row. The tool
 * invocation layer must not import the HTTP runtime directly (the runtime is owned
 * by the HTTP module and pulls in transport concerns); it needs only "run this
 * operation with these arguments, as this actor". That is what the locator below
 * installs.
 */
import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';

export interface HttpToolInvocation {
  workspaceId: string;
  operationId: string;
  serviceId?: string | null;
  input: Record<string, unknown>;
  actor: ActorContext;
  ticketId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  /** Approval has already been satisfied when true. */
  approved?: boolean;
  signal?: AbortSignal;
}

export interface HttpToolResult {
  ok: boolean;
  output?: unknown;
  status?: number;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  cacheStatus?: 'hit' | 'miss' | 'bypass' | 'stored';
  durationMs?: number;
  attempts?: number;
  metadata?: Record<string, unknown>;
}

export type HttpToolInvoker = (
  db: Executor,
  invocation: HttpToolInvocation
) => Promise<HttpToolResult>;

let invoker: HttpToolInvoker | null = null;

export function setHttpToolInvoker(fn: HttpToolInvoker | null): void {
  invoker = fn;
}

export function hasHttpToolInvoker(): boolean {
  return invoker !== null;
}

export function httpToolInvoker(): HttpToolInvoker {
  if (!invoker) {
    throw new Error(
      'HTTP tool invocation is not installed. Call setHttpToolInvoker(executeOperationAsTool) during bootstrap.'
    );
  }
  return invoker;
}
