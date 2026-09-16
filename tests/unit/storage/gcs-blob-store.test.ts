/**
 * Contract tests for GcsBlobStore.
 *
 * These tests must never contact GCS or load `@google-cloud/storage`: the store
 * is constructed with an injected `clientFactory` backed by an in-memory fake,
 * which also lets us assert exactly which objects and options reached the
 * provider layer. The fake deliberately misbehaves the way the real SDK does
 * (404-shaped errors, `ignoreNotFound` handling) so the store's own tolerance
 * is what the assertions exercise.
 */
import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { sha256Hex } from '../../../src/lib/server/core/hash';
import { BlobNotFoundError, type BlobStore } from '../../../src/lib/server/storage/blob-store';
import {
  GcsBlobStore,
  type GcsBlobStoreOptions,
  type GcsBucketLike,
  type GcsFileLike,
  type GcsStorageLike
} from '../../../src/lib/server/storage/gcs-blob-store';

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
  customMetadata: Record<string, string>;
  timeCreated: string;
}

interface SignedUrlCall {
  name: string;
  options: Record<string, unknown>;
}

interface DeleteCall {
  name: string;
  ignoreNotFound?: boolean;
}

/** In-memory replacement for the GCS SDK surface used by GcsBlobStore. */
class FakeGcsStorage implements GcsStorageLike {
  readonly objects = new Map<string, StoredObject>();
  readonly signedUrlCalls: SignedUrlCall[] = [];
  readonly deleteCalls: DeleteCall[] = [];
  bucketCalls = 0;
  fileCalls = 0;

  bucket(_name: string): GcsBucketLike {
    this.bucketCalls += 1;
    return {
      file: (objectName: string): GcsFileLike => {
        this.fileCalls += 1;
        return this.#fileAt(objectName);
      }
    };
  }

  #fileAt(objectName: string): GcsFileLike {
    const fake = this;
    return {
      async save(data, options) {
        // Real GCS overwrites in place, so a plain Map set is the same thing.
        fake.objects.set(objectName, {
          bytes: new Uint8Array(data),
          contentType: options?.contentType,
          customMetadata: { ...(options?.metadata?.metadata ?? {}) },
          timeCreated: new Date().toISOString()
        });
      },
      async download() {
        const object = fake.objects.get(objectName);
        if (!object) throw notFound(objectName);
        return [object.bytes];
      },
      createReadStream() {
        const object = fake.objects.get(objectName);
        if (!object) throw notFound(objectName);
        return Readable.from([object.bytes]);
      },
      async exists() {
        return [fake.objects.has(objectName)];
      },
      async delete(options) {
        fake.deleteCalls.push({ name: objectName, ignoreNotFound: options?.ignoreNotFound });
        // Intentionally ignores `ignoreNotFound` so the store's own 404
        // tolerance is what keeps a delete of a missing key from throwing.
        if (!fake.objects.has(objectName)) throw notFound(objectName);
        fake.objects.delete(objectName);
      },
      async getMetadata() {
        const object = fake.objects.get(objectName);
        if (!object) throw notFound(objectName);
        return [
          {
            size: object.bytes.length,
            contentType: object.contentType,
            timeCreated: object.timeCreated,
            metadata: { ...object.customMetadata }
          }
        ];
      },
      async getSignedUrl(options) {
        fake.signedUrlCalls.push({ name: objectName, options });
        return [`https://storage.example.test/${objectName}?X-Goog-Signature=fake`];
      }
    };
  }
}

function notFound(name: string): Error & { code: number } {
  return Object.assign(new Error(`Not Found: ${name}`), { code: 404 });
}

interface Harness {
  store: BlobStore;
  fake: FakeGcsStorage;
  factoryCalls: () => number;
}

function createHarness(options: Partial<GcsBlobStoreOptions> = {}): Harness {
  const fake = new FakeGcsStorage();
  let calls = 0;
  const store: BlobStore = new GcsBlobStore({
    bucket: options.bucket ?? 'mentat-test-bucket',
    prefix: options.prefix === undefined ? 'workspaces/ws-1' : options.prefix,
    credentials: options.credentials ?? null,
    projectId: options.projectId ?? 'mentat-test-project',
    signedUrlTtlSeconds: options.signedUrlTtlSeconds,
    clientFactory: async () => {
      calls += 1;
      return fake;
    }
  });
  return { store, fake, factoryCalls: () => calls };
}

const encoder = new TextEncoder();

describe('GcsBlobStore', () => {
  test('round-trips bytes under the normalized prefix', async () => {
    const { store, fake } = createHarness({ prefix: '/workspaces/ws-1/' });
    expect(store.kind).toBe('gcs');

    const bytes = encoder.encode('hello object storage');
    await store.put('blobs/ab/cd/hash', bytes, { contentType: 'text/plain' });

    const stored = fake.objects.get('workspaces/ws-1/blobs/ab/cd/hash');
    expect(stored).toBeDefined();
    expect(stored?.bytes).toEqual(bytes);
    expect(stored?.contentType).toBe('text/plain');

    const got = await store.get('blobs/ab/cd/hash');
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got).toEqual(bytes);
    expect(await store.exists('blobs/ab/cd/hash')).toBe(true);
  });

  test('records and reads back the content hash from custom metadata', async () => {
    const { store, fake } = createHarness();
    const bytes = encoder.encode('hashed payload');
    const hash = await sha256Hex(bytes);

    await store.put('blobs/aa/bb/thing', bytes, { contentHash: hash });

    expect(fake.objects.get('workspaces/ws-1/blobs/aa/bb/thing')?.customMetadata).toEqual({
      contentHash: hash
    });
    expect((await store.stat('blobs/aa/bb/thing'))?.contentHash).toBe(hash);
  });

  test('verifies the content hash before uploading anything', async () => {
    const { store, fake } = createHarness();
    const bytes = encoder.encode('payload');
    const good = await sha256Hex(bytes);
    await store.put('good/key', bytes, { contentHash: good });

    const sizeBefore = fake.objects.size;
    await expect(store.put('bad/key', bytes, { contentHash: 'deadbeef' })).rejects.toThrow(
      /hash mismatch/i
    );
    expect(fake.objects.size).toBe(sizeBefore);
    expect(fake.objects.has('workspaces/ws-1/bad/key')).toBe(false);
  });

  test('reports missing objects consistently across every operation', async () => {
    const { store } = createHarness();

    const getError = await store.get('missing/key').catch((error: unknown) => error);
    expect(getError).toBeInstanceOf(BlobNotFoundError);
    expect((getError as BlobNotFoundError).key).toBe('missing/key');
    // The caller's key, not the prefixed object name, is what surfaces.
    expect((getError as Error).message).toContain('missing/key');
    expect((getError as Error).message).not.toContain('workspaces/ws-1');

    const streamError = await store.getStream('missing/key').catch((error: unknown) => error);
    expect(streamError).toBeInstanceOf(BlobNotFoundError);
    expect((streamError as BlobNotFoundError).key).toBe('missing/key');

    expect(await store.exists('missing/key')).toBe(false);
    expect(await store.stat('missing/key')).toBeNull();
    await expect(store.delete('missing/key')).resolves.toBeUndefined();
  });

  test('stat exposes size, contentType and createdAt from object metadata', async () => {
    const { store } = createHarness();
    const bytes = encoder.encode('0123456789');
    const before = Date.now();

    await store.put('blobs/aa/bb/doc', bytes, { contentType: 'application/pdf' });
    const metadata = await store.stat('blobs/aa/bb/doc');

    expect(metadata).not.toBeNull();
    expect(metadata?.key).toBe('blobs/aa/bb/doc');
    expect(metadata?.size).toBe(bytes.length);
    expect(metadata?.contentType).toBe('application/pdf');
    expect(typeof metadata?.createdAt).toBe('number');
    expect(metadata?.createdAt).toBeGreaterThanOrEqual(before);
  });

  test('getStream yields exactly the bytes returned by get', async () => {
    const { store } = createHarness();
    const bytes = encoder.encode('stream me back');
    await store.put('stream/key', bytes);

    const stream = await store.getStream('stream/key');
    const collected = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(collected).toEqual(bytes);
    expect(await store.get('stream/key')).toEqual(bytes);
  });

  test('rejects unsafe keys without touching the provider client', async () => {
    const { store, fake, factoryCalls } = createHarness({ prefix: null });
    const unsafeKeys = ['../x', 'a/../b', '', '/abs', 'a//b'];

    for (const key of unsafeKeys) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow();
      await expect(store.get(key)).rejects.toThrow();
      await expect(store.getSignedUrl(key)).rejects.toThrow();
    }

    expect(fake.objects.size).toBe(0);
    expect(fake.fileCalls).toBe(0);
    expect(fake.bucketCalls).toBe(0);
    expect(factoryCalls()).toBe(0);
  });

  test('rejects a prefix containing traversal segments', () => {
    expect(() => createHarness({ prefix: 'workspaces/../other' })).toThrow();
    expect(() => createHarness({ prefix: '..' })).toThrow();
    expect(() => createHarness({ prefix: 'a/./b' })).toThrow();
  });

  test('getSignedUrl requests a v4 read URL expiring roughly now plus the ttl', async () => {
    const { store, fake } = createHarness({ signedUrlTtlSeconds: 900 });
    const before = Date.now();

    const url = await store.getSignedUrl('blobs/aa/bb/doc');
    const after = Date.now();

    expect(url).toContain('X-Goog-Signature');
    expect(fake.signedUrlCalls).toHaveLength(1);
    const call = fake.signedUrlCalls[0];
    expect(call?.name).toBe('workspaces/ws-1/blobs/aa/bb/doc');
    expect(call?.options.version).toBe('v4');
    expect(call?.options.action).toBe('read');
    const expires = call?.options.expires;
    expect(typeof expires).toBe('number');
    expect(expires as number).toBeGreaterThanOrEqual(before + 900_000);
    expect(expires as number).toBeLessThanOrEqual(after + 900_000);
  });

  test('never exposes credentials through serialization, properties or errors', async () => {
    const credentials = {
      client_email: 'svc@example.test',
      private_key: 'super-secret-private-key-value'
    };
    const { store } = createHarness({ credentials, prefix: null });

    expect(JSON.stringify(store)).not.toContain('super-secret-private-key-value');
    expect(JSON.stringify(store)).not.toContain('svc@example.test');
    expect(String(store)).not.toContain('super-secret-private-key-value');

    const ownProperties = Object.getOwnPropertyNames(store).join(',');
    expect(ownProperties).not.toContain('super-secret-private-key-value');
    expect(ownProperties).not.toContain('credentials');

    const error = await store.get('missing/key').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BlobNotFoundError);
    expect((error as Error).message).not.toContain('super-secret-private-key-value');
    expect((error as Error).message).not.toContain('svc@example.test');
    expect(JSON.stringify(error)).not.toContain('super-secret-private-key-value');
  });

  test('overwrites bytes at an existing key in place', async () => {
    const { store, fake } = createHarness({ prefix: null });
    const first = encoder.encode('first version');
    const second = encoder.encode('second version, longer');

    await store.put('same/key', first, { contentType: 'text/plain' });
    expect(await store.get('same/key')).toEqual(first);

    await store.put('same/key', second, { contentType: 'text/plain' });
    expect(await store.get('same/key')).toEqual(second);
    expect(fake.objects.size).toBe(1);
    expect(fake.objects.has('same/key')).toBe(true);
  });

  test('creates the provider client lazily and only once', async () => {
    const { store, factoryCalls } = createHarness({ prefix: null });
    expect(factoryCalls()).toBe(0);

    await store.exists('lazy/key');
    expect(factoryCalls()).toBe(1);

    await store.exists('lazy/key');
    expect(factoryCalls()).toBe(1);
  });
});
