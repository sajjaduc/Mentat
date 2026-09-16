/**
 * HTTP response cache.
 *
 * ## Why the identity has three parts
 *
 * A cached HTTP response is only safe to reuse for the *same tenant* using the *same
 * credential*. Two workspaces may call the same URL and get different data, and one
 * workspace may hold two credentials (say a sandbox and a production key) against the
 * same service. Reusing across either boundary is a data leak, so the cache identity is
 * `(workspaceId, namespace, authScope, key)`:
 *
 *  - `workspaceId` is the tenant;
 *  - `authScope` is a fingerprint of *which* secret the request would use — never the
 *    secret itself — so rotating a credential naturally misses the old entries;
 *  - `key` is the method + URL + body fingerprint, so different queries never collide.
 *
 * The store talks to the frozen `cache_entries` table directly rather than importing
 * another workstream's cache module, which keeps this workstream independently
 * buildable while still landing in the shared, inspectable cache.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { sha256HexSync } from '../core/hash';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import type { CachePolicy, HttpAuthConfig, HttpAuthType, HttpMethod } from '../db/schema';
import { cacheEntries } from '../db/schema';

export type HttpCacheStatus = 'hit' | 'miss' | 'stored' | 'bypass';

/** The subset of a response worth caching and replaying. */
export interface HttpCachedResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response was JSON, otherwise the raw text. */
  body: unknown;
  bodyText: string;
  contentType: string | null;
  storedAt: number;
  expiresAt: number | null;
}

export interface HttpCacheIdentity {
  workspaceId: string;
  namespace: string;
  authScope: string;
  key: string;
}

export interface HttpCacheStore {
  get(identity: HttpCacheIdentity, now?: number): Promise<HttpCachedResponse | null>;
  set(
    identity: HttpCacheIdentity,
    value: HttpCachedResponse,
    options: { ttlSeconds?: number | null }
  ): Promise<void>;
  delete(identity: HttpCacheIdentity): Promise<void>;
}

export interface HttpCacheIdentityInput {
  workspaceId: string;
  serviceId: string;
  operationId: string;
  method: HttpMethod;
  url: string;
  /** Serialized request body, when there is one. */
  body?: string | null;
  /** Fingerprint of the credential the request would use. */
  authScope: string;
  /** Extra values (`cachePolicy.varyOn`) folded into the key. */
  varyOn?: Record<string, unknown> | null;
}

/** Only safe, side-effect-free methods are cached by default. */
const CACHEABLE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET', 'HEAD']);

export function isCacheableMethod(method: HttpMethod): boolean {
  return CACHEABLE_METHODS.has(method);
}

/** Effective policy: the operation's policy wins, then the service's, then off. */
export function effectiveCachePolicy(
  servicePolicy: CachePolicy | null | undefined,
  operationPolicy: CachePolicy | null | undefined
): CachePolicy | null {
  return operationPolicy ?? servicePolicy ?? null;
}

/**
 * Whether a request may be cached at all: cacheable method, policy enabled, and the
 * read side not explicitly disabled.
 */
/**
 * Whether the request participates in caching at all: policy enabled and method
 * cacheable. Writes still happen when reads are disabled, which lets a caller warm a
 * shared cache without trusting it yet.
 */
export function isCacheEnabled(
  policy: CachePolicy | null | undefined,
  method: HttpMethod
): boolean {
  if (!policy?.enabled) return false;
  return isCacheableMethod(method);
}

/** Whether cached responses may be *read*. `cachePolicy.read === false` disables reads. */
export function isCacheReadEnabled(
  policy: CachePolicy | null | undefined,
  method: HttpMethod
): boolean {
  return isCacheEnabled(policy, method) && policy?.read !== false;
}

/**
 * Fingerprint the credential a service would use. This is intentionally derived from
 * the *references* (secret ids, header names, username) rather than resolved values,
 * so it can be computed before — and without — decrypting anything.
 */
export function computeAuthScope(
  authType: HttpAuthType,
  authConfig: HttpAuthConfig | null | undefined
): string {
  const config = authConfig ?? {};
  const descriptor = [
    authType,
    config.secretId ?? '',
    config.passwordSecretId ?? '',
    config.username ?? '',
    config.headerName ?? '',
    config.queryName ?? ''
  ].join('|');
  return `${authType}:${hashText(descriptor).slice(0, 16)}`;
}

/** Deterministic cache identity including tenant and credential scope. */
export function httpCacheIdentity(input: HttpCacheIdentityInput): HttpCacheIdentity {
  const parts = [input.method, input.url];
  if (input.body) parts.push(input.body);
  if (input.varyOn) parts.push(stableStringify(input.varyOn));
  return {
    workspaceId: input.workspaceId,
    namespace: `http:${input.serviceId}:${input.operationId}`,
    authScope: input.authScope,
    key: hashText(parts.join('\n'))
  };
}

/** SQL-backed default store over the frozen `cache_entries` table. */
export class SqliteHttpCacheStore implements HttpCacheStore {
  constructor(private readonly db: Executor) {}

  async get(
    identity: HttpCacheIdentity,
    now: number = Date.now()
  ): Promise<HttpCachedResponse | null> {
    const rows = this.db
      .select()
      .from(cacheEntries)
      .where(
        and(
          eq(cacheEntries.workspaceId, identity.workspaceId),
          eq(cacheEntries.namespace, identity.namespace),
          eq(cacheEntries.authScope, identity.authScope),
          eq(cacheEntries.key, identity.key),
          or(isNull(cacheEntries.expiresAt), gt(cacheEntries.expiresAt, now))
        )
      )
      .limit(1)
      .all();
    const row = rows[0];
    if (!row) return null;

    this.db
      .update(cacheEntries)
      .set({ hits: sql`${cacheEntries.hits} + 1`, lastAccessedAt: now })
      .where(eq(cacheEntries.id, row.id))
      .run();

    const value = (row.value ?? {}) as HttpCachedResponse;
    return { ...value, storedAt: row.createdAt, expiresAt: row.expiresAt };
  }

  async set(
    identity: HttpCacheIdentity,
    value: HttpCachedResponse,
    options: { ttlSeconds?: number | null }
  ): Promise<void> {
    const now = Date.now();
    const expiresAt =
      options.ttlSeconds === null || options.ttlSeconds === undefined
        ? null
        : now + options.ttlSeconds * 1000;
    const row = {
      id: uuidv7(),
      workspaceId: identity.workspaceId,
      namespace: identity.namespace,
      authScope: identity.authScope,
      key: identity.key,
      value: value as never,
      sizeBytes: byteLength(value.bodyText ?? ''),
      hits: 0,
      tags: null,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      expiresAt
    };
    this.db
      .insert(cacheEntries)
      .values(row)
      .onConflictDoUpdate({
        target: [
          cacheEntries.workspaceId,
          cacheEntries.namespace,
          cacheEntries.authScope,
          cacheEntries.key
        ],
        set: {
          value: value as never,
          sizeBytes: row.sizeBytes,
          hits: 0,
          updatedAt: now,
          lastAccessedAt: now,
          expiresAt
        }
      })
      .run();
  }

  async delete(identity: HttpCacheIdentity): Promise<void> {
    this.db
      .delete(cacheEntries)
      .where(
        and(
          eq(cacheEntries.workspaceId, identity.workspaceId),
          eq(cacheEntries.namespace, identity.namespace),
          eq(cacheEntries.authScope, identity.authScope),
          eq(cacheEntries.key, identity.key)
        )
      )
      .run();
  }
}

function hashText(text: string): string {
  return sha256HexSync(new TextEncoder().encode(text));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Stable JSON for `varyOn` so object key order never changes the cache key. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
