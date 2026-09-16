<script lang="ts">
/**
 * Button.
 *
 * Variants map onto intent rather than colour names, so a screen cannot invent a
 * sixth shade of blue. `loading` swaps the label for a spinner but keeps the
 * button's width, which prevents the layout jump that usually accompanies it.
 */
import type { HTMLButtonAttributes } from 'svelte/elements';

interface Props extends HTMLButtonAttributes {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
}

let {
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  class: className = '',
  children,
  ...rest
}: Props = $props();

const variants: Record<string, string> = {
  primary:
    'bg-[var(--color-accent)] text-white hover:brightness-110 active:brightness-95 border border-transparent shadow-[var(--shadow-card)]',
  secondary:
    'bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-subtle)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]',
  ghost:
    'bg-transparent text-[var(--color-ink-muted)] border border-transparent hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]',
  subtle:
    'bg-[var(--color-surface-muted)] text-[var(--color-ink)] border border-transparent hover:brightness-[0.98]',
  danger: 'bg-[var(--color-danger)] text-white border border-transparent hover:brightness-110'
};

const sizes: Record<string, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-[var(--radius-sm)]',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-[var(--radius-md)]',
  lg: 'h-11 px-5 text-sm gap-2 rounded-[var(--radius-md)]',
  icon: 'h-8 w-8 justify-center rounded-[var(--radius-sm)]'
};
</script>

<button
  {...rest}
  {disabled}
  aria-busy={loading}
  class="inline-flex items-center font-medium transition-[background-color,border-color,filter,transform] duration-150 select-none
    disabled:cursor-not-allowed disabled:opacity-50 active:translate-y-[0.5px]
    {variants[variant]} {sizes[size]} {className}"
>
  {#if loading}
    <span
      class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    ></span>
    <span class="opacity-80">Working…</span>
  {:else}
    {@render children?.()}
  {/if}
</button>
