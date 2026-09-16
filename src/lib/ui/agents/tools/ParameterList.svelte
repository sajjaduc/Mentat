<script lang="ts">
/**
 * ParameterList: a JSON Schema rendered as the rows a person can read.
 *
 * The tool catalogue and the recommended-tool picker both answer "what does this
 * tool expect?", and a raw schema dump is not an answer. `schemaFields` flattens the
 * top level; this component is only the table around it. A schema with no object
 * properties renders the honest empty line instead of an empty table.
 */
import { schemaFields } from '$ui/http/json';

interface Props {
  /** The tool's `inputSchema` (from the API, typed as `unknown`). */
  schema: unknown;
  emptyLabel?: string;
  class?: string;
}

let {
  schema,
  emptyLabel = 'This tool takes no named parameters.',
  class: className = ''
}: Props = $props();

const fields = $derived(schemaFields(schema));
</script>

{#if fields.length === 0}
  <p class="text-xs text-[var(--color-ink-subtle)]">{emptyLabel}</p>
{:else}
  <ul class="divide-y divide-[var(--color-border-subtle)] {className}">
    {#each fields as field (field.name)}
      <li class="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
        <code class="font-mono text-xs text-[var(--color-ink)]">{field.name}</code>
        <span
          class="rounded-full border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-subtle)]"
        >
          {field.type}
        </span>
        {#if field.required}
          <span class="text-[11px] font-medium text-[var(--color-caution)]">required</span>
        {:else}
          <span class="text-[11px] text-[var(--color-ink-subtle)]">optional</span>
        {/if}
        {#if field.defaultValue !== undefined}
          <span class="text-[11px] text-[var(--color-ink-subtle)]">
            default
            <code class="font-mono">{JSON.stringify(field.defaultValue)}</code>
          </span>
        {/if}
        {#if field.description}
          <p class="w-full text-xs leading-relaxed text-[var(--color-ink-muted)]">
            {field.description}
          </p>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
