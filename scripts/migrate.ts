#!/usr/bin/env bun
/**
 * Apply migrations to the configured database.
 *
 *   bun run db:migrate            # ./data/mentat.db
 *   MENTAT_DB_PATH=:memory: bun run scripts/migrate.ts
 */
import { createDatabase } from '../src/lib/server/db/client';
import { runMigrations } from '../src/lib/server/db/migrate';

const url = process.env.MENTAT_DB_PATH ?? './data/mentat.db';
const handle = createDatabase({ url });
try {
  runMigrations(handle.db, handle.sqlite);
  const tables = handle.sqlite
    .query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
    .get() as { n: number };
  process.stdout.write(`Migrations applied to ${url} (${tables.n} tables)\n`);
} finally {
  handle.close();
}
