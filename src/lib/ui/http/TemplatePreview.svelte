<script lang="ts">
/**
 * TemplatePreview: renders a `{{param}}` template with placeholders highlighted, and
 * marks placeholders the operation does not declare. Path templates, raw bodies and
 * output templates all use it, so a missing parameter looks the same everywhere.
 */
import { templateSegments } from './template';

interface Props {
  value: string;
  missing?: string[];
  empty?: string;
  class?: string;
}

let { value, missing = [], empty = 'Nothing to preview.', class: className = '' }: Props = $props();

const missingNames = $derived(new Set(missing));
const segments = $derived(templateSegments(value));

function placeholderName(text: string): string {
  return text.replace(/[{}\s]/g, '');
}
</script>

{#if value.length === 0}
  <p class="text-xs text-[var(--color-ink-subtle)]">{empty}</p>
{:else}
  <p
    class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2 font-mono text-xs break-all text-[var(--color-ink)] {className}"
  >
    {#each segments as segment, index (index)}{#if segment.param}<span
          class="rounded-[var(--radius-xs)] px-0.5 {missingNames.has(placeholderName(segment.text))
            ? 'bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[var(--color-danger)]'
            : 'bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]'}">{segment.text}</span
        >{:else}{segment.text}{/if}{/each}
  </p>
{/if}
