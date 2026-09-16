<script lang="ts">
/**
 * ToolGroup: one collapsible, optionally-toggleable group of tools.
 *
 * Every surface that lists tools groups them by namespace. This component is the one
 * place that decides how a group header looks and behaves: a disclosure control, a
 * count, an optional whole-group toggle, and a slot for the tools themselves. The
 * tri-state checkbox is deliberately native — an unchecked box means "none of this
 * group", checked means "all of it", and the indeterminate state means "some" — so
 * keyboard and screen-reader behaviour comes for free.
 */
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import type { GroupSelectionState } from './group-selection';

interface GroupToggle {
  state: GroupSelectionState;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible label; falls back to the group name. */
  label?: string;
  /** Verb shown next to the checkbox, e.g. "Grant group". */
  hint?: string;
}

interface Props {
  name: string;
  count?: number;
  /** Short right-aligned summary, e.g. "3 of 5 granted". */
  meta?: string;
  defaultOpen?: boolean;
  toggle?: GroupToggle | null;
  actions?: Snippet;
  children?: Snippet;
}

let { name, count, meta, defaultOpen = true, toggle = null, actions, children }: Props = $props();

// `defaultOpen` is read once, on mount: a group the operator collapsed must stay
// collapsed when a parent re-renders.
let open = $state(untrack(() => defaultOpen));
let checkbox: HTMLInputElement | undefined = $state();

// Svelte does not bind `indeterminate` as an attribute, so set the DOM property when
// the group's partial state changes.
$effect(() => {
  if (checkbox) checkbox.indeterminate = toggle?.state === 'some';
});

const headingId = $derived(`tool-group-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
</script>

<section class="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
  <div class="flex flex-wrap items-center gap-2 px-3 py-2.5">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 text-left"
      aria-expanded={open}
      aria-controls={`${headingId}-body`}
      onclick={() => (open = !open)}
    >
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5 shrink-0 text-[var(--color-ink-subtle)] transition-transform {open
          ? 'rotate-90'
          : ''}"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span id={headingId} class="truncate text-sm font-medium text-[var(--color-ink)]">{name}</span>
      {#if count !== undefined}
        <span
          class="rounded-full border border-[var(--color-border-subtle)] px-1.5 text-[10px] text-[var(--color-ink-subtle)]"
        >
          {count}
        </span>
      {/if}
    </button>

    {#if meta}
      <span class="text-[11px] text-[var(--color-ink-subtle)]">{meta}</span>
    {/if}

    {@render actions?.()}

    {#if toggle}
      <label
        class="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
        title={toggle.hint ?? `Toggle every tool in ${name}`}
      >
        <input
          bind:this={checkbox}
          type="checkbox"
          class="h-3.5 w-3.5 accent-[var(--color-accent)]"
          checked={toggle.state === 'all'}
          disabled={toggle.disabled ?? false}
          aria-label={toggle.label ?? `Toggle all tools in ${name}`}
          onchange={() => toggle?.onToggle(toggle.state !== 'all')}
        />
        <span>{toggle.hint ?? 'All'}</span>
      </label>
    {/if}
  </div>

  {#if open}
    <div id={`${headingId}-body`} class="border-t border-[var(--color-border-subtle)] px-3 py-3">
      {@render children?.()}
    </div>
  {/if}
</section>
