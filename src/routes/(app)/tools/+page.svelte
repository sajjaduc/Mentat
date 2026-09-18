<script lang="ts">
/**
 * Tools catalogue.
 *
 * Two jobs, one surface:
 *
 *  - **Management**: every capability is grouped by namespace into a collapsible
 *    section, and a namespace can be switched on or off in one action. A disabled tool
 *    stays visible so it can be brought back; the pickers hide it because it is not
 *    grantable.
 *  - **Creation**: "Add a tool" opens a guided flow that exposes the native
 *    capabilities Mentat already ships and supports adding HTTP tools, importing an
 *    OpenAPI document, or connecting an MCP server.
 *
 * Approval and caching are enforced by Mentat before and around a call; a model can
 * request a tool, never bypass the policy attached to it.
 */

import { pluralize } from '$shared/format';
import { groupByNamespace, ParameterList, PolicySummary, ToolGroup } from '$ui/agents/tools';
import NewToolWizard from '$ui/agents/tools/NewToolWizard.svelte';
import type { NativeToolDescriptor, Tool } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';

let native = $state<NativeToolDescriptor[]>([]);
let stored = $state<Tool[]>([]);
let loading = $state(true);
let error = $state<{ message: string; code: string | null } | null>(null);
let search = $state('');
let wizardOpen = $state(false);
let busyGroup = $state<string | null>(null);

/** Native handlers materialise a row too; the stored section is HTTP + MCP only. */
const storedOnly = $derived(stored.filter((tool) => tool.kind !== 'native'));

function matches(key: string, name: string, description: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    key.toLowerCase().includes(needle) ||
    name.toLowerCase().includes(needle) ||
    description.toLowerCase().includes(needle)
  );
}

const filteredNative = $derived(
  native.filter((tool) => matches(tool.key, tool.name, tool.description))
);
const filteredStored = $derived(
  storedOnly.filter((tool) => matches(tool.key, tool.name, tool.description))
);

const nativeGroups = $derived(groupByNamespace(filteredNative, (tool) => tool.key));
const storedGroups = $derived(groupByNamespace(filteredStored, (tool) => tool.key));

const mcpCount = $derived(storedOnly.filter((tool) => tool.kind === 'mcp').length);

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ native: NativeToolDescriptor[]; stored: Tool[] }>(
      '/api/tools'
    );
    native = response.native;
    stored = response.stored;
  } catch (failure) {
    error = {
      message: describeApiError(failure),
      code: failure instanceof Error && 'code' in failure ? String(failure.code) : null
    };
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

function nativeState(tools: NativeToolDescriptor[]): 'all' | 'some' | 'none' {
  const enabled = tools.filter((tool) => tool.enabled).length;
  if (enabled === 0) return 'none';
  return enabled === tools.length ? 'all' : 'some';
}

function storedState(tools: Tool[]): 'all' | 'some' | 'none' {
  const enabled = tools.filter((tool) => tool.enabled).length;
  if (enabled === 0) return 'none';
  return enabled === tools.length ? 'all' : 'some';
}

async function setEnabled(ids: string[], enabled: boolean, context: string) {
  if (ids.length === 0) return;
  busyGroup = context;
  try {
    const result = await api.post<{ tools: Tool[] }>('/api/tools/enabled', { ids, enabled });
    const changed = new Map(result.tools.map((tool) => [tool.id, tool.enabled]));
    // Native descriptors key off `rowId`, stored rows off `id`; update both lists so a
    // native group toggle and a stored group toggle share one code path.
    native = native.map((tool) =>
      tool.rowId && changed.has(tool.rowId) ? { ...tool, enabled: changed.get(tool.rowId)! } : tool
    );
    stored = stored.map((tool) =>
      changed.has(tool.id) ? { ...tool, enabled: changed.get(tool.id)! } : tool
    );
    pushToast({
      tone: 'success',
      title: `${pluralize(ids.length, 'tool')} ${enabled ? 'enabled' : 'disabled'}`,
      description: context
    });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not change availability',
      description: describeApiError(failure)
    });
  } finally {
    busyGroup = null;
  }
}

function toggleNativeGroup(tools: NativeToolDescriptor[], next: boolean) {
  const ids = tools.map((tool) => tool.rowId).filter((id): id is string => id !== null);
  void setEnabled(ids, next, 'Native capabilities');
}

function toggleStoredGroup(tools: Tool[], next: boolean) {
  void setEnabled(
    tools.map((tool) => tool.id),
    next,
    'Stored tools'
  );
}

function toggleNativeTool(tool: NativeToolDescriptor, enabled: boolean) {
  if (!tool.rowId) return;
  void setEnabled([tool.rowId], enabled, tool.key);
}

function toggleStoredTool(tool: Tool, enabled: boolean) {
  void setEnabled([tool.id], enabled, tool.key);
}

function operationHref(tool: Tool): string | null {
  const { serviceId, operationId } = tool.implementation;
  if (!serviceId || !operationId) return null;
  return `/http-services/${serviceId}/operations/${operationId}`;
}

function created(message: string) {
  pushToast({ tone: 'success', title: message });
  void load();
}
</script>

<svelte:head><title>Tools · Mentat</title></svelte:head>

<div class="space-y-5 p-4 md:p-6">
  <PageHeader
    title="Tools"
    description="Everything an agent can be granted, grouped by where it comes from. Native capabilities ship with Mentat; stored tools come from an HTTP operation or an MCP server. Switch a whole group off to make it unavailable, or add a new capability."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={() => (wizardOpen = true)}>Add a tool</Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <div class="space-y-5">
      {#each Array.from({ length: 3 }) as _, index (index)}
        <Card>
          <Skeleton lines={3} />
        </Card>
      {/each}
    </div>
  {:else if error}
    <ErrorState message={error.message} code={error.code} onRetry={load} />
  {:else}
    <Section
      title="How granting works"
      description="Availability is not the same as a grant. Switching a group on makes it grantable; an agent still needs the exact capability."
    >
      <ul class="space-y-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
        <li>
          <span class="font-medium text-[var(--color-ink)]">Native capabilities</span>
          are granted through the agent's
          <code class="font-mono text-[11px]">permissions.native</code> list, using the tool key
          such as <code class="font-mono text-[11px]">mentat.records.setFields</code>. The
          <code class="font-mono text-[11px]">permission</code> shown here is the workspace permission
          the runtime checks when the tool is called.
        </li>
        <li>
          <span class="font-medium text-[var(--color-ink)]">HTTP and MCP tools</span>
          have a row id and are granted through the agent's
          <code class="font-mono text-[11px]">toolIds</code> — attach them on the agent's Tools tab,
          where the same group toggles are available.
        </li>
        <li>
          <span class="font-medium text-[var(--color-ink)]">Approval is enforced by Mentat</span
          >, not by the model. A model can request a stored tool, but the runtime applies the
          approval and cache policy below before anything leaves the process.
        </li>
      </ul>
    </Section>

    <div class="max-w-md">
      <TextField
        label="Search tools"
        bind:value={search}
        size="sm"
        placeholder="Key, name or description…"
      />
    </div>

    <Section
      title="Native capabilities"
      description="Registered inside Mentat. They run in-process and are covered by a workspace permission rather than a connection. Toggle a group to make it grantable."
    >
      {#snippet actions()}
        <span class="text-[11px] text-[var(--color-ink-subtle)]">
          {pluralize(filteredNative.length, 'tool')}
        </span>
      {/snippet}

      {#if native.length === 0}
        <EmptyState
          title="No native capabilities reported"
          description="The server registry returned no tools. That usually means the instance has not finished starting up."
        />
      {:else if filteredNative.length === 0}
        <EmptyState
          title="No native tools match that search"
          description="Try a shorter term, or clear the search."
        />
      {:else}
        <div class="space-y-3">
          {#each nativeGroups as [namespace, tools] (namespace)}
            {@const enabled = tools.filter((tool) => tool.enabled).length}
            <ToolGroup
              name={namespace}
              count={tools.length}
              meta={`${enabled} of ${tools.length} available`}
              toggle={{
                state: nativeState(tools),
                onToggle: (next: boolean) => toggleNativeGroup(tools, next),
                disabled: busyGroup === 'Native capabilities',
                hint: 'Enable group'
              }}
            >
              <div class="grid gap-4 lg:grid-cols-2">
                {#each tools as tool (tool.key)}
                  <Card padding="sm" class="space-y-3 {tool.enabled ? '' : 'opacity-60'}">
                    <div class="space-y-1">
                      <div class="flex flex-wrap items-start justify-between gap-2">
                        <code class="font-mono text-xs font-medium text-[var(--color-ink)]"
                          >{tool.key}</code
                        >
                        <div class="flex items-center gap-1.5">
                          {#if !tool.enabled}
                            <Badge tone="caution">disabled</Badge>
                          {/if}
                          <Badge tone="accent">native</Badge>
                          <label
                            class="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--color-ink-subtle)]"
                            title={tool.enabled ? 'Disable this tool' : 'Enable this tool'}
                          >
                            <input
                              type="checkbox"
                              class="h-3.5 w-3.5 accent-[var(--color-accent)]"
                              checked={tool.enabled}
                              disabled={!tool.rowId || busyGroup !== null}
                              aria-label={`Enable ${tool.key}`}
                              onchange={(event) =>
                                toggleNativeTool(tool, event.currentTarget.checked)}
                            />
                            on
                          </label>
                        </div>
                      </div>
                      <p class="text-sm text-[var(--color-ink)]">{tool.name}</p>
                      <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
                        {tool.description}
                      </p>
                    </div>
                    <div class="space-y-1">
                      <p class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
                        Parameters
                      </p>
                      <ParameterList schema={tool.inputSchema} />
                    </div>
                    <p class="text-[11px] text-[var(--color-ink-subtle)]">
                      Required permission:
                      {#if tool.permission}
                        <code class="font-mono text-[var(--color-ink-muted)]">{tool.permission}</code>
                      {:else}
                        none beyond workspace membership
                      {/if}
                    </p>
                  </Card>
                {/each}
              </div>
            </ToolGroup>
          {/each}
        </div>
      {/if}
    </Section>

    <Section
      title="Stored tools"
      description="Derived from an HTTP operation or an MCP server. The backing object owns the request; the policy below is what Mentat enforces around it."
    >
      {#snippet actions()}
        <span class="text-[11px] text-[var(--color-ink-subtle)]">
          {pluralize(filteredStored.length, 'tool')}
          {#if mcpCount > 0}· {mcpCount} from MCP{/if}
        </span>
      {/snippet}

      {#if storedOnly.length === 0}
        <EmptyState
          title="No stored tools yet"
          description="Expose an HTTP operation as a tool, import an OpenAPI document, or connect an MCP server and it will appear here ready to grant to an agent."
        >
          <Button variant="primary" onclick={() => (wizardOpen = true)}>Add a tool</Button>
        </EmptyState>
      {:else if filteredStored.length === 0}
        <EmptyState
          title="No stored tools match that search"
          description="Try a shorter term, or clear the search."
        />
      {:else}
        <div class="space-y-3">
          {#each storedGroups as [namespace, tools] (namespace)}
            {@const enabled = tools.filter((tool) => tool.enabled).length}
            <ToolGroup
              name={namespace}
              count={tools.length}
              meta={`${enabled} of ${tools.length} available`}
              toggle={{
                state: storedState(tools),
                onToggle: (next: boolean) => toggleStoredGroup(tools, next),
                disabled: busyGroup === 'Stored tools',
                hint: 'Enable group'
              }}
            >
              <div class="grid gap-4 lg:grid-cols-2">
                {#each tools as tool (tool.id)}
                  {@const href = operationHref(tool)}
                  <Card padding="sm" class="space-y-3 {tool.enabled ? '' : 'opacity-60'}">
                    <div class="space-y-1">
                      <div class="flex flex-wrap items-start justify-between gap-2">
                        <code class="font-mono text-xs font-medium text-[var(--color-ink)]"
                          >{tool.key}</code
                        >
                        <div class="flex items-center gap-1.5">
                          {#if !tool.enabled}
                            <Badge tone="caution">disabled</Badge>
                          {/if}
                          <Badge tone={tool.kind === 'mcp' ? 'positive' : 'neutral'}>{tool.kind}</Badge>
                          <label
                            class="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--color-ink-subtle)]"
                            title={tool.enabled ? 'Disable this tool' : 'Enable this tool'}
                          >
                            <input
                              type="checkbox"
                              class="h-3.5 w-3.5 accent-[var(--color-accent)]"
                              checked={tool.enabled}
                              disabled={busyGroup !== null}
                              aria-label={`Enable ${tool.key}`}
                              onchange={(event) =>
                                toggleStoredTool(tool, event.currentTarget.checked)}
                            />
                            on
                          </label>
                        </div>
                      </div>
                      <p class="text-sm text-[var(--color-ink)]">{tool.name}</p>
                      <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
                        {tool.description}
                      </p>
                    </div>
                    {#if href}
                      <a
                        href={href}
                        class="inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
                      >
                        Backing operation
                        <code class="font-mono text-[11px]">{tool.implementation.operationId}</code>
                      </a>
                    {:else if tool.kind === 'mcp'}
                      <p class="text-[11px] text-[var(--color-ink-subtle)]">
                        MCP tool
                        <code class="font-mono text-[var(--color-ink-muted)]"
                          >{tool.implementation.toolName}</code
                        >
                        from server <code class="font-mono text-[var(--color-ink-muted)]"
                          >{tool.implementation.serverId}</code
                        >
                      </p>
                    {:else}
                      <p class="text-[11px] text-[var(--color-ink-subtle)]">
                        No backing HTTP operation is linked to this tool.
                      </p>
                    {/if}
                    <div class="space-y-1">
                      <p class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
                        Input parameters
                      </p>
                      <ParameterList
                        schema={tool.inputSchema}
                        emptyLabel="No declared input parameters."
                      />
                    </div>
                    <PolicySummary approval={tool.approvalPolicy} cache={tool.cachePolicy} />
                    <p class="text-[11px] text-[var(--color-ink-subtle)]">
                      Granted by tool id
                      <code class="font-mono text-[var(--color-ink-muted)]">{tool.id}</code>
                    </p>
                  </Card>
                {/each}
              </div>
            </ToolGroup>
          {/each}
        </div>
      {/if}
    </Section>
  {/if}
</div>

<NewToolWizard bind:open={wizardOpen} onclose={() => (wizardOpen = false)} oncreated={created} onchanged={load} />
