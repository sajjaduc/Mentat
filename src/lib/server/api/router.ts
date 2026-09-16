/**
 * API dispatcher.
 *
 * Responsibilities, in order:
 *  1. match method + path against the route table (404 with a helpful list);
 *  2. resolve the acting context from locals (the caller supplies it);
 *  3. assert the route's permission;
 *  4. validate query and body through Zod;
 *  5. run the handler;
 *  6. convert `AppError`s into stable, redacted JSON errors.
 *
 * Handlers therefore never parse requests, check permissions or shape errors — they
 * only implement behaviour.
 */

import { type ActorContext, hasPermission } from '../core/context';
import { errors, isAppError, toAppError } from '../core/errors';
import { moduleLogger } from '../core/logger';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import type { Executor } from '../db/client';
import { apiRoutes } from './routes';
import type { ApiResponse, ApiRoute } from './types';

const log = moduleLogger('api');

export interface DispatchInput {
  db: Executor;
  method: string;
  pathname: string;
  /** Populated from the session cookie by the SvelteKit adapter. */
  actor: ActorContext | null;
  /** Parsed query string parameters (already decoded). */
  query: Record<string, string>;
  /** Raw request body text; parsed when a route declares a body schema. */
  rawBody?: string;
  request: Request;
}

export interface DispatchResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export async function dispatchApi(input: DispatchInput): Promise<DispatchResult> {
  const requestId = crypto.randomUUID();
  const pathname = normalizePath(input.pathname);
  const matched = matchRoute(input.method, pathname);

  if (!matched) {
    const allowed = apiRoutes
      .filter((candidate) => matchPath(candidate.path, pathname) !== null)
      .map((candidate) => candidate.method);
    return {
      status: allowed.length > 0 ? 405 : 404,
      body: {
        error: {
          code: allowed.length > 0 ? 'method_not_allowed' : 'not_found',
          message:
            allowed.length > 0
              ? `${input.method} is not allowed on ${pathname}. Allowed: ${allowed.join(', ')}`
              : `No API route matches ${input.method} ${pathname}`,
          requestId
        }
      },
      headers: allowed.length > 0 ? { Allow: allowed.join(', ') } : {}
    };
  }

  const { route: matchedRoute, params } = matched;

  if (!matchedRoute.public && !input.actor) {
    return errorResult(errors.unauthorized(), requestId);
  }

  const actor = input.actor;
  if (matchedRoute.permission && actor && !hasPermission(actor, matchedRoute.permission)) {
    return errorResult(
      errors.forbidden(`Missing permission: ${matchedRoute.permission}`, {
        permission: matchedRoute.permission,
        role: actor.role
      }),
      requestId
    );
  }

  const parsedBody = resolveBody(matchedRoute, input.rawBody);
  if ('failure' in parsedBody) return errorResult(parsedBody.failure, requestId);

  const parsedQuery = resolveQuery(matchedRoute, input.query);
  if ('failure' in parsedQuery) return errorResult(parsedQuery.failure, requestId);

  const body = parsedBody.value;
  const query = parsedQuery.value;

  try {
    const handler = matchedRoute.handler as unknown as (context: {
      db: Executor;
      actor: ActorContext;
      params: Record<string, string>;
      query: unknown;
      body: unknown;
      request: Request;
      rawBody: string | null;
      method: string;
      pathname: string;
    }) => unknown;
    const response = (await handler({
      db: input.db,
      actor: (actor ?? null) as ActorContext,
      params,
      query,
      body,
      request: input.request,
      rawBody: input.rawBody ?? null,
      method: input.method,
      pathname
    })) as ApiResponse | Response | undefined;

    if (response && typeof response === 'object' && response instanceof Response) {
      return {
        status: response.status,
        body: null,
        headers: Object.fromEntries(response.headers.entries())
      };
    }

    const shaped = (response ?? {}) as ApiResponse;
    // Resolve promises *anywhere* in the body, not just at the top level. A handler
    // that writes `{ jobs: listJobs(...) }` without awaiting would otherwise
    // serialize `{}` and the client would see an empty collection with no error —
    // the hardest kind of bug to notice. Deep resolution makes that impossible.
    const resolvedBody = await resolveDeep(shaped.body);
    return {
      status: shaped.status ?? 200,
      body: resolvedBody ?? null,
      headers: shaped.headers ?? {}
    };
  } catch (error) {
    if (isAppError(error)) return errorResult(error, requestId);
    const appError = toAppError(error);
    log.error('unhandled API error', {
      pathname,
      method: input.method,
      code: appError.code,
      error
    });
    return errorResult(appError, requestId);
  }
}

/** Await promises nested in objects and arrays, up to a depth limit. */
async function resolveDeep(value: unknown, depth = 0): Promise<unknown> {
  if (depth > 6) return value;
  if (value && typeof (value as { then?: unknown }).then === 'function') {
    return resolveDeep(await (value as Promise<unknown>), depth + 1);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => resolveDeep(entry, depth + 1)));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, entry]) => [
        key,
        await resolveDeep(entry, depth + 1)
      ])
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** Validate the request body against the route's schema, if it declares one. */
function resolveBody(
  matchedRoute: ApiRoute,
  rawBody: string | null | undefined
): { value: unknown } | { failure: ReturnType<typeof toAppError> } {
  const raw = rawBody ?? undefined;
  if (matchedRoute.body) {
    const parsedJson = parseJsonBody(raw);
    if (parsedJson === INVALID_JSON) {
      return { failure: errors.badRequest('Request body is not valid JSON') };
    }
    const result = matchedRoute.body.safeParse(parsedJson ?? {});
    if (!result.success) return { failure: validationError(result.error) };
    return { value: result.data };
  }
  if (raw && raw.length > 0) return { value: parseJsonBody(raw) };
  return { value: undefined };
}

/** Validate the query against the route's schema, if it declares one. */
function resolveQuery(
  matchedRoute: ApiRoute,
  query: unknown
): { value: unknown } | { failure: ReturnType<typeof toAppError> } {
  if (!matchedRoute.query) return { value: query };
  const result = matchedRoute.query.safeParse(query);
  if (!result.success) return { failure: validationError(result.error) };
  return { value: result.data };
}

function errorResult(error: ReturnType<typeof toAppError>, requestId: string): DispatchResult {
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: error.message,
        details: redactDetails(error.details),
        requestId
      }
    },
    headers: {}
  };
}

/** Belt and braces: an error detail object must never carry a secret plaintext. */
function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(details).length === 0) return details;
  return createRedactor(registeredSecretValues()).value(details);
}

function validationError(error: {
  issues: Array<{ path: PropertyKey[]; message: string; code: string }>;
}) {
  return errors.validation(
    error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; '),
    {
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code
      }))
    }
  );
}

const INVALID_JSON = Symbol('invalid-json');

function parseJsonBody(raw: string | undefined): unknown | typeof INVALID_JSON {
  if (raw === undefined || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return INVALID_JSON;
  }
}

export function normalizePath(pathname: string): string {
  const withoutTrailing = pathname.replace(/\/+$/, '');
  return withoutTrailing.length === 0 ? '/' : withoutTrailing;
}

/**
 * Match a `:param` pattern against a concrete path, returning captured params.
 * Returns null when the shape does not match.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = normalizePath(pattern).split('/').filter(Boolean);
  const pathSegments = normalizePath(pathname).split('/').filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (const [index, segment] of patternSegments.entries()) {
    const actual = pathSegments[index] as string;
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (segment !== actual) return null;
  }
  return params;
}

/**
 * Resolve a request to a route.
 *
 * When several patterns match the same shape, the most *literal* one wins: a static
 * segment beats a parameter, so `/files/search` reaches the search handler rather
 * than being swallowed by `/files/:id`. Ties keep declaration order.
 */
export function matchRoute(
  method: string,
  pathname: string
): { route: ApiRoute; params: Record<string, string> } | null {
  const upperMethod = method.toUpperCase();
  let best: { route: ApiRoute; params: Record<string, string>; score: number } | null = null;

  for (const candidate of apiRoutes) {
    if (candidate.method !== upperMethod) continue;
    const params = matchPath(candidate.path, pathname);
    if (!params) continue;
    const score = literalSegmentCount(candidate.path);
    if (!best || score > best.score) {
      best = { route: candidate, params, score };
    }
  }

  return best ? { route: best.route, params: best.params } : null;
}

/** Number of non-parameter segments; higher means a more specific pattern. */
function literalSegmentCount(pattern: string): number {
  return normalizePath(pattern)
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith(':')).length;
}

/** Human-readable API index, used by the health endpoint and the docs page. */
export function apiIndex(): Array<{
  method: string;
  path: string;
  permission?: string;
  summary?: string;
}> {
  return apiRoutes
    .map((entry) => ({
      method: entry.method,
      path: entry.path,
      permission: entry.permission,
      summary: entry.summary
    }))
    .sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)
    );
}
