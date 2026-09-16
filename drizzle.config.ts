import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * Migrations are generated from the per-domain schema modules and committed as
 * deterministic SQL. They are applied at boot (see `scripts/migrate.ts` and
 * `src/lib/server/db/migrate.ts`) so a fresh clone only needs one command.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/server/db/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.MENTAT_DB_PATH ?? './data/mentat.db'
  },
  strict: true,
  verbose: true
});
