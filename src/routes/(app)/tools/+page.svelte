<script lang="ts">
/**
 * Tools catalogue.
 *
 * Read-only by design: a native tool is registered in the server's in-process
 * registry, and a stored tool is derived from an HTTP operation. Editing either one
 * belongs to its owner — the HTTP service editor or the agent — so this page exists to
 * answer "what can an agent be granted, and what will Mentat enforce?" It deliberately
 * offers no write action.
 *
 * Approval and caching are enforced by Mentat before and around the call; a model can
 * request a tool, never bypass the policy attached to it.
 */

import { pluralize } from '$shared/format';
import { groupByNamespace, ParameterList, PolicySummary } from '$ui/agents/tools';
import type { NativeToolDescriptor, Tool } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';

let native = $state<NativeToolDescriptor[]>([]);
let stored = $state<Tool[]>([]);
let loading = $state(true);
let error = $state<{ message: string; code: string | null } | null>(null);
let search = $state('');

const filteredNative = $derived.by(() => {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return native;
  return native.filter(
    (tool) =>
      tool.key.toLowerCase().includes(needle) ||
      tool.name.toLowerCase().includes(needle) ||
      tool.description.toLowerCase().includes(needle)
  );
});

const filteredStored = $derived.by(() => {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return stored;
  return stored.filter(
    (tool) =>
      tool.key.toLowerCase().includes(needle) ||
      tool.name.toLowerCase().includes(needle) ||
      tool.description.toLowerCase().includes(needle)
  );
});

const nativeGroups = $derived(groupByNamespace(filteredNative, (tool) => tool.key));
const storedGroups = $derived(groupByNamespace(filteredStored, (tool) => tool.key));

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

function operationHref(tool: Tool): string | null {
  const { serviceId, operationId } = tool.implementation;
  if (!serviceId || !operationId) return null;
  return `/http-services/${serviceId}/operations/${operationId}`;
}
</script>

<svelte:head><title>Tools · Mentat</title></svelte:head>

<div class="p-4 md:p-6 space-y-5">
  <PageHeader
    title="Tools"
    description="Everything an agent can be granted. Native capabilities are registered by Mentat; stored tools are derived from HTTP operations. This catalogue is read-only."
  />

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
      description="Reading the catalogue is not the same as granting; these are the two ways an agent can be given a tool."
    >
      <ul class="space-y-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
        <li>
          <span class="font-medium text-[var(--color-ink)]">Native capabilities</span>
          are granted through the agent's
          <code class="font-mono text-[11px]">permissions.native</code> list, using the tool key
          such as <code class="font-mono text-[11px]">mentat.ticket.fields.set</code>. The
          <code class="font-mono text-[11px]">permission</code> shown here is the workspace permission
          the runtime checks when the tool is called.
        </li>
        <li>
          <span class="font-medium text-[var(--color-ink)]">Stored tools</span>
          have a row id and are granted through the agent's
          <code class="font-mono text-[11px]">toolIds</code>, which reference those ids.
        </li>
        <li>
          <span class="font-medium text-[var(--color-ink)]">Approval is enforced by Mentat</span
          >, not by the model. A model can request a stored tool, but the runtime applies the
          approval and cache policy below before anything leaves the process.
        </li>
        <li>
          Editing happens on the owning surface: change a stored tool's HTTP behaviour in its
          service's operation editor, and change what an agent may use in the agent itself.
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
      description="Registered inside Mentat. They run in-process and are covered by a workspace permission rather than an HTTP policy."
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
        {#each nativeGroups as [namespace, tools] (namespace)}
          <div class="space-y-3">
            <h3 class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
              {namespace} · {pluralize(tools.length, 'tool')}
            </h3>
            <div class="grid gap-4 lg:grid-cols-2">
              {#each tools as tool (tool.key)}
                <Card padding="sm" class="space-y-3">
                  <div class="space-y-1">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <code class="font-mono text-xs font-medium text-[var(--color-ink)]"
                        >{tool.key}</code
                      >
                      <Badge tone="accent">native</Badge>
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
          </div>
        {/each}
      {/if}
    </Section>

    <Section
      title="Stored tools"
      description="Derived from an HTTP operation. The backing operation owns the request; the policy below is what Mentat enforces around it."
    >
      {#snippet actions()}
        <span class="text-[11px] text-[var(--color-ink-subtle)]">
          {pluralize(filteredStored.length, 'tool')}
        </span>
      {/snippet}

      {#if stored.length === 0}
        <EmptyState
          title="No stored tools yet"
          description="Expose an HTTP operation as a tool from its service editor, and it will appear here ready to grant to an agent."
        />
      {:else if filteredStored.length === 0}
        <EmptyState
          title="No stored tools match that search"
          description="Try a shorter term, or clear the search."
        />
      {:else}
        {#each storedGroups as [namespace, tools] (namespace)}
          <div class="space-y-3">
            <h3 class="text-[11px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
              {namespace} · {pluralize(tools.length, 'tool')}
            </h3>
            <div class="grid gap-4 lg:grid-cols-2">
              {#each tools as tool (tool.id)}
                {@const href = operationHref(tool)}
                <Card padding="sm" class="space-y-3">
                  <div class="space-y-1">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <code class="font-mono text-xs font-medium text-[var(--color-ink)]"
                        >{tool.key}</code
                      >
                      <Badge tone={tool.kind === 'http' ? 'neutral' : 'accent'}>{tool.kind}</Badge>
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
          </div>
        {/each}
      {/if}
    </Section>
  {/if}
</div>
