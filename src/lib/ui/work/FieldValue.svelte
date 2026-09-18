<script lang="ts">
/**
 * Read-only rendering of a typed field value.
 *
 * One component understands all fifteen field types so the board card, the list
 * and the workItem overview cannot disagree about how a currency or a multi-select
 * is displayed.
 */
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import type { FieldDefinition, FieldOptions, MemberOption, TeamOption } from '$ui/work/types';

interface Props {
  type: FieldDefinition['type'];
  options?: FieldOptions | null;
  value: unknown;
  members?: MemberOption[];
  teams?: TeamOption[];
  compact?: boolean;
}

let { type, options = null, value, members = [], teams = [], compact = false }: Props = $props();

const choices = $derived(options?.choices ?? []);

function choiceLabel(entry: string): string {
  return choices.find((choice) => choice.value === entry)?.label ?? entry;
}

function personName(id: string): string {
  return members.find((member) => member.userId === id)?.name ?? id.slice(0, 8);
}

function teamName(id: string): string {
  return teams.find((team) => team.id === id)?.name ?? id.slice(0, 8);
}

const isEmpty = $derived(value === null || value === undefined || value === '');
const asList = $derived(Array.isArray(value) ? value : []);
</script>

{#if isEmpty}
  <span class="text-xs text-[var(--color-ink-subtle)]">—</span>
{:else if type === 'boolean'}
  <Badge tone={value === true ? 'positive' : 'neutral'}>{value === true ? 'Yes' : 'No'}</Badge>
{:else if type === 'number'}
  <span class="font-mono text-xs">{formatNumber(Number(value))}</span>
{:else if type === 'currency'}
  <span class="font-mono text-xs">{formatCurrency(Number(value), options?.currency ?? 'USD')}</span>
{:else if type === 'date'}
  <span class="text-xs">{formatDate(Number(value))}</span>
{:else if type === 'datetime'}
  <span class="text-xs">{formatDateTime(Number(value))}</span>
{:else if type === 'select'}
  <Badge tone="accent">{choiceLabel(String(value))}</Badge>
{:else if type === 'multi_select'}
  <span class="flex flex-wrap gap-1">
    {#each asList as entry (String(entry))}
      <Badge tone="neutral">{choiceLabel(String(entry))}</Badge>
    {/each}
  </span>
{:else if type === 'user'}
  <span class="text-xs">{personName(String(value))}</span>
{:else if type === 'team'}
  <span class="text-xs">{teamName(String(value))}</span>
{:else if type === 'url'}
  <a
    class="text-xs text-[var(--color-accent)] underline decoration-dotted"
    href={String(value)}
    target="_blank"
    rel="noreferrer noopener">{String(value)}</a
  >
{:else if type === 'email'}
  <a class="text-xs text-[var(--color-accent)] underline decoration-dotted" href="mailto:{String(value)}"
    >{String(value)}</a
  >
{:else if type === 'phone'}
  <a class="text-xs text-[var(--color-accent)] underline decoration-dotted" href="tel:{String(value)}"
    >{String(value)}</a
  >
{:else if type === 'json'}
  <pre
    class="max-h-40 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] p-2 font-mono text-[11px] whitespace-pre-wrap">{typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2)}</pre>
{:else if type === 'long_text'}
  <p class="text-xs whitespace-pre-wrap text-[var(--color-ink-muted)]" class:line-clamp-2={compact}
    >{String(value)}</p
  >
{:else}
  <span class="text-xs" class:truncate={compact} title={compact ? String(value) : undefined}
    >{String(value)}</span
  >
{/if}
