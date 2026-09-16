<script lang="ts">
/**
 * Avatar: initials with a deterministic colour derived from the id, so no colour
 * has to be stored and the same person looks the same everywhere.
 */
import { colorFromId, initials } from '$shared/format';

interface Props {
  id: string;
  name?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  class?: string;
}
let { id, name, size = 'sm', class: className = '' }: Props = $props();
const sizes = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm'
} as const;
const bg = $derived(id === 'agent' ? 'var(--color-accent)' : colorFromId(id));
</script>

<span
  class="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white {sizes[size]} {className}"
  style="background-color: {bg}"
  title={name ?? undefined}
>
  {initials(name ?? '?')}
</span>
