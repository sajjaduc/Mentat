#!/usr/bin/env bun
/**
 * Database reset.
 *
 * Deletes the SQLite file and the local blob directory, then re-applies migrations
 * and the seed. Used by `bun run db:reset` and by anyone who wants a clean local
 * instance without hunting for files.
 *
 * Refuses to run against a path that does not look like a Mentat database unless
 * `--force` is passed, so a mistyped `MENTAT_DB_PATH` cannot delete something else.
 */
import fs from 'node:fs';
import path from 'node:path';

const force = process.argv.includes('--force');
const dbPath = process.env.MENTAT_DB_PATH ?? './data/mentat.db';
const blobRoot = process.env.MENTAT_BLOB_ROOT ?? './data/blobs';

function removeIfPresent(target: string, kind: string) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (kind === 'file' && stat.isDirectory()) {
    throw new Error(`Refusing to treat directory as a database file: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  process.stdout.write(`removed ${target}\n`);
}

const resolvedDb = path.resolve(dbPath);
const looksLikeDatabase =
  resolvedDb.endsWith('.db') || resolvedDb.includes('mentat') || resolvedDb === ':memory:';

if (!looksLikeDatabase && !force) {
  process.stderr.write(
    `MENTAT_DB_PATH (${resolvedDb}) does not look like a Mentat database. Re-run with --force if you are sure.\n`
  );
  process.exit(1);
}

for (const suffix of ['', '-shm', '-wal']) {
  removeIfPresent(`${resolvedDb}${suffix}`, 'file');
}
removeIfPresent(path.resolve(blobRoot), 'dir');

process.stdout.write('Re-applying migrations...\n');
const { createDatabase } = await import('../src/lib/server/db/client');
const { runMigrations } = await import('../src/lib/server/db/migrate');

const handle = createDatabase({ url: dbPath });
try {
  runMigrations(handle.db, handle.sqlite);
} finally {
  handle.close();
}

process.stdout.write('Database reset. Run `bun run seed` to create demo data.\n');
