<script lang="ts">
/**
 * PageHeader: the consistent top of every work surface.
 *
 * A page needs a title, a one-line explanation of what the surface is for, and a
 * place for its primary actions. Stating the purpose inline is deliberate — the
 * brief calls for screens that explain themselves rather than leaving the user to
 * infer intent from an empty table.
 */
interface Props {
  title: string;
  description?: string;
  eyebrow?: string;
  class?: string;
  actions?: import('svelte').Snippet;
  children?: import('svelte').Snippet;
}
let { title, description, eyebrow, class: className = '', actions, children }: Props = $props();
</script>

<header class="flex flex-wrap items-start justify-between gap-3 {className}">
  <div class="min-w-0 space-y-1">
    {#if eyebrow}
      <p class="text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">{eyebrow}</p>
    {/if}
    <h1 class="text-lg font-semibold tracking-tight text-[var(--color-ink)]">{title}</h1>
    {#if description}
      <p class="max-w-2xl text-xs leading-relaxed text-[var(--color-ink-muted)]">{description}</p>
    {/if}
    {#if children}{@render children()}{/if}
  </div>
  {#if actions}
    <div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
  {/if}
</header>
