<script lang="ts">
/**
 * Multi-select filter control.
 *
 * `<details>` gives the popover its keyboard behaviour and focus order for free;
 * the checkboxes keep the control usable with a screen reader and without a mouse.
 */
interface Option {
  value: string;
  label: string;
  color?: string | null;
}

interface Props {
  label: string;
  options: Option[];
  selected: string[];
  onchange: (selected: string[]) => void;
}

let { label, options, selected, onchange }: Props = $props();

function toggle(value: string) {
  onchange(
    selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]
  );
}
</script>

<details class="group relative">
  <summary
    class="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 text-xs text-[var(--color-ink-muted)] hover:border-[var(--color-border-strong)]"
  >
    <span>{label}</span>
    {#if selected.length > 0}
      <span
        class="rounded-full bg-[var(--color-accent-soft)] px-1.5 text-[10px] text-[var(--color-accent-ink)]"
        >{selected.length}</span
      >
    {/if}
    <span class="ml-auto text-[10px]" aria-hidden="true">▾</span>
  </summary>
  <div
    class="animate-pop-in absolute left-0 z-30 mt-1 max-h-64 w-56 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-overlay)]"
  >
    {#each options as option (option.value)}
      <label
        class="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs hover:bg-[var(--color-surface-muted)]"
      >
        <input
          type="checkbox"
          checked={selected.includes(option.value)}
          onchange={() => toggle(option.value)}
        />
        {#if option.color}
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            style="background-color:{option.color}"
            aria-hidden="true"
          ></span>
        {/if}
        <span class="truncate">{option.label}</span>
      </label>
    {/each}
    {#if options.length === 0}
      <p class="px-2 py-2 text-xs text-[var(--color-ink-subtle)]">Nothing to choose from yet.</p>
    {/if}
  </div>
</details>
