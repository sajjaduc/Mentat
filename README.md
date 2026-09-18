# Mentat

A self-hostable work-orchestration platform where humans and AI agents participate
in durable workflows.

A **Workflow** is a project and a state machine, presented primarily as a Kanban
board. **Records** are the durable things the work is about — a Business, Policy,
Claim, Candidate or a Ticket — and cards on the board are **WorkflowItems**: a
Record's participation in one workflow. A Record can participate in several
workflows at once. A state can wait for a human, invoke an agent, require an
approval, or run deterministic work. Mentat provides the infrastructure agents
repeatedly need — HTTP integrations, persistent state, structured data, cache,
secrets, webhooks, cron, approvals, retries, artifacts, audit history, providers
and models — so you build workflows instead of plumbing.

It runs locally with no external infrastructure: SQLite for state, the local
filesystem for blobs, and Ollama (or any OpenAI-compatible endpoint) for models.

## Quick start

Requires [Bun](https://bun.sh) 1.2 or newer.

```bash
git clone <this repo> mentat && cd mentat
bun install

# Optional: a deterministic secrets key. Without it Mentat generates
# ./data/master.key on first use and tells you to back it up.
export MENTAT_MASTER_KEY="$(openssl rand -base64 32)"

bun run db:migrate     # create ./data/mentat.db
bun run seed           # optional: a fully populated demo workspace

bun run dev            # http://localhost:5273
```

The first visit shows **Create the first account**: that account becomes the owner
of a starter workspace. If you ran the seed, sign in with
`owner@mentat.local` / `mentat-local-dev`.

### Docker

Everything Mentat needs is in one service — server, worker and database:

```bash
export MENTAT_MASTER_KEY="$(openssl rand -base64 32)"
docker compose up -d          # http://localhost:5273
```

State lives in the `mentat-data` volume (database, blobs and master key). Ollama runs
on the host; the compose file points Mentat at `host.docker.internal:11434`.

### Connect a local model

1. `ollama serve` (defaults to `http://localhost:11434`) and `ollama pull llama3.1:8b`.
2. In Mentat: **Models → Add provider → Ollama**, accept the prefilled URL, **Test
   connection**, then **Refresh models**.
3. Create an agent (**Agents → New**), pick the discovered model, grant it tools.
4. Bind the agent to a state (**Workflow → Configuration → States**) and move a
   work item into it. Watch it happen on the item's **Agent Work** tab.

Mentat never talks to a model without an explicit agent and state binding, and
every run pins the agent version it used.

## What is in the box

| Area | Highlights |
| --- | --- |
| Workflows | States (human / agent / system / terminal), transitions, human gates, per-state retries, timeouts, failure routing, WIP limits, five seed templates; each Workflow processes a chosen Object Type |
| Records | Universal durable objects of any Object Type: typed base fields, reference fields, identity/uniqueness rules, external IDs, domain relationships, notes, provenance history, archive |
| Workflow items | A Record's participation in a Workflow: state, owner, workflow-overlay fields, work notes, work relationships, human gates, transfer vs add-participation, and multiple simultaneous participations; every workflow dispatches agent/system states through `workflow_item.enter` |
| AI contracts | Object Types, workflow overlays and states are authored as Zod source in one box: format on blur, test against a JSON sample, then save. The stored source is authoritative and reusable at run time, and is projected into typed fields so lists, filters and history keep working; each contract compiles to a Zod schema that an agent must return the record plus the next workflow step against (possibly a different target workflow), with corrective retries and a hard failure |
| Work | Per-workspace record keys, typed fields, notes with revisions, labels, relationships, artifacts, cross-workflow transfer with field mapping, one coherent history — all on Records + WorkflowItems of any Object Type |
| Execution | Durable agent runs with tool calls, streaming into a live timeline, crash-safe resumption, provider retries, run cancellation |
| Approvals | State-level and tool-call gates that pause durably and resume from persistence |
| HTTP | Reusable services with auth/secrets/rate limits, semantic operations, a Postman-inspired editor with Test Request, retries, caching, redaction and tool exposure |
| Agents & skills | Immutable versioning, explicit capability grants, skill injection, context selection per state |
| Native data | Scoped agent state, structured collections, a cache with TTL and stampede protection, all exposed as controlled agent tools |
| Files | Content-addressed blob storage with dedupe, provenance, durable processing, typed file fields, extraction, summaries, full-text retrieval and a first-class Files UI |
| Triggers | Webhook (HMAC, idempotent), cron (timezone-aware, worker-safe), manual and API |
| Configuration | Encrypted secrets, environment variables with inherited/override/local provenance, Use as-is / Override / Fork bindings, local or GCS storage |
| Analytics | Dashboards built from the same filter AST as work lists, with funnels and time-in-state derived from recorded history; data sources cover files, records and workflow items |
| Operations | Durable job queue with leases and retries, an append-only audit ledger, job and audit inspections in the UI |

## Commands

```bash
bun run dev            # dev server on :5273 (runs an in-process worker)
bun run build          # production build (adapter-node)
bun run start          # run the built server
bun run worker         # separate worker process (--once to drain and exit)

bun run test           # unit + integration (bun test)
bun run test:unit
bun run test:integration
bun run test:e2e       # Playwright (starts its own server and database)

bun run lint           # Biome
bun run typecheck      # tsc --noEmit
bun run check          # svelte-check
bun run verify         # lint + typecheck + tests

bun run db:generate    # generate a migration after a schema change
bun run db:migrate     # apply migrations
bun run db:reset       # delete the local database and blobs, then re-migrate
bun run seed           # create the demo workspace
```

## Configuration

Everything has a local default; every value can be overridden by an environment
variable. See `.env.example` for the full list.

| Concern | Default | Variable |
| --- | --- | --- |
| Database | `./data/mentat.db` | `MENTAT_DB_PATH` |
| Blobs | `./data/blobs` | `MENTAT_BLOB_ROOT` |
| Secrets key | generated into `./data/master.key` | `MENTAT_MASTER_KEY` |
| Base URL | `http://localhost:5273` | `MENTAT_BASE_URL` |
| Worker | in-process, 4 concurrent jobs | `MENTAT_WORKER_ENABLED`, `MENTAT_WORKER_CONCURRENCY` |
| Sign-up | allowed | `MENTAT_ALLOW_SIGNUP` |
| Session lifetime | 30 days | `MENTAT_SESSION_DAYS` |
| Ollama suggestion | `http://localhost:11434` | `MENTAT_OLLAMA_URL` |
| Max file size | 50 MiB | `MENTAT_FILE_MAX_BYTES` |
| Log level | `info` (`warn` in tests) | `MENTAT_LOG_LEVEL` |

`MENTAT_MASTER_KEY` must be a 32-byte key: base64 (`openssl rand -base64 32`) or 64
hex characters. Keep `MENTAT_MASTER_KEY_PREVIOUS` set after a rotation until every
secret has been re-encrypted; ciphertexts record the key version that produced them.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | Module map, dependency rules and the ADRs behind every expensive-to-reverse decision |
| `docs/development.md` | Local setup, testing strategy, conventions and how to add a feature |
| `docs/operations.md` | Running it, backups, key rotation, worker scaling, troubleshooting |
| `docs/postgres-migration.md` | The concrete path from SQLite to PostgreSQL, and what is already portable |
| `docs/definition-of-done.md` | Every milestone requirement mapped to the test or surface that proves it |
| `docs/workstream-brief.md` | Conventions and the Definition of Done used during the build |
| `docs/ui-brief.md` | Design system, data-loading pattern and the complete API surface |

## Guarantees worth knowing

- **Durable execution.** Execution state is persisted before anything is streamed.
  A disconnected browser, a crashed worker or a restarted server never loses or
  duplicates work; a run resumes from what is already in the database.
- **Human gates are not advisory.** An agent cannot move a work item out of a gated
  state, and the engine never auto-runs through one because it has outgoing
  transitions.
- **Approval is enforced by Mentat.** Tool and state approvals are evaluated against
  persisted configuration; a model claiming it asked for permission is irrelevant.
- **Secrets never leave execution.** They are encrypted at rest, resolved only at
  the moment of use, redacted from logs, run snapshots, HTTP request logs and audit
  payloads, and never returned by any read path.
- **Tenant isolation is structural.** Every repository query filters by workspace,
  and cross-tenant access returns "not found" rather than "forbidden" so probing
  cannot confirm existence.
- **History is recorded, not inferred.** State changes, field changes, transfers,
  tool calls, approvals and failures are appended to one ledger, which is what the
  timeline and the analytics read.

## Requirements and non-goals

Runtime: Bun and a filesystem. Optional: Ollama or any OpenAI-compatible endpoint,
and Google Cloud Storage if you want remote blobs.

Deliberately **not** required, and not part of this milestone: Redis, Kafka,
Temporal, an external queue, a vector database, or embeddings. Retrieval is
structured filters, metadata and exact/full-text search, behind an interface that
can later gain PostgreSQL FTS or pgvector. Multi-node execution and a hosted control
plane are out of scope; the local footprint stays small on purpose.

## Licence

See `LICENSE`.
