/**
 * API router types.
 *
 * Mentat's HTTP API is one router rather than dozens of near-identical
 * `+server.ts` files. Each route declares its method, path pattern, the permission
 * it needs, and Zod schemas for body/query; the dispatcher applies all four
 * consistently. That means the authorization boundary, validation and error
 * mapping are written and tested once instead of being re-implemented per route —
 * which is where boundary bugs usually live.
 */
import type { z } from 'zod';
import type { ActorContext } from '../core/context';
import type { Executor } from '../db/client';

export interface ApiContext<Body = unknown, Query = unknown> {
  db: Executor;
  actor: ActorContext;
  /** Path parameters captured from the pattern, e.g. `:id`. */
  params: Record<string, string>;
  query: Query;
  body: Body;
  /** The raw request, for handlers that need headers or streams. */
  request: Request;
  /**
   * The exact request body text as received. Handlers that must not re-read the
   * stream (signature verification, content hashing) use this, so the body has one
   * source of truth inside the dispatcher.
   */
  rawBody: string | null;
  method: string;
  pathname: string;
}

export interface ApiResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type ApiHandler<Body = unknown, Query = unknown> = (
  context: ApiContext<Body, Query>
) => Promise<ApiResponse | Response | undefined> | ApiResponse | Response | undefined;

export interface ApiRoute {
  method: string;
  /** Pattern with `:param` segments, e.g. `/workflows/:id/board`. */
  path: string;
  /** Permission asserted before the handler runs. */
  permission?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  handler: ApiHandler<never, never>;
  /** Documented purpose, surfaced by the API index endpoint. */
  summary?: string;
  /** When true the route is reachable without a session (webhooks, health). */
  public?: boolean;
}

/** Declarative helper so the route table reads as a table. */
export function route<B = unknown, Q = unknown>(definition: {
  method: string;
  path: string;
  permission?: string;
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  summary?: string;
  public?: boolean;
  handler: ApiHandler<B, Q>;
}): ApiRoute {
  return definition as unknown as ApiRoute;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}
