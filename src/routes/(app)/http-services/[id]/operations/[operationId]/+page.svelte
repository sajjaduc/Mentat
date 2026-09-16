<script lang="ts">
/**
 * The Postman-inspired operation editor.
 *
 * Layout follows the brief: `Method | URL/path` on top, then the eight tabs an operator
 * moves between, with the Test Request console and the redacted request history beside
 * them. The page holds a *draft*; saving is explicit, and while there are unsaved
 * changes the console is told the persisted definition is what a test would run.
 *
 * `new` is a valid sentinel segment here because operation ids are UUIDv7, so `/operations/new`
 * means "create" without a second route.
 */

import { goto } from '$app/navigation';
import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import AdvancedEditor from '$ui/http/AdvancedEditor.svelte';
import ApprovalPolicyFields from '$ui/http/ApprovalPolicyFields.svelte';
import BodyEditor from '$ui/http/BodyEditor.svelte';
import CachePolicyFields from '$ui/http/CachePolicyFields.svelte';
import CodeBlock from '$ui/http/controls/CodeBlock.svelte';
import JsonTextarea from '$ui/http/controls/JsonTextarea.svelte';
import KeyValueEditor from '$ui/http/controls/KeyValueEditor.svelte';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import {
  draftFromOperation,
  emptyOperation,
  inferredInputSchema,
  missingPathParameters,
  type OperationDraft,
  operationPayload,
  validateOperationDraft
} from '$ui/http/draft';
import { formatJson } from '$ui/http/json';
import OperationLine from '$ui/http/OperationLine.svelte';
import ParametersTable from '$ui/http/ParametersTable.svelte';
import RateLimitFields from '$ui/http/RateLimitFields.svelte';
import RequestLogsPanel from '$ui/http/RequestLogsPanel.svelte';
import ResponseEditor from '$ui/http/ResponseEditor.svelte';
import RetryPolicyFields from '$ui/http/RetryPolicyFields.svelte';
import TestConsole from '$ui/http/TestConsole.svelte';
import type { HttpOperation, HttpRequestLog, HttpService, TestRequestResult } from '$ui/http/types';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import { pushToast } from '$ui/toast';

type TabId =
  | 'parameters'
  | 'headers'
  | 'body'
  | 'response'
  | 'cache'
  | 'retries'
  | 'approval'
  | 'advanced';

let service = $state<HttpService | null>(null);
let draft = $state<OperationDraft | null>(null);
let snapshot = $state('');
let isNew = $state(true);
let loading = $state(true);
let error = $state<string | null>(null);
let errorCode = $state<string | null>(null);
let activeTab = $state<TabId>('parameters');
let saving = $state(false);
let archiving = $state(false);
let testResult = $state<TestRequestResult | null>(null);

let logs = $state<HttpRequestLog[]>([]);
let logsLoading = $state(false);
let logsError = $state<string | null>(null);

let loadedKey: string | null = null;

const dirty = $derived(draft !== null && JSON.stringify(draft) !== snapshot);
const missingPath = $derived(draft ? missingPathParameters(draft) : []);
const problems = $derived(draft ? validateOperationDraft(draft) : []);
const modelSchema = $derived(
  draft && draft.inputSchemaText.trim().length === 0
    ? formatJson(inferredInputSchema(draft.parameters, draft.body))
    : ''
);

function codeOf(failure: unknown): string | null {
  return failure instanceof Error && 'code' in failure ? String(failure.code) : null;
}

async function loadLogs(operationId: string) {
  logsLoading = true;
  logsError = null;
  try {
    const response = await api.get<{ logs: HttpRequestLog[] }>('/api/http/logs', {
      operationId,
      limit: 50
    });
    logs = response.logs;
  } catch (failure) {
    logsError = describeApiError(failure);
  } finally {
    logsLoading = false;
  }
}

async function load(key: string) {
  const [serviceId, operationId] = key.split(':');
  if (!serviceId) return;
  loading = true;
  error = null;
  errorCode = null;
  testResult = null;
  logs = [];
  isNew = operationId === 'new';
  try {
    const serviceResponse = await api.get<{ service: HttpService }>(
      `/api/http/services/${serviceId}`
    );
    service = serviceResponse.service;
    if (isNew || !operationId) {
      draft = emptyOperation(serviceId);
    } else {
      const operationResponse = await api.get<{ operation: HttpOperation }>(
        `/api/http/operations/${operationId}`
      );
      draft = draftFromOperation(operationResponse.operation);
    }
    snapshot = JSON.stringify(draft);
    activeTab = 'parameters';
    if (!isNew && operationId) void loadLogs(operationId);
  } catch (failure) {
    error = describeApiError(failure);
    errorCode = codeOf(failure);
    draft = null;
  } finally {
    loading = false;
  }
}

$effect(() => {
  const key = `${page.params.id}:${page.params.operationId}`;
  if (key === loadedKey) return;
  loadedKey = key;
  void load(key);
});

async function save() {
  if (!draft || !service) return;
  if (problems.length > 0) {
    pushToast({ tone: 'error', title: problems[0] ?? 'The operation is not valid' });
    return;
  }
  saving = true;
  try {
    if (isNew) {
      const response = await api.post<{ operation: HttpOperation }>(
        '/api/http/operations',
        operationPayload(draft)
      );
      pushToast({ tone: 'success', title: `Created ${response.operation.key}` });
      await goto(`/http-services/${service.id}/operations/${response.operation.id}`);
    } else {
      const response = await api.patch<{ operation: HttpOperation }>(
        `/api/http/operations/${draftOperationId()}`,
        operationPayload(draft)
      );
      draft = draftFromOperation(response.operation);
      snapshot = JSON.stringify(draft);
      pushToast({ tone: 'success', title: 'Operation saved' });
    }
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    saving = false;
  }
}

function draftOperationId(): string {
  return page.params.operationId ?? '';
}

async function archive() {
  if (!draft || !service || isNew) return;
  archiving = true;
  try {
    await api.delete(`/api/http/operations/${draftOperationId()}`);
    pushToast({ tone: 'success', title: `Archived ${draft.key}` });
    await goto(`/http-services/${service.id}`);
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    archiving = false;
  }
}

function resetDraft() {
  const operationId = page.params.operationId;
  if (operationId) void load(`${page.params.id}:${operationId}`);
}

function inferOutputSchema() {
  if (!draft) return;
  const schema = testResult?.inferredOutputSchema;
  if (!schema) {
    pushToast({ tone: 'info', title: 'Run a successful test request first' });
    return;
  }
  draft.outputSchemaText = formatJson(schema);
  activeTab = 'response';
  pushToast({ tone: 'success', title: 'Inferred schema applied — review it before saving' });
}

const tabs = $derived([
  { id: 'parameters', label: 'Parameters', count: draft?.parameters.length ?? 0 },
  { id: 'headers', label: 'Headers', count: draft ? Object.keys(draft.headers).length : 0 },
  { id: 'body', label: 'Body' },
  { id: 'response', label: 'Response' },
  { id: 'cache', label: 'Cache' },
  { id: 'retries', label: 'Retries' },
  { id: 'approval', label: 'Approval' },
  { id: 'advanced', label: 'Advanced' }
]);
</script>

<svelte:head>
  <title>{draft?.key ? `${draft.key} · Operation` : 'Operation'} · Mentat</title>
</svelte:head>

<div class="space-y-5 p-4 md:p-6">
  {#if loading}
    <Skeleton lines={2} height="1.25rem" />
    <div class="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
      <Skeleton lines={8} height="1rem" />
    </div>
  {:else if error || !draft || !service}
    <PageHeader
      title="Operation"
      backHref={`/http-services/${page.params.id}`}
      backLabel="Back to service"
    />
    <ErrorState
      message={error ?? 'The operation could not be loaded.'}
      code={errorCode}
      onRetry={() => load(`${page.params.id}:${page.params.operationId}`)}
    />
  {:else if draft && service}
    <PageHeader
      title={isNew ? 'New operation' : draft.name || draft.key}
      description={isNew
        ? `Define a semantic capability on ${service.name}. Save it to enable the test console.`
        : `${service.name} · ${service.baseUrl}`}
      backHref={`/http-services/${service.id}`}
      backLabel="Back to service"
    >
      {#snippet actions()}
        {#if dirty}
          <Button variant="ghost" size="sm" onclick={resetDraft}>Discard</Button>
        {/if}
        <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onclick={save}>
          {isNew ? 'Create operation' : 'Save changes'}
        </Button>
      {/snippet}
    </PageHeader>

    {#if problems.length > 0}
      <ul
        class="space-y-1 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-caution)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-caution)_10%,var(--color-surface))] px-3 py-2"
      >
        {#each problems as problem (problem)}
          <li class="text-xs text-[var(--color-ink)]">{problem}</li>
        {/each}
      </ul>
    {/if}

    <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_27rem]">
      <div class="min-w-0 space-y-4">
        <div
          class="space-y-4 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)]"
        >
          <OperationLine {draft} baseUrl={service.baseUrl} missing={missingPath} />
          <div class="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{draft.parameters.length} parameters</Badge>
            <Badge tone="neutral">body: {draft.body.mode}</Badge>
            <Badge tone={draft.exposeAsTool && draft.enabled ? 'accent' : 'muted'}>
              {draft.exposeAsTool && draft.enabled ? 'exposed as tool' : 'hidden from agents'}
            </Badge>
            {#if isNew}
              <Badge tone="caution">unsaved</Badge>
            {/if}
          </div>
        </div>

        <Tabs
          tabs={tabs}
          active={activeTab}
          onselect={(id) => (activeTab = id as TabId)}
          class="scrollbar-thin overflow-x-auto"
        />

        {#if activeTab === 'parameters'}
          <Section
            title="Parameters"
            description="Every value the model must supply. Path parameters are required by construction."
          >
            <ParametersTable bind:parameters={draft.parameters} missingPath={missingPath} />
          </Section>

          <Section
            title="Input schema"
            description="What the model is told this operation accepts. Leave the override empty to infer it from the parameters and body."
          >
            <JsonTextarea
              label="Authored input schema (optional)"
              bind:value={draft.inputSchemaText}
              rows={8}
              placeholder="Leave empty to infer from parameters and body."
            />
            <CodeBlock
              value={modelSchema}
              label="Inferred schema (what the model will see)"
              emptyLabel="An authored input schema overrides the inference."
            />
          </Section>
        {:else if activeTab === 'headers'}
          <Section
            title="Headers"
            description={'Operation-level headers. Values may contain {{param}} placeholders, which are rendered from the input at execution time.'}
          >
            <KeyValueEditor
              bind:value={draft.headers}
              keyPlaceholder="Accept"
              valuePlaceholder="application/json"
            />
          </Section>
        {:else if activeTab === 'body'}
          <Section
            title="Body"
            description="How the input becomes the request body. The mode decides which mapping is used."
          >
            <BodyEditor bind:body={draft.body} />
          </Section>
        {:else if activeTab === 'response'}
          <Section
            title="Response"
            description="Which responses count as success, what the model sees, and the schema it should expect."
          >
            <ResponseEditor
              {draft}
              onInfer={inferOutputSchema}
              inferAvailable={testResult?.inferredOutputSchema != null}
              inferring={false}
            />
          </Section>
        {:else if activeTab === 'cache'}
          <Section
            title="Cache"
            description="Caching is off by default for operations; only GET and HEAD participate."
          >
            <CachePolicyFields
              bind:value={draft.cachePolicy}
              inherited={service.cachePolicy}
              inheritHint="No service cache default is set."
            />
          </Section>
        {:else if activeTab === 'retries'}
          <Section
            title="Retries"
            description="Retries are a correctness decision: idempotent methods retry, mutations do not unless a status is listed."
          >
            <RetryPolicyFields
              bind:value={draft.retryPolicy}
              inherited={service.retryPolicy}
              inheritHint="No service retry default is set."
            />
          </Section>
        {:else if activeTab === 'approval'}
          <Section
            title="Approval"
            description="Mentat enforces this policy before any request leaves the process."
          >
            <ApprovalPolicyFields
              bind:value={draft.approvalPolicy}
              inherited={service.defaultApprovalPolicy}
              inheritHint="No service approval default is set."
            />
          </Section>
        {:else if activeTab === 'advanced'}
          <AdvancedEditor
            {draft}
            currentKey={isNew ? null : draft.key}
            onArchive={archive}
            archiving={archiving}
          />
          <Section
            title="Rate limit override"
            description="Overrides the service rate limit for this operation only."
          >
            <RateLimitFields bind:value={draft.rateLimitOverride} />
          </Section>
        {/if}
      </div>

      <div class="min-w-0 space-y-4">
        <Section
          title="Test request"
          description="Runs the persisted operation as a human-initiated call: approval and cache are bypassed, everything else still applies."
        >
          {#if dirty}
            <p class="text-xs text-[var(--color-caution)]">
              You have unsaved changes; the test runs the saved definition.
            </p>
          {/if}
          <TestConsole
            operationId={isNew ? null : draftOperationId()}
            {draft}
            bind:result={testResult}
            onSent={() => (isNew ? undefined : loadLogs(draftOperationId()))}
          />
        </Section>

        <Section
          title="Request logs"
          description="The redacted exchanges Mentat recorded for this operation."
        >
          <RequestLogsPanel
            {logs}
            loading={logsLoading}
            error={logsError}
            onRefresh={() => (isNew ? undefined : loadLogs(draftOperationId()))}
            emptyLabel="No requests recorded for this operation yet."
          />
        </Section>
      </div>
    </div>
  {/if}
</div>
