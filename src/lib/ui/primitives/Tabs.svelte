<script lang="ts">
  /**
   * Tabs: roving-tabindex tab list so arrow keys work as expected. The selected tab
   * is part of URL state on the pages that use it, which keeps deep links useful.
   */
  interface Tab { id: string; label: string; count?: number; disabled?: boolean }
  interface Props { tabs: Tab[]; active: string; onselect: (id: string) => void; class?: string }
  let { tabs, active, onselect, class: className = '' }: Props = $props();

  function onKeydown(event: KeyboardEvent, index: number) {
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    const current = tabs.findIndex((tab) => tab.id === active);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const candidate = tabs[next];
    if (candidate && !candidate.disabled) onselect(candidate.id);
    void index;
  }
</script>

<div role="tablist" class="flex items-center gap-1 border-b border-[var(--color-border-subtle)] {className}">
  {#each tabs as tab, index (tab.id)}
    <button
      role="tab"
      type="button"
      aria-selected={active === tab.id}
      tabindex={active === tab.id ? 0 : -1}
      disabled={tab.disabled}
      class="-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors
        {active === tab.id
          ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
          : 'border-transparent text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]'}
        disabled:cursor-not-allowed disabled:opacity-40"
      onclick={() => onselect(tab.id)}
      onkeydown={(event) => onKeydown(event, index)}
    >
      {tab.label}
      {#if tab.count !== undefined}
        <span class="rounded-full bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-subtle)]">{tab.count}</span>
      {/if}
    </button>
  {/each}
</div>
