<script lang="ts">
/**
 * ToolPicker: choose the HTTP tools an agent may call.
 *
 * Two different things live behind "tools", and conflating them is how an operator
 * ends up believing they granted a capability they did not:
 *
 *  - Stored (`kind: 'http'`) tools have an id and are attached to the agent via
 *    `toolIds`. These are selectable here.
 *  - Native capabilities are registry entries with `id: null`; the agent is granted
 *    them through `permissions.native` on the Permissions tab. They are listed here
 *    read-only so the whole tool surface is visible in one place.
 */
import { truncate } from '$shared/format';
import type { NativeToolDescriptor, Tool } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import MultiSelect from '$ui/http/controls/MultiSelect.svelte';
import Section from '$ui/http/controls/Section.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';

interface Props {
  toolIds?: string[];
}

let { toolIds = $bindable<string[]>([]) }: Props = $props();

let nativeTools = $state<NativeToolDescriptor[]>([]);
let storedTools = $state<Tool[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const result = await api.get<{ native: NativeToolDescriptor[]; stored: Tool[] }>('/api/tools');
    nativeTools = result.native;
    storedTools = result.stored;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

function namespaceOf(key: string): string {
  const head = key.split('.')[0];
  return head !== undefined && head.length > 0 ? head : 'other';
}

function storedHint(tool: Tool): string {
  const parts = [truncate(tool.description, 140)];
  parts.push(tool.approvalPolicy ? `approval: ${tool.approvalPolicy.mode}` : 'approval: none');
  if (tool.cachePolicy?.enabled) {
    parts.push(
      tool.cachePolicy.ttlSeconds === undefined
        ? 'cache: on'
        : `cache: on (${tool.cachePolicy.ttlSeconds}s)`
    );
  } else {
    parts.push('cache: off');
  }
  return parts.join(' · ');
}

const storedOptions = $derived(
  storedTools.map((tool) => ({
    value: tool.id,
    label: tool.key,
    group: namespaceOf(tool.key),
    hint: storedHint(tool),
    badge: tool.enabled ? undefined : 'disabled'
  }))
);

const nativeGroups = $derived.by(() => {
  const groups = new Map<string, NativeToolDescriptor[]>();
  for (const tool of nativeTools) {
    const namespace = namespaceOf(tool.key);
    const bucket = groups.get(namespace);
    if (bucket) bucket.push(tool);
    else groups.set(namespace, [tool]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
});
</script>

<Section
  title="Tools"
  description="Stored HTTP tools this agent may call. Native capabilities are granted on the Permissions tab and are listed here for reference only."
>
  {#if loading}
    <Skeleton lines={3} height="2.25rem" />
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else}
    <MultiSelect
      label="HTTP tools"
      hint="Only stored tools can be attached here; each one is an operation exposed as a tool."
      searchPlaceholder="Search tools…"
      emptyLabel="No HTTP tools exist yet. Expose an operation as a tool under HTTP Services first."
      options={storedOptions}
      bind:selected={toolIds}
    />

    <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
      <div class="space-y-0.5">
        <p class="text-sm font-medium text-[var(--color-ink)]">Native capabilities</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Native tools have no id and cannot be attached here. Grant the ones this agent
          needs on the <span class="font-medium text-[var(--color-ink-muted)]">Permissions</span>
          tab.
        </p>
      </div>

      {#if nativeGroups.length === 0}
        <p class="text-xs text-[var(--color-ink-subtle)]">No native tools are registered.</p>
      {:else}
        <div class="grid gap-3 md:grid-cols-2">
          {#each nativeGroups as [namespace, tools] (namespace)}
            <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
              <p
                class="text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase"
              >
                {namespace}
              </p>
              <ul class="mt-2 space-y-2">
                {#each tools as tool (tool.key)}
                  <li class="space-y-0.5">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="font-mono text-xs text-[var(--color-ink)]">{tool.key}</span>
                      {#if tool.permission !== null}
                        <Badge tone="neutral">{tool.permission}</Badge>
                      {/if}
                    </div>
                    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
                      {tool.description}
                    </p>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</Section>
