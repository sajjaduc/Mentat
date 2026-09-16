# Development

How to work on Mentat: setup, the testing strategy, the conventions that keep the
code coherent, and the recipe for adding a feature.

## Setup

```bash
bun install
bun run db:migrate
bun run seed          # optional demo data
bun run dev           # :5273
```

`bun run dev` applies migrations and bootstraps on the first request, so nothing else
is required. Use `bun run db:reset && bun run seed` whenever you want a clean slate.

## The verification loop

```bash
bun run lint          # Biome: formatting + lint
bun run typecheck     # tsc --noEmit (strict, noUncheckedIndexedAccess)
bun run check         # svelte-check for .svelte files
bun run test          # bun test: unit + integration
bun run test:e2e      # Playwright against a real server
bun run verify        # lint + typecheck + tests
```

All five must be clean before work is considered done. The build also has to pass
(`bun run build`), because SvelteKit catches SSR-only mistakes that `tsc` cannot.

## Testing strategy

Tests are a design tool here, not a tax. Each layer has a job:

| Layer | Location | What it proves |
| --- | --- | --- |
| Unit | `tests/unit/**` | Pure logic: ids, redaction, crypto, cron math, filter compilation, schema validation, chart bucketing, provider capabilities |
| Integration | `tests/integration/**` | Behaviour against a real database: transitions, human gates, transfer, jobs and leases, approvals, secret redaction, files and dedupe, HTTP runtime, triggers, analytics correctness, API boundaries |
| Contract | co-located with integration | A module against a fake of its collaborator (a mock HTTP server, a scripted provider, a fake BlobStore) so the interface is pinned without a network |
| E2E | `tests/e2e/**` | The product end to end in a browser, on a real server with its own database |

Every test gets its own in-memory database:

```ts
const handle = createTestDatabase();   // migrations applied, isolated
try {
  // ... handle.db (Drizzle) or handle.sqlite (raw)
} finally {
  handle.cleanup();
}
```

`tests/helpers/factories.ts` builds fixtures by inserting rows directly, so a factory
never depends on behaviour that is itself under test. `tests/helpers/fake-provider.ts`
scripts model turns; `tests/helpers/mock-http.ts` and
`src/lib/server/providers/testing/mock-ollama.ts` stand in for servers.

### What to test first

Write the failing test before the implementation, and prefer these areas:

- state transitions, especially human gates and required-field enforcement;
- concurrency: leases, duplicate delivery, optimistic version conflicts;
- retries and idempotency (the same job delivered twice);
- approval pause and resume, including rejection;
- secret redaction (assert by searching the raw SQLite rows for the plaintext);
- tenant isolation (assert 404, not 403, across workspaces);
- HTTP mapping, retries, cache identity and auth isolation;
- cross-workflow transfer: mapping, missing fields, policy, preserved history;
- analytics correctness derived from history, not from current rows.

A bug fix starts with a reproducing test. No exceptions.

## Conventions

Enforced by Biome and `tsconfig`; the reasoning matters more than the rule.

- **Errors** are `errors.notFound(...)`, `errors.validation(...)` and friends from
  `$server/core/errors`. Never throw bare strings. Convert unknown throws with
  `toAppError` at the boundary.
- **Ids** are `uuidv7()`. Never an autoincrement, never a random string.
- **Timestamps** are epoch milliseconds, UTC, from `Date.now()` or an injected
  `Clock`.
- **Transactions** use `withTransaction(db, (tx) => { … })` and the callback is
  **synchronous**. Do network I/O outside, then persist the result in a later
  transaction. The runner enforces this at runtime.
- **Enqueue after persistence.** Work is enqueued inside the same transaction as the
  change that caused it, so a crash cannot lose or duplicate it.
- **Audit every mutation** with `writeAudit(tx, {…})` in the same transaction, using
  a constant from `AuditActions`.
- **Tenancy**: every query filters by `workspaceId`; cross-tenant access returns
  `notFound`, never `forbidden`.
- **Permissions**: `assertPermission(actor, Permissions.x)` at the service boundary.
  Repositories do not check permissions.
- **Optimistic concurrency**: bump `version` and compare it wherever two writers could
  race.
- **Redaction**: pass anything possibly sensitive through `redact()` or a
  `createRedactor()` before it is persisted or logged.
- **Secrets**: obtain plaintext only via `resolveSecretValue`/`resolveSecretByKey`.
  Never store, log, return or serialize it.
- **Comments explain why.** If a line needs a comment to be understood, the comment
  should explain the trade-off or the failure mode, not restate the code.

Module files start with a doc comment stating why the module exists. Route handlers
and services stay thin; policy lives in one place.

## Adding a feature

1. **Decide where it lives.** Business rules belong in a service under
   `src/lib/server/<module>/`; persistence in its repository; the HTTP surface in
   `src/lib/server/api/handlers/<domain>.ts`. Never in a `.svelte` file or a route
   handler.
2. **Check the schema.** If a column is needed, edit
   `src/lib/server/db/schema/*.ts`, run `bun run db:generate`, and read the generated
   SQL before committing it. Migrations are deterministic and reviewed.
3. **Write the test**, in `tests/integration/<module>/`, and watch it fail.
4. **Implement the minimum** that makes it pass. Add the audit event, the permission
   check and the tenant filter as part of the behaviour, not afterwards.
5. **Expose it** through the API router with a permission and a Zod schema for the
   body and query.
6. **Surface it in the UI** using the primitives, with loading, error, empty and
   content states, and optimistic updates where the interaction should feel instant.
7. **Wire background work** if it is slow: enqueue a durable job rather than blocking
   a request, register the handler, and make it idempotent.
8. **Run the loop**: lint, typecheck, tests, build, and the E2E spec if you touched a
   flow that has one.

## Schema changes in detail

Because migrations are committed SQL and reviewed:

- Prefer additive changes. A new nullable column needs no data migration.
- A new `NOT NULL` column needs a default or a two-step migration.
- Never edit an already-applied migration; generate a new one.
- SQLite cannot alter a column in place, so drizzle-kit rewrites the table. Read that
  SQL: confirm the new table keeps every index and foreign key, and that the copy
  selects columns in the right order.
- `workspace_id` on a new table should be indexed with whatever else you filter on,
  not on its own.
- If a change is expensive to reverse, record the reasoning in
  `docs/architecture.md` as an ADR.

## Debugging

```bash
# Structured logs, redacted
MENTAT_LOG_LEVEL=debug bun run dev

# Inspect the database
sqlite3 ./data/mentat.db '.tables'
sqlite3 ./data/mentat.db 'select action, summary from audit_events order by seq desc limit 20;'

# Job queue state without the UI
sqlite3 ./data/mentat.db 'select type, status, attempts, last_error from jobs order by created_at desc limit 10;'

# Run the queue once and see what happens
MENTAT_WORKER_ENABLED=false bun run worker --once
```

The API index at `GET /api` lists every route with the permission it requires, which
is the fastest way to confirm what a browser call needs.

## Working in parallel

Changes that touch many files are split by module ownership and done in separate git
worktrees, one branch per workstream, with an integration gate before merge:

- Define shared interfaces first; parallel work must not invent its own.
- One owner per file. Append to shared files (`tests/helpers/factories.ts`) rather
  than restructuring them.
- Before merging: inspect the whole diff, check tenant isolation and secret handling,
  confirm the tests genuinely cover the behaviour, run the full suite, and look at UI
  changes at desktop and narrow widths.
