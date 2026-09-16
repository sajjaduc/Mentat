/**
 * LocalBlobStore contract.
 *
 * Local storage is the default deployment target, so this is the reference the
 * GCS implementation must match. The path-traversal assertions are security
 * tests, not unit trivia: `assertSafeKey` is the single gate every store uses.
 */
import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  assertSafeKey,
  BlobNotFoundError,
  blobKeyFor
} from '../../../src/lib/server/storage/blob-store';
import { LocalBlobStore } from '../../../src/lib/server/storage/local-blob-store';
import { createTestDatabase } from '../../helpers/db';

const encoder = new TextEncoder();

describe('assertSafeKey', () => {
  test('accepts content-addressed keys', () => {
    expect(() => assertSafeKey(blobKeyFor('ws-1', 'ab'.repeat(32)))).not.toThrow();
  });

  test.each(['../escape', 'a/../../b', '/absolute', 'a//b', 'a/./b', '', 'a b', 'a\u0000b'])(
    'rejects unsafe key %p',
    (key) => {
      expect(() => assertSafeKey(key)).toThrow();
    }
  );

  test('rejects keys longer than the limit', () => {
    expect(() => assertSafeKey('a'.repeat(513))).toThrow();
  });
});

describe('LocalBlobStore contract', () => {
  test('put/get round-trips bytes and overwrites atomically', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', 'aa'.repeat(32));

      await store.put(key, encoder.encode('first'));
      expect(new TextDecoder().decode(await store.get(key))).toBe('first');
      expect(await store.exists(key)).toBe(true);

      await store.put(key, encoder.encode('second'));
      expect(new TextDecoder().decode(await store.get(key))).toBe('second');
    } finally {
      handle.cleanup();
    }
  });

  test('verifies the supplied content hash before publishing', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', 'bb'.repeat(32));
      await expect(
        store.put(key, encoder.encode('payload'), { contentHash: 'nope' })
      ).rejects.toThrow();
      expect(await store.exists(key)).toBe(false);
    } finally {
      handle.cleanup();
    }
  });

  test('missing objects surface as BlobNotFoundError', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', 'cc'.repeat(32));
      await expect(store.get(key)).rejects.toBeInstanceOf(BlobNotFoundError);
      await expect(store.getStream(key)).rejects.toBeInstanceOf(BlobNotFoundError);
      expect(await store.exists(key)).toBe(false);
      expect(await store.stat(key)).toBeNull();
      await expect(store.delete(key)).resolves.toBeUndefined();
    } finally {
      handle.cleanup();
    }
  });

  test('getStream yields the same bytes as get', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', 'dd'.repeat(32));
      const payload = encoder.encode('streamed content');
      await store.put(key, payload);

      const stream = await store.getStream(key);
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
      }
      expect(total).toEqual(payload);
    } finally {
      handle.cleanup();
    }
  });

  test('stat reports size and creation time', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', 'ee'.repeat(32));
      await store.put(key, encoder.encode('123456'));
      const stat = await store.stat(key);
      expect(stat).not.toBeNull();
      expect(stat?.size).toBe(6);
      expect(stat?.key).toBe(key);
      expect(stat?.createdAt).toBeGreaterThan(0);
    } finally {
      handle.cleanup();
    }
  });

  test('delete removes the object and is idempotent', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', 'ff'.repeat(32));
      await store.put(key, encoder.encode('bye'));
      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
      await store.delete(key);
    } finally {
      handle.cleanup();
    }
  });

  test('rejects keys that would escape the root', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      await expect(store.put('../evil', encoder.encode('x'))).rejects.toThrow();
      await expect(store.get('a/../../etc/passwd')).rejects.toThrow();
      await expect(store.getSignedUrl('../evil')).rejects.toThrow();
    } finally {
      handle.cleanup();
    }
  });

  test('local signed URLs are Mentat-served paths, never provider URLs', async () => {
    const handle = createTestDatabase();
    try {
      const store = new LocalBlobStore({ root: handle.tempDir });
      const key = blobKeyFor('ws-1', '11'.repeat(32));
      const url = await store.getSignedUrl(key);
      expect(url.startsWith('/api/files/blob?key=')).toBe(true);
      expect(url).toContain(encodeURIComponent(key));
    } finally {
      handle.cleanup();
    }
  });

  test('keeps its root inside the configured directory', async () => {
    const handle = createTestDatabase();
    try {
      const root = `${handle.tempDir}/nested/blobs`;
      const store = new LocalBlobStore({ root });
      const key = blobKeyFor('ws-1', '22'.repeat(32));
      await store.put(key, encoder.encode('scoped'));
      expect(store.resolvePath(key).startsWith(root)).toBe(true);
      await rm(root, { recursive: true, force: true });
    } finally {
      handle.cleanup();
    }
  });
});
