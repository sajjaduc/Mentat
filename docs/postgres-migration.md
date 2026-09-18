# PostgreSQL migration path

SQLite is a deployment choice in Mentat, not a domain assumption. This document is
the plan for moving to PostgreSQL when a single writer stops being enough — and the
record of what has already been kept portable so the move is a swap, not a rewrite.

## What is already portable

| Concern | How Mentat handles it |
| --- | --- |
| Identity | Application-generated UUIDv7 strings for every entity. No sequences, no autoincrement dependence, no id rewriting on migration. |
| Timestamps | Epoch milliseconds in `integer` columns. No timezone conversion, no dialect timestamp type, no `now()` calls inside application transactions. |
| JSON | `text({ mode: 'json' })` columns map to `jsonb`. Documents are read and written through typed accessors, so a dialect change does not touch call sites. |
| Booleans | Integer `0/1` with `mode: 'boolean'`, mapped to `boolean`. |
| Transactions | `withTransaction(executor, fn)` with a **synchronous** callback (ADR-0004). PostgreSQL swaps the runner and gains true async transactions for free, because every transaction body already avoids awaiting. |
| Counters | A single-row `UPDATE … RETURNING` in the creating transaction. Works identically on both dialects. |
| Leases | A conditional `UPDATE … WHERE id = (SELECT … LIMIT 1)` with a re-checked predicate. The PostgreSQL version becomes `SELECT … FOR UPDATE SKIP LOCKED`. |
| Ordering | `audit_events.seq` and `run_events.seq` are dialect-portable monotonic ordinals. Timelines and SSE replay use them instead of relying on row order. |
| Constraints | Every tenancy index includes `workspace_id`; no query depends on SQLite's default rowid ordering. |
| Text search | Behind a `FileSearchIndex` interface: SQLite FTS5 today, PostgreSQL `tsvector` or pgvector later, with a portable `LIKE` fallback in between (ADR-0018). |

### Known dialect-specific code (all isolated)

| Location | What is SQLite-specific | PostgreSQL replacement |
| --- | --- | --- |
| `src/lib/server/filters/compile.ts` | `json_extract(provenance, '$.sourceType')` for the `sourceType` filter | `provenance ->> 'sourceType'` |
| `src/lib/server/analytics/query.ts` | `strftime('%s','now')` for `timeInStateSeconds` | `extract(epoch from now())` |
| `src/lib/server/analytics/series.ts` | `strftime` bucketing for day/week/month | `date_trunc('day' \| 'week' \| 'month', to_timestamp(ms/1000))` |
| `src/lib/server/files/filter-compile.ts` | `json_extract` on file metadata | `->>` |
| `src/lib/server/files/retrieval.ts` | FTS5 virtual table | `tsvector` column + GIN index |
| `src/lib/server/api/handlers/data.ts` | A raw `sqlite_master` catalog query in the file-content endpoint and the health check | `information_schema` / `pg_class` |
| `src/lib/server/jobs/queue.ts` | The lease statement | `FOR UPDATE SKIP LOCKED` |
| `src/lib/server/db/client.ts` | `bun:sqlite` setup, pragmas, transaction runner | `node-postgres` pool + `drizzle-orm/node-postgres` |
| `src/lib/server/db/migrate.ts` | The migrator and the FTS bootstrap | `drizzle-orm/node-postgres/migrator`, drop the FTS bootstrap |
| `scripts/reset-db.ts`, `scripts/seed.ts` | `VACUUM INTO` / file deletion | `DROP SCHEMA public CASCADE` on the target database |

Everything else — repositories, services, the execution engine, the API — is
dialect-neutral.

## Migration steps

### 1. Introduce the driver abstraction

`src/lib/server/db/client.ts` currently owns dialect setup and exports `Executor`.
Add a PostgreSQL implementation *alongside* the SQLite one, selected by URL scheme:

```ts
export interface DatabaseHandle {
  db: AppDb;
  close(): Promise<void>;
  dialect: 'sqlite' | 'postgres';
}

export function createDatabase(url: string): DatabaseHandle {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return createPostgresHandle(url);
  }
  return createSqliteHandle(url);
}
```

`withTransaction` keeps its signature. The SQLite runner keeps the synchronous guard;
the PostgreSQL runner becomes genuinely async. Because no transaction body awaits
today, both work without touching a single service.

### 2. Make the schema dialect-selectable

The schema modules use `sqliteTable`. Two options, in order of preference:

1. **Parameterised tables** (recommended). Generate the schema from a small factory
   so a single definition emits both `sqliteTable` and `pgTable`. The column list is
   identical; only the builder differs.
2. **A forked schema directory** (`db/schema/pg/*.ts`) generated from the SQLite
   definitions, kept in sync by a test that compares column names and types.

Whichever is chosen, `drizzle-kit generate` for PostgreSQL produces a fresh baseline
rather than replaying SQLite migrations.

### 3. Move the data

The dump/restore is mechanical because ids and timestamps are already portable:

```bash
# Source: SQLite
sqlite3 ./data/mentat.db ".mode json" ".output workflow_items.json" "SELECT * FROM workflow_items;"

# Target: PostgreSQL
psql "$DATABASE_URL" -c "\copy workflow_items FROM 'workflow_items.json' WITH (FORMAT csv)"
```

Recommended order respects foreign keys: workspaces → users → memberships → teams →
field definitions → object types → workflows → states → transitions → records →
workflow items → workflow item field values → notes → files → blobs → runs → steps →
approvals → jobs → audit.

Two details to get right:

- **JSON columns** must be inserted as valid JSON text, not as string literals. Cast
  explicitly: `$1::jsonb`.
- **`audit_events.seq`** and **`run_events.seq`** are ordinals. Insert them in order
  with `OVERRIDING SYSTEM VALUE`, then reset the identity sequence with
  `setval(pg_get_serial_sequence('audit_events','seq'), max(seq))`.

Write a verification query per table (`SELECT count(*) FROM x` on both sides) and a
spot check that joins a work item to its record, field values, notes, runs and events — count
parity alone will not catch a broken join key.

### 4. Replace the isolated dialect code

Work through the table above. Each site is a single expression; none has call-site
consequences. Add the PostgreSQL integration test suite (below) before starting, so
each replacement is verified as it lands.

### 5. Add PostgreSQL CI

Run the existing unit and integration suite against both dialects:

```yaml
services:
  postgres:
    image: postgres:17
    env: { POSTGRES_PASSWORD: mentat, POSTGRES_DB: mentat_test }
    options: >-
      --health-cmd pg_isready --health-interval 5s --health-timeout 3s --health-retries 10
steps:
  - run: bun test --preload ./tests/setup.ts tests/unit tests/integration
    env: { MENTAT_DB_PATH: ${{ secrets.PG_URL }} }
```

`tests/helpers/db.ts` becomes dialect-aware: `createTestDatabase()` returns a SQLite
handle by default and a PostgreSQL handle when `MENTAT_DB_PATH` is a `postgres://`
URL, truncating all tables between tests instead of recreating a file.

### 6. Switch

Keep SQLite as the default for local installs and make PostgreSQL opt-in via
`MENTAT_DB_PATH=postgres://…`. Nobody's workflow changes; only the connection string.

## Concurrency semantics to re-verify

These are the behaviours where a real multi-writer database differs from SQLite, so
they need explicit tests rather than an assumption:

| Behaviour | Today (SQLite) | PostgreSQL |
| --- | --- | --- |
| Job leasing | Single writer; the conditional UPDATE is sufficient | Must use `FOR UPDATE SKIP LOCKED` or two workers can claim the same row under load |
| Work-item optimistic concurrency | `WHERE id = ?` + version compare | Same, but add a retry loop for serialization failures |
| Counter allocation | Row update inside the creating transaction | `INSERT … ON CONFLICT DO UPDATE … RETURNING value` |
| Cache stampede lock | Insert-with-expiry, take over when expired | Same, plus `FOR UPDATE` on the lock row to avoid duplicate computes |
| Cache upsert | Unique index on (workspace, namespace, authScope, key) | Same; verify the index exists before relying on `ON CONFLICT` |
| Audit/run sequence ordering | Monotonic via rowid-backed ordinal | Identity column has gaps after aborted transactions — ordering is still correct, contiguity is not guaranteed (and is not relied upon) |
| Analytics median | Window function over the grouped set | Same SQL; verify no implicit integer division |

## Test coverage to add

1. The full unit and integration suite green against PostgreSQL.
2. A worker-leasing stress test with two concurrent workers and 500 jobs asserting no
   job is executed twice.
3. Tenant-isolation tests re-run on PostgreSQL, including the analytics joins.
4. An FTS parity test: the same query returns the same file ids and ordering under
   `tsvector` and `LIKE`.
5. A migration rehearsal: dump a populated SQLite database, restore into PostgreSQL,
   and assert per-table counts plus a joined spot check.
6. A performance baseline for the board query (one workflow, 10k work items) before and
   after, so the index strategy is validated rather than assumed.

## Non-goals

- No ORM switch, no query-builder rewrite, no repository interface churn.
- No change to ids, timestamps or JSON shapes: those decisions exist precisely so
  this migration is boring.
- No premature sharding or read-replica topology. A single PostgreSQL primary
  replaces a single SQLite writer, and that is the whole point.
