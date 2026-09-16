<script lang="ts">
/**
 * OperationsTable: the semantic inventory of a service.
 *
 * It answers the operator's first question — "what can a model actually call here?" —
 * by showing tool exposure and enabled state next to the transport details.
 */
import { formatRelative } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import type { HttpOperation } from './types';
import { HTTP_METHOD_TONES, type HttpMethod } from './types';

interface Props {
  serviceId: string;
  operations: HttpOperation[];
}

let { serviceId, operations }: Props = $props();

function tone(method: string): 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted' {
  return HTTP_METHOD_TONES[method as HttpMethod] ?? 'neutral';
}
</script>

<div class="overflow-x-auto">
  <table class="w-full min-w-[44rem] border-collapse text-sm">
    <thead>
      <tr class="border-b border-[var(--color-border-subtle)] text-left text-[11px] tracking-wide text-[var(--color-ink-subtle)] uppercase">
        <th class="py-2 pr-3 font-medium">Key</th>
        <th class="py-2 pr-3 font-medium">Method</th>
        <th class="py-2 pr-3 font-medium">Path</th>
        <th class="py-2 pr-3 font-medium">Tool</th>
        <th class="py-2 pr-3 font-medium">Enabled</th>
        <th class="py-2 pr-3 font-medium">Updated</th>
      </tr>
    </thead>
    <tbody>
      {#each operations as operation (operation.id)}
        <tr class="border-b border-[var(--color-border-subtle)] last:border-0 hover:bg-[var(--color-surface-muted)]">
          <td class="py-2 pr-3">
            <a
              class="font-mono text-xs text-[var(--color-accent-ink)] hover:underline"
              href={`/http-services/${serviceId}/operations/${operation.id}`}
            >
              {operation.key}
            </a>
          </td>
          <td class="py-2 pr-3"><Badge tone={tone(operation.method)}>{operation.method}</Badge></td>
          <td class="max-w-[16rem] truncate py-2 pr-3 font-mono text-xs text-[var(--color-ink-muted)]" title={operation.path}>
            {operation.path}
          </td>
          <td class="py-2 pr-3">
            {#if operation.exposeAsTool && operation.enabled}
              <Badge tone="accent">exposed</Badge>
            {:else}
              <Badge tone="muted">hidden</Badge>
            {/if}
          </td>
          <td class="py-2 pr-3">
            <Badge tone={operation.enabled ? 'positive' : 'muted'}>
              {operation.enabled ? 'enabled' : 'disabled'}
            </Badge>
          </td>
          <td class="py-2 pr-3 text-xs text-[var(--color-ink-subtle)]">
            {formatRelative(operation.updatedAt)}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
