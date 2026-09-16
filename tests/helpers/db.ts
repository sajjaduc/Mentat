/**
 * Test database harness.
 *
 * Every integration test gets its own in-memory SQLite database with migrations
 * applied. Nothing is shared between tests, so tenant-isolation and
 * optimistic-concurrency tests cannot leak state into one another.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetEnvCache } from '../../src/lib/server/config/env';
import { clearSecretRegistry } from '../../src/lib/server/core/secret-registry';
import {
  type AppDb,
  createDatabase,
  type DatabaseHandle,
  type Executor
} from '../../src/lib/server/db/client';
import { runMigrations } from '../../src/lib/server/db/migrate';

export interface TestDatabase extends DatabaseHandle {
  db: AppDb;
  /** Directory available to tests that need real files (blob store contracts). */
  tempDir: string;
  cleanup(): void;
}

export function createTestDatabase(): TestDatabase {
  resetEnvCache();
  clearSecretRegistry();
  const tempDir = mkdtempSync(path.join(tmpdir(), 'mentat-test-'));
  const handle = createDatabase({ url: ':memory:', busyTimeoutMs: 2000 });
  runMigrations(handle.db, handle.sqlite);
  return {
    ...handle,
    tempDir,
    cleanup() {
      try {
        handle.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  };
}

/**
 * Run a callback against a fresh database and always clean up. Use this in tests
 * that do not need to inspect the handle directly.
 */
export async function withTestDatabase<T>(
  fn: (db: AppDb, handle: TestDatabase) => Promise<T> | T
): Promise<T> {
  const handle = createTestDatabase();
  try {
    return await fn(handle.db, handle);
  } finally {
    handle.cleanup();
  }
}

/** Convenience alias used widely in repository tests. */
export type Db = Executor;
