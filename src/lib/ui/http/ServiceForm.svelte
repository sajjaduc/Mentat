<script lang="ts">
/**
 * ServiceForm: the connection editor for an HTTP service.
 *
 * A service owns connection concerns (base URL, auth, defaults, limits) and an
 * operation owns meaning (ADR-0014). This form therefore edits only the former, and
 * every policy is optional — leaving one unset means the runtime's defaults apply,
 * which the operation editor can still override per operation.
 */

import ApprovalPolicyFields from './ApprovalPolicyFields.svelte';
import AuthEditor from './AuthEditor.svelte';
import CachePolicyFields from './CachePolicyFields.svelte';
import KeyValueEditor from './controls/KeyValueEditor.svelte';
import NumberField from './controls/NumberField.svelte';
import Section from './controls/Section.svelte';
import TagsInput from './controls/TagsInput.svelte';
import TextAreaField from './controls/TextAreaField.svelte';
import TextField from './controls/TextField.svelte';
import type { ServiceDraft } from './draft';
import RateLimitFields from './RateLimitFields.svelte';
import RetryPolicyFields from './RetryPolicyFields.svelte';
import type { SecretView } from './types';

interface Props {
  draft: ServiceDraft;
  secrets: SecretView[];
  secretsLoading?: boolean;
  secretsError?: string | null;
}

let { draft, secrets, secretsLoading = false, secretsError = null }: Props = $props();
</script>

<div class="space-y-5">
  <Section
    title="Connection"
    description="Where the service lives and how long Mentat waits for it. The base URL is prefixed to every operation path."
  >
    <div class="grid gap-4 sm:grid-cols-2">
      <TextField label="Name" bind:value={draft.name} required />
      <TextField
        label="Base URL"
        type="url"
        bind:value={draft.baseUrl}
        placeholder="https://api.example.com"
        required
      />
    </div>
    <TextAreaField
      label="Description"
      bind:value={draft.description}
      rows={2}
      placeholder="What this service is for, and who owns it."
    />
    <NumberField
      label="Timeout (ms)"
      min={100}
      max={120000}
      value={draft.timeoutMs}
      hint="Applied to each attempt unless an operation overrides it."
      onchange={(next) => (draft.timeoutMs = next ?? 15000)}
    />
    <TagsInput
      label="Allowed hosts"
      bind:values={draft.allowedHosts}
      placeholder="api.example.com"
      hint="Optional. When set, these are the only hosts Mentat will call for this service."
    />
  </Section>

  <Section
    title="Authentication"
    description="Mentat resolves the credential only inside execution and redacts it from every request log."
  >
    <AuthEditor
      bind:authType={draft.authType}
      bind:authConfig={draft.authConfig}
      {secrets}
      {secretsLoading}
      {secretsError}
    />
  </Section>

  <Section
    title="Default headers"
    description="Sent on every operation unless the operation declares the same header itself."
  >
    <KeyValueEditor
      bind:value={draft.defaultHeaders}
      keyPlaceholder="Accept"
      valuePlaceholder="application/json"
    />
  </Section>

  <div class="grid gap-5 lg:grid-cols-2">
    <Section
      title="Retry defaults"
      description="Inherited by operations that do not override them."
    >
      <RetryPolicyFields bind:value={draft.retryPolicy} inheritHint="No service default is set." />
    </Section>

    <Section
      title="Cache defaults"
      description="Inherited by operations that do not override them."
    >
      <CachePolicyFields bind:value={draft.cachePolicy} inheritHint="No service default is set." />
    </Section>

    <Section
      title="Approval default"
      description="Inherited by operations that do not override them."
    >
      <ApprovalPolicyFields
        bind:value={draft.defaultApprovalPolicy}
        inheritHint="No service default is set; operations run without approval."
      />
    </Section>

    <Section title="Rate limits" description="Enforced across every operation on this service.">
      <RateLimitFields bind:value={draft.rateLimit} />
    </Section>
  </div>
</div>
