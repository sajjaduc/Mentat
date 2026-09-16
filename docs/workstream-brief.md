# Workstream brief

Shared context for every parallel workstream in the Mentat build. Read this and
`docs/architecture.md` before writing code.

## What Mentat is

A self-hostable work-orchestration platform where humans and AI agents participate
in durable workflows. A Workflow is a project and a state machine; Tickets move
through user-defined States; states may wait for humans, invoke agents, require
approvals, or run deterministic work. Mentat provides the infrastructure agents
repeatedly need: HTTP integrations, persistent state, structured data, cache,
secrets, webhooks, cron, approvals, retries, artifacts, audit history, providers
and models.

Two requirement documents define the product:

- `mentat_build_plan_core.md` — core platform
- `mentat_followup_files_and_agent_created_work.md` — first-class Files and
  agent-created work

Read the parts that touch your workstream. They are the acceptance criteria.

## Stack and constraints

- **Bun 1.3**, TypeScript `strict` with `noUncheckedIndexedAccess`
- **SvelteKit 2 / Svelte 5** (server modules are plain TypeScript)
- **Drizzle ORM** over `bun:sqlite`; PostgreSQL must stay reachable
- **Zod v4** for every trust boundary
- **Biome** for lint/format; **`bun test`** for unit and integration tests
- Local-only for this milestone: no cloud infra, no Redis, no Kafka, no Temporal,
  no vector database

## Non-negotiable invariants

1. Ticket is the central work object.
2. Workflow is a configurable state machine.
3. Human owner and current agent worker are independent.
4. Execution is durable, observable, retryable and auditable.
5. Inheritance and overrides are always visible.
6. Secrets never enter model context.
7. HTTP, storage and cache are first-class primitives.
8. SQLite now, with a clean PostgreSQL path.
9. UI/UX quality is an acceptance criterion.
10. TDD.

## Conventions

- Every module file starts with a doc comment explaining **why it exists**, not
  what the code says.
- Errors: throw `errors.notFound(...)`, `errors.validation(...)`, etc. from
  `$server/core/errors`. Never throw bare strings. Convert unknown throws with
  `toAppError`.
- Ids: `uuidv7()` from `$server/core/ids`.
- Timestamps: epoch milliseconds, UTC.
- Transactions: `await withTransaction(db, (tx) => { ... })` — **the callback must
  be synchronous**. Do external I/O (HTTP, provider calls, file reads) outside the
  transaction, then persist the result in a later transaction.
- Audit: call `writeAudit(tx, {...})` inside the same transaction as every
  mutation. Use an action constant from `AuditActions`.
- Tenancy: every query filters by `workspaceId`. Cross-tenant access returns
  `notFound`, never `forbidden`, so probing cannot confirm existence.
- Permissions: `assertPermission(actor, Permissions.x)` at the service boundary;
  repositories do not check permissions.
- Optimistic concurrency: bump `version` and compare it for tickets/agent/files
  where workers may race.
- Redaction: pass anything potentially sensitive through `redact()` or a
  `createRedactor()` instance before persisting it in audit, run snapshots or HTTP
  request logs.
- Secrets: use `resolveSecretValue` / `resolveSecretByKey` from
  `$server/secrets/service`. Never store, log, return or serialize plaintext.
- Comments should explain trade-offs. Avoid restating the code. No TODOs without a
  concrete follow-up plan, and no placeholder UI or dead code.

## Frozen files

Do not modify these; they are the shared foundation:

```text
src/lib/server/db/**                  (schema, client, migrations)
src/lib/server/core/**
src/lib/server/audit/ledger.ts
src/lib/server/jobs/queue.ts
src/lib/server/jobs/handlers.ts
src/lib/server/jobs/worker.ts
src/lib/server/execution/events.ts
drizzle/**
svelte.config.js  vite.config.ts  tsconfig.json  biome.json  package.json
```

You may **append** to `tests/helpers/factories.ts` (new factory functions only —
existing signatures are frozen). If you need a schema change or a new dependency,
stop and report it instead of editing those files.

## Commands

Run from your worktree:

```bash
bunx tsc --noEmit -p tsconfig.json                     # typecheck
bun test --preload ./tests/setup.ts tests/unit tests/integration
bunx biome check --write src tests && bunx biome check src tests
```

`node_modules` is symlinked; do not run `bun install`.

## Test harness

```ts
import { createTestDatabase } from '../../helpers/db';
import { createWorkspace, createUser, addMember, createWorkflow, createTicket } from '../../helpers/factories';

const handle = createTestDatabase();   // fresh in-memory SQLite + migrations
// ... use handle.db (a Drizzle client) or handle.sqlite (raw Bun SQLite)
handle.cleanup();
```

Every test gets its own database. Build two workspaces when testing isolation.

## Definition of done for a workstream

1. Behavioural tests written first, then implementation (TDD).
2. `bunx tsc --noEmit` clean, `biome check` clean, full test suite green.
3. Tenant isolation, permission, redaction and audit behaviour covered by tests.
4. Public functions documented; module doc comments explain the design decision.
5. Work committed on your branch with a clear message.
6. Report: files added, test counts, commands run, interface requests, open risks.

## Reporting format

```
WORKSTREAM: <name>
STATUS: complete | blocked
FILES: <paths>
TESTS: <n> added, <n> passing (command used)
VERIFY: typecheck OK, lint OK
INTERFACE REQUESTS: <what you need from another module, or "none">
RISKS / NOTES: <anything the supervisor must know>
```
