<script lang="ts">
/**
 * Badge: compact status or label chip. Colour comes from a token set so a badge
 * always reads as "state", never as decoration.
 */
interface Props {
  tone?: 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted';
  size?: 'sm' | 'md';
  dot?: boolean;
  class?: string;
  children?: import('svelte').Snippet;
}
let {
  tone = 'neutral',
  size = 'sm',
  dot = false,
  class: className = '',
  children
}: Props = $props();

const tones: Record<string, string> = {
  neutral:
    'bg-[var(--color-surface-muted)] text-[var(--color-ink-muted)] border-[var(--color-border-subtle)]',
  accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)] border-transparent',
  positive:
    'bg-[color-mix(in_oklch,var(--color-positive)_18%,transparent)] text-[var(--color-positive)] border-transparent',
  caution:
    'bg-[color-mix(in_oklch,var(--color-caution)_22%,transparent)] text-[color-mix(in_oklch,var(--color-caution)_70%,var(--color-ink))] border-transparent',
  danger:
    'bg-[color-mix(in_oklch,var(--color-danger)_16%,transparent)] text-[var(--color-danger)] border-transparent',
  muted: 'bg-transparent text-[var(--color-ink-subtle)] border-[var(--color-border-subtle)]'
};
const sizes = { sm: 'h-5 px-1.5 text-[11px] gap-1', md: 'h-6 px-2 text-xs gap-1.5' } as const;
</script>

<span
  class="inline-flex items-center rounded-full border font-medium whitespace-nowrap {tones[tone]} {sizes[size]} {className}"
>
  {#if dot}<span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true"></span>{/if}
  {@render children?.()}
</span>
