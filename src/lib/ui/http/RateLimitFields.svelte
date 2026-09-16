<script lang="ts">
/** RateLimitFields: requests per window and in-flight concurrency for a service. */
import { defaultRateLimit, describeRateLimit } from './policy';
import type { RateLimitConfig } from './types';
import NumberField from './controls/NumberField.svelte';
import Toggle from './controls/Toggle.svelte';

interface Props {
  value?: RateLimitConfig | null;
  hint?: string;
}

let {
  value = $bindable<RateLimitConfig | null>(null),
  hint = 'Applies across every operation on this service.'
}: Props = $props();

function patch(changes: Partial<RateLimitConfig>) {
  if (value) value = { ...value, ...changes };
}

function toggle(next: boolean) {
  value = next ? defaultRateLimit() : null;
}
</script>

<div class="space-y-4">
  <Toggle
    checked={value !== null}
    label="Rate limit this service"
    {hint}
    onchange={toggle}
  />

  {#if value}
    <div class="grid gap-3 sm:grid-cols-3">
      <NumberField
        label="Requests"
        min={1}
        value={value.requests ?? null}
        onchange={(next) => patch({ requests: next ?? undefined })}
      />
      <NumberField
        label="Window (seconds)"
        min={1}
        value={value.windowSeconds ?? null}
        onchange={(next) => patch({ windowSeconds: next ?? undefined })}
      />
      <NumberField
        label="Concurrency"
        min={1}
        value={value.concurrency ?? null}
        onchange={(next) => patch({ concurrency: next ?? undefined })}
        hint="Max in-flight requests."
      />
    </div>
  {:else}
    <p class="text-xs text-[var(--color-ink-subtle)]">{describeRateLimit(null)}</p>
  {/if}
</div>
