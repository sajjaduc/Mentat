# Mentat — End-to-End Build Plan

## Mission
Build **Mentat**, a self-hostable work-orchestration platform where humans and AI agents participate in durable workflows. A Workflow is a project/state machine presented primarily as a Kanban board. Tickets move through user-defined states; states may wait for humans, invoke agents, require approvals, or run deterministic work.

Mentat itself provides the infrastructure agents repeatedly need: HTTP integrations, persistent state, structured data, cache, secrets, webhooks, cron, approvals, retries, artifacts, audit history, providers and models.

### Invariants
1. Ticket is the central work object.
2. Workflow is a configurable state machine.
3. Human owner and current agent worker are independent.
4. Execution is durable, observable, retryable and auditable.
5. Inheritance/overrides are always visible.
6. Secrets never enter model context.
7. HTTP, storage and cache are first-class primitives.
8. Start on SQLite but preserve a clean PostgreSQL path.
9. UI/UX quality is an acceptance criterion.
10. Follow TDD.

## Stack
- Bun, TypeScript strict
- SvelteKit / Svelte 5
- Tailwind CSS
- Drizzle ORM
- SQLite initially; PostgreSQL later
- Zod-style schema validation
- Bun test + Playwright
- Biome
- Application-generated UUID/UUIDv7 IDs
- UTC persistence timestamps

Do not require Redis, Kafka, Temporal, external queues or vector databases for V1.

## Architecture
Use modules for `db`, `auth`, `workflows`, `tickets`, `execution`, `jobs`, `agents`, `skills`, `tools`, `http`, `providers`, `config`, `secrets`, `storage`, `cache`, `approvals`, `triggers`, `artifacts`, and `audit`.

Dependency direction:

```text
Svelte UI → typed API/server boundary → application services → domain → repositories → Drizzle → SQLite/PostgreSQL
```

Do not put business rules in components or route handlers.

### PostgreSQL portability
SQLite is a deployment choice, not a domain assumption. Isolate dialect-specific locking/query behavior behind interfaces; avoid SQLite-only correctness assumptions; never depend on autoincrement IDs; keep migrations deterministic; maintain `docs/postgres-migration.md`; add PostgreSQL CI after the schema stabilizes.

## Core Domain
### Workspace
Top-level tenant containing users, teams, workflows, common resources, HTTP services, providers/models, environment variables and secrets. Enforce `workspaceId` at service/repository boundaries.

### Workflow
Workflow = project + state machine. Contains states/transitions, tickets, triggers, workflow resources/overrides, data collections and settings. Primary UI: `Board | List | Activity | Data | Configuration`.

### State
User-defined Kanban state: human/manual, agent-driven, deterministic/system, or terminal. Configuration may define worker/agent, automatic execution, transitions, approval behavior, failure state, timeout and retries.

### Ticket
Store `id, workspaceId, workflowId, title, description, stateId, priority, ownerUserId?, ownerTeamId?, structuredData, version, createdAt, updatedAt`. Relate to labels, comments, artifacts, runs, approvals and events. Use optimistic concurrency where workers may race.

## Execution
When a ticket enters a state: validate and persist transition transactionally; append events; inspect state configuration; wait for manual states; enqueue AgentRun for agent states; create durable approval gates where required; execute; validate requested next transition; transition atomically; enqueue subsequent work only after persistence succeeds.

Agents do not directly mutate arbitrary ticket state. Prevent duplicate state-entry work using idempotency/version checks.

## Audit Ledger
Maintain append-only events such as `ticket.created`, `ticket.state.entered`, `agent.run.started`, `tool.call.completed`, `approval.requested`, `job.retry_scheduled`, and `trigger.received`. Current domain rows remain authoritative; do not implement full event sourcing.

## Durable Jobs
Create a native job queue for agent runs, webhooks, cron, retries, approval resumption and background work. Store type, payload, status, attempts, availability, lease/lock and errors. Define `JobQueue`; implement SQLite-safe leasing now and allow PostgreSQL `SKIP LOCKED` later. Test worker death, expired leases and duplicate delivery.

## Agents and Skills
Agent is versioned configuration: name, description, instructions, model, skills, tools, output schema, execution settings and permissions. Every AgentRun references an immutable agent version.

Skills are versioned reusable instruction/procedure packages with instructions, examples, references and recommended tools. Skills are not executable plugins.

## Agent Runs
Persist ticket, agent/version, provider/model, status, attempt, timestamps, input snapshot, output, usage and error. Persist steps/tool calls separately. UI must expose model/version, tool calls, redacted inputs, outputs, cache status, timing, retries, approvals and transition. Never snapshot plaintext secrets.

## Tools
Tool contract: name, description, input/output schema, implementation type, permissions, timeout, retry policy, approval policy and cache policy. Initial implementations: Mentat-native and HTTP. Keep extensible for future MCP/sandbox/plugin tools.


## First-Class HTTP
HTTP is a flagship capability.

### HTTP Service
Reusable service with name, base URL, authentication, default headers, timeout, retry defaults, cache defaults and rate limits. Initial auth: none, bearer secret, API-key header/query, basic auth and custom secret-backed headers. Resolve secrets only inside execution.

### HTTP Operation
Define semantic agent-facing name/description, method, path, path/query/header/body mappings, input/output schemas, success rules, response mapping, timeout, retries, cache and approval policy. The model sees semantic tools such as `hubspot.get_contact`, not credentials.

### Editor
Build a clean Postman-inspired editor:

```text
Method | URL/path
Parameters | Headers | Body | Response | Cache | Retries | Approval | Advanced
```

Include Test Request, formatted response, status, latency, redaction and optional output-schema inference. Keep architecture ready for cURL/OpenAPI/Postman import.

### Runtime
Centralize timeout, safe retries, exponential backoff, Retry-After, service-level rate/concurrency limits, caching, redaction, audit and response mapping. GET/HEAD caching may be enabled; mutation caching defaults off. Cache identity must include workspace/auth identity.

## Native Agent State
Expose `state.get/set/delete/list` with ticket, workflow, agent and workspace scopes. Permissions govern access; workspace writes require explicit permission. Never expose arbitrary Mentat SQL.

## Structured Collections
Expose `data.get/find/insert/update/delete`. Workflow authors define collections such as customers or research results. Use portable document/JSON persistence initially. Provide Workflow → Data inspection UI.

## Native Cache
Expose `cache.get/set/delete/getOrCompute`. Support TTL, namespaces, clearing, inspection and stampede protection. HTTP tools use the same cache subsystem and report hit/miss/age. Keep locking abstract for SQLite/PostgreSQL.

## Artifacts
Support uploads, generated files, text/JSON and external references through an `ArtifactStore`. Start with local filesystem + DB metadata; permit future object storage.

## Environment and Secrets
Resolution is `Workflow override > Workspace value`. UI must label **Inherited**, **Override**, and **Local**. Removing an override resumes inheritance.

Secrets are encrypted at rest, never returned after creation, never enter prompts, never appear in logs, are redacted in diagnostics, are referenced by ID/version in audit data, and resolve only at execution time. Use standard authenticated encryption and a deployment-provided master key.

## Common Resources
For agents, skills, tools, variables and secrets use consistent semantics:
- **Use as-is** — common resource
- **Override** — inherit but change workflow-specific values
- **Fork** — independent local copy

Always display effective configuration and provenance. Do not force all resource types into one polymorphic DB table.

## Providers and Models
Separate Provider from Model. Provider stores type/base URL/credentials/defaults/health; Model stores provider, model ID, display name, capabilities, context metadata and inference defaults.

Define provider interface around `health()`, `listModels()`, `generate()`, `stream()` with explicit capabilities.

### Ollama
Ollama is required in V1. User configures e.g. `http://localhost:11434`. Mentat tests connectivity, discovers/refreshes installed models, lets users register/select them, supports generation and streaming, exposes tool calling only where supported, shows errors cleanly and supports relevant model/context options. AgentRunner must not depend directly on Ollama. Add mock-server contract tests and optional real-Ollama integration tests.

## Live Execution
Use SSE initially for run started, streaming output, tool started/completed, approval requested, retry scheduled and run completed. Persist authoritative execution state; browser disconnection never stops execution.

## Approvals
V1 supports state-level and tool-call approvals. Persist requested action/context, requester, reviewer, status, timestamps, decision and comment. Execution pauses durably and resumes from persistence. Provide top-level Approvals plus ticket-local approval UI. Approval policy is enforced by Mentat, never by model judgment alone.

## Users and Assignment
Support multiple users, teams and practical Owner/Admin/Member roles. Ticket ownership is independent of current agent execution. Support user/team/unassigned ownership and My Work, Waiting for Me, Waiting for Agent, Waiting for Approval, Failed/Needs Attention views.

## Triggers
Initial triggers: webhook, cron/schedule, manual/API. Normalize to internal events.

Webhook: workflow endpoint, signature/secret support, idempotency, safe payload capture/redaction, create/update/wake mapping and retry-safe processing.

Cron: persisted schedules, worker-safe claiming, timezone-aware authoring and deterministic next-run calculation without external cron infrastructure.

## Filtering
Build structured Jira-style filters without JQL initially: state, owner/team, priority, labels, dates, approval/run status and practical custom fields. Support AND/OR groups and saved views. Store a serializable filter AST for future textual query language.


## UI / UX Standard
The product must feel **slick, modern, fast, calm and unusually clean**, not like a generic admin dashboard.

Require generous spacing, strong typography, restrained hierarchy, minimal chrome, keyboard navigation, contextual actions, excellent empty states, skeletons instead of layout jumps, optimistic updates where safe, strong error/retry states, accessibility and reduced-motion support.

Use purposeful motion for Kanban movement, state transitions, drawers, list insertion/removal, approvals, run/tool progress and subtle hover/focus feedback. Motion communicates causality; avoid decorative friction.

Suggested navigation:

```text
Workflows
My Work
Approvals
────────────
Agents
Skills
Tools
HTTP Services
────────────
Models
Integrations
────────────
Settings
```

Workflow: `Board | List | Activity | Data | Configuration`.
Ticket: `Overview | Agent Work | Activity | Artifacts`.

**Agent Work** is a flagship surface: live and historical execution in a readable timeline.

Add a command palette early.

### Refresh experience
Avoid full-page refreshes. Require optimistic Kanban movement with rollback, background board/list refresh, live AgentRun updates, stable scroll positions, preserved ticket drawer state and useful URL state. The application should feel like a live workbench rather than CRUD forms.

## TDD
For every feature:
1. write behavioral/contract test;
2. verify failure;
3. implement minimum behavior;
4. refactor;
5. run relevant suite;
6. add integration/E2E coverage where warranted.

Prioritize tests for transitions, concurrency, job leases, retries/idempotency, version snapshots, approval pause/resume, secret redaction, inheritance, tenant isolation, HTTP mapping/retries/cache/auth isolation/rate limits, storage permissions, cache stampede, webhook dedupe, cron and Ollama contracts.

Every bug fix gets a reproducing test first.

## Git Worktrees and Subagents
Use isolated git worktrees for parallel subagents. Never let multiple agents make unrelated changes in the same working tree.

Suggested branches/worktrees:

```text
agent/foundation
agent/workflows
agent/execution
agent/http
agent/providers
agent/data
agent/ui
agent/e2e
```

Each subagent receives a bounded objective, architectural constraints, owned modules/files, acceptance criteria, tests and integration contracts. It must inspect existing architecture, write/update tests first, implement only its scope, run formatting/lint/typecheck/tests, document decisions and prepare a reviewable diff. **Subagents do not merge directly to main.**

Avoid parallel edits to the same files. Supervisor defines shared interfaces before parallel implementation.

## Supervisor
A dedicated Supervisor owns architecture and integration quality.

Before any subagent work is committed/merged, Supervisor must:
1. inspect the complete diff;
2. verify scope and module boundaries;
3. review schema/migration implications;
4. check tenant isolation;
5. check secret handling/redaction;
6. check SQLite/PostgreSQL portability;
7. verify tests genuinely cover behavior;
8. run lint, format, typecheck, unit/integration tests;
9. run affected Playwright flows;
10. inspect UI changes visually at desktop and narrower widths;
11. reject placeholder UX, dead code, unexplained TODOs and silent scope expansion;
12. request fixes in the originating worktree;
13. only integrate after the review gate passes.

After integration, run the complete suite again. The Supervisor should make small integration fixes itself only when clearly cross-cutting; substantive fixes return to the owning subagent.

## Delivery Phases

### Phase 0 — Bootstrap
Create SvelteKit/Bun project, Tailwind, Biome, tests, Drizzle/SQLite, migrations, environment handling, app shell, CI and worktree conventions. Establish ADRs and architecture docs.

### Phase 1 — Workspace + Workflow Core
Implement users/workspaces, workflow CRUD, state designer, tickets, transitions, ownership, labels, Board/List, ticket drawer/page and audit events. E2E: create workflow → states → ticket → move card.

### Phase 2 — Durable Execution
Implement JobQueue, worker lifecycle, leases, retries, idempotency, Agent/Skill versioning, AgentRun/steps and live SSE timeline. Use a deterministic fake provider first.

### Phase 3 — Providers + Ollama
Implement generic provider contracts and built-in Ollama health/model discovery/generation/streaming. E2E with mock provider; optional real Ollama smoke test.

### Phase 4 — Native Data
Implement scoped agent state, structured collections, cache, permissions, cache locks/stampede protection, Workflow Data UI and native agent tools.

### Phase 5 — HTTP Platform
Implement HTTP Services, auth/secrets, operations, visual editor, test request, response mapping, retries, rate limiting, cache and tool-call audit. This phase must receive strong integration/contract testing.

### Phase 6 — Approvals
Implement approval records, inbox, state/tool gates, durable pause/resume and approval timeline.

### Phase 7 — Triggers
Implement webhook endpoints/idempotency/mapping, cron scheduler and manual/API triggers.

### Phase 8 — Configuration + Overrides
Implement workspace environment/secrets, workflow overrides, provenance UI and common/workflow resource binding semantics.

### Phase 9 — Filtering + UX Completion
Implement filter AST, saved views, My Work, command palette, keyboard flows, refined animation, optimistic updates, loading/empty/error states and accessibility.

### Phase 10 — Hardening
Run tenant/security review, secret-leak tests, concurrency tests, worker crash recovery, migration rehearsal, performance profiling, full E2E, fresh-install test and PostgreSQL portability audit.

## Definition of Done
Mentat is complete for this milestone only when a fresh clone can be installed and started with documented Bun commands and a user can:

1. create/sign into a workspace;
2. create a Workflow and states;
3. create/assign/move tickets;
4. define common and workflow resources;
5. see inherited vs overridden configuration;
6. configure secrets safely;
7. connect local Ollama and select a model;
8. define an agent with skills/tools;
9. create/test an HTTP Service and expose an operation as an agent tool;
10. use native state/data/cache;
11. attach an agent to a state;
12. trigger work manually, by webhook and by schedule;
13. watch live agent/tool execution;
14. survive transient failures through retries;
15. require and resolve human approval;
16. inspect complete ticket/run/audit history;
17. filter/save useful ticket views;
18. use the application without full-page-refresh friction.

No milestone is done with failing tests, broken typecheck/lint, unreviewed migrations, unresolved security issues, or major placeholder UI.

## Final Agent Instructions
Prefer the simplest architecture that preserves the invariants above. Do not introduce infrastructure because it is fashionable. Keep PostgreSQL portability real, not theoretical. Make failure states explicit. Keep secrets out of model-visible surfaces. Preserve auditability. Treat HTTP tooling and Agent Work UX as flagship features.

Use subagents aggressively for bounded parallel work, but use the Supervisor as a strict merge gate. The final responsibility is a coherent product, not maximizing parallelism.

When implementation choices are ambiguous, choose the option that improves durability, inspectability, composability and human understanding while keeping the V1 operational footprint small.


---

# Addendum — Cross-Workflow Routing, Fields, Human Gates, Notes and Analytics

The following requirements are part of the core Mentat architecture, not optional extensions.

## 27. Cross-Workflow Ticket Movement and Router Workflows

Tickets must be able to move **between Workflows**, not only between states inside one Workflow.

This enables a powerful pattern:

```text
Email / Webhook / API / Cron / Other Event
                    ↓
             Intake Workflow
                    ↓
              Routing Agent
          ┌─────────┼─────────┐
          ↓         ↓         ↓
       Claims     Sales     Support
       Workflow   Workflow   Workflow
```

A common Intake/Triage Workflow can receive heterogeneous events, normalize them into tickets, classify them, enrich their fields, and route them to the appropriate specialized Workflow.

### Transfer semantics

Treat cross-workflow movement as a first-class controlled operation:

```text
ticket.transfer({
  targetWorkflow,
  targetState?,
  fieldMapping?,
  reason?
})
```

The operation must:

1. validate permission to transfer;
2. validate the destination Workflow;
3. determine/validate the destination state;
4. validate destination-required fields;
5. apply configured field mappings;
6. preserve ticket identity unless an explicit future copy/fork operation is requested;
7. preserve notes, artifacts, external references and full historical lineage;
8. append transfer audit events;
9. atomically update current Workflow/state;
10. trigger normal destination-state entry semantics.

The default model is **move, not copy**.

The ticket's history must make movement obvious:

```text
10:01 Ticket created in Intake / Incoming
10:02 Intake Agent classified ticket
10:02 Field "Request Type" set to "Claim"
10:03 Transferred Intake → Claims
      Reason: Classified as claim
10:03 Entered Claims / New Claim
```

### Transfer policies

Workflows should be able to define:

- allowed destination Workflows;
- default destination state;
- whether agents may transfer;
- whether humans may transfer;
- field mappings;
- required destination fields;
- optional approval/human gate before transfer.

Do not let an LLM bypass transfer policies.

### Routing Workflows

Do not create a separate hard-coded "router" product concept. A routing/intake Workflow should be an ordinary Workflow using ordinary Mentat primitives. This keeps the platform composable.

---

# 28. First-Class Ticket Field System

`structuredData` alone is insufficient for user-facing ticket metadata.

Mentat needs a first-class Jira-style field system.

Each Workflow can define its ticket schema using reusable field definitions.

Examples:

```text
Customer
Request Type
Policy Number
Claim Amount
Renewal Date
Company
Email
Phone
Priority
Risk Category
Assigned Underwriter
Premium
Due Date
```

### Field definitions

A field should include approximately:

```text
id
workspaceId
key
name
description
type
scope
required
defaultValue?
options?
validation?
displayConfiguration
createdAt
updatedAt
```

Initial field types:

- short text
- long text
- number
- currency
- boolean
- date
- datetime
- single select
- multi-select
- user
- team
- URL
- email
- phone
- JSON/object for advanced cases

System fields such as title, state, priority, owner, created date and updated date remain native system fields.

### Workflow field configuration

A Workflow selects which fields apply to its tickets and may configure:

- order;
- required/optional;
- visibility;
- editable/read-only;
- default value;
- state-specific requirements;
- list/board-card display;
- filterability;
- dashboard availability.

### Ticket field values

Store values in a way that supports:

- typed validation;
- efficient filtering;
- field history;
- analytics;
- future PostgreSQL migration.

Do not hide all field values inside one opaque JSON blob if doing so prevents reliable filtering, indexing and history.

A practical model is explicit field definitions plus typed/normalized ticket field-value records, with optional JSON for complex values.

### Human and agent editing

Humans edit fields through the ticket UI.

Agents receive controlled native operations such as:

```text
ticket.fields.get
ticket.fields.set
ticket.fields.setMany
```

All writes:

- validate type;
- validate field permissions;
- enforce state rules;
- record actor;
- record previous/new value;
- append audit history.

### Agent extraction

A common pattern is:

```text
Incoming email
      ↓
Ticket created
      ↓
Agent extracts:
  Customer
  Request Type
  Policy Number
  Effective Date
      ↓
Fields populated
      ↓
Routing decision
```

This must be easy to implement without bespoke database code.

---

# 29. Field Mapping Across Workflows

Because tickets can move between Workflows, field compatibility must be explicit.

Prefer workspace-level reusable field definitions where the semantic field is truly shared.

Example:

```text
Workspace Field: customer_email
Used by:
  Intake
  Claims
  Sales
```

Then no mapping is required.

Where schemas differ, transfer configuration can define mappings:

```text
Intake.request_type       → Claims.claim_type
Intake.customer_email     → Claims.contact_email
Intake.reference_number   → Claims.external_reference
```

The transfer preview/configuration UI should identify:

- directly compatible fields;
- mapped fields;
- destination-required fields with no value;
- source-only fields.

Never silently discard source field history. Even if a field is not active in the destination Workflow, its historical value remains part of the ticket record/history.

---

# 30. Notes, Comments and Attachments

Tickets need a first-class human/agent work journal.

Distinguish:

### Notes/comments

Users and agents can add timestamped notes.

Store:

```text
id
workspaceId
ticketId
authorType
authorId?
body
createdAt
editedAt?
```

If editing is supported, retain edit history or audit the before/after value.

Agents may add notes through a controlled native tool.

### Attachments/artifacts

Attachments may be:

- manually uploaded;
- generated by an agent;
- received from email;
- fetched from an HTTP integration;
- produced by another connector.

Every attachment/artifact must retain provenance:

```text
sourceType
sourceReference?
uploadedBy?
createdByRun?
originalFilename
mimeType
size
storageReference
createdAt
```

Example:

```text
policy_schedule.pdf
Source: Incoming email
Message: external-ref-123
Added: 10:01
```

Attachments automatically received from external events must appear naturally alongside manually uploaded files.

### Context control

Do not automatically inject every note/attachment into every model call.

Agent/Skill/state configuration should control which ticket fields, notes, history and artifacts are assembled into context. This is necessary for token efficiency and data minimization.

---

# 31. Human Gates and Human-Controlled States

Human approval and a **human gate** are related but distinct concepts.

A Human Gate state means Mentat intentionally stops automatic progression and requires a permitted human to make the transition.

Example:

```text
Agent Research
      ↓
Human Review
      ↓
[human chooses]
 ┌────┴─────┐
Approve   Rework
   ↓         ↓
Quote      Research
```

For a human-gated state:

- agents cannot transition the ticket out;
- automatic state transitions cannot bypass it;
- only authorized humans may select an allowed outgoing transition;
- optional comment/reason can be required;
- optional required fields can be enforced before exit;
- the human decision is auditable.

Configuration:

```text
Human Gate: enabled

Allowed human transitions:
  Approve → Ready to Send
  Rework  → Research
  Reject  → Closed

Required before exit:
  Review Outcome
  Reviewer Notes

Allowed roles/teams:
  Senior Underwriters
```

This differs from tool-call approval, where an agent execution is suspended pending approval and then resumes.

Both primitives must coexist.

The execution engine must never auto-run through a human-gated state merely because the state has outgoing transitions.

---

# 32. Complete Ticket History and Provenance

Ticket history is a flagship feature.

A ticket can accumulate activity across multiple Workflows and many agents/humans. The history must remain one coherent chronological record.

Track at minimum:

- creation;
- external source/event;
- workflow transfers;
- state transitions;
- field changes;
- assignment/reassignment;
- notes/comments;
- attachments;
- agent runs;
- tool calls;
- approvals;
- human-gate decisions;
- retries/failures;
- labels;
- priority changes;
- automated extraction;
- manual corrections.

Example:

```text
10:01  Email received
10:01  Ticket created in Intake
10:01  attachment.pdf attached from email
10:02  Triage Agent started
10:02  Customer = ACME Pty Ltd
        Set by Triage Agent
10:02  Request Type = Claim
        Set by Triage Agent
10:03  Intake → Claims
        Transferred by Triage Agent
10:03  Claims / New → Investigation
10:04  Claims Agent started
10:07  Claims Agent added note
10:08  Investigation → Human Review
10:22  Sarah changed Claim Amount
        $12,000 → $12,500
10:24  Sarah approved human gate
10:24  Human Review → Ready to Lodge
```

The UI should support a unified timeline plus filters such as:

```text
All | Human | Agents | Fields | States | Tools | Files
```

Never overwrite history merely because the current value changed.

---

# 33. Analytics and Dashboards

Mentat must support operational dashboards built from ticket fields, states, transitions and filters.

Analytics is not an afterthought; field/history design must support it from the beginning.

### Dashboard model

Users can create dashboards containing configurable widgets.

Initial widget types:

- KPI/count;
- number/sum/average;
- bar chart;
- line/time-series;
- breakdown/pie/donut where appropriate;
- table;
- funnel;
- aging/time-in-state;
- saved-filter result.

A widget specifies:

```text
data source / workflow(s)
filter
measure
grouping
time range
visualization
```

Examples:

```text
Open Claims
Count tickets
Filter: Workflow = Claims AND State != Closed
```

```text
Claim Value by Type
Measure: SUM(Claim Amount)
Group: Claim Type
```

```text
Tickets by Owner
Measure: COUNT
Group: Owner
```

### Funnels

Funnels are especially important because Workflows are state machines.

Example:

```text
Incoming       1,240
Qualified        870
Quoted           520
Accepted         180
```

Support:

- count reaching each stage;
- conversion between stages;
- overall conversion;
- median/average time between stages;
- configurable time window;
- filtering by ticket fields.

Do not infer funnel order solely from current Kanban column order when workflows can branch. Funnel definitions should explicitly select ordered milestones/states.

### Historical correctness

Current ticket state alone cannot answer historical funnel or throughput questions.

Analytics must derive historical metrics from immutable transition/field events or purpose-built analytics projections.

Design for questions such as:

- How many tickets entered Claims last month?
- How long did tickets spend in Human Review?
- What percentage of qualified tickets reached Bound?
- Which agent generated the most retries?
- What is average Claim Amount by claim type?
- How did conversion change week over week?

### Dashboard filters

Dashboard/global filters should support:

- workflow;
- state;
- owner/team;
- labels;
- date ranges;
- field values;
- source/connector;
- agent/model;
- approval status.

Widgets may add their own local filters.

### Saved filters as reusable analytics inputs

The same structured filter AST used by ticket lists should power dashboard widgets where possible.

Do not create separate incompatible filtering languages for tickets and analytics.

---

# 34. Schema and Event Implications

Update the persistence plan to explicitly include concepts equivalent to:

```text
field_definitions
workflow_fields
ticket_field_values
ticket_field_value_history / audit events

ticket_notes
artifacts

workflow_transfer_rules

dashboards
dashboard_widgets

human_gate configuration / decisions
```

Exact table decomposition is an implementation decision, but preserve:

- typed values;
- provenance;
- tenant isolation;
- history;
- filterability;
- analytics;
- PostgreSQL portability.

For high-volume analytics later, projections/materialized summaries may be introduced. V1 should favor correctness and a clean query abstraction over premature warehouse infrastructure.

---

# 35. Updated Native Agent Capabilities

The native Mentat tool surface should eventually include controlled operations conceptually like:

```text
mentat.ticket.get
mentat.ticket.fields.get
mentat.ticket.fields.set
mentat.ticket.fields.setMany
mentat.ticket.addNote
mentat.ticket.addArtifact
mentat.ticket.requestTransition
mentat.ticket.transfer

mentat.state.get
mentat.state.set

mentat.data.find
mentat.data.insert
mentat.data.update

mentat.cache.get
mentat.cache.set
```

Every mutating operation passes through authorization, validation, workflow policy and audit.

---

# 36. Additional TDD Requirements

Add tests covering:

- cross-workflow transfer;
- transfer into default/specified states;
- invalid destination;
- transfer field mapping;
- missing destination-required fields;
- transfer authorization;
- preservation of ticket identity/history;
- routing workflow behavior;
- typed field validation;
- human vs agent field changes;
- field-level audit history;
- state-specific required fields;
- human gate cannot be bypassed by agents;
- permitted human gate transitions;
- required gate notes/fields;
- automatic email attachment provenance;
- notes and attachment audit;
- dashboard aggregation correctness;
- funnel calculations from historical transitions;
- time-in-state calculations;
- saved filter reuse in dashboards;
- workspace isolation for analytics.

---

# 37. Updated Delivery Ordering

Integrate these requirements into the existing phases rather than postponing them.

### Workflow Core
Include first-class field definitions/values, notes and attachments from the beginning.

### Durable Execution
Include field mutation events and human-gate enforcement in the state engine.

### Native Data / Agent Tools
Include native ticket-field, note and transfer operations.

### Triggers
Ensure incoming events can create attachments and populate/extract fields.

### Configuration
Add cross-workflow transfer policies and field mappings.

### UX Completion
Add full unified ticket timeline and transfer visualization.

### Analytics Phase
Before final hardening, implement dashboards, reusable filters, field aggregations, funnels and time-in-state analytics.

The analytics phase must use real historical semantics rather than only querying current ticket rows.

---

# 38. Additional Definition of Done

The milestone is not complete until a user can also:

1. define Jira-style typed fields for a Workflow;
2. display selected fields prominently on cards/list/ticket detail;
3. edit fields manually;
4. let an agent extract and update fields;
5. add notes and attachments;
6. receive an attachment automatically through an incoming event;
7. configure a human-gated state that agents cannot bypass;
8. inspect field changes and gate decisions in ticket history;
9. move a ticket between Workflows without losing identity/history;
10. create an Intake Workflow whose agent routes tickets to specialized Workflows;
11. map fields during cross-workflow transfer;
12. build a dashboard from ticket fields and filters;
13. define and view a funnel from historical workflow milestones;
14. measure time-in-state and conversion over a selected period.
