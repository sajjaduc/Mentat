# Mentat — Follow-Up Implementation Brief v3
## Universal Records and Workflow Participation

> This document supersedes the prior Object Types/Records briefs. The decisive change is: **Mentat has no special Ticket primitive or special Ticket Object Type. Workflows process Records of any Object Type.**

## Canonical ontology

```text
Object Type  = schema for a kind of thing
Record       = durable instance and knowledge
Workflow     = configurable process/state machine
WorkflowItem = a Record participating in a Workflow
File         = durable content/evidence
Event        = historical fact/activity
```

If users want Jira-like tickets, they define an Object Type called `Ticket`, `Task`, `Issue`, `Case`, or `Request`. Mentat's runtime treats it exactly like Business, Policy, Claim, Opportunity, Candidate, or any other Object Type.


# Mandatory Architectural Corrections to the Prior Brief

The sections below are normative and override any residual wording later in this document that implies Ticket is special.

## 1. No Ticket primitive

Do not create:
- a `tickets` domain table as a privileged work primitive;
- a hard-coded Ticket Object Type required by the runtime;
- Ticket-specific execution APIs;
- Ticket-specific analytics semantics;
- assumptions that a Workflow contains Tickets.

A board/list contains **WorkflowItems**, each pointing to a Record.

UI nouns come from the Workflow's configured Object Type:

```text
Policy Workflow     → Policies / New Policy
Claim Workflow      → Claims / New Claim
Task Workflow       → Tasks / New Task
Candidate Workflow  → Candidates / New Candidate
```

## 2. WorkflowItem owns process state

Record owns durable identity/data:

```text
fields
relationships
external IDs
Record notes
Record Files
history
```

WorkflowItem owns contextual work state:

```text
workflow
state
owner/team
Workflow field overlay values
AgentRuns
human gates
approvals
retries
transitions
work notes
work-specific Files
```

Never put `workflowId` or `stateId` on Record.

## 3. Multiple participation

One Record may have multiple active WorkflowItems:

```text
Policy POL-123
├── Policy Lifecycle / Active
├── Renewal / Quoting
└── Compliance Review / Pending
```

Workflows may constrain duplicate active participation for the same Record, but the platform model must support it.

## 4. Transfer vs add participation

These are distinct:

- **transfer**: a work participation moves; preserve lineage and create/activate destination WorkflowItem while closing/transferring source as configured.
- **add participation**: Record enters another Workflow while existing WorkflowItems remain active.

Never implement cross-Workflow movement by mutating `record.workflowId`.

## 5. Fields

Object Type defines durable base fields. Workflow defines contextual field overlays.

Example:

```text
Policy base:
Policy Number
Insured
Premium
Expiry Date

Renewal overlay:
Renewal Premium
Quoted Date
Renewal Outcome

Compliance overlay:
Review Status
PEP Result
Reviewer
```

Workflow contextual values survive completion/transfer for history and analytics.

Use one generalized typed-field engine for Object Type fields, Workflow overlays, and File contextual fields where practical.

## 6. Records and relationships

All domain objects are Records. Fields may reference Records and Records may have configurable typed relationships.

Keep domain relationships separate from work relationships:

```text
Business HAS_POLICY Policy       // Record relationship
WorkflowItem A BLOCKS Item B     // work relationship
```

## 7. Creation

Expose conceptually:

```text
records.create(...)
workflowItems.create(...)
```

Creating a Record does not inherently put it into a Workflow.

A UX/API convenience may atomically create both when a user clicks e.g. `New Claim`, but persistence/execution semantics remain distinct.

Agents and humans may create Records and WorkflowItems subject to policy, identity validation, permissions, and audit.

## 8. Files and notes

Files can link durably to Records and contextually to WorkflowItems.

Notes have two scopes:
- Record note = durable knowledge about the thing;
- WorkflowItem note = information about the particular process/work.

The first-class Files follow-up remains valid with this distinction.

## 9. Automation

Separate event families:

```text
record.created
record.updated
record.field.changed
record.relationship.created

workflow_item.created
workflow_item.state.entered
workflow_item.state.exited
workflow_item.completed
workflow_item.transferred
```

Scheduled automation can query Records and create WorkflowItems directly:

```text
Find active Policies expiring in 60 days
AND without an active Renewal WorkflowItem
→ create Renewal WorkflowItem for each Policy
```

No artificial Ticket Record is required.

## 10. Analytics

Unify analytics around:

```text
Records
Record Fields
Relationships
WorkflowItems
Workflow transitions
Events
```

Funnels derive from WorkflowItem transition history. Field charts aggregate Record/base or Workflow-overlay values. Cross-object analytics uses relationships.

## 11. Persistence direction

Conceptually target:

```text
object_types
records
field_definitions
record_field_values
workflow_field_definitions
workflow_record_field_values
record_relationship_definitions
record_relationships
record_external_ids
record_notes

workflows
workflow_items
workflow_states
workflow_transitions
workflow_item_relationships
workflow_item_notes

files
file_records
file_workflow_items

events
agent_runs
tool_calls
approvals
jobs
```

This is conceptual; reuse clean existing generalized infrastructure rather than mechanically creating every table.

## 12. Migration from current implementation

Before refactoring, inspect the actual current schema and create a supervisor-approved ADR/migration plan.

Any existing Ticket data maps to:

```text
ordinary Object Type (whatever current UX calls it)
+ Record
+ WorkflowItem
```

Map durable fields to Record; map state/owner/execution/work-context fields to WorkflowItem. Preserve IDs/external references where practical and preserve all audit history.

Do not retain runtime Ticket special-casing merely for migration convenience.

## 13. TDD additions

Tests must cover:
- arbitrary Object Type Workflow;
- no Ticket-specific runtime requirement;
- Record with zero/multiple WorkflowItems;
- transfer vs add-participation;
- state independence from Record;
- base + Workflow overlay fields;
- contextual field history after completion;
- Record vs WorkflowItem notes;
- Record vs WorkflowItem File links;
- domain vs work relationships;
- human/agent Record creation;
- human/agent WorkflowItem creation;
- scheduled Record query → WorkflowItem;
- funnels from WorkflowItem transitions;
- migration of existing work data/history;
- tenant isolation and permissions.

## 14. Definition of Done

This refactor is complete only when:
1. Mentat runtime has no special Ticket primitive.
2. A Workflow can process any Object Type.
3. Kanban/list cards are WorkflowItems backed by Records.
4. UI terminology derives from Object Type.
5. state/owner/execution live on WorkflowItem.
6. Records can participate in multiple Workflows.
7. transfer and add-participation are distinct.
8. base and Workflow fields resolve/history correctly.
9. Records, Files, notes and relationships preserve durable vs work-context semantics.
10. agents can create/manage Records and WorkflowItems under policy.
11. automation can create Workflow participation directly from Record queries/events.
12. dashboards/funnels use the unified Record + WorkflowItem model.
13. existing data/history migrates without Ticket runtime special-casing.
14. TDD, supervisor, security, E2E, and SQLite→PostgreSQL portability gates pass.

The invariant is:

> **Record describes what a thing is and what Mentat knows about it. WorkflowItem describes what is being done with that Record in one Workflow.**


# Retained Detailed Requirements From v2

# Mentat — Follow-Up Implementation Brief: Object Types, Records, Relationships, and Cross-Ticket Knowledge

## Purpose

This is a separate follow-up implementation brief for Mentat, intended for implementation after the core platform and first-class Files work are stable.

Add a new durable primitive:

> **Record = a durable thing the work is about.**

Mentat should distinguish:

- **Ticket** — work being performed
- **File** — durable content/evidence
- **Record** — durable domain object
- **Event** — historical fact/activity

Records must be generic. Examples include Business, Person, Policy, Claim, Vehicle, Property, Product, Contract, Account, Shipment, Supplier, Asset, or arbitrary user-defined concepts.

Do not hard-code Mentat around CRM companies or insurance.

## 1. Terminology

Use:

- **Object Type** = schema/definition, e.g. `Business`, `Policy`, `Vehicle`
- **Record** = instance, e.g. `ACME Pty Ltd`, `POL-123`, `1ABC23`

Object Types and Records belong to the **Workspace**, not individual Workflows. Multiple Workflows must operate on the same Record.

## 2. Object Type Definition

Users can define Object Types with:

- key/name/plural name
- description and display metadata
- primary display field
- secondary display fields
- typed fields
- identity/uniqueness rules
- relationship definitions
- configurable record layout
- permissions/policies where appropriate

Example:

```text
Object Type: Business
Primary: Business Name
Secondary: ABN

Fields:
Business Name
ABN
Industry
Website
Phone
Account Owner
Status
Annual Revenue
```

## 3. Record Fields

Reuse/generalize Mentat's existing field architecture where clean.

Support short/long text, number, currency, boolean, date/datetime, single/multi-select, URL, email, phone, user, team, Record reference, and advanced JSON/object where genuinely needed.

Do not bury all values in opaque JSON if that compromises validation, filtering, indexing, history, analytics, identity rules, or PostgreSQL portability.

All writes require typed validation, authorization, provenance, and history.

## 4. Record Reference Fields

Fields may reference other Records:

```text
Policy.insured  → Business
Policy.insurer  → Business
Vehicle.owner   → Business
Claim.policy    → Policy
Claim.claimant  → Person
```

Use real references with searchable/autocomplete UI, not duplicated strings.

## 5. Record Model

A Record contains approximately:

```text
id
workspaceId
objectTypeId
displayName/cache where useful
version
createdBy
createdAt
updatedAt
```

Typed values live in the field-value architecture. Use optimistic concurrency where humans/agents may race.

## 6. Ticket ↔ Record Relationships

Tickets can relate to multiple Records:

```text
Ticket #1827 — Renew ACME Motor Fleet

Business   ACME Pty Ltd
Policy     POL-382991
Fleet      ACME Fleet
Broker     John Smith
```

Many Tickets may reference the same Record, enabling cross-ticket aggregation.

Ticket Fields must also support `Record` type fields, e.g. `Customer → Business`, `Policy → Policy`.

## 7. File ↔ Record Relationships

First-class Files can relate to Records:

```text
policy_schedule.pdf
Business  → ACME Pty Ltd
Policy    → POL-001
Insurer   → Hollard
```

File extraction agents may resolve identifiers against Records and establish links subject to permissions/policies.

## 8. Record ↔ Record Relationships

Support relationships such as:

```text
Business ACME
├── HAS_POLICY → POL-001
├── OWNS → Vehicle ABC123
└── CONTACT → John Smith

Policy POL-001
├── INSURED → ACME
├── INSURER → Hollard
└── COVERS → Vehicle ABC123
```

Object Types define allowed relationships, inverse names, target types and practical cardinality constraints.

Do not introduce a graph database. Relational storage is sufficient.

## 9. Identity and Deduplication

Object Types need configurable identity rules.

Examples:

```text
Business: ABN
Policy: Policy Number + Insurer
Vehicle: VIN
Alternative Vehicle match: Registration + State
Person: Email where appropriate
```

Enforce deterministic uniqueness where valid. For fuzzy matching, surface candidates rather than silently merging.

Agents must not casually create duplicate Records where identity rules indicate an existing object.

## 10. External Identities

Records need first-class external IDs:

```text
ACME Pty Ltd
HubSpot Company     8329183
Salesforce Account  001...
Xero Contact        ...
Internal CRM        C-12881
```

Store integration/system + external ID with suitable workspace-level uniqueness. Webhooks should resolve Records through external IDs rather than repeated name matching.

## 11. Field Provenance

Retain complete Record field history.

Example:

```text
Employee Count
320 → 347
Changed by Company Enrichment Agent
Source: external company API
AgentRun: run_1827

347 → 341
Changed by Sarah
Reason: customer confirmed
```

Where useful record source, confidence, observed time, model/run, external system, and human actor.

Never overwrite provenance when current values change.

## 12. Record Notes

Humans and authorized agents can add notes directly to Records. This stores durable information that belongs to the Business/Policy/etc., rather than a single Ticket.

Notes participate in Record history/activity and follow context-selection rules before being exposed to agents.

## 13. Record Files

Record detail includes Files sourced from File↔Record relationships. Files need not remain attached to active Tickets to remain organizational knowledge.

## 14. Record Activity

Provide a unified activity stream assembled from the existing Mentat event/audit architecture, not a disconnected CRM activity subsystem.

Aggregate relevant:

- Record field changes
- relationship changes
- linked Ticket activity
- linked File activity
- notes
- agent actions
- appropriate external events

Example:

```text
14:22 Ticket #2031 created — Renewal Review
13:51 Policy premium changed $84,200 → $87,600
Yesterday renewal_schedule.pdf linked from email
Yesterday Underwriting Agent completed review
14 Sep Ticket #1982 completed
```

Support activity filters such as `All | Fields | Tickets | Files | Humans | Agents | Relationships`.

## 15. Record Detail UX

Build a generic renderer:

```text
Record Header
[Overview] [Activity] [Tickets] [Files] [Related] [History]
```

Do not hard-code a Company/CRM page.

Object Type configuration controls header fields, overview sections, field order, related-record sections, visibility/read-only behavior, and eventually key metric cards.

Start constrained; do not build an unrestricted page builder.

## 16. Derived Metrics

Design for configurable aggregate cards such as:

Business:
- Active Policies
- Open Tickets
- Claims YTD
- Annual Premium

Policy:
- Open Endorsements
- Linked Vehicles
- Claims Count
- Days to Expiry

Reuse dashboard/filter aggregation primitives rather than hard-coding metrics by Object Type.

## 17. Native Agent Record Tools

Expose controlled operations conceptually like:

```text
records.get
records.search
records.create
records.update
records.getFields
records.setFields
records.addNote
records.link
records.unlink
records.getRelated
records.getHistory
records.linkFile
records.linkTicket
```

Every mutation passes through authorization, schema validation, identity rules, relationship rules, and audit. Never expose arbitrary SQL.

## 18. Agent Resolution Pattern

Support:

```text
incoming event
→ extract ABN
→ search Business by ABN
→ existing Record found
→ link Ticket to Business
```

If none exists, apply identity/matching policy, then create or request human resolution before linking.

This must compose naturally with Intake/routing Workflows.

## 19. Permissions and Gates

Allow policies such as:

- agent may read/search Businesses
- agent may update selected fields
- agent may create Business only when ABN is present
- agent may link existing Policy
- agent may not merge Records
- creation of certain Object Types requires human approval

Enforcement belongs to Mentat, not model judgment.

## 20. Record Events and Automation

Support durable events such as:

```text
record.created
record.updated
record.field.changed
record.relationship.created
record.relationship.removed
```

These can trigger work:

```text
Policy.expiry_date changed
→ expiry <= 60 days
→ create Renewal Ticket
→ Renewals Workflow
```

Use existing event/job infrastructure.

## 21. Scheduled Record Queries

Cron/scheduled automation should query Records:

```text
Every morning:
Find Policies where
expiry_date <= +60 days
AND status = Active
AND no related open Renewal Ticket

For each:
create Renewal Ticket
link Policy
link insured Business
```

Compose this from Records + Relationships + Filters + Cron + Ticket Creation rather than custom code.

## 22. Filtering, Saved Views, and Search

Extend the structured filter AST to Records.

Support Object Type, Record fields, dates, owners, external IDs, relationship existence, and practical linked-ticket conditions.

Saved views may include:

- Policies Expiring Soon
- High-Risk Businesses
- Vehicles Missing VIN
- Active Customers

Search prioritizes primary/secondary display fields, exact identity fields, external IDs, structured filters, and useful textual matching.

Keep future PostgreSQL search improvements behind clean interfaces.

## 23. Dashboards and Analytics

Extend dashboard data sources to:

```text
Tickets
Files
Records
```

Examples:

- Businesses by Industry/Owner
- Policies expiring in 30/60/90 days
- Premium by Product/Insurer
- Businesses with expiring Policies and no open Renewal Ticket
- Policies with open Claims

Reuse the existing dashboard/filter architecture. Do not build a separate Record analytics engine.

## 24. Cross-Object Queries

Design query/service boundaries for relationship-aware questions such as:

```text
Businesses
WHERE related Policy.expiry_date < +60d
AND no related open Renewal Ticket
```

or:

```text
Policies
WHERE insurer = X
AND related Claims count > 2
```

V1 may support a constrained subset, but the schema must preserve this capability. Do not have LLMs generate arbitrary SQL.

## 25. Agent Context Assembly

Do not inject all Record data into every prompt.

Allow configuration such as:

```text
include primary linked Record fields
include selected related Record fields
include Record summary
include latest N Record notes
include selected related Records
allow retrieval on demand
```

Prefer concise key context plus explicit agent retrieval. Respect permissions.

## 26. Record Summaries

Optionally support versioned/auditable generated Record summaries. Generated summaries are convenience/context, never authoritative structured truth.

## 27. Duplicate Resolution and Future Merge

Design relationships/IDs so controlled Record merge is possible later.

A future merge must reconcile fields, external IDs, Ticket links, File links, Record relationships, notes, and history.

Initial implementation may detect duplicates and require human resolution without implementing merge.

Agents must not autonomously perform destructive merges in V1.

## 28. Archival and Deletion

Prefer archive/soft lifecycle semantics for Records with historical relationships.

Deleting/archive actions must preserve historical Ticket/File meaning and audit. Define explicit behavior for active references and external identities.

## 29. Suggested Persistence Concepts

Exact schema is an implementation decision, but explicitly account for concepts equivalent to:

```text
object_types
object_type_fields / generalized field definitions
records
record_field_values
record_relationship_definitions
record_relationships
record_external_ids
record_notes
ticket_records
file_records
record_layouts
```

Reuse existing generalized fields, audit, filter, and relationship infrastructure where clean.

Preserve tenant isolation, typed values, history, provenance, analytics, and SQLite→PostgreSQL portability.

## 30. TDD Requirements

Write tests first for:

- Object Type creation/schema validation
- typed Record fields
- Record reference fields
- deterministic identity uniqueness
- compound identity
- fuzzy candidate behavior without silent merge
- external-ID uniqueness/resolution
- Record field history/provenance
- Ticket↔Record many-to-many
- File↔Record many-to-many
- Record↔Record relationships/inverse navigation
- relationship constraints
- Record notes
- unified Record activity
- agent Record permissions
- agent create/update/link
- Intake resolution by identity
- Record-triggered Ticket creation
- scheduled Record query → Ticket creation
- Record filters/saved views
- relationship-aware query behavior
- dashboard aggregations
- tenant isolation
- optimistic concurrency
- archival semantics

Every bug fix requires a reproducing test.

## 31. Worktrees, Subagents, and Supervisor

Continue the existing Mentat worktree/subagent model.

Suggested bounded workstreams:

```text
agent/object-types
agent/record-domain
agent/record-relationships
agent/record-search
agent/record-agents
agent/record-ui
agent/record-automation
agent/record-analytics
agent/e2e-records
```

The Supervisor must define shared contracts before parallel implementation, especially field integration, relationship model, filter/query AST extensions, activity projection, and native agent tools.

No subagent merges directly. Supervisor reviews architecture, tests, tenant isolation, permissions, history/provenance, SQLite/PostgreSQL portability, UX, and integration before commit/merge.

## 32. Recommended Delivery Sequence

### A — Object Type + Record Foundation
Object Types, generalized fields, Records, validation, CRUD, history, identity rules.

### B — Relationships
Ticket↔Record, File↔Record, Record↔Record, relationship definitions, external IDs.

### C — Record UX
Object Type configuration, Record list/search/detail, layouts, notes, Files/Tickets/Related tabs, activity.

### D — Native Agent Capabilities
Search/get/create/update/link/note tools, permissions, identity resolution, Intake patterns.

### E — Automation
Record events, field-change triggers, scheduled Record queries and Ticket creation.

### F — Filtering and Analytics
Saved Record views, relationship-aware filters, Record dashboard sources and derived metric cards.

### G — Hardening
Concurrency, duplicate detection, archival, tenant/security review, performance, E2E, PostgreSQL portability.

## 33. Definition of Done

This follow-up milestone is complete when a user can:

1. define arbitrary Object Types;
2. define typed fields and identity rules;
3. create/edit Records;
4. define Record-reference fields;
5. link the same Record across many Tickets;
6. link Files to Records;
7. define and navigate Record↔Record relationships;
8. resolve Records by deterministic external/identity IDs;
9. inspect complete field provenance/history;
10. add Record notes;
11. view aggregated Record activity across Tickets, Files, agents and humans;
12. configure a useful generic Record detail layout;
13. search/filter Records and save views;
14. let authorized agents find/create/update/link Records;
15. prevent unauthorized/duplicate agent creation;
16. create Tickets from Record events/scheduled queries;
17. build dashboards from Record fields/relationships;
18. perform practical cross-object filtering;
19. archive Records without destroying historical meaning;
20. pass TDD, supervisor, security, E2E, and portability gates.

The resulting architecture should make Mentat a coherent operational knowledge system:

```text
Records = durable things we know about
Tickets = work performed about those things
Files   = durable evidence/content
Events  = history of what happened
Agents/Humans = actors operating across all of them
```

Keep this model generic, relational, inspectable, and composable. Avoid domain-specific hard-coding and avoid introducing graph/database infrastructure that is unnecessary for the required behavior.


---

# SUPERSEDING ARCHITECTURAL UPDATE — Ticket as Record + WorkflowItem

> **This section supersedes any earlier parts of this document that model Ticket as a parallel durable domain object. Implement the architecture below.**

## A. Fundamental Model

Ticket is a specialized use of the universal **Record** primitive.

More generally:

> **A Workflow processes Records of any configured Object Type.**

Use these distinctions:

```text
Record       = durable identity, fields, relationships, notes, Files and knowledge
WorkflowItem = a Record's participation in a Workflow/state machine
File         = durable content/evidence
Event        = historical fact/activity
```

The UI may continue to call a WorkflowItem a **Ticket** when the Workflow processes the user-defined generic work Object Type.

Do not collapse workflow execution state into Record merely because Ticket is now Record-backed.

## B. Unified Architecture

```text
                         OBJECT TYPES
                              │
                              ▼
                            RECORDS
                  ┌───────────┼───────────┐
                  │           │           │
               Business     Policy      Ticket
                  │           │           │
                  └───────────┼───────────┘
                              │
                        RELATIONSHIPS
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
               FILES                   WORKFLOWS
                                          │
                                    Workflow Items
                                          │
                                    State Machine
                                          │
                               ┌──────────┴──────────┐
                               ▼                     ▼
                             Humans                Agents
```

Records hold durable knowledge. WorkflowItems hold work/execution context.

## C. Generic Work Object Types

Ship a user-defined generic work Object Type with minimal base fields such as:

```text
Title
Description
Priority
```

Do **not** put workflow, state, owner, approvals, retries, current agent, or execution status on the Ticket Record itself. Those belong to WorkflowItem.

Basic users should still experience ordinary "Tickets" and Kanban workflows without needing to understand the underlying abstraction.

## D. Workflow Processes an Object Type

Every Workflow specifies an Object Type:

```text
General Intake       → Ticket
Sales Pipeline       → Opportunity
Policy Renewal       → Policy
Claims Processing    → Claim
Recruitment          → Candidate
```

Do not bake `ticketId` assumptions into Workflow/execution code. Use `recordId` + `workflowItemId`.

This allows domain Records to participate directly where appropriate instead of always manufacturing a separate Ticket.

## E. WorkflowItem

Introduce a first-class internal/domain primitive approximately equivalent to:

```text
id
workspaceId
workflowId
recordId
stateId
ownerUserId?
ownerTeamId?
version
enteredAt
createdAt
updatedAt
completedAt?
```

WorkflowItem owns/relates to:

- current state;
- ownership/accountability;
- state-entry execution;
- human gates;
- approvals;
- AgentRuns;
- transition history;
- Workflow-specific field context;
- work-specific notes;
- work-specific File relationships;
- retry/failure/execution metadata.

State must never be stored as an intrinsic Record field.

## F. Multiple Workflow Participation

A Record may participate in zero, one, or multiple Workflows simultaneously.

Example:

```text
Policy POL-123
├── Policy Lifecycle / Active
└── Renewal / Quoting
```

A Workflow may configure whether more than one active WorkflowItem for the same Record is permitted.

Do not assume a Record has exactly one current Workflow.

## G. Transfer vs Additional Participation

Distinguish:

### Transfer
The same work concept moves from one Workflow to another. Preserve Record identity and lineage; source WorkflowItem becomes transferred/completed and destination WorkflowItem is created.

### Add Participation
The Record legitimately participates in another Workflow without ending the first.

Example:

```text
Policy remains in Policy Lifecycle
+
Policy enters Renewal Workflow
```

Make these separate operations in services/native tools. Do not overload a single ambiguous `workflowId` mutation.

## H. Workflow Field Overlay

Object Type defines base fields; Workflow may add contextual fields.

Example:

```text
Ticket base:
Title
Description
Priority

Underwriting overlay:
Business
Policy
Premium
Risk Category
Effective Date
```

Effective schema clearly shows provenance:

```text
Title          BASE: Ticket
Priority       BASE: Ticket
Business       WORKFLOW: Underwriting
Premium        WORKFLOW: Underwriting
```

Workflow-specific values remain historically available after the Record leaves that Workflow.

## I. Unified Field Engine

Avoid independent Ticket/Record/File field engines.

Generalize one typed-field infrastructure providing:

- definitions/types;
- validation/options;
- required/default behavior;
- permissions;
- provenance/history;
- filtering/indexing;
- analytics metadata;
- display configuration.

Apply it to Object Type base fields, Workflow overlays, and File contextual fields, while allowing storage differences where semantics genuinely differ.

## J. Record References

Fields can reference Records:

```text
Ticket.Customer   → Business
Ticket.Policy     → Policy
Policy.Insured    → Business
Vehicle.Owner     → Business
Claim.Policy      → Policy
```

Use real IDs/relationships with searchable pickers and controlled agent resolution, never duplicated display strings as identity.

## K. Work Relationships vs Record Relationships

Keep separate concepts:

```text
Record Relationship:
Business HAS_POLICY Policy

WorkflowItem Relationship:
Work item A BLOCKS work item B
```

WorkflowItems may support `parent`, `child`, `related`, `duplicate`, `blocks`, `blocked_by`.

Do not confuse domain relationships with work dependencies.

## L. Agent-Created Records and Work

Expose distinct controlled operations:

```text
records.create(...)
workflowItems.create(...)
```

`records.create` creates durable domain data.

`workflowItems.create` puts an existing/new Record into a Workflow.

For Ticket-based workflows, provide a convenience operation that creates a Ticket Record and its WorkflowItem atomically.

Example:

```text
Incoming email
→ Intake Ticket Record + WorkflowItem
→ Analysis Agent
→ creates 3 child Ticket Records
→ creates WorkflowItems in specialist Workflows
```

## M. Files

The separate Files follow-up remains valid with these refinements:

- File↔Record is the durable domain association.
- File↔WorkflowItem is optional work-specific context.
- extraction can resolve/create/link Records;
- Workflow-specific File fields use the generalized field engine;
- file processing may create WorkflowItems where policy allows;
- BlobStore/Local/GCS architecture is unchanged.

## N. Notes

Support both:

### Record Note
Durable knowledge about the underlying thing.

### WorkflowItem Note
Information specific to a particular piece of work.

Example:

```text
Record note:
"ACME prefers quarterly billing."

WorkflowItem note:
"Waiting for broker to confirm vehicle count."
```

Both are audited. Context assembly must distinguish them.

## O. Activity and History

Use one event/audit foundation with different projections.

Record Activity aggregates:

- base field changes;
- Record relationships;
- external IDs;
- Record notes;
- File links;
- relevant WorkflowItem activity.

WorkflowItem Activity emphasizes:

- state transitions;
- owners;
- Workflow fields;
- agent/tool activity;
- approvals;
- human gates;
- work notes;
- retries/failures;
- work-context Files.

Do not create parallel event systems.

## P. UX

### Record detail

```text
[Overview] [Activity] [Work] [Files] [Related] [History]
```

`Work` lists WorkflowItems involving the Record.

### WorkflowItem / Ticket detail

For Ticket-based workflows continue familiar UX:

```text
[Overview] [Agent Work] [Activity] [Files]
```

Overview combines base Record fields, Workflow overlay fields, state/owner, related Records, relevant notes and Files.

### Kanban

Kanban cards represent WorkflowItems. Columns represent Workflow states. Cards display selected fields from the effective Record schema.

Moving a card changes WorkflowItem state, never Record identity.

## Q. Native Agent APIs

Refactor toward:

```text
records.get
records.search
records.create
records.update
records.getFields
records.setFields
records.addNote
records.link
records.unlink
records.getRelated
records.getHistory
records.linkFile

workflowItems.get
workflowItems.create
workflowItems.search
workflowItems.getFields
workflowItems.setFields
workflowItems.addNote
workflowItems.requestTransition
workflowItems.transfer
workflowItems.addParticipation
workflowItems.linkFile
```

Ticket-named aliases may be exposed in Ticket workflows for model/user ergonomics.

All mutations pass through authorization, validation, workflow policy and audit.

## R. Automation

Separate Record events from WorkflowItem events.

Record:

```text
record.created
record.updated
record.field.changed
record.relationship.created
```

WorkflowItem:

```text
workflow_item.created
workflow_item.state.entered
workflow_item.state.exited
workflow_item.completed
workflow_item.transferred
workflow_item.owner.changed
```

Scheduled automation can query Records and create Workflow participation:

```text
Every morning:
Find active Policies expiring within 60 days
AND without an active Renewal WorkflowItem
→ create Renewal WorkflowItem for each Policy
```

No extra Ticket Record is required unless the business process wants an episodic work object.

## S. When to Use Ticket vs Domain Record

Use a domain Record directly when the Workflow represents lifecycle/process state of the thing:

```text
Opportunity → Sales Pipeline
Candidate → Recruitment
Claim → Claims Processing
Policy → Renewal
```

Use a Ticket Record when the work is episodic/separate:

```text
Investigate policy discrepancy
Respond to customer request
Review business documentation
One-off endorsement task
```

Then link the Ticket Record to the relevant domain Records.

Support both patterns.

## T. Filters, Dashboards, and Funnels

Unify analytics around:

```text
Records
Record Fields
Relationships
WorkflowItems
Workflow State Transitions
Events
```

A funnel uses WorkflowItem transition history.

A field chart uses Record/effective Workflow fields.

Cross-object analytics uses relationships.

Examples:

```text
Policies expiring by month
Premium by insurer
Open work by Business
Policy Renewal funnel
Businesses with expiring Policies and no Renewal WorkflowItem
Average time Policies spend in Renewal/Quoted
```

Do not maintain separate Ticket analytics and Record analytics engines.

## U. Persistence Direction

Refactor conceptually toward:

```text
object_types
records

field_definitions
record_field_values
workflow_field_definitions
workflow_record_field_values

record_relationship_definitions
record_relationships
record_external_ids
record_notes

workflows
workflow_items
workflow_states
workflow_transitions
workflow_item_relationships
workflow_item_notes

files
file_records
file_workflow_items

events
agent_runs
tool_calls
approvals
jobs
```

This is conceptual, not a mandate to mechanically create every table. Reuse existing generalized infrastructure where clean.

## V. Migration From Existing Ticket Implementation

Because this work follows the initial Mentat build, inspect the actual current schema before changing anything.

Create and supervisor-review an explicit migration plan first.

Target conceptual mapping:

```text
Existing Ticket
→ Ticket Object Type Record
+ WorkflowItem
```

Typical mapping:

```text
title/description/priority → Ticket Record fields
state                      → WorkflowItem state
owner                      → WorkflowItem owner
workflow                   → WorkflowItem workflow
custom fields              → base/Workflow field values
agent runs                 → WorkflowItem execution
work notes                 → WorkflowItem notes
files                      → Record and/or WorkflowItem relationships
events                     → preserved/repointed audit history
```

Preserve stable IDs/external references where practical. Never discard historical events to simplify migration.

Add migration tests with representative existing data.

## W. Backward-Compatible Product Experience

The architectural improvement must not make Mentat harder for normal users.

Default creation should remain simple:

```text
New Workflow
→ General Work
→ Processes: Ticket
```

Users immediately receive normal Ticket/Kanban behavior.

Advanced users may select another Object Type.

Do not expose `WorkflowItem` jargon unnecessarily in basic UI.

## X. Additional TDD Requirements

Add tests for:

- Ticket Record + WorkflowItem creation;
- arbitrary Object Type Workflow;
- Record in multiple Workflows;
- one-active-item constraint where configured;
- transfer vs add-participation semantics;
- base + Workflow field overlay resolution;
- preservation of old Workflow field values;
- WorkflowItem state independent from Record;
- Record note vs WorkflowItem note;
- Record File vs WorkflowItem File;
- Record relationship vs work relationship;
- agent Record creation;
- agent WorkflowItem creation;
- atomic Ticket convenience creation;
- scheduled Record query → WorkflowItem;
- funnels from WorkflowItem transitions;
- migration of existing Ticket data/history;
- backward-compatible Ticket APIs/UI;
- workspace isolation throughout.

Every regression discovered during refactor gets a reproducing test first.

## Y. Recommended Implementation Sequence

1. **Architecture/migration design** — inspect existing implementation; supervisor approves ADR and migration plan.
2. **Record/WorkflowItem foundation** — introduce abstractions without breaking existing Ticket UX.
3. **Migrate Ticket** — built-in Ticket Object Type + Record + WorkflowItem mapping.
4. **Field unification** — base fields and Workflow overlays.
5. **Generalized Workflow processing** — arbitrary Object Types.
6. **Relationships/notes/files** — distinguish Record vs WorkflowItem contexts.
7. **Agent APIs** — Records and WorkflowItems.
8. **Automation** — Record events, WorkflowItem events, scheduled participation.
9. **Analytics** — unified filters, dashboards, funnels.
10. **Hardening** — migration compatibility, concurrency, permissions, E2E, PostgreSQL portability.

Use separate worktrees/subagents for bounded areas, but require supervisor review before each integration.

## Z. Updated Definition of Done

This architectural update is complete when:

1. There is no special Ticket primitive; generic work uses an ordinary user/system-defined Object Type such as Task, Request, Case, or Ticket.
2. Ticket-based Workflows still feel unchanged/simple to users.
3. WorkflowItem contains state/owner/execution semantics.
4. a Workflow can process a non-Ticket Object Type.
5. one Record can participate in multiple Workflows.
6. transfer and additional participation are distinct.
7. Object Type base fields and Workflow overlays resolve correctly.
8. contextual field history survives Workflow changes.
9. Record and WorkflowItem notes/files are distinguishable.
10. Record and work relationships are distinguishable.
11. agents can create Records and WorkflowItems under policy.
12. scheduled Record queries can create work.
13. funnels derive from WorkflowItem transitions.
14. dashboards/querying operate over the unified model.
15. existing Ticket history/data migrates safely.
16. TDD, supervisor, security, E2E and SQLite→PostgreSQL portability gates pass.

The architectural rule to preserve is:

> **Unify the data model, but never erase the semantic distinction between durable knowledge and work being performed.**

Record stores what the thing **is and what Mentat knows about it**.

WorkflowItem stores **what is currently being done with it in a particular Workflow**.
