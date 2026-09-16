<script lang="ts">
/**
 * AuthEditor: the authentication half of an HTTP service.
 *
 * The only thing this editor ever handles is a *reference* to a secret. Options are
 * built from the `/api/secrets` metadata (key name and last four), and the copy says
 * plainly that the value is encrypted at rest and never displayed again. No code path
 * here reads, receives or stores a plaintext credential.
 */
import type { Option } from '$ui/primitives/types';
import SelectField from './controls/SelectField.svelte';
import TextField from './controls/TextField.svelte';
import TemplatePreview from './TemplatePreview.svelte';
import type { HttpAuthConfig, HttpAuthType, SecretView } from './types';
import { AUTH_TYPE_LABELS } from './types';

interface Props {
  authType?: HttpAuthType;
  authConfig?: HttpAuthConfig;
  secrets: SecretView[];
  secretsLoading?: boolean;
  secretsError?: string | null;
}

let {
  authType = $bindable<HttpAuthType>('none'),
  authConfig = $bindable<HttpAuthConfig>({}),
  secrets,
  secretsLoading = false,
  secretsError = null
}: Props = $props();

const typeOptions: Option[] = (
  ['none', 'bearer', 'api_key_header', 'api_key_query', 'basic', 'custom_header'] as HttpAuthType[]
).map((type) => ({ value: type, label: AUTH_TYPE_LABELS[type] }));

const secretOptions = $derived<Option[]>(
  secrets.map((secret) => ({
    value: secret.id,
    label: `${secret.key}${secret.lastFour ? ` · ••••${secret.lastFour}` : ' · value hidden'}`
  }))
);

function patch(changes: Partial<HttpAuthConfig>) {
  authConfig = { ...authConfig, ...changes };
}

const needsSecret = $derived(
  authType === 'bearer' ||
    authType === 'api_key_header' ||
    authType === 'api_key_query' ||
    authType === 'custom_header'
);
</script>

<div class="space-y-4">
  <SelectField
    label="Authentication"
    options={typeOptions}
    value={authType}
    hint="Secrets are resolved only inside execution, immediately before the request."
    onchange={(next) => (authType = next as HttpAuthType)}
  />

  {#if authType !== 'none'}
    <p class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
      Only a reference is stored. The secret's value is encrypted at rest, is never returned after
      creation, and is never displayed again — this editor shows the key name and its last four
      characters so you can recognise which credential is bound.
    </p>
  {/if}

  {#if secretsError}
    <p class="text-xs text-[var(--color-danger)]">
      Could not load secrets: {secretsError}. Create one under Settings first.
    </p>
  {:else if needsSecret && !secretsLoading && secrets.length === 0}
    <p class="text-xs text-[var(--color-ink-subtle)]">
      No secrets exist in this workspace yet. Create one under
      <a class="text-[var(--color-accent-ink)] underline" href="/settings">Settings</a> before
      saving this service.
    </p>
  {/if}

  {#if needsSecret}
    <SelectField
      label="Secret"
      options={secretOptions}
      value={authConfig.secretId ?? ''}
      placeholder={secretsLoading ? 'Loading secrets…' : 'Select a secret…'}
      onchange={(next) => patch({ secretId: next.length > 0 ? next : undefined })}
    />
  {/if}

  {#if authType === 'api_key_header'}
    <TextField
      label="Header name"
      value={authConfig.headerName ?? ''}
      placeholder="X-API-Key"
      hint="Defaults to X-API-Key when left empty."
      onchange={(next) => patch({ headerName: next.length > 0 ? next : undefined })}
    />
  {/if}

  {#if authType === 'api_key_query'}
    <TextField
      label="Query parameter name"
      value={authConfig.queryName ?? ''}
      placeholder="api_key"
      hint="The credential appears in the URL, so it is redacted in every log and audit row."
      onchange={(next) => patch({ queryName: next.length > 0 ? next : undefined })}
    />
  {/if}

  {#if authType === 'basic'}
    <TextField
      label="Username"
      value={authConfig.username ?? ''}
      autocomplete="off"
      onchange={(next) => patch({ username: next.length > 0 ? next : undefined })}
    />
    <SelectField
      label="Password secret"
      options={secretOptions}
      value={authConfig.passwordSecretId ?? ''}
      placeholder={secretsLoading ? 'Loading secrets…' : 'Select a secret…'}
      onchange={(next) => patch({ passwordSecretId: next.length > 0 ? next : undefined })}
    />
  {/if}

  {#if authType === 'custom_header'}
    <TextField
      label="Header name"
      value={authConfig.headerName ?? ''}
      placeholder="X-Auth"
      hint="Defaults to X-Auth when left empty."
      onchange={(next) => patch({ headerName: next.length > 0 ? next : undefined })}
    />
    <TextField
      label="Header template"
      value={authConfig.template ?? ''}
      placeholder={'Bearer {{secret}}'}
      hint={'Must contain {{secret}}; it is replaced with the resolved value at execution time.'}
      onchange={(next) => patch({ template: next.length > 0 ? next : undefined })}
    />
    <TemplatePreview value={authConfig.template ?? 'Bearer {{secret}}'} />
  {/if}
</div>
