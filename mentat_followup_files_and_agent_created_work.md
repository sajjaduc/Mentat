# Mentat — Follow-Up Requirements: First-Class Files, Retrieval, and Agent-Created Work

## Purpose
This is a **follow-up implementation brief** for the Mentat agent after the current core build finishes. It extends, rather than replaces, the existing architecture and its requirements for workspaces, workflows, tickets, fields, audit, permissions, durable execution, TDD, worktrees/subagents, and supervisor review.

The main addition is to make **Files first-class durable domain objects**, not merely ticket attachments.

## 1. Core Model
Do not model `Ticket → attachment blob`. Model a reusable File backed by a Blob:

```text
Blob ← File
       ├── Workflow File Context(s)
       ├── Ticket Relationship(s)
       ├── Extracted Content
       ├── Summary
       ├── File Fields
       └── Processing History
```

A File may be referenced by multiple tickets, workflows, events, emails and agent runs.

## 2. Content-Addressed Storage
Hash every incoming file before expensive processing. Use SHA-256 over actual bytes.

```text
bytes → hash → known blob?
                 ├─ yes: reuse
                 └─ no: store
```

Filename/path/source ID is not content identity. Store blob metadata including workspace, content hash, size, MIME, storage provider/key and timestamps. Preserve tenant isolation.

## 3. Deduplication Semantics
Blob dedupe is not processing dedupe. The same bytes may need new processing because the parser, processor, model, prompt, workflow schema or field definitions changed.

Processing identity should conceptually include:

```text
contentHash + processorType + processorVersion + configuration/schemaVersion + modelVersion where relevant
```

Reuse results only when the full processing identity is compatible.

## 4. First-Class File
File contains/relates to identity, blob, original filename, MIME, size, generic metadata, summary, provenance, workflow contexts, ticket relationships, processing runs, extracted content and file-field values.

The same Blob may back multiple logical File records when distinct provenance requires it, while byte storage remains deduplicated.

## 5. BlobStore
Create a first-class abstraction:

```text
put()
get()
getStream()
exists()
delete()
getSignedUrl() // where supported
```

Initial implementations:
1. `LocalBlobStore`
2. `GCSBlobStore`

Do not store large arbitrary binaries in normal DB tables.


## 6. Local and GCS Storage
Local/self-hosted storage may use `./data/blobs/` with collision-safe/content-addressed keys.

Support Google Cloud Storage as a production BlobStore. Prefer Workspace-level configuration initially:

```text
Provider: Google Cloud Storage
Bucket: mentat-production
Credentials: Mentat secret reference
Prefix: workspaces/{workspaceId}/
```

Do not initially make physical storage provider a Workflow override; cross-workflow movement becomes unnecessarily complex. Logical Files belong to the Workspace and Workflows reference/contextualize them. GCS credentials use the existing secret subsystem and never enter model context.

## 7. Provenance
Every File retains provenance: human upload, incoming email/message attachment, agent run, HTTP connector, webhook, etc. Preserve source references, actor/run/tool identifiers and timestamps even when the underlying Blob was deduplicated.

## 8. First-Class File Fields
Implement Jira-style **File Fields**, analogous to Ticket Fields. Examples: Document Type, Document Date, Policy Number, Insured, Premium, Expiry Date, Issuer, Invoice Number, Customer, Jurisdiction.

Reuse/generalize the Ticket Field framework where clean. Support typed fields such as text, number, currency, boolean, date/datetime, selects, URL/email, user/team where meaningful and advanced JSON/object.

## 9. Generic vs Workflow Metadata
Universal properties belong to File: filename, MIME, size, hash, page count, detected language, generic extraction metadata.

Workflow-specific interpretation belongs to a Workflow↔File context. The same File may be a `Policy Schedule` in Underwriting and `Evidence` in Compliance without one interpretation overwriting the other.

## 10. Durable Processing Pipeline
Use existing Mentat Jobs:

```text
receive → hash/dedupe → identify MIME → extract content
→ generic metadata → summary → workflow field extraction
→ persist provenance/results → index for retrieval
```

Stages must be observable, retryable where appropriate, versioned, auditable, idempotent where possible and independently reusable/cacheable. Do not bind processing to synchronous upload requests.

## 11. Extracted Content and Summaries
Persist extracted content separately from raw bytes. Establish processor contracts by MIME type and implement a useful initial set rather than every format.

Summary results record processor/prompt version, provider/model where relevant, timestamp and source processing identity. Do not regenerate compatible results unnecessarily. Preserve generated history if humans can edit the current summary.

## 12. File Field Extraction
Within a Workflow context, processing may extract configured File Fields. Persist value, processor/actor, model/version, confidence when available, source page/span where available and timestamp.

Humans and authorized agents may correct values. Retain before/after history and provenance.


## 13. File History and Relationships
History records ingestion, dedupe/reuse, workflow/ticket association, processing, extraction, summary, field changes, agent use, relationship changes and storage migration where relevant.

Implement explicit many-to-many `Ticket ↔ File` relationships. A single File can support multiple Tickets. Removing/closing one Ticket must not destroy shared content.

## 14. Incoming Attachments
Triggers/connectors can create Files automatically:

```text
incoming email → ticket → attachment bytes → file ingestion
→ blob dedupe → Ticket↔File link → processing
```

UI must visibly preserve that an attachment came from the originating event/email.

## 15. First-Class Files UI
Add `Workflow → Files` with search, filters, field columns, summary preview, processing status, provenance, linked tickets and upload.

File detail:

```text
Overview | Fields | Content | Relationships | Processing | History
```

This is a proper Files experience, not only an attachments tab.

## 16. Retrieval
Support structured retrieval over File Fields and metadata, e.g.:

```text
Document Type = Invoice
AND Customer = ACME
AND Document Date > 2026-01-01
```

Support textual search over extracted content. Prioritize structured filters, metadata and exact/full-text search initially.

Keep retrieval interfaces extensible for later PostgreSQL FTS, pgvector, semantic or hybrid search. Do not require embeddings/vector infrastructure in this milestone.

## 17. Native Agent File Tools
Expose controlled capabilities conceptually like:

```text
files.get
files.list
files.find
files.search
files.read
files.getSummary
files.getFields
files.setFields
files.linkToTicket
```

Agents never receive storage credentials. Enforce workspace permissions and audit.

## 18. Context Assembly
Do not automatically inject all files, notes or full extracted documents into every prompt. Agent/Skill/state configuration controls context, e.g. ticket fields, latest notes, linked-file summaries, selected File Fields, with full content retrieved on demand. Optimize token use, latency and data minimization.


## 19. Human- and Agent-Created Tickets
Ticket creation is a native operation available to humans, agents, external events, APIs and workflow/system actions.

Expose controlled `tickets.create()` behavior supporting target Workflow, initial/default state, title/description, fields, owner/team, labels, notes, linked Files, originating-ticket relationship and provenance.

Apply the same validation, authorization and audit semantics regardless of creator.

## 20. Ticket Relationships
Add first-class relationships:

```text
parent
child
related
duplicate
blocks
blocked_by
```

Example:

```text
Inbound Request #102
├── Claim #103
├── Claim #104
└── Claim #105
```

Every relationship is auditable.

This enables agents to decompose work:

```text
email → Intake Ticket → Analysis Agent
→ identifies 3 independent tasks
→ creates 3 child Tickets
→ routes children to relevant Workflows
```

Use cross-workflow **transfer** when the same work item changes Workflow; create child/related Tickets when new independent work items are created.

## 21. Storage vs Database Responsibility
Keep raw bytes and application knowledge separate:

```text
Database:
  File identity, blob references, File Fields, summaries,
  extracted-content metadata, relationships, processing runs, history

BlobStore:
  raw bytes
```

PostgreSQL later remains the metadata/state system of record; Local/GCS/etc. stores raw bytes.

## 22. Persistence Concepts
Account for concepts equivalent to:

```text
blobs
files
file_sources
workflow_files
file_field_definitions (or generalized fields)
workflow_file_fields
file_field_values
file_processing_runs
file_extracted_content
file_summaries
ticket_files
ticket_relationships
```

Exact decomposition is an implementation decision. Preserve tenant isolation, typed fields, provenance, filtering, processing versioning, history and PostgreSQL portability.


## 23. Security and Lifecycle
Enforce/test workspace isolation, authorized reads/downloads, signed URL expiration where used, no cross-workspace hash leakage, safe filenames, MIME/content validation, file-size limits, local path-traversal prevention, secret redaction and safe deletion.

Hash equality must never reveal that another tenant possesses a file.

Define explicit semantics for unlinking from Ticket, removing Workflow context, deleting logical File, deleting Blob and retention. Physically delete a Blob only when no retained reference requires it and policy permits. Audit destructive actions.

## 24. TDD Requirements
Write tests first for:
- deterministic hashing;
- duplicate blob ingestion;
- same blob from multiple sources;
- workspace isolation during dedupe;
- processing-version/cache identity;
- workflow-specific processing of same File;
- LocalBlobStore contract;
- GCSBlobStore contract via test double/emulator strategy;
- provenance;
- File↔Ticket many-to-many;
- incoming attachment ingestion;
- File Field validation/extraction/correction history;
- structured and content retrieval;
- permission enforcement;
- native agent file tools;
- context-selection rules;
- human ticket creation;
- agent ticket creation;
- ticket relationships;
- agent-created child Tickets in another Workflow;
- safe Blob deletion/shared-reference lifecycle.

Every bug fix requires a reproducing test.

## 25. Worktrees, Subagents and Supervisor
Continue the existing process. Suggested workstreams:

```text
agent/blob-store
agent/file-domain
agent/file-processing
agent/file-fields
agent/file-retrieval
agent/file-ui
agent/ticket-creation
agent/e2e-files
```

Supervisor defines shared interfaces before parallel work, especially BlobStore, FileRepository, processor contracts, field integration, retrieval and ticket/file relationships.

No subagent merges directly. Supervisor reviews architecture, tests, security, tenant isolation, storage lifecycle, SQLite/PostgreSQL portability, UX and integration compatibility before integration.

## 26. Delivery Sequence
### A — File/Blob Foundation
BlobStore, LocalBlobStore, hashing/dedupe, File domain, provenance, Ticket↔File.

### B — GCS
GCSBlobStore, workspace storage configuration, secrets and contract tests.

### C — Processing
Durable file-processing jobs, processor contracts, extracted content, metadata and processing-result version/reuse semantics.

### D — File Fields and Summaries
Workflow File Fields, extraction, summaries, human correction and history.

### E — Retrieval
Structured filters, metadata search and extracted-content text search.

### F — File UX
Workflow Files, file detail, processing/history, field editing, linked Tickets, provenance and polished upload/refresh states.

### G — Agent File Capabilities
Native retrieval/read/field/link tools and context-selection policies.

### H — Agent-Created Tickets
Controlled ticket creation, Ticket relationships and cross-Workflow child-ticket patterns.

### I — Hardening
Security, dedupe, retention/deletion, concurrency, GCS/local parity, E2E and PostgreSQL portability review.

## 27. Definition of Done
This follow-up milestone is complete when a user can:

1. upload a File and have Mentat hash/store it;
2. ingest the same bytes again without duplicate Blob storage;
3. preserve distinct provenance for repeated appearances;
4. switch/configure Local or GCS storage at Workspace level;
5. automatically ingest an attachment from an incoming event;
6. process a File durably and inspect processing history;
7. extract/reuse content and summary with version-aware processing;
8. define Workflow File Fields and extract them automatically;
9. manually correct File Fields with full history;
10. browse/search/filter Files as first-class objects;
11. search extracted file content;
12. link one File to multiple Tickets;
13. let agents retrieve/read Files through controlled native tools;
14. control which file context enters an agent prompt;
15. create Tickets manually;
16. allow an authorized agent to create a Ticket;
17. create parent/child/related Ticket relationships;
18. let an agent decompose one Intake Ticket into child Tickets routed to other Workflows;
19. delete/unlink Files safely without corrupting shared references;
20. pass the full TDD, security, supervisor and E2E review gates.

Prefer a simple, inspectable implementation that composes with existing Mentat primitives. Do not turn Mentat into a general-purpose document-management system; build the file capabilities necessary for durable agent work, retrieval, provenance and reuse.
