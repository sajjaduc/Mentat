import { describe, expect, test } from 'bun:test';
import {
  cacheIdentity,
  cacheIdentityHash,
  DEFAULT_AUTH_SCOPE,
  DEFAULT_NAMESPACE,
  MAX_CACHE_KEY_LENGTH,
  normalizeCacheKey,
  validateCacheKey
} from '../../../src/lib/server/cache/identity';

describe('cache identity', () => {
  test('normalizes missing namespace and auth scope to their defaults', () => {
    const key = normalizeCacheKey({ workspaceId: 'ws-1', key: 'weather' });
    expect(key.namespace).toBe(DEFAULT_NAMESPACE);
    expect(key.authScope).toBe(DEFAULT_AUTH_SCOPE);
  });

  test('treats a blank namespace as the default namespace', () => {
    expect(normalizeCacheKey({ workspaceId: 'ws-1', key: 'k', namespace: '   ' }).namespace).toBe(
      DEFAULT_NAMESPACE
    );
  });

  test('is stable regardless of property order', () => {
    const a = cacheIdentity({ workspaceId: 'ws-1', key: 'k', namespace: 'n', authScope: 's' });
    const b = cacheIdentity({ authScope: 's', namespace: 'n', key: 'k', workspaceId: 'ws-1' });
    expect(a).toBe(b);
  });

  test('separates identity by workspace, namespace, authScope and key', () => {
    const base = { workspaceId: 'ws-1', key: 'k', namespace: 'n', authScope: 's' };
    const identities = new Set([
      cacheIdentity(base),
      cacheIdentity({ ...base, workspaceId: 'ws-2' }),
      cacheIdentity({ ...base, namespace: 'm' }),
      cacheIdentity({ ...base, authScope: 'other' }),
      cacheIdentity({ ...base, key: 'j' })
    ]);
    expect(identities.size).toBe(5);
  });

  test('hashes identity deterministically to 64 hex characters', async () => {
    const input = { workspaceId: 'ws-1', key: 'k', namespace: 'n', authScope: 's' };
    const hash = await cacheIdentityHash(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheIdentityHash(input)).toBe(hash);
    expect(await cacheIdentityHash({ ...input, authScope: 'other' })).not.toBe(hash);
  });

  test('rejects an empty or oversized key', () => {
    expect(() => validateCacheKey(normalizeCacheKey({ workspaceId: 'ws-1', key: '' }))).toThrow();
    expect(() =>
      validateCacheKey(
        normalizeCacheKey({ workspaceId: 'ws-1', key: 'x'.repeat(MAX_CACHE_KEY_LENGTH + 1) })
      )
    ).toThrow();
  });
});
