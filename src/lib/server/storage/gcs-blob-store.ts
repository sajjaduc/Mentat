/**
 * Google Cloud Storage BlobStore.
 *
 * Hosted Mentat deployments need object storage that survives container
 * restarts and scales past a single filesystem, while self-hosted deployments
 * must not pay for the SDK at runtime. Both goals drive the same design:
 * `@google-cloud/storage` is imported lazily inside the default client factory,
 * so merely importing the storage module never pulls the cloud SDK into a
 * local-only process, and the SDK object is reached only through a narrow
 * structural interface (`GcsStorageLike`) that tests can substitute.
 *
 * Keys are treated as untrusted input and validated before any object name is
 * built, including the configured prefix: a prefix containing `..` would
 * otherwise let a caller escape the intended namespace even though the key
 * itself is safe.
 */

import { sha256Hex } from '../core/hash';
import {
  assertSafeKey,
  type BlobMetadata,
  BlobNotFoundError,
  type BlobStore,
  type PutOptions
} from './blob-store';

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/**
 * The slice of the GCS SDK surface this store uses. Modelling it structurally —
 * instead of importing SDK types — is what keeps the SDK a lazy, optional
 * dependency and lets unit tests run an in-memory fake with no network.
 */
export interface GcsFileLike {
  save(
    data: Uint8Array,
    options?: {
      resumable?: boolean;
      contentType?: string;
      metadata?: { metadata?: Record<string, string> };
    }
  ): Promise<unknown>;
  download(): Promise<[Uint8Array]>;
  createReadStream(): NodeJS.ReadableStream;
  exists(): Promise<[boolean]>;
  delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  getMetadata(): Promise<[Record<string, unknown>]>;
  getSignedUrl(options: Record<string, unknown>): Promise<[string]>;
}

export interface GcsBucketLike {
  file(name: string): GcsFileLike;
}

export interface GcsStorageLike {
  bucket(name: string): GcsBucketLike;
}

export interface GcsBlobStoreOptions {
  bucket: string;
  /**
   * Already-resolved service-account credentials. Held in an ECMAScript private
   * field (not a TypeScript `private` field, which is erased at runtime and
   * therefore enumerable and serializable) so they can never leak through
   * `JSON.stringify`, property enumeration, or spread.
   */
  credentials?: Record<string, unknown> | null;
  projectId?: string | null;
  /** Namespace prepended to every key, e.g. `workspaces/abc`. */
  prefix?: string | null;
  /** Default lifetime for signed URLs; overridable per call. */
  signedUrlTtlSeconds?: number;
  /** Test seam: builds the SDK client on first use instead of loading the SDK. */
  clientFactory?: () => Promise<GcsStorageLike>;
}

export class GcsBlobStore implements BlobStore {
  readonly kind = 'gcs';

  readonly #credentials: Record<string, unknown> | null;
  readonly #projectId: string | null;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #signedUrlTtlSeconds: number;
  readonly #clientFactory: () => Promise<GcsStorageLike>;
  #client: Promise<GcsStorageLike> | null = null;

  constructor(options: GcsBlobStoreOptions) {
    if (!options.bucket || options.bucket.trim().length === 0) {
      throw new Error('GCS bucket name is required');
    }
    this.#bucket = options.bucket;
    this.#credentials = options.credentials ?? null;
    this.#projectId = options.projectId ?? null;
    this.#prefix = normalizePrefix(options.prefix);
    // Validate the prefix eagerly: a traversal segment must fail at construction,
    // before any object name can be assembled from it.
    if (this.#prefix) assertSafeKey(this.#prefix);
    this.#signedUrlTtlSeconds = options.signedUrlTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    this.#clientFactory =
      options.clientFactory ?? (() => createSdkClient(this.#credentials, this.#projectId));
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key);
    // Verify before uploading: a mismatch must leave the bucket untouched.
    if (options.contentHash) {
      const actual = await sha256Hex(bytes);
      if (actual !== options.contentHash) {
        throw new Error(
          `Blob hash mismatch for ${key}: expected ${options.contentHash}, computed ${actual}`
        );
      }
    }

    const file = await this.#fileFor(key);
    const saveOptions: {
      resumable: boolean;
      contentType?: string;
      metadata?: { metadata: Record<string, string> };
    } = { resumable: false };
    if (options.contentType) saveOptions.contentType = options.contentType;
    if (options.contentHash) {
      saveOptions.metadata = { metadata: { contentHash: options.contentHash } };
    }
    await file.save(bytes, saveOptions);
  }

  async get(key: string): Promise<Uint8Array> {
    const file = await this.#fileFor(key);
    try {
      const [bytes] = await file.download();
      // Normalize Buffer to a plain Uint8Array so callers never depend on Node.
      return new Uint8Array(bytes);
    } catch (error) {
      if (isNotFound(error)) throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const file = await this.#fileFor(key);
    // The SDK read stream reports a missing object asynchronously, so check
    // first to surface a deterministic BlobNotFoundError from this call.
    const [found] = await file.exists();
    if (!found) throw new BlobNotFoundError(key);

    const nodeStream = file.createReadStream();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on('data', (chunk: unknown) => controller.enqueue(toBytes(chunk)));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (error: unknown) => controller.error(error));
      },
      cancel() {
        // The structural NodeJS.ReadableStream type omits destroy; real SDK
        // streams expose it, and releasing the socket early avoids leaks.
        (nodeStream as { destroy?: () => void }).destroy?.();
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    const file = await this.#fileFor(key);
    try {
      const [found] = await file.exists();
      return found === true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const file = await this.#fileFor(key);
    try {
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async stat(key: string): Promise<BlobMetadata | null> {
    const file = await this.#fileFor(key);
    try {
      const [metadata] = await file.getMetadata();
      const result: BlobMetadata = { key, size: readSize(metadata) };
      const contentType = metadata.contentType;
      if (typeof contentType === 'string' && contentType.length > 0) {
        result.contentType = contentType;
      }
      const contentHash = readContentHash(metadata);
      if (contentHash) result.contentHash = contentHash;
      const createdAt = readCreatedAt(metadata);
      if (createdAt !== undefined) result.createdAt = createdAt;
      return result;
    } catch {
      // Mirror LocalBlobStore: an unreadable object is reported as absent.
      return null;
    }
  }

  async getSignedUrl(key: string, options: { expiresInSeconds?: number } = {}): Promise<string> {
    const file = await this.#fileFor(key);
    const expiresInSeconds = options.expiresInSeconds ?? this.#signedUrlTtlSeconds;
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInSeconds * 1000
    });
    return url;
  }

  /** Validate the key, apply the prefix, and resolve the SDK file handle. */
  async #fileFor(key: string): Promise<GcsFileLike> {
    const objectName = this.#objectName(key);
    const client = await this.#getClient();
    return client.bucket(this.#bucket).file(objectName);
  }

  #objectName(key: string): string {
    assertSafeKey(key);
    const objectName = this.#prefix ? `${this.#prefix}/${key}` : key;
    // Re-validate the composed name so a prefix cannot smuggle in traversal.
    assertSafeKey(objectName);
    return objectName;
  }

  #getClient(): Promise<GcsStorageLike> {
    if (!this.#client) {
      this.#client = this.#clientFactory().catch((error: unknown) => {
        // Do not cache a failed initialization; the next call retries.
        this.#client = null;
        throw error;
      });
    }
    return this.#client;
  }
}

function normalizePrefix(prefix: string | null | undefined): string {
  if (!prefix) return '';
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

async function createSdkClient(
  credentials: Record<string, unknown> | null,
  projectId: string | null
): Promise<GcsStorageLike> {
  const mod = await import('@google-cloud/storage');
  const options: Record<string, unknown> = {};
  if (credentials) options.credentials = credentials;
  if (projectId) options.projectId = projectId;
  const StorageCtor = mod.Storage as unknown as new (
    options?: Record<string, unknown>
  ) => GcsStorageLike;
  return new StorageCtor(options);
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return (
    candidate.code === 404 ||
    candidate.code === '404' ||
    candidate.status === 404 ||
    candidate.status === '404' ||
    candidate.statusCode === 404
  );
}

function readSize(metadata: Record<string, unknown>): number {
  const value = metadata.size;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readContentHash(metadata: Record<string, unknown>): string | undefined {
  const custom = metadata.metadata;
  if (typeof custom === 'object' && custom !== null) {
    const value = (custom as Record<string, unknown>).contentHash;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const direct = metadata.contentHash;
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
}

function readCreatedAt(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.timeCreated;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new Error('Unexpected GCS stream chunk type');
}
