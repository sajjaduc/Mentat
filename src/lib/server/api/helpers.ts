/**
 * Shared API handler helpers.
 *
 * Handlers are thin: they resolve the workspace, wrap a synchronous domain
 * function in a transaction, and return a shaped body. These helpers keep that
 * pattern from being re-typed forty times.
 */

import type { ActorContext } from '../core/context';
import { errors } from '../core/errors';
import { type AppDb, type Executor, isTransaction } from '../db/client';
import type { ApiContext } from './types';

/**
 * Run a synchronous domain mutation in one transaction.
 *
 * Deliberately synchronous: `bun:sqlite` is a synchronous driver, so wrapping a
 * domain write in a promise buys nothing and forces every handler to remember an
 * `await` inside a nested object literal — which is exactly the mistake that
 * silently serializes a promise as `{}`. Awaiting the result is still harmless for
 * handlers that prefer it.
 */
export function mutate<T>(db: Executor, fn: (tx: Executor) => T): T {
  if (isTransaction(db)) return fn(db);
  return (db as AppDb).transaction((tx) => fn(tx as Executor));
}

/** Assert a path parameter matches the caller's active workspace. */
export function assertActiveWorkspace(actor: ActorContext, workspaceId: string): void {
  if (workspaceId !== actor.workspaceId) {
    // Cross-tenant probing must not confirm existence.
    throw errors.notFound('Resource', workspaceId);
  }
}

/** Read a required path parameter, failing with a clear validation error. */
export function param(context: ApiContext, name: string): string {
  const value = context.params[name];
  if (!value) throw errors.validation(`Missing path parameter: ${name}`);
  return value;
}

/** Read an optional query parameter as a trimmed string. */
export function queryString(context: ApiContext, name: string): string | null {
  const value = (context.query as Record<string, unknown>)[name];
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

/** Read a boolean query parameter with a default. */
export function queryBool(context: ApiContext, name: string, fallback = false): boolean {
  const value = queryString(context, name);
  if (value === null) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

/** Read an integer query parameter with a default and bounds. */
export function queryInt(
  context: ApiContext,
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {}
): number {
  const value = queryString(context, name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw errors.validation(`${name} must be a number`);
  }
  const min = bounds.min ?? Number.MIN_SAFE_INTEGER;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, min), max);
}

/** Parse a JSON-bearing query parameter, tolerating a missing value. */
export function queryJson<T>(context: ApiContext, name: string): T | null {
  const value = queryString(context, name);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw errors.validation(`${name} must be valid JSON`);
  }
}

/** Strip undefined values so a PATCH body only carries what changed. */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
