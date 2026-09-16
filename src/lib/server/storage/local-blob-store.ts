/**
 * Local filesystem BlobStore.
 *
 * Default for self-hosted Mentat. Objects are written to a temporary file and
 * atomically renamed into place, so a crashed write can never leave a
 * partially-written object that a later read would treat as valid.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { blobRoot } from '../config/env';
import { sha256Hex } from '../core/hash';
import {
  assertSafeKey,
  type BlobMetadata,
  BlobNotFoundError,
  type BlobStore,
  type PutOptions
} from './blob-store';

export interface LocalBlobStoreOptions {
  root?: string;
}

export class LocalBlobStore implements BlobStore {
  readonly kind = 'local';
  private readonly root: string;

  constructor(options: LocalBlobStoreOptions = {}) {
    this.root = path.resolve(options.root ?? blobRoot());
  }

  /** Absolute filesystem path for a key, validated against the root. */
  resolvePath(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    const relative = path.relative(this.root, full);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Blob key escapes storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    const target = this.resolvePath(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });

    if (options.contentHash) {
      const actual = await sha256Hex(bytes);
      if (actual !== options.contentHash) {
        throw new Error(
          `Blob hash mismatch for ${key}: expected ${options.contentHash}, computed ${actual}`
        );
      }
    }

    // Atomic publish: write to a sibling temp file, fsync, then rename.
    const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await fsp.open(temp, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
  }

  async get(key: string): Promise<Uint8Array> {
    const target = this.resolvePath(key);
    try {
      return new Uint8Array(await fsp.readFile(target));
    } catch (error) {
      if (isNotFound(error)) throw new BlobNotFoundError(key);
      throw error;
    }
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.resolvePath(key);
    if (!fs.existsSync(target)) throw new BlobNotFoundError(key);
    const nodeStream = fs.createReadStream(target);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (error) => controller.error(error));
      },
      cancel() {
        nodeStream.destroy();
      }
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.resolvePath(key));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolvePath(key);
    try {
      await fsp.unlink(target);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async stat(key: string): Promise<BlobMetadata | null> {
    const target = this.resolvePath(key);
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return null;
      return {
        key,
        size: stat.size,
        createdAt: Math.floor(stat.mtimeMs)
      };
    } catch {
      return null;
    }
  }

  /**
   * Local storage cannot issue provider-signed URLs. Callers receive a Mentat
   * download path and must route the request through authorization.
   */
  async getSignedUrl(key: string, _options: { expiresInSeconds?: number } = {}): Promise<string> {
    assertSafeKey(key);
    return `/api/files/blob?key=${encodeURIComponent(key)}`;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
