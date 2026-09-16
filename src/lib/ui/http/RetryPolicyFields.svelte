<script lang="ts">
/**
 * RetryPolicyFields: the retry editor shared by a service default and an operation
 * override. "Override" is explicit because `null` means "inherit the service value"
 * and a UI that cannot express that makes the effective policy unknowable.
 */

import NumberField from './controls/NumberField.svelte';
import TagsInput from './controls/TagsInput.svelte';
import Toggle from './controls/Toggle.svelte';
import { defaultRetryPolicy, describeRetryPolicy } from './policy';
import type { RetryPolicy } from './types';

interface Props {
  value?: RetryPolicy | null;
  inherited?: RetryPolicy | null;
  title?: string;
  inheritHint?: string;
}

let {
  value = $bindable<RetryPolicy | null>(null),
  inherited = null,
  title = 'Retry policy',
  inheritHint = 'When off, the service default applies.'
}: Props = $props();

function patch(changes: Partial<RetryPolicy>) {
  if (value) value = { ...value, ...changes };
}

function toggleOverride(next: boolean) {
  value = next ? defaultRetryPolicy() : null;
}
</script>

<div class="space-y-4">
  <Toggle
    checked={value !== null}
    label={`Override ${title.toLowerCase()}`}
    hint={inheritHint}
    onchange={toggleOverride}
  />

  {#if value}
    <div class="grid gap-3 sm:grid-cols-3">
      <NumberField
        label="Max attempts"
        min={1}
        max={20}
        value={value.maxAttempts}
        onchange={(next) => patch({ maxAttempts: next ?? 1 })}
        hint="Including the first try."
      />
      <NumberField
        label="Base delay (ms)"
        min={0}
        value={value.baseDelayMs ?? null}
        onchange={(next) => patch({ baseDelayMs: next ?? undefined })}
      />
      <NumberField
        label="Max delay (ms)"
        min={0}
        value={value.maxDelayMs ?? null}
        onchange={(next) => patch({ maxDelayMs: next ?? undefined })}
      />
    </div>

    <TagsInput
      label="Retry status codes"
      values={(value.retryOn ?? []).map(String)}
      placeholder="500"
      hint="Only these statuses are retried (plus the runtime's transient defaults)."
      onchange={(entries) =>
        patch({
          retryOn: entries
            .map((entry) => Number(entry))
            .filter((entry) => Number.isFinite(entry))
        })}
    />

    <Toggle
      checked={value.honorRetryAfter !== false}
      label="Honour Retry-After"
      hint="A server-supplied Retry-After wins over exponential backoff, capped at 60s."
      onchange={(next) => patch({ honorRetryAfter: next })}
    />
  {:else}
    <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
      {describeRetryPolicy(inherited)}
    </p>
  {/if}

  <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
    Default behaviour: GET, HEAD, PUT, DELETE and OPTIONS are retried; POST and PATCH are
    not, because replaying a mutation can duplicate its effect.
  </p>
</div>
