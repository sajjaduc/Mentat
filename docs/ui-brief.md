# UI workstream brief

Read `docs/architecture.md` and `docs/workstream-brief.md` first for product context
and conventions. This document is the UI-specific contract.

## What already exists (do not modify)

```text
src/lib/ui/api.ts              typed API client: api.get/post/put/patch/delete/upload,
                               ApiError (code/status/details/retryable/actionable),
                               mutateOptimistic + describeApiError
src/lib/ui/toast.ts            pushToast / dismissToast / clearToasts
src/lib/ui/primitives/*        Button Card Badge Input Select Textarea Avatar Skeleton
                               EmptyState ErrorState Drawer Modal Tabs Toasts (+ types)
src/lib/ui/shell/CommandPalette.svelte
src/routes/+layout.svelte                     global styles + toast layer
src/routes/(app)/+layout.server.ts            identity, workspace, nav counts
src/routes/(app)/+layout.svelte               sidebar shell, workspace switcher, ⌘K
src/routes/login/**                           sign in / first-run account creation
```

Primitives are the only styling vocabulary you need. Prefer them over new CSS; if
you genuinely need a new primitive, add it under `src/lib/ui/primitives/` with the
same shape (typed `$props()`, tokens, focus-visible, reduced-motion safe) and export
it from `index.ts`. **If another workstream might also need it, keep it in your own
namespace instead** — see ownership below.

## Design system rules

- Tokens only: `var(--color-canvas|surface|surface-muted|border-subtle|border-strong|ink|ink-muted|ink-subtle|accent|accent-soft|positive|caution|danger)`,
  `var(--radius-*)`, `var(--shadow-card|raised|overlay)`. Never hard-code a hex value.
- Type scale: `text-sm` for body, `text-xs` for secondary, `text-[11px]` for meta,
  `text-base`/`text-lg` for titles. `font-mono` for ids, keys, JSON and templates.
- Spacing: 4/8/12/16/24px steps. Cards `p-4`; page padding `p-6` (desktop) / `p-4`.
- Motion: `animate-fade-in`, `animate-pop-in`, `animate-pulse-ring` only, and only to
  communicate causality (a card moving, a run starting, a drawer opening).
- Skeletons instead of layout jumps. EmptyState that explains the next action.
  ErrorState with a retry. Optimistic updates with rollback for board moves,
  field edits, approvals and label changes.
- Keyboard: every action reachable without a mouse; `Esc` closes overlays; visible
  focus rings come free from `app.css` — do not remove them.
- Accessibility: real `<button>`/`<a>`/`<label>`, `aria-*` where needed, no
  click-only divs, honour reduced motion.

## Data loading pattern

Server-render the shell (already done). Pages fetch their own data in the browser:

```svelte
<script lang="ts">
  import { api, describeApiError } from '$ui/api';
  import { pushToast } from '$ui/toast';
  let data = $state<Thing[] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  async function load() {
    loading = true; error = null;
    try { data = (await api.get<{ things: Thing[] }>('/things')).things; }
    catch (failure) { error = describeApiError(failure); }
    finally { loading = false; }
  }
  load();
</script>
```

Rules: always render loading → error → empty → content. Never a full-page reload:
mutations update local state and only re-fetch what changed. Use
`mutateOptimistic` for anything a user perceives as instant.

## API surface

All routes are same-origin under `/api`. Errors are `{ error: { code, message, details, requestId } }`.

### Auth / workspace
```
GET    /api/health
POST   /api/auth/register {email,name,password}      POST /api/auth/login {email,password}
POST   /api/auth/logout                              GET  /api/auth/me
POST   /api/auth/switch-workspace {workspaceId}
GET    /api/workspaces                     POST /api/workspaces {name,description}
GET    /api/workspaces/:id                 PATCH /api/workspaces/:id {name,description,settings}
GET    /api/workspaces/:id/members         POST /api/workspaces/:id/members {email,name,role,title}
PATCH  /api/workspaces/:id/members/:userId {role,status,title}
DELETE /api/workspaces/:id/members/:userId
GET    /api/teams                          POST /api/teams {name,description,color,memberIds}
PUT    /api/teams/:id/members {userIds}
```

### Workflows
```
GET    /api/workflow-templates
GET    /api/workflows?includeArchived=   POST /api/workflows {name,key,template,description,icon,color}
GET    /api/workflows/:id                PATCH /api/workflows/:id   DELETE /api/workflows/:id
GET    /api/workflows/:id/board?filter=&search=&limit=
GET    /api/workflows/:id/states         POST /api/workflows/:id/states
PATCH  /api/states/:id                   DELETE /api/states/:id
PUT    /api/workflows/:id/states/order {stateIds}
GET    /api/workflows/:id/transitions    POST /api/workflows/:id/transitions
DELETE /api/transitions/:id              GET  /api/states/:id/transitions
GET    /api/fields?scope=ticket|file     POST /api/fields
PATCH  /api/fields/:id                   DELETE /api/fields/:id        GET /api/fields/:id/usage
GET    /api/workflows/:id/fields         PUT /api/workflows/:id/fields {fields:[...]}
GET    /api/workflows/:id/transfer-rules PUT /api/workflows/:id/transfer-rules
DELETE /api/transfer-rules/:id
GET    /api/config?workflowId=
```
State body: `{name,description,kind:'manual'|'agent'|'system'|'terminal',category,color,position,
isStart,isTerminal,agentId,autoExecute,maxAttempts,timeoutSeconds,failureStateId,
humanGate:{enabled,allowedTransitionIds,requiredFieldKeys,requiredComment,allowedRoles,allowedTeamIds,instructions},
config:{systemAction,context:{includeTitle,includeDescription,fieldKeys,includeRecentNotes,includeFileSummaries,
includeFileFields,includeFullFileContent,includeHistory,includeStateHistory},allowedToolKeys,wipLimit,slaSeconds}}`

### Tickets
```
GET    /api/tickets?workflowId=&filter=<json>&sort=<json>&limit=&cursor=&search=&stateIds=
POST   /api/tickets {workflowId,stateId?,title,description?,priority?,ownerUserId?,ownerTeamId?,
                     fields?,labelIds?,labelNames?,parentTicketId?,provenance?}
GET    /api/tickets/:id            → ticket, state, workflow, fields, labels, notes, relationships,
                                     files, runs, approvals, availableTransitions, humanGate,
                                     gateDecisions, historySummary
PATCH  /api/tickets/:id {title,description,priority,ownerUserId,ownerTeamId,dueAt,expectedVersion}
GET    /api/tickets/:id/fields     PUT /api/tickets/:id/fields {values}
GET    /api/tickets/:id/field-history
POST   /api/tickets/:id/notes {body}      PATCH /api/notes/:id {body}   DELETE /api/notes/:id
POST   /api/tickets/:id/transitions {transitionId|targetStateId,comment?,fieldValues?}
POST   /api/tickets/:id/transfer {targetWorkflowId,targetStateId?,reason?,fieldMappings?,approved?}
POST   /api/tickets/:id/transfer-preview {targetWorkflowId}
POST   /api/tickets/:id/relationships {toTicketId,type,note?}   DELETE /api/relationships/:id
POST   /api/tickets/:id/labels {labelIds?,labelNames?}          DELETE /api/tickets/:id/labels/:labelId
POST   /api/tickets/:id/files {fileId,relationship?,caption?}   DELETE /api/tickets/:id/files/:fileId
GET    /api/tickets/:id/runs       POST /api/tickets/:id/dispatch {stateId?,reason?,force?}
GET    /api/runs/:id               POST /api/runs/:id/cancel
GET    /api/tickets/:id/timeline?filter=all|human|agents|fields|states|tools|files&limit=&cursor=
GET    /api/tickets/:id/events?since=
GET    /api/my-work?limit=         → {assigned,waitingForMe,waitingForAgent,waitingForApproval,
                                      needsAttention,createdByMe}
GET    /api/search?q=&limit=       → {results:[{kind,id,key,title,subtitle,href}]}
GET    /api/labels                 POST /api/labels {name,color,description}
```

### Agents / skills / tools / providers / models
```
GET/POST /api/agents            GET/PATCH/DELETE /api/agents/:id     GET /api/agents/:id/versions
GET/POST /api/skills            GET/PATCH/DELETE /api/skills/:id
GET      /api/tools             → {native:[...], stored:[...]}
GET/POST /api/providers         POST /api/providers/suggest {type}
PATCH/DELETE /api/providers/:id
POST     /api/providers/:id/health        POST /api/providers/:id/refresh-models
GET/POST /api/models            PATCH/DELETE /api/models/:id
GET      /api/runs?limit=       → recent runs with agent_name and ticket_key
```
Agent body: `{name,description,instructions,workflowId,providerId,modelId,skillIds,toolIds,
outputSchema,executionConfig:{maxSteps,maxOutputTokens,temperature,topP,timeoutSeconds,
continueOnToolError,retryOnProviderError,requireApprovalForMutations},
permissions:{native:[],httpOperationIds:[],canTransferTickets,canCreateTickets,
canWriteWorkspaceState,canUploadFiles,writableFieldKeys:[]}}`

### HTTP platform / triggers
```
GET/POST /api/http/services     GET/PATCH/DELETE /api/http/services/:id
GET/POST /api/http/operations   GET/PATCH/DELETE /api/http/operations/:id
POST     /api/http/operations/:id/test {input,inferSchemaFromResponse}
POST     /api/http/operations/:id/invoke {input}
GET      /api/http/logs?serviceId=&operationId=&limit=
GET/POST /api/triggers          PATCH/DELETE /api/triggers/:id
POST     /api/triggers/:id/fire {input,idempotencyKey}   GET /api/triggers/:id/events
POST     /api/triggers/schedule/tick                     GET /api/triggers/:id/webhook-url
GET/PUT  /api/storage {provider,bucket,prefix,credentialsSecretId,localRoot,maxFileBytes}
```

### Files / data / analytics / ops
```
GET    /api/files?filename=&mimeType=&status=&workflowId=&ticketId=&content=&limit=&cursor=
POST   /api/files            (multipart: file, ticketId?, workflowId?, sourceType?)
GET    /api/files/:id        DELETE /api/files/:id
GET    /api/files/:id/content
GET    /api/files/:id/fields PUT /api/files/:id/fields {workflowId,values}
POST   /api/files/:id/process {workflowId,force}    POST /api/files/:id/unlink {ticketId}
POST   /api/files/:id/workflow-context {workflowId,contextLabel}
DELETE /api/files/:id/workflow-context/:workflowId  GET /api/files/search?q=
DELETE /api/blobs/:id
GET    /api/approvals?status=&ticketId=&mine=&limit=   → approvals + pendingCount
GET    /api/approvals/:id      POST /api/approvals/:id/decide {decision,comment,decisionData}
GET/POST /api/views            PATCH/DELETE /api/views/:id     GET /api/views/:id/apply
GET/POST /api/dashboards       GET/PATCH/DELETE /api/dashboards/:id
POST   /api/dashboards/:id/widgets   PATCH/DELETE /api/widgets/:id   POST /api/dashboards/:id/run
GET/POST /api/collections      GET/DELETE /api/collections/:id
GET/POST /api/collections/:id/records    PATCH/DELETE /api/records/:id
GET/PUT/DELETE /api/state      GET /api/state/value
GET/PUT/DELETE /api/cache      GET /api/cache/value
GET/POST /api/secrets          POST /api/secrets/:id/rotate {value}   DELETE /api/secrets/:id
GET/PUT  /api/environment      DELETE /api/environment/:id
GET/PUT  /api/overrides        DELETE /api/overrides/:id
GET      /api/jobs?status=&type=&ticketId=&limit=      GET /api/jobs/:id/attempts
GET      /api/audit?ticketId=&action=&limit=&cursor=
```

### Live events (SSE)
```
GET /api/events?runId=&ticketId=&since=<seq>
```
Replays from `since` then streams live. Event types: `run.queued run.started
run.output.delta run.reasoning.delta run.warning step.started step.completed tool.started
tool.completed tool.failed approval.requested approval.decided retry.scheduled
state.transition ticket.field.changed ticket.note.added ticket.file.attached
run.paused run.resumed run.completed run.failed run.cancelled ticket.updated
stream.ready`. Payload is `{seq,type,runId,ticketId,data,createdAt}`.

Use `EventSource` with `since` from the highest sequence already rendered. Because
events are persisted first, a reconnect with the last sequence receives exactly the
gap — the UI must never poll to "catch up".

## Reporting format

Same as `docs/workstream-brief.md`. Report files, routes added, commands run
(`bunx tsc --noEmit -p tsconfig.json`, `bunx biome check src tests`,
`bun test --preload ./tests/setup.ts tests/unit tests/integration`) and any
primitive you added or need.
