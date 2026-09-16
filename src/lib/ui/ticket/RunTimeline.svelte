<script lang="ts">
/**
 * A run rendered as a readable timeline.
 *
 * The timeline is the flagship execution surface: context assembly, assistant
 * messages, tool calls with their arguments and results, errors, approvals,
 * retries and the final transition, each as a row with its timing. Raw payloads
 * stay available behind a disclosure instead of dominating the view.
 */
import { formatDateTime, formatDurationShort, formatNumber, formatRelative } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import { runStatusLabel, runStatusTone } from '$ui/work/format';
import JsonBlock from '$ui/work/JsonBlock.svelte';
import type { AgentRun, AgentRunStep, ApprovalRequest, RunUsage } from '$ui/work/types';

interface Props {
  run: AgentRun;
  steps: AgentRunStep[];
  agentName: string | null;
  agentVersion: number | null;
  transitionNames: Record<string, string>;
  approvals: ApprovalRequest[];
  liveText: string;
  onCancel?: (runId: string) => void;
}

let { run, steps, agentName, agentVersion, transitionNames, approvals, liveText, onCancel }: Props =
  $props();

function stepText(step: AgentRunStep): string {
  if (typeof step.output === 'string') return step.output;
  if (step.output && typeof step.output === 'object') {
    const record = step.output as Record<string, unknown>;
    for (const key of ['text', 'content', 'message', 'summary']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  if (typeof step.input === 'string') return step.input;
  return '';
}

function usageLine(usage: RunUsage | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${formatNumber(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${formatNumber(usage.outputTokens)} out`);
  if (usage.totalTokens !== undefined) parts.push(`${formatNumber(usage.totalTokens)} total`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const live = $derived(run.status === 'running' || run.status === 'queued');
const tokens = $derived(usageLine(run.usage));
const requestedName = $derived(
  run.requestedTransitionId
    ? (transitionNames[run.requestedTransitionId] ?? run.requestedTransitionId)
    : null
);
const appliedName = $derived(
  run.appliedTransitionId
    ? (transitionNames[run.appliedTransitionId] ?? run.appliedTransitionId)
    : null
);
</script>

<article class="space-y-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
  <header class="flex flex-wrap items-center gap-2">
    <Badge tone={runStatusTone(run.status)} dot={true}>{runStatusLabel(run.status)}</Badge>
    <span class="text-xs font-medium">{agentName ?? 'Agent'}</span>
    {#if agentVersion !== null}<span class="text-[11px] text-[var(--color-ink-subtle)]"
        >v{agentVersion}</span
      >{/if}
    <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{run.modelKey ?? 'no model'}</span>
    {#if run.attempt > 1}<Badge tone="caution">Attempt {run.attempt}</Badge>{/if}
    {#if run.cacheStatus}<Badge tone="muted">cache {run.cacheStatus}</Badge>{/if}
    {#if run.triggerType}<span class="text-[11px] text-[var(--color-ink-subtle)]"
        >{run.triggerType.replace('_', ' ')}</span
      >{/if}
    <span class="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-ink-subtle)]">
      {#if run.startedAt}
        <span title={formatDateTime(run.startedAt)}>{formatRelative(run.startedAt)}</span>
      {/if}
      <span>{formatDurationShort(run.durationMs)}</span>
    </span>
  </header>

  <dl class="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
    <div class="flex gap-1.5">
      <dt class="text-[var(--color-ink-subtle)]">Started</dt>
      <dd>{formatDateTime(run.startedAt)}</dd>
    </div>
    <div class="flex gap-1.5">
      <dt class="text-[var(--color-ink-subtle)]">Finished</dt>
      <dd>{formatDateTime(run.finishedAt)}</dd>
    </div>
    {#if tokens}
      <div class="flex gap-1.5">
        <dt class="text-[var(--color-ink-subtle)]">Tokens</dt>
        <dd>{tokens}</dd>
      </div>
    {/if}
    {#if requestedName}
      <div class="flex gap-1.5">
        <dt class="text-[var(--color-ink-subtle)]">Requested transition</dt>
        <dd>{requestedName}</dd>
      </div>
    {/if}
    {#if appliedName}
      <div class="flex gap-1.5">
        <dt class="text-[var(--color-ink-subtle)]">Applied transition</dt>
        <dd>{appliedName}</dd>
      </div>
    {/if}
  </dl>

  {#if run.error}
    <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] p-2 text-xs text-[var(--color-danger)]" role="alert">
      {run.errorCode ? `${run.errorCode}: ` : ''}{run.error}
    </p>
  {/if}

  {#if live}
    <div class="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent-soft)] p-2">
      <span class="animate-pulse-ring h-2 w-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true"></span>
      <span class="text-xs text-[var(--color-accent-ink)]">
        {liveText === '' ? 'Generating…' : 'Live output'}
      </span>
      {#if onCancel}
        <span class="ml-auto">
          <Button size="sm" variant="ghost" onclick={() => onCancel?.(run.id)}>Cancel</Button>
        </span>
      {/if}
    </div>
  {/if}

  {#if liveText !== ''}
    <pre class="scrollbar-thin max-h-72 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2 font-mono text-[11px] whitespace-pre-wrap">{liveText}</pre>
  {/if}

  {#if steps.length === 0 && !live && liveText === ''}
    <p class="text-xs text-[var(--color-ink-subtle)]">
      This run recorded no steps. Its output is shown below if the agent produced any.
    </p>
  {/if}

  <ol class="space-y-2">
    {#each steps as step (step.id)}
      <li class="border-l-2 border-[var(--color-border-subtle)] pl-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[11px] font-medium text-[var(--color-ink-muted)]">
            {step.type === 'tool_call'
              ? `Tool call · ${step.name ?? step.toolKey ?? 'tool'}`
              : step.type === 'tool_result'
                ? `Tool result · ${step.name ?? step.toolKey ?? 'tool'}`
                : step.type === 'context'
                  ? 'Context assembled'
                  : step.type === 'field_change'
                    ? 'Field change'
                    : step.type === 'approval'
                      ? 'Approval'
                      : step.type === 'transition'
                        ? 'Transition'
                        : step.type === 'state'
                          ? 'State'
                          : step.type === 'note'
                            ? 'Note'
                            : step.type === 'error'
                              ? 'Error'
                              : step.type === 'thought'
                                ? 'Reasoning'
                                : 'Message'}
          </span>
          {#if step.status === 'failed'}<Badge tone="danger">failed</Badge>{/if}
          <span class="text-[10px] text-[var(--color-ink-subtle)]"
            >{formatDurationShort(step.durationMs)}</span
          >
        </div>

        {#if step.type === 'message' || step.type === 'thought'}
          {#if stepText(step)}
            <p class="mt-1 text-xs whitespace-pre-wrap">{stepText(step)}</p>
          {/if}
          {#if step.input !== null && step.input !== undefined}
            <div class="mt-1"><JsonBlock value={step.input} label="Input" /></div>
          {/if}
        {:else if step.type === 'tool_call'}
          <div class="mt-1"><JsonBlock value={step.input} label="Arguments" /></div>
          {#if step.metadata}
            <div class="mt-1"><JsonBlock value={step.metadata} label="Metadata" /></div>
          {/if}
        {:else if step.type === 'tool_result'}
          <div class="mt-1"><JsonBlock value={step.output} label="Result" /></div>
        {:else if step.type === 'context'}
          <div class="mt-1">
            <JsonBlock value={step.input ?? step.output} label="Included sections" open={true} />
          </div>
        {:else if step.type === 'error'}
          <p class="mt-1 text-xs text-[var(--color-danger)]" role="alert">
            {step.error ?? stepText(step)}
          </p>
        {:else}
          {#if stepText(step)}
            <p class="mt-1 text-xs whitespace-pre-wrap">{stepText(step)}</p>
          {/if}
          {#if step.input !== null && step.input !== undefined}
            <div class="mt-1"><JsonBlock value={step.input} label="Before" /></div>
          {/if}
          {#if step.output !== null && step.output !== undefined}
            <div class="mt-1"><JsonBlock value={step.output} label="After" /></div>
          {/if}
        {/if}

        {#if step.error && step.type !== 'error'}
          <p class="mt-1 text-xs text-[var(--color-danger)]">{step.error}</p>
        {/if}
      </li>
    {/each}
  </ol>

  {#if run.outputText}
    <div>
      <p class="text-[11px] font-medium text-[var(--color-ink-subtle)] uppercase">Final output</p>
      <pre class="scrollbar-thin mt-1 max-h-72 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2 font-mono text-[11px] whitespace-pre-wrap">{run.outputText}</pre>
    </div>
  {:else if run.output !== null && run.output !== undefined}
    <JsonBlock value={run.output} label="Final output" />
  {/if}

  {#if approvals.length > 0}
    <div class="space-y-1 border-t border-[var(--color-border-subtle)] pt-2">
      <p class="text-[11px] font-medium text-[var(--color-ink-subtle)] uppercase">Approvals</p>
      {#each approvals as approval (approval.id)}
        <a
          href={`/approvals?ticketId=${approval.ticketId ?? ''}`}
          class="flex items-center gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
        >
          <Badge tone={approval.status === 'pending' ? 'caution' : approval.status === 'approved' ? 'positive' : 'danger'}>
            {approval.status}
          </Badge>
          <span class="truncate">{approval.title}</span>
        </a>
      {/each}
    </div>
  {/if}
</article>
