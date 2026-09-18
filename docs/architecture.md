# Mentat architecture

Mentat is a self-hostable work-orchestration platform. A **Workflow** is a project
and a state machine presented as a Kanban board; **Records** are the durable things
work is about and **WorkflowItems** are a Record's participation in one Workflow.
The UI speaks in the vocabulary of the Workflow's Object Type (for example
"Claims"), so ordinary users see a familiar board while the underlying model stays
general (ADR-0021).

This document is the map. It records the module layout, the dependency direction,
the boundaries that must not be crossed, and the reasoning behind the decisions
that are expensive to reverse.

## Runtime shape

```text
Svelte UI (browser)
    │  fetch / SSE
    ▼
SvelteKit routes  ──────────────────────────────►  +server.ts API handlers
    │                                                   │
    ▼                                                   ▼
server-side loaders                              Zod-validated boundary
    │                                                   │
    └───────────────► application services ◄────────────┘
                            │
                            ▼
                         domain
                            │
                            ▼
                      repositories
                            │
                            ▼
                    Drizzle ORM (SQLite now, PostgreSQL later)
```

Rules:

- **No business rules in components or route handlers.** Routes validate input,
  call a service, and render. Services hold policy.
- **Everything is workspace-scoped.** Every repository entry point takes a
  `workspaceId`; services additionally check a permission from `ActorContext`.
- **Transactions are explicit and synchronous.** `withTransaction` refuses an
  `async` callback, which keeps network I/O out of transactions by construction.
- **Enqueue after persistence.** Work is enqueued inside the same transaction as
  the state change that caused it, so a crash cannot lose or duplicate work.

## Module map

| Module | Path | Responsibility |
| --- | --- | --- |
| core | `src/lib/server/core` | ids, errors, clock/cron, redaction, secret registry, crypto, logger, validation, actor context |
| db | `src/lib/server/db` | schema, client/transactions, migration runner |
| audit | `src/lib/server/audit` | append-only ledger written inside domain transactions |
| jobs | `src/lib/server/jobs` | durable queue, handler registry, worker runtime |
| execution | `src/lib/server/execution` | state-entry engine, agent runner, run events, SSE |
| approvals | `src/lib/server/approvals` | approval records, durable pause/resume |
| records | `src/lib/server/records` | object types, records, typed base fields, external ids, domain relationships, notes |
| workflow-items | `src/lib/server/workflow-items` | work participation, state machine, overlay fields, work notes/relationships, transfer vs add-participation |
| workflows | `src/lib/server/workflows` | workflows, states, transitions, transfer rules |
| agents | `src/lib/server/agents` | agents/skills versioning, context assembly |
| tools | `src/lib/server/tools` | tool contract, registry, native tool implementations |
| http | `src/lib/server/http` | HTTP services/operations, runtime, editor support |
| providers | `src/lib/server/providers` | provider/model contracts, Ollama and friends |
| config | `src/lib/server/config` | env vars, overrides, storage config, provenance |
| secrets | `src/lib/server/secrets` | encrypted secrets, resolution at execution time |
| storage | `src/lib/server/storage` | BlobStore contract, local and GCS implementations |
| files | `src/lib/server/files` | file domain, processing pipeline, file fields, retrieval |
| cache | `src/lib/server/cache` | native cache with TTL and stampede protection |
| collections | `src/lib/server/collections` | structured document collections |
| state | `src/lib/server/state` | scoped agent state |
| triggers | `src/lib/server/triggers` | webhook, cron, manual/API entry points |
| filters | `src/lib/server/filters` | filter AST, compiler, saved views |
| analytics | `src/lib/server/analytics` | widgets, aggregations, funnels, time-in-state |
| auth | `src/lib/server/auth` | sessions, password hashing, workspace membership |

## Decisions that are expensive to reverse

### ADR-0003 — Application-generated UUIDv7 identity

Every entity id is a UUIDv7 generated in the application. UUIDv7 is time-ordered,
so inserts stay local in the B-tree and keyset pagination is cheap; it is also
portable, so a PostgreSQL migration needs no sequence work.

The single exception is the audit ledger's `seq`: a monotonic log ordinal, not an
entity identity. It gives strict cross-dialect ordering for timelines and SSE
replay. `run_events.seq` follows the same reasoning.

### ADR-0004 — Synchronous transaction bodies

`bun:sqlite` is synchronous and Drizzle commits as soon as the callback returns, so
an `async` callback would commit early and silently break atomicity. Rather than
hide that, `withTransaction` throws when a callback returns a Promise. This forces
provider calls, HTTP requests and file processing outside transactions, which is
where they belong anyway. The PostgreSQL port keeps the same interface and gains
true async transactions for free.

### ADR-0005 — Typed fields, not one opaque JSON blob

Record and file metadata use `field_definitions` plus typed value rows
(`value_text`, `value_number`, `value_date`, `value_bool`, `value_json`) with a
lowercase `search_text` projection. This supports validation, indexing, filtering,
history and analytics — none of which are reliable over a single JSON column.
`structuredData` remains available for values with no field definition.

### ADR-0006 — Overrides are provenance rows, not polymorphism

Agents, skills, tools, HTTP services, fields and collections each keep their own
table. A single `workspace_overrides` row records the *binding* between a
workspace-level resource and a workflow-scoped copy, along with the mode
(`use_asis` / `override` / `fork`) and the overridden field names. The UI can then
always answer "where does this effective value come from" without guessing, and no
unrelated resource types are forced into one table.

### ADR-0007 — Streaming is a view over persisted facts

Every execution fact is written before it is streamed. `run_events` is
authoritative; the in-process bus is a fan-out cache. A disconnected browser
reconnects with its last sequence and replays exactly the gap from the table.

### ADR-0008 — Agents and skills are immutable versions

`agent_versions` and `skill_versions` hold frozen snapshots. Every `agent_run`
references the version it used, so editing an agent never rewrites history.

### ADR-0009 — Blob ← File, with content-addressed storage

Raw bytes live in a BlobStore keyed by SHA-256; the database holds metadata. A
`files` row is a *logical* document with provenance, summary and field values; the
same blob may back several files when provenance differs. Blob uniqueness is
`(workspaceId, contentHash)`, so hash equality never reveals cross-tenant
possession.

### ADR-0010 — Blob dedupe is not processing dedupe

`file_processing_runs.processing_key` is
`contentHash + processorType + processorVersion + configurationFingerprint`.
Improved parsers, prompts or schemas therefore re-process the same bytes and
results are reused only when the full identity matches.

### ADR-0011 — Cross-workflow movement is a controlled operation

`workflowItems.transfer` validates permission, destination workflow, destination
state, required fields and mappings; preserves record identity, notes, artifacts and
lineage; appends audit events; updates workflow/state atomically; then triggers
normal destination-state semantics. The default is **move, not copy**. A routing
workflow is an ordinary workflow using ordinary primitives — there is no separate
"router" product concept.

### ADR-0012 — One filtering language

The filter AST in `src/lib/server/filters/ast.ts` powers work lists, file lists,
saved views and dashboard widgets. Work-item and analytics filtering cannot drift
apart because there is only one representation.

### ADR-0013 — History is recorded, never inferred

`workflow_item_state_history` stores intervals (`enteredAt`/`exitedAt`) and
`workflow_item_workflow_history` stores moves. Current state alone cannot answer
"how many entered Claims last month" or "how long did work items spend in Human
Review", so analytics reads history rather than current rows.

### ADR-0014 — HTTP is a first-class platform

A service holds connection concerns (base URL, auth, defaults, rate limits); an
operation holds semantic, model-facing meaning (key, schemas, mapping, success
rules). Models see `hubspot.get_contact`, never credentials.

### ADR-0015 — Providers are behind an interface

`ModelProvider` declares `health()`, `listModels()`, `generate()` and `stream()`
with explicit capabilities. The runner depends on the interface, so Ollama is one
implementation among several and a fake provider can drive the whole execution
suite deterministically. Reasoning is part of that contract: a model declares the
portable levels it accepts, each provider maps a level onto its native knob, and a
level the model does not accept is dropped with a `run.warning` rather than failing
the run.

### ADR-0016 — No external infrastructure in V1

Jobs, cache, cron and locks are implemented on the same transactional store. No
Redis, Kafka, Temporal or vector database is required to run Mentat locally.

### ADR-0017 — Analytics is derived from history

Widgets declare data source, filter, measure, grouping, time range and
visualization. Funnels explicitly select ordered milestones because workflows
branch; Kanban column order is never used to infer stage order.

### ADR-0018 — Retrieval is an interface with a portable default

Content search uses SQLite FTS5 when the build supports it and falls back to a
portable `LIKE` scan otherwise. PostgreSQL FTS/pgvector can replace the
implementation without changing the retrieval interface. Embeddings and vector
infrastructure are explicitly out of scope for this milestone.

### ADR-0019 — Approval is enforced by Mentat

Tool and state approvals are evaluated by the policy engine against persisted
configuration. A model's claim that it asked for permission is never sufficient.

### ADR-0020 — Secrets never enter model context

Plaintext is decrypted only inside execution, registered with the process-wide
redactor immediately, referenced by id in audit rows, and structurally redacted
from logs, run snapshots, HTTP request logs and diagnostics.

### ADR-0021 — Records and WorkflowItems are the universal model

There is no privileged Ticket primitive. The ontology is:

```text
Object Type  = schema for a kind of thing       (object_types + object_type_fields)
Record       = durable instance and knowledge   (records + record_field_values)
Workflow     = configurable process             (workflows.objectTypeId)
WorkflowItem = a Record in one Workflow         (workflow_items + overlay values)
File         = durable content/evidence         (file_records, file_workflow_items)
Event        = historical fact/activity         (audit_events, run_events)
```

Consequences that the code enforces:

- **State, owner and execution live on the WorkflowItem.** A Record never carries
  `workflowId` or `stateId`; the same Record may have zero, one or several active
  WorkflowItems (one per Workflow).
- **Base fields belong to the Record; workflow overlays belong to the
  WorkflowItem.** One field engine (`field_definitions` + typed value columns)
  serves records, workflow items and files. Overlay values and their
  `field_value_history` rows survive completion and transfer.
- **Transfer and add-participation are different operations.**
  `workflowItems.transfer` closes the source item and opens a destination item with
  `sourceWorkflowItemId` lineage; `workflowItems.addParticipation` adds a second
  Workflow without ending the first. Neither mutates a foreign key to "move" work.
- **Domain relationships and work relationships are separate.** `record_relationships`
  models `Business HAS_POLICY Policy`; `workflow_item_relationships` models
  `item A BLOCKS item B`.
- **One filtering language.** The filter AST gained `record_field` and
  `relationship` kinds; record lists compile against `records`/`record_field_values`
  and are type-aware (number/date/boolean columns), with unknown keys reported
  rather than silently dropped.
- **Unified analytics.** Dashboard widgets accept `records` and `workflow_items`
  data sources. `analytics/universal.ts` compiles the same filter AST against the
  canonical tables, groups by Object Type / state / workflow / owner / record field
  / time, and derives funnels and time-in-state from `workflow_item_state_history`
  rather than current rows.
- **Two event families.** `record.*` facts are separate from
  `workflow_item.*` process events; both are written to `run_events` in the same
  transaction as the change.

### ADR-0022 — Ticket has been removed; Records and WorkflowItems are the only work model

The legacy Ticket tables, services, UI and projection bridge have been deleted.
There is exactly one source of truth for work: `records` (durable identity and base
field values) plus `workflow_items` (participation, state, owner, execution metadata,
work notes, work relationships, workflow-overlay values and history). Files link
durably to Records (`file_records`) and contextually to WorkflowItems
(`file_workflow_items`). Jobs, agent runs, run events, approvals, trigger events,
audit events and agent state all reference `recordId`/`workflowItemId`.

There is no seeded system Object Type. A Workflow must name the Object Type it
processes (`workflows.objectTypeId` is required), and users define the Object Types
they need. This removes the last place where "Ticket" was privileged.

### ADR-0023 — AI execution is a validated Record contract

An agent run is *about* a subject: a Record + WorkflowItem. Input is
always the record the agent is working on. Output is the same record plus a workflow
directive (next `stateId`/`transitionId`, or a different `workflowId`).

The Object Type's effective schema — base fields plus the target workflow's overlay
— is compiled into a Zod schema (`records/contract.ts`). The `workflowItems.submit`
tool validates the submitted record against that schema (strict: unknown fields are
rejected) before anything is written. Invalid output is returned to the model as
structured field issues so it can repair; a state that sets
`config.requiredSubmission` forces the runner to keep going until a valid submission
exists, then fails the run after `maxNudges`. If the submission names another
workflow, the record is validated against *that* workflow's schema before the work
transfers.

**The contract is authored as Zod source.** An Object Type, a workflow overlay and a
workflow state can each store a Zod expression (`settings.zodSchema` /
`config.zodSchema`) written in one box, formatted on blur and tested against a JSON
sample before saving (`schema/ZodSchemaBox.svelte`, `POST /schemas/test`). The stored
source is authoritative and re-compiled at validation time, so constraints the typed
field engine cannot express — coercions, minimum lengths, unions — are enforced. The
bound `field_definitions` / `object_type_fields` / `workflow_fields` rows are a
projection of the source (`schemas/zod-source.ts`), which is what keeps lists,
filters, history and analytics working; editing fields directly clears the source and
makes the field set authoritative again. A state's schema is additionally validated
against the submitted record while the item is in that state. The same mechanism is
reusable: author once, run later.

This is why `outputSchema` on an agent is only a provider hint: the enforced contract
is the Object Type schema plus the submission requirement, evaluated by Mentat, not
by the model.

### ADR-0024 — One dispatch path per WorkflowItem

Agent and system states are dispatched through jobs enqueued in the same transaction
that moved the item. Every workflow uses `workflow_item.enter`, which runs the agent
against the record (with the contract) or executes the deterministic `SystemAction`
(`transition`, `setFields`, `emitEvent`, `wait`). Human gates set `waitingOn` and
enqueue nothing; terminal states close the item; stale or superseded entries are
skipped rather than run, which makes duplicate delivery harmless.

## Human gates versus approvals

These are different primitives and both exist:

- **Human gate** — a state that intentionally stops automatic progression. Agents
  cannot transition out of it; only an authorized human may select an allowed
  outgoing transition, optionally with required fields and a required comment. The
  execution engine never auto-runs through a gated state merely because it has
  outgoing transitions.
- **Approval** — a running agent execution is suspended pending a decision, then
  resumes from persisted state.

## Local deployment

| Concern | Default | Override |
| --- | --- | --- |
| Database | `./data/mentat.db` | `MENTAT_DB_PATH` |
| Blobs | `./data/blobs` | `MENTAT_BLOB_ROOT` |
| Master key | generated into `./data/master.key` | `MENTAT_MASTER_KEY` |
| Worker | in-process, 4 concurrent jobs | `MENTAT_WORKER_ENABLED`, `MENTAT_WORKER_CONCURRENCY` |
| Ollama | `http://localhost:11434` | configure per workspace |
| Storage | local filesystem | per-workspace GCS configuration |
