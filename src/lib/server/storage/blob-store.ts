/**
 * BlobStore contract.
 *
 * Raw bytes live in a BlobStore; the database keeps only metadata and the storage
 * key (ADR-0009). Keys are content-addressed, so `put` is naturally idempotent and
 * two uploads of the same bytes cannot produce two objects.
 *
 * Implementations must:
 *  - treat `key` as opaque and never concatenate it with user input without
 *    rejecting traversal segments;
 *  - be safe to call concurrently for the same key;
 *  - never log object contents.
 */

export interface BlobMetadata {
  key: string;
  size: number;
  /** Value observed at write time; a mismatch means the object was replaced. */
  contentHash?: string;
  contentType?: string;
  createdAt?: number;
}

export interface PutOptions {
  contentType?: string;
  /** Expected SHA-256 of the bytes; implementations may verify on write. */
  contentHash?: string;
}

export interface BlobStore {
  /** Stable identifier for diagnostics: `local`, `gcs`. */
  readonly kind: string;
  put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  exists(key: string): Promise<boolean>;
  /** Best-effort delete. Missing objects are not an error. */
  delete(key: string): Promise<void>;
  stat(key: string): Promise<BlobMetadata | null>;
  /**
   * Time-limited direct URL where the provider supports it. Local storage returns
   * a Mentat-served path instead, so callers must not assume a signed URL.
   */
  getSignedUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string>;
}

export class BlobNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
  }
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Reject keys that could escape the storage root. This is the single place where
 * path-traversal safety is enforced, so every implementation gets it for free.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > 512) {
    throw new Error('Blob key must be between 1 and 512 characters');
  }
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Unsafe blob key segment: ${JSON.stringify(segment)}`);
    }
    if (!SEGMENT_RE.test(segment)) {
      throw new Error(`Unsafe characters in blob key segment: ${JSON.stringify(segment)}`);
    }
  }
}

/**
 * Canonical content-addressed key layout:
 *   `workspaces/{workspaceId}/blobs/{hash[0:2]}/{hash[2:4]}/{hash}`
 *
 * The two-level fan-out keeps directories small on local filesystems and object
 * listings cheap on GCS, while the workspace prefix preserves tenant separation.
 */
export function blobKeyFor(workspaceId: string, contentHash: string): string {
  return `workspaces/${workspaceId}/blobs/${contentHash.slice(0, 2)}/${contentHash.slice(2, 4)}/${contentHash}`;
}
