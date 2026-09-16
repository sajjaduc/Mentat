/**
 * Cache identity.
 *
 * A cached value belongs to exactly one workspace *and* one credential scope. The
 * physical uniqueness of `cache_entries` is
 * `(workspaceId, namespace, authScope, key)`, and this module is the single place
 * that normalizes and fingerprints that tuple. Cache identity is therefore a
 * security boundary, not a convenience: two callers may only share an entry when
 * every component matches (see ADR-0016 and the tenancy invariant in the brief).
 *
 * The hash is exposed for logs, diagnostics and future sharded stores; the raw
 * identity string is what the database enforces.
 */
import { errors } from '../core/errors';
import { sha256Hex, stableStringify } from '../core/hash';

export const DEFAULT_NAMESPACE = 'default';
/** Anonymous/workspace-level credential scope; never a user- or secret-derived id. */
export const DEFAULT_AUTH_SCOPE = '';

export const MAX_CACHE_KEY_LENGTH = 512;
export const MAX_CACHE_NAMESPACE_LENGTH = 128;
export const MAX_CACHE_AUTH_SCOPE_LENGTH = 256;

export interface CacheKeyInput {
  workspaceId: string;
  key: string;
  namespace?: string;
  /**
   * Identity of the credential the value was produced under (for example an HTTP
   * service + secret version, or an agent run's resolved auth). Values cached under
   * one scope are never returned for another.
   */
  authScope?: string;
}

export interface NormalizedCacheKey {
  workspaceId: string;
  namespace: string;
  key: string;
  authScope: string;
}

export function normalizeCacheKey(input: CacheKeyInput): NormalizedCacheKey {
  const namespace = input.namespace?.trim() ? input.namespace.trim() : DEFAULT_NAMESPACE;
  return {
    workspaceId: input.workspaceId,
    namespace,
    key: input.key,
    authScope: input.authScope ?? DEFAULT_AUTH_SCOPE
  };
}

/** Reject unusable identities before they reach storage. */
export function validateCacheKey(input: NormalizedCacheKey): void {
  if (!input.workspaceId) throw errors.validation('A cache key requires a workspaceId');
  if (!input.key) throw errors.validation('A cache key requires a non-empty key');
  if (input.key.length > MAX_CACHE_KEY_LENGTH) {
    throw errors.validation(`Cache key must be ${MAX_CACHE_KEY_LENGTH} characters or fewer`, {
      length: input.key.length
    });
  }
  if (input.namespace.length > MAX_CACHE_NAMESPACE_LENGTH) {
    throw errors.validation(
      `Cache namespace must be ${MAX_CACHE_NAMESPACE_LENGTH} characters or fewer`
    );
  }
  if (input.authScope.length > MAX_CACHE_AUTH_SCOPE_LENGTH) {
    throw errors.validation(
      `Cache authScope must be ${MAX_CACHE_AUTH_SCOPE_LENGTH} characters or fewer`
    );
  }
}

/** Canonical, order-stable identity string for a cache slot. */
export function cacheIdentity(input: CacheKeyInput): string {
  const key = normalizeCacheKey(input);
  return stableStringify([key.workspaceId, key.namespace, key.authScope, key.key]);
}

/** SHA-256 fingerprint of {@link cacheIdentity}; safe to log. */
export function cacheIdentityHash(input: CacheKeyInput): Promise<string> {
  return sha256Hex(cacheIdentity(input));
}
