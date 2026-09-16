<script lang="ts">
/**
 * Drawer: the ticket detail surface.
 *
 * Renders inside the page (not a portal) so URL state and scroll position are
 * preserved when it opens and closes. Escape closes it; focus is moved to the
 * panel so keyboard users are not stranded behind it.
 */
interface Props {
  open: boolean;
  title?: string;
  subtitle?: string;
  width?: string;
  onclose: () => void;
  children?: import('svelte').Snippet;
  header?: import('svelte').Snippet;
}
let { open, title, subtitle, width = '42rem', onclose, children, header }: Props = $props();

let panel: HTMLElement | undefined = $state();

$effect(() => {
  if (!open) return;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onclose();
  };
  document.addEventListener('keydown', onKey);
  panel?.focus();
  const previous = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = previous;
  };
});
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex justify-end" role="presentation">
    <button
      class="absolute inset-0 cursor-default bg-[color-mix(in_oklch,var(--color-ink)_28%,transparent)] backdrop-blur-[1px]"
      aria-label="Close panel"
      onclick={onclose}
    ></button>
    <section
      bind:this={panel}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      class="animate-fade-in relative flex h-full w-full max-w-full flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-canvas)] shadow-[var(--shadow-overlay)] outline-none"
      style="max-width: min({width}, 100vw)"
    >
      <header class="flex items-start justify-between gap-3 border-b border-[var(--color-border-subtle)] px-5 py-3.5">
        <div class="min-w-0 space-y-0.5">
          {#if header}
            {@render header()}
          {:else}
            {#if title}<h2 class="truncate text-sm font-semibold">{title}</h2>{/if}
            {#if subtitle}<p class="truncate text-xs text-[var(--color-ink-subtle)]">{subtitle}</p>{/if}
          {/if}
        </div>
        <button
          class="rounded-[var(--radius-sm)] p-1.5 text-[var(--color-ink-subtle)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
          aria-label="Close"
          onclick={onclose}
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <div class="scrollbar-thin flex-1 overflow-y-auto">{@render children?.()}</div>
    </section>
  </div>
{/if}
