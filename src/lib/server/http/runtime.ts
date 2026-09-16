/**
 * HTTP execution runtime.
 *
 * Everything that can be centralized about making a third-party call is centralized
 * here, in one ordered lifecycle:
 *
 *   load → authorize → validate → approval gate → cache → rate limit → resolve secrets
 *   → build request → fetch with retry/backoff/Retry-After → success rules → map
 *   → persist a redacted log and audit row in one transaction → return
 *
 * The ordering encodes the important invariants:
 *
 *  - **Approval is decided before anything leaves the process.** When a policy says a
 *    human must approve, `executeOperation` returns a structured `approvalRequired`
 *    outcome carrying the request it *would* make (redacted) and performs no I/O. The
 *    execution engine owns creating the approval record; this module owns the
 *    decision, via {@link requiresApproval}, so a model's claim can never gate it
 *    (ADR-0019).
 *  - **Secrets are resolved last.** Cache hits and approval previews never decrypt, so
 *    a credential is only opened when a request is actually about to be sent
 *    (ADR-0020).
 *  - **The real request and its redacted twin are built together.** There is no path
 *    that sends a request without also producing the redacted form persisted to
 *    `http_request_logs` and the audit ledger.
 *
 * The runtime performs network I/O outside transactions and opens a short transaction
 * only to write the log row and its audit row together (ADR-0004).
 */
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import { type Executor, withTransaction } from '../db/client';
import type { ApprovalPolicy, HttpMethod, HttpOperation, HttpService } from '../db/schema';
import { httpRequestLogs } from '../db/schema';
import { resolveSecretValue } from '../secrets/service';
import { applyAuth, PREVIEW_SECRET_PLACEHOLDER, type ResolvedAuthSecrets } from './auth';
import {
  computeAuthScope,
  effectiveCachePolicy,
  type HttpCacheStatus,
  type HttpCacheStore,
  httpCacheIdentity,
  isCacheEnabled,
  isCacheReadEnabled,
  SqliteHttpCacheStore
} from './cache';
import {
  applyBodyMapping,
  applyResponseMapping,
  evaluateSuccessRules,
  inferInputSchema,
  selectBodyPath,
  validateInput
} from './mapping';
import { InProcessRateLimiter, type RateLimiter } from './rate-limit';
import { findOperationRow, findOperationRowByKey, findServiceRow } from './repository';
import { parseRetryAfter, retryDelayMs, shouldRetry } from './retry';
import { buildUrl, resolveParameterValue } from './url';

const RESPONSE_PREVIEW_LIMIT = 4096;
const DEFAULT_TIMEOUT_MS = 15_000;
const MUTATING_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'POST',
  'PUT',
  'PATCH',
  'DELETE'
]);
const HEADER_TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Shared limiter for the process; injectable through `overrides.rateLimiter`. */
export const defaultRateLimiter: RateLimiter = new InProcessRateLimiter();

export interface HttpRuntimeOverrides {
  /** Marks the request as coming from the editor's Test Request path. */
  fromTestConsole?: boolean;
  /** `bypass` skips the approval gate entirely (Test Request only). */
  approval?: 'enforce' | 'bypass';
  /** `bypass` ignores the cache policy; `use` honours it. */
  cache?: 'use' | 'bypass';
  /** Allow POST/PATCH retries (Test Request only). */
  retryMutations?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rateLimiter?: RateLimiter;
  cacheStore?: HttpCacheStore;
  signal?: AbortSignal;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ExecuteOperationOptions {
  db: Executor;
  actor: ActorContext;
  /** Resolve the operation by id or by semantic key (exactly one is required). */
  operationId?: string;
  operationKey?: string;
  /** Optional cross-check when the caller already knows the service. */
  serviceId?: string;
  input?: Record<string, unknown>;
  runId?: string | null;
  stepId?: string | null;
  overrides?: HttpRuntimeOverrides;
}

export interface HttpRetryTraceEntry {
  attempt: number;
  status?: number | null;
  error?: string | null;
  delayMs?: number;
}

export interface RedactedRequestSummary {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  query: Record<string, unknown>;
}

export interface HttpApprovalRequired {
  kind: 'approvalRequired';
  mode: ApprovalPolicy['mode'];
  reason: string;
  operationId: string;
  operationKey: string;
  serviceId: string;
  request: RedactedRequestSummary;
}

export interface HttpExecutionError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HttpExecutionResult {
  ok: boolean;
  status: number | null;
  output: unknown;
  raw: unknown;
  attempts: number;
  latencyMs: number;
  cacheStatus: HttpCacheStatus;
  logId: string | null;
  retryTrace: HttpRetryTraceEntry[];
  request: RedactedRequestSummary;
  /** Redacted response headers, when a response was received. */
  responseHeaders?: Record<string, string>;
  approvalRequired?: HttpApprovalRequired;
  error?: HttpExecutionError;
}

export function executeOperation(options: ExecuteOperationOptions): Promise<HttpExecutionResult>;
export function executeOperation(
  actor: ActorContext,
  options: Omit<ExecuteOperationOptions, 'actor'>
): Promise<HttpExecutionResult>;
export async function executeOperation(
  actorOrOptions: ActorContext | ExecuteOperationOptions,
  maybeOptions?: Omit<ExecuteOperationOptions, 'actor'>
): Promise<HttpExecutionResult> {
  const options: ExecuteOperationOptions = maybeOptions
    ? { ...maybeOptions, actor: actorOrOptions as ActorContext }
    : (actorOrOptions as ExecuteOperationOptions);
  return runExecution(options);
}

async function runExecution(options: ExecuteOperationOptions): Promise<HttpExecutionResult> {
  const { db, actor } = options;
  const input = options.input ?? {};
  const overrides = options.overrides ?? {};
  const fromTestConsole = overrides.fromTestConsole ?? false;
  const now = overrides.now ?? (() => Date.now());
  const sleep = overrides.sleep ?? ((ms: number) => Bun.sleep(ms));
  const fetchImpl = overrides.fetch ?? (globalThis.fetch as FetchLike);

  const operation = loadOperation(db, actor, options);
  // Authorization is asserted after the workspace-scoped load: a member without
  // `http:invoke` gets a 403, while a *different workspace* never reached the load and
  // therefore gets a 404 that cannot confirm the operation exists.
  assertPermission(actor, Permissions.httpInvoke, 'Not permitted to invoke HTTP operations');
  if (operation.archivedAt !== null) throw errors.notFound('HTTP operation', operation.id);
  if (!operation.enabled)
    throw errors.precondition(`HTTP operation "${operation.key}" is disabled`);

  const service = findServiceRow(db, actor.workspaceId, operation.serviceId);
  if (!service) throw errors.notFound('HTTP service', operation.serviceId);
  if (service.archivedAt !== null) throw errors.precondition('HTTP service is archived');

  const effectiveInputSchema =
    operation.inputSchema ?? inferInputSchema(operation.parameters, operation.body);
  const value = validateInput(effectiveInputSchema, operation.parameters, input);

  const policy = approvalPolicyFor(operation, service);
  const approvalMode = overrides.approval ?? (fromTestConsole ? 'bypass' : 'enforce');
  if (
    approvalMode !== 'bypass' &&
    evaluateApprovalPolicy(policy, { operation, service, input: value })
  ) {
    return approvalRequiredResult(operation, service, value, policy);
  }

  const prepared = prepareRequest(operation, service, value);
  const cachePolicy = effectiveCachePolicy(service.cachePolicy, operation.cachePolicy);
  const cacheMode = overrides.cache ?? (fromTestConsole ? 'bypass' : 'use');
  const cacheParticipates = cacheMode !== 'bypass' && isCacheEnabled(cachePolicy, operation.method);
  const cacheReads = cacheParticipates && isCacheReadEnabled(cachePolicy, operation.method);
  const authScope = computeAuthScope(service.authType, service.authConfig);
  const identity = httpCacheIdentity({
    workspaceId: actor.workspaceId,
    serviceId: service.id,
    operationId: operation.id,
    method: operation.method,
    url: prepared.built.url,
    body: prepared.body.body ?? null,
    authScope,
    varyOn: cacheVaryOn(cachePolicy?.varyOn, value)
  });
  const cacheStore = overrides.cacheStore ?? new SqliteHttpCacheStore(db);

  if (cacheReads) {
    const hit = await cacheStore.get(identity);
    if (hit) {
      return completeFromCache({
        options,
        operation,
        service,
        prepared,
        hit,
        fromTestConsole
      });
    }
  }

  const rateLimiter = overrides.rateLimiter ?? defaultRateLimiter;
  const lease = await rateLimiter.acquire(
    { workspaceId: actor.workspaceId, serviceId: service.id },
    { config: operation.rateLimitOverride ?? service.rateLimit ?? null }
  );

  try {
    const resolvedSecrets = resolveAuthSecrets(
      db,
      actor.workspaceId,
      service.authConfig,
      options.runId
    );
    const applied = applyAuth({ service, resolvedSecrets });
    const url = appendQuery(prepared.built.url, applied.query);
    const headers: Record<string, string> = { ...prepared.headers, ...applied.headers };
    if (prepared.body.contentType && !hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = prepared.body.contentType;
    }

    const redactor = createRedactor(
      redactionSeeds(registeredSecretValues(), resolvedSecrets.secret, resolvedSecrets.password)
    );
    const safeUrl = redactor.string(url);
    const safeHeaders = redactor.value(headers);
    const safeBody = prepared.body.body ? redactor.string(prepared.body.body) : null;
    const redactedQuery: Record<string, unknown> = {
      ...(redactor.value(prepared.built.query) as Record<string, unknown>),
      ...applied.redactedQuery
    };
    const requestSummary: RedactedRequestSummary = {
      method: operation.method,
      url: safeUrl,
      headers: safeHeaders,
      query: redactedQuery,
      ...(safeBody !== null ? { body: safeBody } : {})
    };

    const timeoutMs =
      overrides.timeoutMs ?? operation.timeoutMs ?? service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryPolicy = operation.retryPolicy ?? service.retryPolicy ?? null;
    const startedAt = now();
    const retryTrace: HttpRetryTraceEntry[] = [];
    let attempt = 1;
    let response: Response | null = null;

    while (true) {
      const signal = createTimeoutSignal(timeoutMs, overrides.signal);
      try {
        response = await fetchImpl(url, {
          method: operation.method,
          headers,
          ...(prepared.body.body !== undefined ? { body: prepared.body.body } : {}),
          signal
        });
        const status = response.status;
        if (
          shouldRetry({
            method: operation.method,
            attempt,
            policy: retryPolicy,
            status,
            optIn: overrides.retryMutations
          })
        ) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
          const delayMs = retryDelayMs({ attempt, policy: retryPolicy, retryAfterMs });
          retryTrace.push({ attempt, status, delayMs });
          await discardResponse(response);
          await sleep(delayMs);
          attempt += 1;
          continue;
        }
        retryTrace.push({ attempt, status });
        break;
      } catch (error) {
        const timedOut = isTimeoutError(error, signal);
        const appError = timedOut
          ? errors.timeout(`HTTP request timed out after ${timeoutMs}ms`, { url: safeUrl, attempt })
          : errors.dependency(
              `HTTP request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
              { url: safeUrl, attempt }
            );
        if (
          shouldRetry({
            method: operation.method,
            attempt,
            policy: retryPolicy,
            error: appError,
            optIn: overrides.retryMutations
          })
        ) {
          const delayMs = retryDelayMs({ attempt, policy: retryPolicy, retryAfterMs: null });
          retryTrace.push({ attempt, error: appError.message, delayMs });
          await sleep(delayMs);
          attempt += 1;
          continue;
        }
        retryTrace.push({ attempt, error: appError.message });
        await persistLog({
          db,
          actor,
          operation,
          service,
          runId: options.runId ?? null,
          stepId: options.stepId ?? null,
          safeUrl,
          safeHeaders,
          safeBody,
          attempt,
          status: null,
          safeResponseHeaders: null,
          preview: null,
          responseBytes: null,
          latencyMs: now() - startedAt,
          cacheStatus: cacheParticipates ? 'miss' : 'bypass',
          fromTestConsole,
          ok: false,
          errorMessage: appError.publicMessage,
          errorCode: appError.code
        });
        throw appError;
      }
    }

    const latencyMs = now() - startedAt;
    const rawText = await readText(response);
    const contentType = response.headers.get('content-type');
    const rawBody = parseResponseBody(rawText, contentType);
    const success = evaluateSuccessRules(operation.successRules, response.status, rawBody);
    const output = success.ok
      ? applyResponseMapping(rawBody, operation.responseMapping)
      : undefined;
    const safeResponseHeaders = redactor.value(headersToObject(response.headers)) as Record<
      string,
      string
    >;

    let cacheStatus: HttpCacheStatus = cacheParticipates ? 'miss' : 'bypass';
    if (cacheParticipates && success.ok) {
      await cacheStore.set(
        identity,
        {
          status: response.status,
          headers: cacheStorableHeaders(response.headers),
          body: rawBody,
          bodyText: rawText,
          contentType,
          storedAt: now(),
          expiresAt: null
        },
        { ttlSeconds: cachePolicy?.ttlSeconds ?? null }
      );
      cacheStatus = 'stored';
    }

    const logId = await persistLog({
      db,
      actor,
      operation,
      service,
      runId: options.runId ?? null,
      stepId: options.stepId ?? null,
      safeUrl,
      safeHeaders,
      safeBody,
      attempt,
      status: response.status,
      safeResponseHeaders,
      preview: truncate(redactor.string(rawText), RESPONSE_PREVIEW_LIMIT),
      responseBytes: byteLength(rawText),
      latencyMs,
      cacheStatus,
      fromTestConsole,
      ok: success.ok,
      errorMessage: success.ok ? null : (success.reason ?? null),
      errorCode: success.ok ? null : errorCodeForStatus(response.status)
    });

    if (!success.ok) {
      return {
        ok: false,
        status: response.status,
        output: undefined,
        raw: rawBody,
        attempts: attempt,
        latencyMs,
        cacheStatus,
        logId,
        retryTrace,
        request: requestSummary,
        responseHeaders: safeResponseHeaders,
        error: {
          code: errorCodeForStatus(response.status),
          message: success.reason ?? `HTTP ${response.status}`
        }
      };
    }

    return {
      ok: true,
      status: response.status,
      output,
      raw: rawBody,
      attempts: attempt,
      latencyMs,
      cacheStatus,
      logId,
      retryTrace,
      request: requestSummary,
      responseHeaders: safeResponseHeaders
    };
  } finally {
    lease.release();
  }
}

/**
 * Whether an operation requires human approval.
 *
 * Exported so the execution engine can gate *before* calling the runtime (for example
 * to create the durable approval record first). The runtime calls it too, so a direct
 * invocation cannot skip the gate; the engine and the runtime can never disagree
 * because they share this one predicate.
 */
export function requiresApproval(
  operation: Pick<HttpOperation, 'approvalPolicy' | 'method' | 'key' | 'serviceId'>,
  service: Pick<HttpService, 'defaultApprovalPolicy' | 'id'>,
  input: Record<string, unknown>
): boolean {
  const policy = operation.approvalPolicy ?? service.defaultApprovalPolicy ?? { mode: 'never' };
  return evaluateApprovalPolicy(policy, {
    operation: operation as Pick<HttpOperation, 'approvalPolicy' | 'method' | 'key' | 'serviceId'>,
    service: service as Pick<HttpService, 'defaultApprovalPolicy' | 'id'>,
    input
  });
}

interface ApprovalContext {
  operation: Pick<HttpOperation, 'method' | 'key' | 'serviceId'>;
  service: Pick<HttpService, 'id'>;
  input: Record<string, unknown>;
}

function approvalPolicyFor(operation: HttpOperation, service: HttpService): ApprovalPolicy {
  return operation.approvalPolicy ?? service.defaultApprovalPolicy ?? { mode: 'never' };
}

function evaluateApprovalPolicy(policy: ApprovalPolicy, context: ApprovalContext): boolean {
  switch (policy.mode) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'conditional':
      // An unreadable or empty condition fails closed: it requires approval rather
      // than silently allowing the call.
      return evaluateApprovalCondition(policy.condition, context);
    default:
      return true;
  }
}

function evaluateApprovalCondition(
  condition: string | undefined,
  context: ApprovalContext
): boolean {
  if (condition === undefined || condition.trim().length === 0) return true;
  const trimmed = condition.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'always' || lower === 'true') return true;
  if (lower === 'never' || lower === 'false') return false;
  if (lower === 'mutations' || lower === 'mutating') {
    return MUTATING_METHODS.has(context.operation.method);
  }

  const scope = buildApprovalScope(context);

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, unknown>).every(([path, expected]) =>
          matchApprovalRule(scope, path, expected)
        );
      }
    } catch {
      return true;
    }
    return true;
  }

  const expression = /^([A-Za-z0-9_.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(trimmed);
  if (expression) {
    const [, path, operator, literal] = expression;
    const actual = resolvePath(scope, path ?? '');
    return compareValues(actual, actual, operator ?? '==', parseLiteral(literal ?? ''));
  }
  return true;
}

function buildApprovalScope(context: ApprovalContext): Record<string, unknown> {
  return {
    input: context.input,
    method: context.operation.method,
    operationKey: context.operation.key,
    serviceId: context.service.id
  };
}

function matchApprovalRule(
  scope: Record<string, unknown>,
  path: string,
  expected: unknown
): boolean {
  const actual = resolvePath(scope, path);
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    return Object.entries(expected as Record<string, unknown>).every(([operator, value]) =>
      compareValues(actual, actual, operator, value)
    );
  }
  return deepEqual(actual, expected);
}

/** `actual` is used for ordering operators, `subject` for equality/containment. */
function compareValues(
  subject: unknown,
  actual: unknown,
  operator: string,
  expected: unknown
): boolean {
  switch (operator) {
    case 'eq':
    case '==':
      return deepEqual(subject, expected);
    case 'ne':
    case '!=':
      return !deepEqual(subject, expected);
    case 'gt':
    case '>':
      return asNumber(actual) > asNumber(expected);
    case 'gte':
    case '>=':
      return asNumber(actual) >= asNumber(expected);
    case 'lt':
    case '<':
      return asNumber(actual) < asNumber(expected);
    case 'lte':
    case '<=':
      return asNumber(actual) <= asNumber(expected);
    case 'in':
      return Array.isArray(expected) && expected.some((entry) => deepEqual(subject, entry));
    case 'contains':
      return (
        typeof subject === 'string' && typeof expected === 'string' && subject.includes(expected)
      );
    case 'exists':
      return (subject !== undefined && subject !== null) === (expected !== false);
    default:
      return false;
  }
}

function resolvePath(scope: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  const direct = selectBodyPath(scope, path);
  return direct;
}

function parseLiteral(literal: string): unknown {
  const trimmed = literal.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && trimmed !== '' ? numeric : trimmed;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

interface PreparedRequest {
  built: ReturnType<typeof buildUrl>;
  body: { body?: string; contentType?: string };
  headers: Record<string, string>;
}

/**
 * Fold `cachePolicy.varyOn` input values into the cache identity. Without this, two
 * callers that differ only in a vary-on parameter (say `locale`) would collide on one
 * cached response.
 */
function cacheVaryOn(
  names: readonly string[] | undefined,
  input: Record<string, unknown>
): Record<string, unknown> | null {
  if (!names || names.length === 0) return null;
  const values: Record<string, unknown> = {};
  for (const name of names) values[name] = input[name] ?? null;
  return values;
}

function prepareRequest(
  operation: HttpOperation,
  service: HttpService,
  input: Record<string, unknown>
): PreparedRequest {
  const built = buildUrl({ service, operation, params: input });
  const body = applyBodyMapping(operation.body, input);

  const headers: Record<string, string> = {};
  for (const [key, template] of Object.entries(operation.headers ?? {})) {
    headers[key] = renderHeaderTemplate(template, input);
  }
  for (const parameter of operation.parameters ?? []) {
    if (parameter.location !== 'header') continue;
    const raw = resolveParameterValue(parameter, input);
    if (raw === undefined || raw === null) continue;
    headers[parameter.wireName ?? parameter.name] = String(raw);
  }
  return { built, body, headers };
}

function renderHeaderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(HEADER_TEMPLATE_RE, (_match, name: string) => {
    const value = input[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

function approvalRequiredResult(
  operation: HttpOperation,
  service: HttpService,
  input: Record<string, unknown>,
  policy: ApprovalPolicy
): HttpExecutionResult {
  const request = buildPreviewRequest(operation, service, input);
  return {
    ok: false,
    status: null,
    output: null,
    raw: null,
    attempts: 0,
    latencyMs: 0,
    cacheStatus: 'bypass',
    logId: null,
    retryTrace: [],
    request,
    approvalRequired: {
      kind: 'approvalRequired',
      mode: policy.mode,
      reason: policy.reason ?? `Operation "${operation.key}" requires approval`,
      operationId: operation.id,
      operationKey: operation.key,
      serviceId: service.id,
      request
    }
  };
}

/**
 * Preview a request without decrypting anything: secrets are replaced by a placeholder,
 * so the approval inbox shows *which* credential and *where* it goes, never its value.
 */
function buildPreviewRequest(
  operation: HttpOperation,
  service: HttpService,
  input: Record<string, unknown>
): RedactedRequestSummary {
  const prepared = prepareRequest(operation, service, input);
  const redactor = createRedactor(redactionSeeds(registeredSecretValues()));
  let authHeaders: Record<string, string> = {};
  let authQuery: Record<string, string> = {};
  try {
    const applied = applyAuth({
      service,
      resolvedSecrets: {
        secret: PREVIEW_SECRET_PLACEHOLDER,
        password: PREVIEW_SECRET_PLACEHOLDER
      }
    });
    authHeaders = applied.redactedHeaders;
    authQuery = applied.redactedQuery;
  } catch {
    // A misconfigured service must not make the approval decision itself fail; the
    // preview simply falls back to structural redaction of what can be built.
    authHeaders = {};
    authQuery = {};
  }
  const url = redactor.string(appendQuery(prepared.built.url, authQuery));
  return {
    method: operation.method,
    url,
    headers: redactor.value({ ...prepared.headers, ...authHeaders }),
    query: {
      ...(redactor.value(prepared.built.query) as Record<string, unknown>),
      ...authQuery
    },
    ...(prepared.body.body !== undefined ? { body: redactor.string(prepared.body.body) } : {})
  };
}

interface CacheHitInput {
  options: ExecuteOperationOptions;
  operation: HttpOperation;
  service: HttpService;
  prepared: PreparedRequest;
  hit: Awaited<ReturnType<HttpCacheStore['get']>>;
  fromTestConsole: boolean;
}

async function completeFromCache(input: CacheHitInput): Promise<HttpExecutionResult> {
  const { options, operation, service, prepared, fromTestConsole } = input;
  const hit = input.hit;
  if (!hit) throw errors.internal('Cache hit was empty');

  const redactor = createRedactor(redactionSeeds(registeredSecretValues()));
  const authApplied = safeRedactedAuth(service);
  const redactedQuery: Record<string, unknown> = {
    ...(redactor.value(prepared.built.query) as Record<string, unknown>),
    ...authApplied.query
  };
  const requestSummary: RedactedRequestSummary = {
    method: operation.method,
    url: redactor.string(prepared.built.url),
    headers: { ...redactor.value(prepared.headers), ...authApplied.headers },
    query: redactedQuery
  };

  const success = evaluateSuccessRules(operation.successRules, hit.status, hit.body);
  const output = success.ok ? applyResponseMapping(hit.body, operation.responseMapping) : undefined;
  const safeHitHeaders = redactor.value(hit.headers) as Record<string, string>;
  const logId = await persistLog({
    db: options.db,
    actor: options.actor,
    operation,
    service,
    runId: options.runId ?? null,
    stepId: options.stepId ?? null,
    safeUrl: requestSummary.url,
    safeHeaders: requestSummary.headers,
    safeBody: prepared.body.body ?? null,
    attempt: 0,
    status: hit.status,
    safeResponseHeaders: safeHitHeaders,
    preview: truncate(redactor.string(hit.bodyText), RESPONSE_PREVIEW_LIMIT),
    responseBytes: byteLength(hit.bodyText),
    latencyMs: 0,
    cacheStatus: 'hit',
    fromTestConsole,
    ok: success.ok,
    errorMessage: success.ok ? null : (success.reason ?? null),
    errorCode: success.ok ? null : errorCodeForStatus(hit.status)
  });

  return {
    ok: success.ok,
    status: hit.status,
    output,
    raw: hit.body,
    attempts: 0,
    latencyMs: 0,
    cacheStatus: 'hit',
    logId,
    retryTrace: [],
    request: requestSummary,
    responseHeaders: safeHitHeaders,
    ...(success.ok
      ? {}
      : {
          error: {
            code: errorCodeForStatus(hit.status),
            message: success.reason ?? `HTTP ${hit.status}`
          }
        })
  };
}

function safeRedactedAuth(service: HttpService): {
  headers: Record<string, string>;
  query: Record<string, string>;
} {
  try {
    const applied = applyAuth({
      service,
      resolvedSecrets: {
        secret: PREVIEW_SECRET_PLACEHOLDER,
        password: PREVIEW_SECRET_PLACEHOLDER
      }
    });
    return { headers: applied.redactedHeaders, query: applied.redactedQuery };
  } catch {
    return { headers: {}, query: {} };
  }
}

function resolveAuthSecrets(
  db: Executor,
  workspaceId: string,
  authConfig: HttpService['authConfig'],
  runId: string | null | undefined
): ResolvedAuthSecrets {
  const secret = authConfig?.secretId
    ? resolveSecretValue(db, {
        workspaceId,
        secretId: authConfig.secretId,
        runId: runId ?? null,
        purpose: 'http.request'
      })
    : null;
  const password = authConfig?.passwordSecretId
    ? resolveSecretValue(db, {
        workspaceId,
        secretId: authConfig.passwordSecretId,
        runId: runId ?? null,
        purpose: 'http.request'
      })
    : null;
  return { secret, password };
}

function loadOperation(
  db: Executor,
  actor: ActorContext,
  options: ExecuteOperationOptions
): HttpOperation {
  if (options.operationId) {
    const row = findOperationRow(db, actor.workspaceId, options.operationId);
    if (!row) throw errors.notFound('HTTP operation', options.operationId);
    if (options.serviceId && row.serviceId !== options.serviceId) {
      throw errors.notFound('HTTP operation', options.operationId);
    }
    return row;
  }
  if (options.operationKey) {
    const row = findOperationRowByKey(db, actor.workspaceId, options.operationKey);
    if (!row) throw errors.notFound('HTTP operation', options.operationKey);
    if (options.serviceId && row.serviceId !== options.serviceId) {
      throw errors.notFound('HTTP operation', options.operationKey);
    }
    return row;
  }
  throw errors.validation('executeOperation requires an operationId or operationKey');
}

interface PersistLogInput {
  db: Executor;
  actor: ActorContext;
  operation: HttpOperation;
  service: HttpService;
  runId: string | null;
  stepId: string | null;
  safeUrl: string;
  safeHeaders: Record<string, string>;
  safeBody: string | null;
  attempt: number;
  status: number | null;
  safeResponseHeaders: Record<string, string> | null;
  preview: string | null;
  responseBytes: number | null;
  latencyMs: number;
  cacheStatus: HttpCacheStatus;
  fromTestConsole: boolean;
  ok: boolean;
  errorMessage: string | null;
  errorCode: string | null;
}

/**
 * Persist the request log and its audit row in one transaction. `withTransaction` takes
 * a synchronous callback, so both writes either commit together or neither does.
 */
async function persistLog(input: PersistLogInput): Promise<string> {
  const logId = uuidv7();
  const now = Date.now();
  await withTransaction(input.db, (tx) => {
    tx.insert(httpRequestLogs)
      .values({
        id: logId,
        workspaceId: input.actor.workspaceId,
        serviceId: input.service.id,
        operationId: input.operation.id,
        runId: input.runId,
        stepId: input.stepId,
        method: input.operation.method,
        url: input.safeUrl,
        requestHeaders: input.safeHeaders,
        requestBody: input.safeBody,
        attempt: input.attempt,
        responseStatus: input.status,
        responseHeaders: input.safeResponseHeaders,
        responseBodyPreview: input.preview,
        responseBytes: input.responseBytes,
        latencyMs: input.latencyMs,
        cacheStatus: input.cacheStatus,
        fromTestConsole: input.fromTestConsole,
        error: input.errorMessage,
        errorCode: input.errorCode,
        createdAt: now
      })
      .run();
    writeAudit(tx, {
      workspaceId: input.actor.workspaceId,
      action: input.ok ? AuditActions.httpRequestCompleted : AuditActions.httpRequestFailed,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      actorLabel: input.actor.actorLabel,
      entityType: 'http_operation',
      entityId: input.operation.id,
      workflowId: input.service.workflowId,
      runId: input.runId,
      summary: input.ok
        ? `HTTP ${input.operation.method} ${input.operation.key} completed`
        : `HTTP ${input.operation.method} ${input.operation.key} failed`,
      data: {
        serviceId: input.service.id,
        operationKey: input.operation.key,
        status: input.status,
        attempts: input.attempt,
        cacheStatus: input.cacheStatus,
        latencyMs: input.latencyMs,
        errorCode: input.errorCode
      }
    });
  });
  return logId;
}

function errorCodeForStatus(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'dependency_failed';
  if (status >= 400) return 'bad_request';
  return 'dependency_failed';
}

function createTimeoutSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError';
  }
  return false;
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled has already been discarded by the runtime.
  }
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseResponseBody(text: string, contentType: string | null): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return text;
  if (contentType && !/json/i.test(contentType) && !/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function cacheStorableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    // Session cookies must never be replayed from a response cache.
    if (lower === 'set-cookie') continue;
    out[key] = value;
  }
  return out;
}

function appendQuery(url: string, query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Secrets may appear on the wire percent-encoded (a query-string API key, for
 * example), so both the plaintext and its URL-encoded form are registered with the
 * redactor. Missing the encoded form would let a credential into the request log while
 * the exact plaintext was correctly masked.
 */
function redactionSeeds(...groups: Array<string | null | undefined | readonly string[]>): string[] {
  const seeds = new Set<string>();
  for (const group of groups) {
    const values =
      typeof group === 'string' || group === null || group === undefined ? [group] : group;
    for (const value of values) {
      if (!value) continue;
      seeds.add(value);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) seeds.add(encoded);
    }
  }
  return [...seeds];
}
