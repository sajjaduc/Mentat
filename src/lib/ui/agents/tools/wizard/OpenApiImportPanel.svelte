<script lang="ts">
/**
 * Guided OpenAPI import.
 *
 * Paste or choose a document, review exactly which operations it would create, then
 * point them at a service. The preview is computed server-side from the same parser
 * the import uses, so what the operator checks here is what gets written — no
 * client-side interpretation of the spec.
 */
import type { OpenApiOperationDraft, OpenApiPreview } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import AuthEditor from '$ui/http/AuthEditor.svelte';
import SelectField from '$ui/http/controls/SelectField.svelte';
import TextAreaField from '$ui/http/controls/TextAreaField.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import type { HttpAuthConfig, HttpAuthType, HttpService, SecretView } from '$ui/http/types';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { groupSelectionState, toggleGroupSelection } from '../group-selection';
import ToolGroup from '../ToolGroup.svelte';

interface Props {
  onBack: () => void;
  onDone: (message: string) => void;
}

let { onBack, onDone }: Props = $props();

let loading = $state(true);
let loadError = $state<string | null>(null);
let services = $state<HttpService[]>([]);
let secrets = $state<SecretView[]>([]);

let document = $state('');
let namespace = $state('');
let preview = $state<OpenApiPreview | null>(null);
let selected = $state<string[]>([]);
let parsing = $state(false);

let serviceMode = $state<'new' | 'existing'>('new');
let existingServiceId = $state('');
let serviceName = $state('');
let serviceBaseUrl = $state('');
let authType = $state<HttpAuthType>('none');
let authConfig = $state<HttpAuthConfig>({});

let importing = $state(false);
let error = $state<string | null>(null);

async function load() {
  loading = true;
  loadError = null;
  try {
    const [serviceResult, secretResult] = await Promise.all([
      api.get<{ services: HttpService[] }>('/api/http/services'),
      api
        .get<{ secrets: SecretView[] }>('/api/secrets')
        .catch(() => ({ secrets: [] as SecretView[] }))
    ]);
    services = serviceResult.services;
    secrets = secretResult.secrets;
    if (services[0]) existingServiceId = services[0].id;
  } catch (failure) {
    loadError = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

async function readFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  document = await file.text();
  preview = null;
}

async function parse() {
  if (document.trim().length === 0) {
    error = 'Paste an OpenAPI document or choose a file first.';
    return;
  }
  parsing = true;
  error = null;
  try {
    const result = await api.post<{ preview: OpenApiPreview }>('/api/openapi/preview', {
      document,
      namespace: namespace.trim() || undefined
    });
    preview = result.preview;
    selected = result.preview.operations.map((operation) => operation.key);
    namespace = result.preview.namespace;
    serviceName = result.preview.title;
    serviceBaseUrl = result.preview.baseUrl ?? '';
    serviceMode = services.length > 0 ? serviceMode : 'new';
  } catch (failure) {
    error = describeApiError(failure);
    preview = null;
  } finally {
    parsing = false;
  }
}

const methodGroups = $derived.by(() => {
  const groups = new Map<string, OpenApiOperationDraft[]>();
  for (const operation of preview?.operations ?? []) {
    const bucket = groups.get(operation.method);
    if (bucket) bucket.push(operation);
    else groups.set(operation.method, [operation]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
});

const serviceOptions = $derived(
  services.map((service) => ({ value: service.id, label: `${service.name} · ${service.baseUrl}` }))
);

async function runImport() {
  if (!preview) return;
  if (selected.length === 0) {
    error = 'Select at least one operation to import.';
    return;
  }
  if (serviceMode === 'existing' && !existingServiceId) {
    error = 'Choose a service.';
    return;
  }
  if (serviceMode === 'new' && (!serviceName.trim() || !serviceBaseUrl.trim())) {
    error = 'A service name and base URL are required.';
    return;
  }
  importing = true;
  error = null;
  try {
    const result = await api.post<{ imported: number }>('/api/openapi/import', {
      document,
      namespace,
      keys: selected,
      serviceId: serviceMode === 'existing' ? existingServiceId : null,
      service:
        serviceMode === 'new'
          ? {
              name: serviceName.trim(),
              baseUrl: serviceBaseUrl.trim(),
              authType,
              authConfig
            }
          : null
    });
    onDone(
      `Imported ${result.imported} tool${result.imported === 1 ? '' : 's'} from ${preview.title}`
    );
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    importing = false;
  }
}
</script>

{#if loading}
  <Skeleton lines={4} height="2rem" />
{:else if loadError}
  <ErrorState message={loadError} onRetry={load} />
{:else}
  <div class="space-y-4">
    {#if !preview}
      <TextAreaField
        label="OpenAPI document"
        bind:value={document}
        rows={10}
        placeholder={'{\n  "openapi": "3.0.0",\n  "info": { "title": "My API", "version": "1.0.0" },\n  "paths": { ... }\n}'}
        hint="JSON or YAML (OpenAPI 3.x). Nothing is written until you review and import."
      />
      <label class="block text-xs text-[var(--color-ink-muted)]">
        …or choose a file
        <input
          type="file"
          accept=".json,.yaml,.yml,application/json,text/yaml"
          class="mt-1 block w-full text-xs"
          onchange={readFile}
        />
      </label>
      <TextField
        label="Key namespace (optional)"
        bind:value={namespace}
        placeholder="Derived from the API title"
        hint="Prefixes every imported tool key, e.g. petstore.listpets."
      />
      {#if error}<p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>{/if}
      <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
        <Button variant="ghost" onclick={onBack}>Back</Button>
        <Button variant="primary" loading={parsing} onclick={parse}>Preview operations</Button>
      </div>
    {:else}
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2.5"
      >
        <p class="text-sm font-medium text-[var(--color-ink)]">{preview.title}</p>
        <p class="text-[11px] text-[var(--color-ink-subtle)]">
          OpenAPI {preview.version ?? 'document'} · {preview.operations.length} operation(s) ·
          namespace <code class="font-mono">{preview.namespace}</code>
        </p>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">
            Operations · {selected.length} of {preview.operations.length} selected
          </p>
          <button
            type="button"
            class="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
            onclick={() =>
              (selected =
                selected.length === preview!.operations.length
                  ? []
                  : preview!.operations.map((operation) => operation.key))}
          >
            {selected.length === preview.operations.length ? 'Clear all' : 'Select all'}
          </button>
        </div>
        {#each methodGroups as [methodName, operations] (methodName)}
          {@const keys = operations.map((operation) => operation.key)}
          <ToolGroup
            name={methodName}
            count={operations.length}
            toggle={{
              state: groupSelectionState(selected, keys),
              onToggle: () => (selected = toggleGroupSelection(selected, keys)),
              hint: 'All'
            }}
          >
            <ul class="space-y-2">
              {#each operations as operation (operation.key)}
                <li>
                  <label class="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                      checked={selected.includes(operation.key)}
                      onchange={() =>
                        (selected = selected.includes(operation.key)
                          ? selected.filter((key) => key !== operation.key)
                          : [...selected, operation.key])}
                    />
                    <span class="min-w-0 space-y-0.5">
                      <span class="flex flex-wrap items-center gap-2">
                        <code class="font-mono text-xs text-[var(--color-ink)]">{operation.key}</code>
                        <span class="text-[10px] text-[var(--color-ink-subtle)]">{operation.path}</span>
                      </span>
                      <span class="block text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
                        {operation.name}
                      </span>
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          </ToolGroup>
        {/each}
      </div>

      <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-3">
        <div class="flex flex-wrap gap-2">
          <Button variant={serviceMode === 'new' ? 'primary' : 'secondary'} size="sm" onclick={() => (serviceMode = 'new')}>
            New service
          </Button>
          {#if services.length > 0}
            <Button
              variant={serviceMode === 'existing' ? 'primary' : 'secondary'}
              size="sm"
              onclick={() => (serviceMode = 'existing')}
            >
              Existing service
            </Button>
          {/if}
        </div>
        {#if serviceMode === 'existing'}
          <SelectField label="Service" options={serviceOptions} bind:value={existingServiceId} />
        {:else}
          <TextField label="Service name" bind:value={serviceName} required />
          <TextField label="Base URL" type="url" bind:value={serviceBaseUrl} required />
          <AuthEditor bind:authType bind:authConfig {secrets} />
        {/if}
      </div>

      {#if error}<p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>{/if}
      <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
        <Button variant="ghost" onclick={() => (preview = null)}>Back to document</Button>
        <Button variant="primary" loading={importing} onclick={runImport}>
          Import {selected.length} tool{selected.length === 1 ? '' : 's'}
        </Button>
      </div>
    {/if}
  </div>
{/if}
