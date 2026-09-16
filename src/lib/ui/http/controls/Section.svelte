<script lang="ts">
/**
 * Section: a titled card. Configuration surfaces are long, so each block owns a
 * heading, a one-line explanation of *why* the setting exists, and optional actions.
 */
import type { Snippet } from 'svelte';

interface Props {
  title: string;
  description?: string;
  actions?: Snippet;
  children?: Snippet;
  class?: string;
}

let { title, description, actions, children, class: className = '' }: Props = $props();
</script>

<section
  class="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] {className}"
>
  <header
    class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3"
  >
    <div class="min-w-0 space-y-0.5">
      <h2 class="text-sm font-semibold text-[var(--color-ink)]">{title}</h2>
      {#if description}
        <p class="max-w-3xl text-xs leading-relaxed text-[var(--color-ink-subtle)]">{description}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
    {/if}
  </header>
  <div class="space-y-4 p-4">{@render children?.()}</div>
</section>
