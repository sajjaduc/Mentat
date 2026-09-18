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
| 2 | Create a Workflow and states | **IT** `acceptance/definition-of-done` "1-3. create a workspace, a workflow with states, and move a work item"; `api/router` "creates a workflow from a template with states and transitions" |
| 3 | Create/assign/move work items | **IT** `acceptance` "1-3"; `work/lifecycle` transition and assignment suites |
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
| 16 | Inspect complete work item/run/audit history | **IT** `acceptance` "8-9, 11-14" (timeline + ledger actions); `work/lifecycle` audit coverage; `security/sweep` ledger isolation |
| 17 | Filter/save useful work item views | **IT** `acceptance` "17. filter and save a view"; `filters/compile` and `filters/views` suites |
| 18 | Use the app without full-page-refresh friction | **E2E** board move, drawer and live-update specs (optimistic move + rollback asserted); **IT** `work/lifecycle` optimistic concurrency |

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
| 12 | Link one File to multiple Work items | **IT** `acceptance` "12. one file linked to several work items; unlinking keeps the file"; `files/lifecycle` |
| 13 | Let agents retrieve/read Files through controlled native tools | **IT** `native/tools` file-tool suite (permission denial, tenant isolation, audit) |
| 14 | Control which file context enters an agent prompt | **IT** `execution/context` "a file summary is included, but not the full content, unless asked"; "full content is truncated at the configured budget" |
| 15 | Create Work items manually | **IT** `acceptance` "16-18"; `api/router` work item creation |
| 16 | Allow an authorized agent to create a work item | **IT** `acceptance` "16-18" (created with an agent actor, audited as the agent) |
| 17 | Create parent/child/related work item relationships | **IT** `acceptance` "16-18" (three children from one parent); `work/lifecycle` relationships |
| 18 | Let an agent decompose one Intake work item into children routed elsewhere | **IT** `acceptance` "16-18" (children created in a second workflow; `transfer` moves identity, `create` makes new work) |
| 19 | Delete/unlink Files safely without corrupting shared references | **IT** `acceptance` "19. deleting a file never destroys another work item's content"; `files/lifecycle` shared-blob cases |
| 20 | Pass the full TDD, security, supervisor and E2E review gates | `bun run verify` (1000+ tests, 0 failures), `security/sweep`, `hardening/fresh-install`, `hardening/scale`, `bun run test:e2e` |

## Follow-up milestone: Universal Records and WorkflowItems (ADR-0021/0022)

The decisive change is that Mentat has no special Ticket primitive: a Workflow
processes Records of any Object Type, and a WorkflowItem owns process state.

| # | Requirement | Where it is proven |
| --- | --- | --- |
| 1 | Mentat runtime has no special Ticket primitive | **IT** `records/universal` "a Workflow processes an arbitrary Object Type and records need no ticket" (zero `tickets` rows while work runs) |
| 2 | A Workflow can process any Object Type | **IT** `records/universal` arbitrary Object Type suite; `records/object-types` |
| 3 | Kanban/list cards are WorkflowItems backed by Records | **IT** `records/universal` "a Workflow processes an arbitrary Object Type…" asserts `getWorkflowBoard` columns/cards and `listWorkflowItems` joins the Record |
| 4 | UI terminology derives from Object Type | **IT** `records/universal` detail exposes `objectTypeKey`/`objectTypeName`; **API** `GET /object-types`; workflow create requires an explicit Object Type |
| 5 | state/owner/execution live on WorkflowItem | **IT** `records/universal` "state lives on the WorkflowItem, not the Record" (Record version unchanged; no `stateId` on the record) |
| 6 | Records can participate in multiple Workflows | **IT** `records/universal` "a record can have zero items and then participate in several workflows…" |
| 7 | transfer and add-participation are distinct | **IT** `records/universal` "transfer closes the source item while add-participation keeps it active" |
| 8 | base and Workflow fields resolve/history correctly | **IT** `records/universal` "base and workflow overlay fields resolve together and overlay history survives completion" |
| 9 | Records, Files, notes and relationships preserve durable vs work-context semantics | **IT** `records/universal` notes, file-link and relationship suites |
| 10 | agents can create/manage Records and WorkflowItems under policy | **IT** `records/universal` agent create/start suites (granted and denied); **UT** native tool contracts |
| 11 | automation can create Workflow participation directly from Record queries/events | **IT** `records/universal` "a scheduled-style record query drives work creation without a work item" |
| 12 | dashboards/funnels use the unified model | **IT** `analytics/universal-widgets` (Records and WorkflowItems as widget data sources: count/group/sum/median, field filters, month buckets, state-interval funnels, time-in-state, workspace isolation); `records/universal` "funnels can be derived from WorkflowItem transition history" |
| 13 | the legacy Ticket primitive is fully removed | `grep -r "tickets\\b" src` finds no ticket tables/services; `records` + `workflow_items` are the only work model (no projection, no bridge columns, no system Ticket Object Type) |
| 14 | TDD, supervisor, security, E2E and SQLite→PostgreSQL portability gates pass | `bun run verify`; `security/sweep`; `hardening/scale`; `postgres-migration` declaration rules |

## Follow-up milestone: Generic Record UI, dispatch engine and AI contracts

| # | Requirement | Where it is proven |
| --- | --- | --- |
| 1 | Browse/create Records of any Object Type | **E2E** `stability` "records settles"; **UI** `$ui/records/RecordsBrowser`; **API** `GET/POST /records` |
| 2 | Generic Record detail with Overview/Activity/Work/Files/Related/History | **E2E** `stability` "record detail settles"; **UI** `$ui/records/RecordSurface`; **API** `GET /records/:id/{history,files,notes,related}` |
| 3 | Configure Object Type schemas in the UI | **E2E** `stability` "object type settings settles"; **UI** `$ui/records/ObjectTypeSettings`; **API** `/object-types` |
| 4 | Dispatch agent/system states for WorkflowItems of any Object Type | **IT** `records/dispatch` (enqueue, system actions, human gate, stale skip, manual dispatch) |
| 5 | Every WorkflowItem uses one dispatch path | **IT** `records/dispatch` "a generic dispatch never double-runs a stale entry" |
| 6 | Agents run against the Record with the effective schema | **IT** `execution/record-contract` "nudges an unfinished answer, then accepts a validated submission" |
| 7 | Required structured submission retries then fails | **IT** `execution/record-contract` (nudge accepted; never-arriving submission fails; invalid record rejected and not persisted) |
| 8 | Contract is derived from field definitions | **UT** `records/contract` (types, required, strict unknown-key rejection, choices, dates) |
| 9 | Cross-workflow output validates against the target workflow | **IT** `records/work-contract` (transfer path, target overlay, `allowWorkflowChange`) |

## End-to-end status

`bun run test:e2e` runs five Playwright specs against a real dev server and its own
database under `.e2e/`, in two viewport projects: `chromium` (1280x720) and
`chromium-narrow` (900x900).

Each project gets its own dev server and database, so the two cannot contaminate each
other's fixtures or empty states.

| Project | Result |
| --- | --- |
| `chromium` (1280x720) | **74/74 passing** |
| `chromium-narrow` (900x900) | **74/74 passing** |
| Total | **148/148 passing** |

| Spec | Tests | What it covers |
| --- | --- | --- |
| `tests/e2e/smoke.spec.ts` | 6 | The DoD path end to end: sign in through the form, create a workflow from a template, create a work item inline on the board, move it from the card menu, open the work item drawer and walk its four tabs, load every primary surface without an error state, and write a secret that is never rendered back. |
| `tests/e2e/work-surfaces.spec.ts` | 11 | Board ordering and filters, inline creation, keyboard move, drag-and-drop, the URL-addressed work item drawer and its tabs, tab state across a reload, state renaming, the list and its column picker, My Work, and the approvals inbox. |
| `tests/e2e/configuration.spec.ts` | 7 | HTTP service and operation authoring with a real Test Request against Mentat's own API, provider connection testing and hand-registered models, the tool catalogue, integrations, and archiving. |
| `tests/e2e/files-analytics-settings.spec.ts` | 23 | Files (durability, dedupe, filter AST in `?filter=`, content search, the six-tab detail view), dashboards (KPI values, chart data-table fallbacks, funnels, aging), every settings section, and the workflow Data surface. |
| `tests/e2e/stability.spec.ts` | 26 | Every surface settles: after loading, each page is watched with a MutationObserver while idle and fails if it keeps re-rendering. Also asserts no surface logs an uncaught error. |

Getting here surfaced and fixed real defects — an unrun widget editor, a board that hid
its own columns, a team creation response that crashed the page, a filter builder that
did not publish its AST, and two effects that re-ran on their own writes. The stability
spec exists so that last class cannot come back quietly.

### What is deliberately a warning, not an error

`bun run lint` reports 21 `noExcessiveCognitiveComplexity` warnings against a raised
threshold of 30. They are concentrated in the state machine, filter compiler, provider
adapters and the execution runner — functions that are branch-heavy by nature. The rule
is advisory here: a warning does not fail `bun run verify`, and the two functions that
crossed the threshold were refactored rather than the rule being disabled outright.

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
