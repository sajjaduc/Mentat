<script lang="ts">
  /**
   * Card: the default surface for grouped content. `interactive` adds the hover and
   * focus treatment used by board cards and list rows.
   */
  interface Props {
    padding?: 'none' | 'sm' | 'md' | 'lg';
    interactive?: boolean;
    selected?: boolean;
    class?: string;
    children?: import('svelte').Snippet;
  }
  let { padding = 'md', interactive = false, selected = false, class: className = '', children }: Props = $props();

  const paddings = { none: '', sm: 'p-2.5', md: 'p-4', lg: 'p-6' } as const;
</script>

<div
  class="rounded-[var(--radius-lg)] border bg-[var(--color-surface)] shadow-[var(--shadow-card)]
    {selected ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent-soft)]' : 'border-[var(--color-border-subtle)]'}
    {interactive ? 'cursor-pointer transition-[border-color,box-shadow,transform] duration-150 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-raised)]' : ''}
    {paddings[padding]} {className}"
>
  {@render children?.()}
</div>
