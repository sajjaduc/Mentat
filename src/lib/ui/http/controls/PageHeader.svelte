<script lang="ts">
/**
 * PageHeader: the title block every configuration page opens with. `actions` is the
 * page's primary affordance; `backHref` turns the header into a breadcrumb for
 * detail routes without a second row of chrome.
 */
import type { Snippet } from 'svelte';

interface Props {
  title: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
  actions?: Snippet;
}

let { title, description, backHref, backLabel = 'Back', actions }: Props = $props();
</script>

<div class="flex flex-wrap items-start justify-between gap-3">
  <div class="min-w-0 space-y-1">
    {#if backHref}
      <a
        href={backHref}
        class="inline-flex items-center gap-1 text-xs text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        {backLabel}
      </a>
    {/if}
    <h1 class="text-lg font-semibold tracking-tight text-[var(--color-ink)]">{title}</h1>
    {#if description}
      <p class="max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
  {/if}
</div>
