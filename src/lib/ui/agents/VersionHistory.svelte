<script lang="ts">
/**
 * VersionHistory: the immutable versions of an agent.
 *
 * Runs pin the version they started with, so this list is the record of what a
 * historical or in-flight run actually executed. Editing an agent never rewrites
 * these rows; it appends a new one.
 */
import { formatDateTime } from '$shared/format';
import type { AgentVersion } from '$ui/agents/types';
import Section from '$ui/http/controls/Section.svelte';
import Badge from '$ui/primitives/Badge.svelte';

interface Props {
  versions: AgentVersion[];
  currentVersionId: string | null;
}

let { versions, currentVersionId }: Props = $props();
</script>

<Section
  title="Versions"
  description="Every run pins the immutable version it used, so editing an agent never changes what a run in flight — or one from last month — executed."
>
  {#if versions.length === 0}
    <p class="text-xs text-[var(--color-ink-subtle)]">No versions have been recorded yet.</p>
  {:else}
    <ol class="space-y-2">
      {#each versions as version (version.id)}
        {@const current = currentVersionId !== null && version.id === currentVersionId}
        <li
          class="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-md)] border p-3
            {current
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-border-subtle)]'}"
        >
          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs text-[var(--color-ink)]">v{version.version}</span>
              {#if current}<Badge tone="accent">Current</Badge>{/if}
            </div>
            <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
              {version.changeNote ?? 'No change note recorded.'}
            </p>
            <p class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{version.id}</p>
          </div>
          <p class="shrink-0 text-[11px] text-[var(--color-ink-subtle)]">
            {formatDateTime(version.createdAt)}
          </p>
        </li>
      {/each}
    </ol>
  {/if}
</Section>
