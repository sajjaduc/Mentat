<script lang="ts">
  /** EmptyState: explains what this space is for and what to do next. */
  interface Props { title: string; description?: string; class?: string; children?: import('svelte').Snippet }
  let { title, description, class: className = '', children }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center {className}">
  <div class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[var(--color-ink-subtle)]">
    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M4 7h16M4 12h10M4 17h7" stroke-linecap="round" />
    </svg>
  </div>
  <div class="space-y-1">
    <p class="text-sm font-medium text-[var(--color-ink)]">{title}</p>
    {#if description}<p class="mx-auto max-w-sm text-xs leading-relaxed text-[var(--color-ink-subtle)]">{description}</p>{/if}
  </div>
  {@render children?.()}
</div>
