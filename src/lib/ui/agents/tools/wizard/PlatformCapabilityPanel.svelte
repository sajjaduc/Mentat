<script lang="ts">
/**
 * Platform capability panel.
 *
 * The first thing an operator should learn is what they do *not* have to build:
 * Mentat ships a set of native capabilities (tickets, state, data, files) that run
 * in-process. This panel exposes them, grouped, and points at the one place a grant
 * actually happens — an agent's Permissions tab.
 */
import { goto } from '$app/navigation';
import type { NativeToolDescriptor } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { groupByNamespace } from '../namespaces';
import ToolGroup from '../ToolGroup.svelte';

interface Props {
  onBack: () => void;
  onDone: (message: string) => void;
}

let { onBack, onDone }: Props = $props();

let native = $state<NativeToolDescriptor[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const result = await api.get<{ native: NativeToolDescriptor[] }>('/api/tools');
    native = result.native;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

const groups = $derived(groupByNamespace(native, (tool) => tool.key));
</script>

{#if loading}
  <Skeleton lines={4} height="2rem" />
{:else if error}
  <ErrorState message={error} onRetry={load} />
{:else}
  <div class="space-y-4">
    <div
      class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2.5"
    >
      <p class="text-sm font-medium text-[var(--color-ink)]">
        These {native.length} capabilities are built into Mentat
      </p>
      <p class="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-muted)]">
        They need no connection, credential or import. Toggle the entire namespace on the
        Tools page to make it available, then grant the exact capabilities to an agent on
        its <span class="font-medium text-[var(--color-ink)]">Permissions</span> tab.
      </p>
    </div>

    <div class="space-y-2">
      {#each groups as [namespace, tools] (namespace)}
        {@const enabled = tools.filter((tool) => tool.enabled).length}
        <ToolGroup name={namespace} count={tools.length} meta={`${enabled} available`} defaultOpen={false}>
          <ul class="space-y-2">
            {#each tools as tool (tool.key)}
              <li class="space-y-0.5">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono text-xs text-[var(--color-ink)]">{tool.key}</span>
                  {#if tool.permission !== null}
                    <Badge tone="neutral">{tool.permission}</Badge>
                  {/if}
                  {#if !tool.enabled}
                    <Badge tone="caution">disabled</Badge>
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

    <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
      <Button variant="ghost" onclick={onBack}>Back</Button>
      <div class="flex items-center gap-2">
        <Button variant="secondary" onclick={() => onDone('Nothing to create — capabilities are built in')}>
          Close
        </Button>
        <Button
          variant="primary"
          onclick={() => {
            onDone('Grant capabilities from an agent');
            void goto('/agents');
          }}
        >
          Grant from an agent
        </Button>
      </div>
    </div>
  </div>
{/if}
