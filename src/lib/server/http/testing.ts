/**
 * Editor support: the Test Request path.
 *
 * The HTTP editor is Postman-inspired, and its "Send" button has different semantics
 * from an agent invocation: a human explicitly asked for this call, so approval is
 * bypassed, mutation retries are allowed, the cache is bypassed by default, and the
 * result is shaped for display — status, latency, formatted body, redacted headers and
 * the retry trace — rather than for a model.
 *
 * The bypass lives in the *overrides* passed to the runtime, not in a separate code
 * path: the same validation, redaction, rate limiting, audit and logging apply. The log
 * row is marked `fromTestConsole` so operators can tell editor traffic from production
 * traffic.
 */
import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';
import type { HttpCacheStore } from './cache';
import type { RateLimiter } from './rate-limit';
import {
  executeOperation,
  type FetchLike,
  type HttpExecutionResult,
  type HttpRetryTraceEntry,
  type HttpRuntimeOverrides,
  type RedactedRequestSummary
} from './runtime';

export interface TestRequestInput {
  db: Executor;
  actor: ActorContext;
  operationId?: string;
  operationKey?: string;
  serviceId?: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
  fetch?: FetchLike;
  rateLimiter?: RateLimiter;
  cacheStore?: HttpCacheStore;
  /** Honour the cache policy instead of bypassing it (default: bypass). */
  useCache?: boolean;
  signal?: AbortSignal;
}

export interface TestRequestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  attempts: number;
  cacheStatus: string;
  logId: string | null;
  /** Parsed JSON when possible, otherwise the raw text. */
  body: unknown;
  /** Pretty-printed body for the response pane. */
  formattedBody: string;
  /** Redacted response headers. */
  headers: Record<string, string>;
  /** Redacted request headers actually sent. */
  requestHeaders: Record<string, string>;
  request: RedactedRequestSummary;
  retryTrace: HttpRetryTraceEntry[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export async function testRequest(input: TestRequestInput): Promise<TestRequestResult> {
  const overrides: HttpRuntimeOverrides = {
    fromTestConsole: true,
    approval: 'bypass',
    cache: input.useCache ? 'use' : 'bypass',
    retryMutations: true,
    timeoutMs: input.timeoutMs,
    fetch: input.fetch,
    rateLimiter: input.rateLimiter,
    cacheStore: input.cacheStore,
    signal: input.signal
  };
  const result = await executeOperation({
    db: input.db,
    actor: input.actor,
    operationId: input.operationId,
    operationKey: input.operationKey,
    serviceId: input.serviceId,
    input: input.input ?? {},
    overrides
  });
  return formatTestResult(result);
}

export function formatTestResult(result: HttpExecutionResult): TestRequestResult {
  const raw = result.raw;
  const parsed = typeof raw === 'string' ? tryParse(raw) : raw;
  return {
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    attempts: result.attempts,
    cacheStatus: result.cacheStatus,
    logId: result.logId,
    body: parsed,
    formattedBody: formatBody(parsed),
    headers: result.responseHeaders ?? {},
    requestHeaders: result.request.headers,
    request: result.request,
    retryTrace: result.retryTrace,
    ...(result.error ? { error: result.error } : {})
  };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === undefined) return '';
  return `${JSON.stringify(body, null, 2)}\n`;
}
