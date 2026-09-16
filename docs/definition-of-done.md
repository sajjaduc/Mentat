# Definition of Done — verification map

Every item in both Definition-of-Done lists, mapped to the thing that proves it. Run
`bun run verify` for lint, typecheck and the 900+ unit and integration tests, and
`bun run test:e2e` for the browser flows. Test names below are real; use them to jump
straight to the assertion.

Legend: **IT** = `tests/integration/**`, **UT** = `tests/unit/**`, **E2E** =
`tests/e2e/**`.

## Core plan

| # | Requirement | Where it is proven |
| --- | --- | --- |
| 1 | Create/sign into a workspace | **IT** `api/router` — registration, sign-in, session cookie hash, membership; **E2E** auth flow |
| 2 | Create a Workflow and states | **IT** `acceptance/definition-of-done` "1-3. create a workspace, a workflow with states, and move a ticket"; `api/router` "creates a workflow from a template with states and transitions" |
| 3 | Create/assign/move tickets | **IT** `acceptance` "1-3"; `tickets/lifecycle` transition and assignment suites |
| 4 | Define common and workflow resources | **IT** `acceptance` "4-6. define shared resources, expose provenance, and store secrets safely" |
| 5 | See inherited vs overridden configuration | **IT** `acceptance` "4-6" (workflow override wins, source reported); `config/overrides` suite |
| 6 | Configure secrets safely | **IT** `acceptance` "4-6"; `security/sweep` "a resolved secret appears in no table, raw or URL-encoded"; `api/router` "never returns plaintext and reports only a hint" |
| 7 | Connect local Ollama and select a model | **IT** `acceptance` "7. connect a local Ollama provider and select a discovered model" (mock Ollama: health, discovery, capability heuristics); `providers/ollama` contract suite; **optional** real-Ollama smoke test |
| 8 | Define an agent with skills/tools | **IT** `acceptance` "8-9, 11-14"; `agents` suites |
| 9 | Create/test an HTTP Service and expose an operation as an agent tool | **IT** `acceptance` "8-9, 11-14" (Test Request, tool row materialised); `http/runtime` and `http/service` suites |
| 10 | Use native state/data/cache | **IT** `acceptance` "10. native agent state, collections and cache"; `native/tools`, `cache`, `collections` suites |
| 11 | Attach an agent to a state | **IT** `acceptance` "8-9, 11-14"; `bootstrap` "a state entry reaches a completed agent run through the queue and worker" |
| 12 | Trigger work manually, by webhook and by schedule | **IT** `acceptance` "12. trigger work by webhook and by schedule"; `triggers/webhook`, `triggers/cron`, `triggers/manual` suites |
| 13 | Watch live agent/tool execution | **IT** `execution/engine` "streams content deltas into persisted run events"; `execution/events` replay; **E2E** Agent Work timeline |
| 14 | Survive transient failures through retries | **IT** `acceptance` "18. transient failures are survived through retries"; `jobs/queue` retry, dead-letter and lease-expiry suite; `http/runtime` Retry-After |
| 15 | Require and resolve human approval | **IT** `acceptance` "15. require and resolve human approval for a gated tool call"; `execution/engine` approval, rejection and pause/resume suites |
| 16 | Inspect complete ticket/run/audit history | **IT** `acceptance` "8-9, 11-14" (timeline + ledger actions); `tickets/lifecycle` audit coverage; `security/sweep` ledger isolation |
| 17 | Filter/save useful ticket views | **IT** `acceptance` "17. filter and save a view"; `filters/compile` and `filters/views` suites |
| 18 | Use the app without full-page-refresh friction | **E2E** board move, drawer and live-update specs (optimistic move + rollback asserted); **IT** `tickets/lifecycle` optimistic concurrency |

## Follow-up milestone: Files and agent-created work

| # | Requirement | Where it is proven |
| --- | --- | --- |
| 1 | Upload a File and have Mentat hash/store it | **IT** `acceptance` "1-3. upload, hash, deduplicate and preserve distinct provenance"; `files/ingest` |
| 2 | Ingest the same bytes again without duplicate storage | **IT** `acceptance` "1-3" (one blob, two logical files) |
| 3 | Preserve distinct provenance for repeated appearances | **IT** `acceptance` "1-3"; `files/ingest` provenance cases |
| 4 | Switch/configure Local or GCS storage at Workspace level | **IT** `acceptance` "4. configure workspace storage"; `storage/gcs-blob-store` and `resolve-blob-store` contract suites |
| 5 | Automatically ingest an attachment from an incoming event | **IT** `acceptance` "5-7. automatic attachment from an event, durable processing, version-aware reuse" |
| 6 | Process a File durably and inspect processing history | **IT** `files/processing-pipeline`; `acceptance` "5-7" (processing runs, statuses) |
| 7 | Extract/reuse content and summary with version-aware processing | **IT** `files/processing` "a processor version change forces a new run"; `files/summary-reuse` |
| 8 | Define Workflow File Fields and extract them automatically | **IT** `acceptance` "8-9. define workflow file fields, correct them, and keep history"; `files/file-fields` |
| 9 | Manually correct File Fields with full history | **IT** `acceptance` "8-9" (before/after history rows asserted) |
| 10 | Browse/search/filter Files as first-class objects | **IT** `acceptance` "10-11"; `files/retrieval-parity`; **E2E** Files browser |
| 11 | Search extracted file content | **IT** `files/retrieval-parity` (FTS and LIKE agree); `acceptance` "10-11" |
| 12 | Link one File to multiple Tickets | **IT** `acceptance` "12. one file linked to several tickets; unlinking keeps the file"; `files/lifecycle` |
| 13 | Let agents retrieve/read Files through controlled native tools | **IT** `native/tools` file-tool suite (permission denial, tenant isolation, audit) |
| 14 | Control which file context enters an agent prompt | **IT** `execution/context` "a file summary is included, but not the full content, unless asked"; "full content is truncated at the configured budget" |
| 15 | Create Tickets manually | **IT** `acceptance` "16-18"; `api/router` ticket creation |
| 16 | Allow an authorized agent to create a Ticket | **IT** `acceptance` "16-18" (created with an agent actor, audited as the agent) |
| 17 | Create parent/child/related Ticket relationships | **IT** `acceptance` "16-18" (three children from one parent); `tickets/lifecycle` relationships |
| 18 | Let an agent decompose one Intake Ticket into children routed elsewhere | **IT** `acceptance` "16-18" (children created in a second workflow; `transfer` moves identity, `create` makes new work) |
| 19 | Delete/unlink Files safely without corrupting shared references | **IT** `acceptance` "19. deleting a file never destroys another ticket's content"; `files/lifecycle` shared-blob cases |
| 20 | Pass the full TDD, security, supervisor and E2E review gates | `bun run verify` (913 tests, 0 failures), `security/sweep`, `hardening/fresh-install`, `hardening/scale`, `bun run test:e2e` |

## Additional gates

| Gate | Command | Evidence |
| --- | --- | --- |
| Formatting and lint | `bun run lint` | 0 errors |
| Typecheck (strict, `noUncheckedIndexedAccess`) | `bun run typecheck` | 0 errors; also clean with `--noUnusedLocals` |
| Svelte check | `bun run check` | 0 errors |
| Production build | `bun run build` | Adapter-node output; verified serving `/login` and the API |
| Migrations on a clean database | `bun run db:migrate` | **IT** `hardening/fresh-install` "migrations create the complete schema and are idempotent" |
| Seed | `bun run seed` | Creates the demo workspace; second run is a no-op |
| Worker as a separate process | `bun run worker --once` | Drains the queue and exits |
| Docker | `docker compose up -d` | One service, `/data` volume, health check |

## Deliberate non-goals for this milestone

These are recorded so their absence is a decision rather than a gap:

- **Embeddings and vector search.** Retrieval is structured filters, metadata and
  full-text search behind an interface built to accept pgvector later (ADR-0018).
- **Multi-node execution.** One writer, one worker pool; the queue is written so a
  second process joins safely, but there is no distributed coordinator.
- **A hosted control plane.** Mentat is self-hosted by design.
- **A textual query language for filters.** The serializable filter AST is the single
  language; a parser can emit it later without touching storage.
- **OCR for images.** Image files are stored, hashed and described; text extraction
  reports `unsupported` explicitly rather than pretending to succeed.
- **Retention enforcement.** `retentionDays` is stored per workspace and exposed, but
  no reaper deletes domain data: retention is policy, not a background job, in V1.
