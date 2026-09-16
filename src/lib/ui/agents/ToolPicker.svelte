<script lang="ts">
/**
 * ToolPicker: choose the stored tools (HTTP operations and MCP tools) an agent may
 * call.
 *
 * Two different things live behind "tools", and conflating them is how an operator
 * ends up believing they granted a capability they did not:
 *
 *  - Stored tools (`kind: 'http' | 'mcp'`) have an id and are attached to the agent
 *    via `toolIds`. These are selectable here, and a whole namespace can be toggled
 *    at once.
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
import { groupByNamespace, namespaceForKey, ToolGroup } from './tools';

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
    // Native handlers materialise a row too, and the runner exposes them to the model
    // through `toolIds`; attaching one here is what makes it callable at all. Their
    // exact capability must additionally be granted on the Permissions tab.
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

function storedHint(tool: Tool): string {
  const parts = [truncate(tool.description, 140)];
  if (tool.kind === 'mcp') parts.push('MCP tool');
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
    group: namespaceForKey(tool.key),
    hint: storedHint(tool),
    badge: tool.enabled ? undefined : 'disabled'
  }))
);

const nativeGroups = $derived(groupByNamespace(nativeTools, (tool) => tool.key));
</script>

<Section
  title="Tools"
  description="Stored HTTP and MCP tools this agent may call. Native capabilities are granted on the Permissions tab and are listed here for reference only."
>
  {#if loading}
    <Skeleton lines={3} height="2.25rem" />
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else}
    <MultiSelect
      label="HTTP and MCP tools"
      hint="Only stored tools can be attached here; each one is an operation or MCP tool exposed as a tool. Use a group's checkbox to attach or detach the whole namespace."
      searchPlaceholder="Search tools…"
      emptyLabel="No stored tools exist yet. Add one from the Tools page or expose an operation under HTTP Services."
      options={storedOptions}
      groupToggle
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
        <div class="space-y-2">
          {#each nativeGroups as [namespace, tools] (namespace)}
            <ToolGroup name={namespace} count={tools.length} defaultOpen={false}>
              <ul class="space-y-2">
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
            </ToolGroup>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</Section>
