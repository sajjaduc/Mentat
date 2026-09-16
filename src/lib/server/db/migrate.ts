/**
 * Migration runner.
 *
 * Migrations are deterministic SQL committed under `drizzle/`. They are applied at
 * boot and by `bun run db:migrate`, so a fresh clone needs one command. A
 * secondary, idempotent bootstrap step creates optional database features that
 * Drizzle does not model (the SQLite FTS5 content index); it is skipped silently
 * when the build of SQLite lacks FTS5, because retrieval falls back to a portable
 * `LIKE` scan instead (see ADR-0018).
 */

import type { Database } from 'bun:sqlite';
import path from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { moduleLogger } from '../core/logger';
import type { AppDb } from './client';

const log = moduleLogger('db.migrate');

export interface MigrateOptions {
  migrationsFolder?: string;
  /** Skip optional feature bootstrap (used by tests that assert exact state). */
  skipOptionalFeatures?: boolean;
}

export function migrationsFolder(): string {
  return process.env.MENTAT_MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'drizzle');
}

export function runMigrations(db: AppDb, sqlite: Database, options: MigrateOptions = {}): void {
  const folder = options.migrationsFolder ?? migrationsFolder();
  migrate(db, { migrationsFolder: folder });
  if (!options.skipOptionalFeatures) {
    const fts = bootstrapFullTextSearch(sqlite);
    log.debug('migrations applied', { folder, fullTextSearch: fts });
  }
}

/**
 * Create the FTS5 index used for content search when the SQLite build supports it.
 * Returns whether full-text search is available.
 */
export function bootstrapFullTextSearch(sqlite: Database): boolean {
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
        file_id UNINDEXED,
        workspace_id UNINDEXED,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    return true;
  } catch {
    return false;
  }
}

/** True when the FTS5 index exists and can be used. */
export function hasFullTextSearch(sqlite: Database): boolean {
  try {
    const row = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_content_fts' LIMIT 1"
      )
      .get() as { name?: string } | null;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}
