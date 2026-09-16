<script lang="ts">
/** Skeleton: placeholder that preserves layout instead of jumping. */
interface Props {
  class?: string;
  lines?: number;
  height?: string;
}
let { class: className = '', lines = 1, height = '0.75rem' }: Props = $props();
</script>

<div class="flex flex-col gap-2 {className}" aria-hidden="true">
  {#each Array.from({ length: lines }) as _, index (index)}
    <div class="skeleton rounded-[var(--radius-sm)]" style="height: {height}; width: {index === lines - 1 && lines > 1 ? '62%' : '100%'}"></div>
  {/each}
</div>
