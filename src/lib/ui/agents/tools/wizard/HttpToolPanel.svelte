<script lang="ts">
/**
 * Guided HTTP tool creation.
 *
 * Two questions, asked in order: *where* does the call go (an existing service or a
 * new connection), and *what* is the call (method, path, parameters). Creating the
 * service and its first operation here produces exactly the same rows as the full
 * HTTP editor, so nothing about policy, audit or agent grants differs — this is a
 * shorter path to the same object.
 */

import { api, describeApiError } from '$ui/api';
import AuthEditor from '$ui/http/AuthEditor.svelte';
import NumberField from '$ui/http/controls/NumberField.svelte';
import SelectField from '$ui/http/controls/SelectField.svelte';
import TextAreaField from '$ui/http/controls/TextAreaField.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import Toggle from '$ui/http/controls/Toggle.svelte';
import type { HttpAuthConfig, HttpAuthType, HttpService, SecretView } from '$ui/http/types';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';

interface Props {
  onBack: () => void;
  onDone: (message: string) => void;
}

let { onBack, onDone }: Props = $props();

interface ParameterRow {
  name: string;
  location: 'path' | 'query' | 'header';
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description: string;
}

let step = $state<1 | 2>(1);
let loading = $state(true);
let loadError = $state<string | null>(null);
let services = $state<HttpService[]>([]);
let secrets = $state<SecretView[]>([]);

let useExisting = $state(false);
let existingServiceId = $state('');
let serviceName = $state('');
let baseUrl = $state('');
let serviceDescription = $state('');
let authType = $state<HttpAuthType>('none');
let authConfig = $state<HttpAuthConfig>({});

let namespace = $state('');
let operationName = $state('');
let displayName = $state('');
let method = $state<'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('GET');
let path = $state('/');
let description = $state('');
let exposeAsTool = $state(true);
let timeoutMs = $state<number | null>(null);
let parameters = $state<ParameterRow[]>([]);
let busy = $state(false);
let formError = $state<string | null>(null);

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
    useExisting = services.length > 0;
    if (services[0]) {
      existingServiceId = services[0].id;
      namespace = namespaceFromService(services[0].name);
    }
  } catch (failure) {
    loadError = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

function namespaceFromService(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'api'
  );
}

const serviceOptions = $derived(
  services.map((service) => ({
    value: service.id,
    label: `${service.name} · ${service.baseUrl}`
  }))
);

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const resolvedKey = $derived(`${slug(namespace) || 'api'}.${slug(operationName) || 'operation'}`);

function addParameter() {
  parameters = [
    ...parameters,
    { name: '', location: 'query', type: 'string', required: false, description: '' }
  ];
}

function removeParameter(index: number) {
  parameters = parameters.filter((_, position) => position !== index);
}

function validateStepOne(): string | null {
  if (useExisting) {
    if (!existingServiceId) return 'Choose a service.';
    return null;
  }
  if (!serviceName.trim()) return 'Give the new service a name.';
  if (!baseUrl.trim()) return 'A base URL is required.';
  return null;
}

function validateStepTwo(): string | null {
  if (!slug(operationName)) return 'Give the operation a short name.';
  if (!path.trim()) return 'A path is required.';
  const named = parameters.filter((parameter) => parameter.name.trim().length > 0);
  if (named.length !== parameters.length) return 'Every parameter needs a name.';
  return null;
}

function next() {
  formError = validateStepOne();
  if (!formError) step = 2;
}

async function create() {
  formError = validateStepTwo();
  if (formError) return;
  busy = true;
  formError = null;
  try {
    let serviceId = existingServiceId;
    if (!useExisting) {
      const created = await api.post<{ service: HttpService }>('/api/http/services', {
        name: serviceName.trim(),
        description: serviceDescription.trim() || null,
        baseUrl: baseUrl.trim(),
        authType,
        authConfig
      });
      serviceId = created.service.id;
    }
    await api.post('/api/http/operations', {
      serviceId,
      key: resolvedKey,
      name: displayName.trim() || resolvedKey,
      description,
      method,
      path: path.trim(),
      parameters: parameters.map((parameter) => ({
        name: parameter.name.trim(),
        location: parameter.location,
        type: parameter.type,
        required: parameter.required,
        description: parameter.description.trim() || undefined
      })),
      timeoutMs,
      exposeAsTool,
      enabled: true
    });
    onDone(`Created tool ${resolvedKey}`);
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}
</script>

{#if loading}
  <Skeleton lines={4} height="2rem" />
{:else if loadError}
  <ErrorState message={loadError} onRetry={load} />
{:else}
  <div class="space-y-4">
    <p class="text-xs text-[var(--color-ink-subtle)]">Step {step} of 2 · {step === 1 ? 'Connection' : 'The call'}</p>

    {#if step === 1}
      {#if services.length > 0}
        <div class="flex flex-wrap gap-2">
          <Button variant={useExisting ? 'primary' : 'secondary'} size="sm" onclick={() => (useExisting = true)}>
            Use an existing service
          </Button>
          <Button variant={!useExisting ? 'primary' : 'secondary'} size="sm" onclick={() => (useExisting = false)}>
            Create a new service
          </Button>
        </div>
      {/if}

      {#if useExisting}
        <SelectField
          label="Service"
          options={serviceOptions}
          bind:value={existingServiceId}
          onchange={(value) => {
            const service = services.find((entry) => entry.id === value);
            if (service && namespace.trim().length === 0) namespace = namespaceFromService(service.name);
          }}
        />
      {:else}
        <TextField label="Service name" bind:value={serviceName} required placeholder="HubSpot" />
        <TextField
          label="Base URL"
          type="url"
          bind:value={baseUrl}
          required
          placeholder="https://api.hubapi.com"
        />
        <TextAreaField label="Description" bind:value={serviceDescription} rows={2} />
        <AuthEditor bind:authType bind:authConfig {secrets} />
      {/if}
    {:else}
      <div class="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Namespace"
          bind:value={namespace}
          hint="Groups the tool and prefixes its key."
          placeholder="hubspot"
        />
        <TextField label="Operation name" bind:value={operationName} required placeholder="get_contact" />
      </div>
      <p class="text-[11px] text-[var(--color-ink-subtle)]">
        Tool key: <code class="font-mono text-[var(--color-ink-muted)]">{resolvedKey}</code>
      </p>
      <div class="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <SelectField
          label="Method"
          value={method}
          options={['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((entry) => ({
            value: entry,
            label: entry
          }))}
          onchange={(value) => (method = value as typeof method)}
        />
        <TextField label="Path" bind:value={path} required placeholder={'/contacts/{{id}}'} />
      </div>
      <TextField label="Display name" bind:value={displayName} placeholder={resolvedKey} />
      <TextAreaField
        label="Description"
        bind:value={description}
        rows={2}
        placeholder="What this call does, in the words a model should see."
      />
      <NumberField
        label="Timeout (ms)"
        min={100}
        max={120000}
        value={timeoutMs}
        hint="Leave empty to inherit the service timeout."
        onchange={(next) => (timeoutMs = next)}
      />

      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">Parameters</p>
          <Button variant="ghost" size="sm" onclick={addParameter}>Add parameter</Button>
        </div>
        {#if parameters.length === 0}
          <p class="text-[11px] text-[var(--color-ink-subtle)]">
            No parameters. Path placeholders like <code class="font-mono">{'{{id}}'}</code> become required inputs.
          </p>
        {:else}
          <div class="space-y-2">
            {#each parameters as parameter, index (index)}
              <div class="grid gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2 sm:grid-cols-[1fr_7rem_7rem_auto]">
                <TextField label="Name" bind:value={parameter.name} />
                <SelectField
                  label="In"
                  value={parameter.location}
                  options={[
                    { value: 'path', label: 'path' },
                    { value: 'query', label: 'query' },
                    { value: 'header', label: 'header' }
                  ]}
                  onchange={(value) => (parameter.location = value as ParameterRow['location'])}
                />
                <SelectField
                  label="Type"
                  value={parameter.type}
                  options={['string', 'number', 'boolean', 'object', 'array'].map((entry) => ({
                    value: entry,
                    label: entry
                  }))}
                  onchange={(value) => (parameter.type = value as ParameterRow['type'])}
                />
                <div class="flex items-end gap-2 pb-1">
                  <label class="flex items-center gap-1 text-[11px] text-[var(--color-ink-muted)]">
                    <input type="checkbox" class="h-3.5 w-3.5 accent-[var(--color-accent)]" bind:checked={parameter.required} />
                    Required
                  </label>
                  <Button variant="ghost" size="sm" onclick={() => removeParameter(index)}>Remove</Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <Toggle bind:checked={exposeAsTool} label="Expose as a tool" hint="Agents can be granted this operation only when it is exposed." />
    {/if}

    {#if formError}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{formError}</p>
    {/if}

    <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
      <Button variant="ghost" onclick={() => (step === 1 ? onBack() : (step = 1))}>
        {step === 1 ? 'Back' : 'Previous'}
      </Button>
      {#if step === 1}
        <Button variant="primary" onclick={next} disabled={services.length === 0 && !useExisting}>
          Continue
        </Button>
      {:else}
        <Button variant="primary" loading={busy} onclick={create}>Create tool</Button>
      {/if}
    </div>
  </div>
{/if}
