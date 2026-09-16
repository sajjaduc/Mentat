<script lang="ts">
/** Modal: centred dialog for focused, blocking decisions (create, approve, connect). */
interface Props {
  open: boolean;
  title: string;
  description?: string;
  width?: string;
  onclose: () => void;
  footer?: import('svelte').Snippet;
  children?: import('svelte').Snippet;
}
let { open, title, description, width = '30rem', onclose, footer, children }: Props = $props();

let panel: HTMLElement | undefined = $state();
$effect(() => {
  if (!open) return;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onclose();
  };
  document.addEventListener('keydown', onKey);
  panel?.focus();
  return () => document.removeEventListener('keydown', onKey);
});
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      class="absolute inset-0 cursor-default bg-[color-mix(in_oklch,var(--color-ink)_30%,transparent)] backdrop-blur-[1px]"
      aria-label="Close dialog"
      onclick={onclose}
    ></button>
    <div
      bind:this={panel}
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      class="animate-pop-in relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-[var(--shadow-overlay)] outline-none"
      style="max-width: {width}"
    >
      <header class="space-y-1 px-5 pt-5">
        <h2 class="text-base font-semibold">{title}</h2>
        {#if description}<p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">{description}</p>{/if}
      </header>
      <div class="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">{@render children?.()}</div>
      {#if footer}
        <footer class="flex items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-5 py-3">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
