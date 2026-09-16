<script lang="ts">
/**
 * CachePolicyFields: cache participation for a service default or an operation.
 *
 * The note about credential identity is not decoration: the cache key includes a
 * fingerprint of the secret the request would use, so a cached response can never be
 * replayed under a different credential (the runtime's `computeAuthScope`).
 */
import { defaultCachePolicy, describeCachePolicy } from './policy';
import type { CachePolicy } from './types';
import NumberField from './controls/NumberField.svelte';
import TagsInput from './controls/TagsInput.svelte';
import Toggle from './controls/Toggle.svelte';

interface Props {
  value?: CachePolicy | null;
  inherited?: CachePolicy | null;
  title?: string;
  inheritHint?: string;
}

let {
  value = $bindable<CachePolicy | null>(null),
  inherited = null,
  title = 'Cache policy',
  inheritHint = 'When off, the service default applies.'
}: Props = $props();

function patch(changes: Partial<CachePolicy>) {
  if (value) value = { ...value, ...changes };
}

function toggleOverride(next: boolean) {
  value = next ? defaultCachePolicy() : null;
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
    <div class="space-y-3">
      <Toggle
        checked={value.enabled}
        label="Cache enabled"
        hint="Only GET and HEAD responses participate; mutations are never cached."
        onchange={(next) => patch({ enabled: next })}
      />
      <Toggle
        checked={value.read !== false}
        label="Read from cache"
        disabled={!value.enabled}
        hint="Writing still happens when reads are off, which warms a cache you do not trust yet."
        onchange={(next) => patch({ read: next })}
      />
      <NumberField
        label="TTL (seconds)"
        min={0}
        value={value.ttlSeconds ?? null}
        disabled={!value.enabled}
        placeholder="No expiry"
        hint="Leave empty for an entry that does not expire."
        onchange={(next) => patch({ ttlSeconds: next ?? undefined })}
      />
      <TagsInput
        label="Vary on"
        values={value.varyOn ?? []}
        disabled={!value.enabled}
        placeholder="locale"
        hint="Input parameter names folded into the cache key so different callers never collide."
        onchange={(entries) => patch({ varyOn: entries })}
      />
    </div>
  {:else}
    <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
      {describeCachePolicy(inherited)}
    </p>
  {/if}

  <p class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
    Cache identity includes the workspace, this operation, the method, the URL and body, and a
    fingerprint of the credential used. Rotating a secret naturally misses the old entries, and
    two credentials never share a cached response.
  </p>
</div>
