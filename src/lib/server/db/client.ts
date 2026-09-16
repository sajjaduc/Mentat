/**
 * Database client.
 *
 * One module owns dialect-specific setup. Everything above this file talks to the
 * `Executor` interface, which is satisfied by both a connection and a transaction,
 * so repositories never know whether they are inside a transaction.
 *
 * ## Why transaction bodies are synchronous
 *
 * `bun:sqlite` is a synchronous driver; Drizzle's `transaction()` for that driver
 * commits as soon as the callback returns. An `async` callback would therefore
 * commit *before* its awaited work finished, silently breaking atomicity. Rather
 * than hide that hazard, `withTransaction` refuses callbacks that return a Promise
 * and tells the caller to move external I/O outside the transaction.
 *
 * This is a deliberate design constraint, not a limitation: network calls,
 * provider generation and HTTP tool invocations must never happen while a
 * transaction is open. The PostgreSQL port keeps the same interface and gains
 * true async transactions for free (ADR-0004).
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { errors } from '../core/errors';
import { allSchema } from './schema';

export type AppDb = BunSQLiteDatabase<typeof allSchema>;
export type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];
/** Anything that can run queries: a connection or an open transaction. */
export type Executor = AppDb | AppTx;

export interface DatabaseHandle {
  db: AppDb;
  sqlite: Database;
  close(): void;
}

export interface CreateDatabaseOptions {
  /** File path, `:memory:` or a `file:` URL. */
  url: string;
  readonly?: boolean;
  /** Milliseconds to wait for a write lock before failing. */
  busyTimeoutMs?: number;
  verbose?: boolean;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const url = normalizeUrl(options.url);
  // SQLite creates the file but not the directory, so a nested path (the default
  // `./data/mentat.db`, or a test database under `.e2e/`) needs the parent to exist
  // before the connection is opened.
  ensureParentDirectory(url, options.readonly ?? false);
  const sqlite = new Database(url, options.readonly ? { readonly: true } : undefined);

  // WAL keeps readers from blocking the single writer; `foreign_keys` is off by
  // default in SQLite and must be enabled per connection; `busy_timeout` turns
  // lock contention into a wait rather than an immediate SQLITE_BUSY.
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
  sqlite.exec('PRAGMA synchronous = NORMAL;');

  const db = drizzle(sqlite, { schema: allSchema });
  return {
    db,
    sqlite,
    close: () => sqlite.close()
  };
}

/** Create the containing directory for a filesystem-backed database path. */
function ensureParentDirectory(url: string, readonly: boolean): void {
  if (url === ':memory:' || url.startsWith('file::memory:')) return;
  if (readonly) return;
  const filePath = url.startsWith('file:') ? url.slice('file:'.length) : url;
  if (filePath.length === 0 || filePath.includes('?')) return;
  const directory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(directory, { recursive: true });
}

function normalizeUrl(url: string): string {
  if (url === ':memory:') return url;
  if (url.startsWith('file:') || url.startsWith('/')) return url;
  // Bare relative path — resolve against the current working directory.
  return url;
}

let singleton: DatabaseHandle | null = null;

/** Process-wide handle. Tests construct their own handles instead of using this. */
export function getDatabaseHandle(url?: string): DatabaseHandle {
  if (!singleton) {
    singleton = createDatabase({
      url: url ?? process.env.MENTAT_DB_PATH ?? './data/mentat.db',
      verbose: process.env.MENTAT_DB_VERBOSE === '1'
    });
  }
  return singleton;
}

export function getDb(): AppDb {
  return getDatabaseHandle().db;
}

export function closeDatabase(): void {
  singleton?.close();
  singleton = null;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Run `fn` inside a transaction.
 *
 * The callback MUST be synchronous. Attempting to `await` inside throws
 * immediately with an actionable message rather than producing a partial commit.
 * Nested calls on an already-open transaction run inline so they compose.
 */
export async function withTransaction<T>(executor: Executor, fn: (tx: AppTx) => T): Promise<T> {
  if (isTransaction(executor)) {
    return fn(executor as AppTx);
  }
  const db = executor as AppDb;
  return db.transaction((tx) => {
    const value = fn(tx);
    if (isPromiseLike(value)) {
      throw new Error(
        'withTransaction callback must be synchronous: awaiting inside a transaction would ' +
          'commit before the awaited work completes. Move external I/O outside the transaction.'
      );
    }
    return value;
  });
}

/**
 * True when `executor` is an open transaction rather than a connection.
 * Drizzle transaction objects expose `rollback`, which is absent on connections.
 */
export function isTransaction(executor: Executor): boolean {
  return typeof (executor as unknown as { rollback?: unknown }).rollback === 'function';
}

/**
 * Portable atomic counter increment (ticket numbers, per-workspace sequences).
 * A single-row `UPDATE ... RETURNING` works identically on SQLite and PostgreSQL.
 */
export async function nextCounter(
  tx: Executor,
  workspaceId: string,
  name: string,
  step = 1
): Promise<number> {
  const { counters } = allSchema;
  const id = `${workspaceId}:${name}`;
  const updated = await tx
    .update(counters)
    .set({ value: sql`${counters.value} + ${step}`, updatedAt: Date.now() })
    .where(sql`${counters.workspaceId} = ${workspaceId} AND ${counters.name} = ${name}`)
    .returning({ value: counters.value });
  const row = updated[0];
  if (row) return row.value;

  try {
    const inserted = await tx
      .insert(counters)
      .values({ id, workspaceId, name, value: step, updatedAt: Date.now() })
      .returning({ value: counters.value });
    const created = inserted[0];
    if (created) return created.value;
  } catch {
    // Another writer created the row between our update and insert; retry once.
    const retried = await tx
      .update(counters)
      .set({ value: sql`${counters.value} + ${step}`, updatedAt: Date.now() })
      .where(sql`${counters.workspaceId} = ${workspaceId} AND ${counters.name} = ${name}`)
      .returning({ value: counters.value });
    const retriedRow = retried[0];
    if (retriedRow) return retriedRow.value;
  }
  throw errors.internal(`Failed to allocate counter ${name}`, { workspaceId });
}

export { sql };
