<script lang="ts">
/**
 * RequestLogsPanel: the redacted request history for an operation or service.
 *
 * Every row comes from `http_request_logs`, which the runtime writes with secrets
 * already masked, so this panel can show headers and bodies without a second redaction
 * step. Expanding a row is the "detail view of the redacted exchange".
 */
import { formatDateTime, formatDurationShort } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import CodeBlock from './controls/CodeBlock.svelte';
import StatusBadge from './controls/StatusBadge.svelte';
import type { HttpRequestLog } from './types';
import { HTTP_METHOD_TONES, type HttpMethod } from './types';

interface Props {
  logs: HttpRequestLog[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  emptyLabel?: string;
}

let {
  logs,
  loading,
  error,
  onRefresh,
  emptyLabel = 'No requests have been made for this operation yet.'
}: Props = $props();

let expanded = $state<string | null>(null);

function toggle(id: string) {
  expanded = expanded === id ? null : id;
}

function headerText(headers: Record<string, string> | null): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function methodTone(
  method: string
): 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted' {
  return HTTP_METHOD_TONES[method as HttpMethod] ?? 'neutral';
}
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between gap-2">
    <p class="text-xs text-[var(--color-ink-subtle)]">
      {logs.length} request{logs.length === 1 ? '' : 's'} recorded. Headers and bodies are stored
      redacted.
    </p>
    <Button size="sm" variant="ghost" onclick={onRefresh} loading={loading}>Refresh</Button>
  </div>

  {#if error}
    <p class="text-xs text-[var(--color-danger)]">{error}</p>
  {:else if loading && logs.length === 0}
    <p class="text-xs text-[var(--color-ink-subtle)]">Loading requests…</p>
  {:else if logs.length === 0}
    <p
      class="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-subtle)] px-3 py-3 text-xs text-[var(--color-ink-subtle)]"
    >
      {emptyLabel}
    </p>
  {:else}
    <ul class="scrollbar-thin max-h-96 space-y-1 overflow-y-auto">
      {#each logs as log (log.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]">
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-surface-muted)]"
            aria-expanded={expanded === log.id}
            onclick={() => toggle(log.id)}
          >
            <Badge tone={methodTone(log.method)}>{log.method}</Badge>
            <StatusBadge status={log.responseStatus} label={log.error ? 'failed' : undefined} />
            <span class="font-mono text-[11px] text-[var(--color-ink-muted)]">
              {formatDurationShort(log.latencyMs)}
            </span>
            <span class="text-[11px] text-[var(--color-ink-subtle)]">
              {log.attempt} attempt{log.attempt === 1 ? '' : 's'}
            </span>
            {#if log.cacheStatus}
              <span class="text-[11px] text-[var(--color-ink-subtle)]">cache {log.cacheStatus}</span>
            {/if}
            {#if log.fromTestConsole}
              <span class="text-[11px] text-[var(--color-ink-subtle)]">test console</span>
            {/if}
            <span class="ml-auto text-[11px] text-[var(--color-ink-subtle)]">
              {formatDateTime(log.createdAt)}
            </span>
          </button>

          {#if expanded === log.id}
            <div class="space-y-3 border-t border-[var(--color-border-subtle)] px-3 py-3">
              <p class="font-mono text-[11px] break-all text-[var(--color-ink-muted)]">{log.url}</p>
              {#if log.error}
                <p class="text-xs text-[var(--color-danger)]">
                  {log.errorCode ? `${log.errorCode}: ` : ''}{log.error}
                </p>
              {/if}
              <CodeBlock value={headerText(log.requestHeaders)} label="Request headers" maxHeight="10rem" emptyLabel="No headers recorded." />
              {#if log.requestBody}
                <CodeBlock value={log.requestBody} label="Request body" maxHeight="12rem" />
              {/if}
              <CodeBlock value={headerText(log.responseHeaders)} label="Response headers" maxHeight="10rem" emptyLabel="No response headers recorded." />
              {#if log.responseBodyPreview}
                <CodeBlock value={log.responseBodyPreview} label="Response body (preview)" maxHeight="14rem" />
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
