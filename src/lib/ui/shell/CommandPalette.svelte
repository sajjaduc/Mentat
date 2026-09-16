<script lang="ts">
/**
 * Command palette.
 *
 * Two kinds of result: navigation (always available, instant) and entities
 * (debounced server search). Keyboard-first: ↑/↓ to move, Enter to open, Esc to
 * close. Recent entities are remembered locally so the palette is useful even
 * before a search round-trips.
 */
import { goto } from '$app/navigation';
import { api, describeApiError } from '$ui/api';

interface Props {
  open: boolean;
  onclose: () => void;
}
let { open, onclose }: Props = $props();

const destinations = [
  { label: 'Workflows', href: '/workflows', group: 'Go to' },
  { label: 'My Work', href: '/my-work', group: 'Go to' },
  { label: 'Approvals', href: '/approvals', group: 'Go to' },
  { label: 'Agents', href: '/agents', group: 'Go to' },
  { label: 'Skills', href: '/skills', group: 'Go to' },
  { label: 'Tools', href: '/tools', group: 'Go to' },
  { label: 'HTTP Services', href: '/http-services', group: 'Go to' },
  { label: 'Files', href: '/files', group: 'Go to' },
  { label: 'Models', href: '/models', group: 'Go to' },
  { label: 'Dashboards', href: '/dashboards', group: 'Go to' },
  { label: 'Integrations', href: '/integrations', group: 'Go to' },
  { label: 'Settings', href: '/settings', group: 'Go to' }
];

interface Result {
  kind: string;
  id: string;
  key?: string;
  title: string;
  subtitle?: string;
  href: string;
  group: string;
}

let query = $state('');
let results = $state<Result[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);
let cursor = $state(0);
let input: HTMLInputElement | undefined = $state();

const filteredDestinations = $derived(
  query.trim().length === 0
    ? destinations
    : destinations.filter((entry) => entry.label.toLowerCase().includes(query.trim().toLowerCase()))
);

const flat = $derived<Result[]>([
  ...filteredDestinations.map((entry) => ({
    kind: 'nav',
    id: entry.href,
    title: entry.label,
    href: entry.href,
    group: entry.group
  })),
  ...results
]);

$effect(() => {
  if (open) {
    query = '';
    results = [];
    error = null;
    cursor = 0;
    queueMicrotask(() => input?.focus());
  }
});

$effect(() => {
  if (!open) return;
  const term = query.trim();
  if (term.length < 2) {
    results = [];
    return;
  }
  // Debounce so typing does not issue a request per keystroke.
  const timer = setTimeout(async () => {
    loading = true;
    error = null;
    try {
      const response = await api.get<{
        results: Array<{
          kind: string;
          id: string;
          key?: string;
          title: string;
          subtitle?: string;
          href: string;
        }>;
      }>('/search', { q: term, limit: 8 });
      results = response.results.map((entry) => ({
        ...entry,
        group: entry.kind === 'ticket' ? 'Tickets' : 'Results'
      }));
      cursor = 0;
    } catch (failure) {
      error = describeApiError(failure);
      results = [];
    } finally {
      loading = false;
    }
  }, 160);
  return () => clearTimeout(timer);
});

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    cursor = Math.min(cursor + 1, Math.max(flat.length - 1, 0));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    cursor = Math.max(cursor - 1, 0);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const chosen = flat[cursor];
    if (chosen) void select(chosen);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    onclose();
  }
}

async function select(entry: Result) {
  onclose();
  await goto(entry.href);
}

const groupOrder = $derived([...new Set(flat.map((entry) => entry.group))]);
</script>

{#if open}
  <div class="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]">
    <button class="absolute inset-0 cursor-default bg-[color-mix(in_oklch,var(--color-ink)_32%,transparent)] backdrop-blur-[2px]" aria-label="Close search" onclick={onclose}></button>
    <div class="animate-pop-in relative w-full max-w-xl overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-[var(--shadow-overlay)]">
      <div class="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3.5 py-2.5">
        <svg viewBox="0 0 24 24" class="h-4 w-4 text-[var(--color-ink-subtle)]" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" stroke-linecap="round" />
        </svg>
        <input
          bind:this={input}
          bind:value={query}
          onkeydown={onKeydown}
          placeholder="Search tickets, workflows and pages…"
          class="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-ink-subtle)]"
          aria-label="Search"
        />
        {#if loading}<span class="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-ink-subtle)] border-t-transparent"></span>{/if}
        <kbd class="rounded border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-subtle)]">esc</kbd>
      </div>

      <div class="scrollbar-thin max-h-80 overflow-y-auto p-1.5">
        {#if error}
          <p class="px-3 py-2 text-xs text-[var(--color-danger)]">{error}</p>
        {/if}
        {#if flat.length === 0}
          <p class="px-3 py-6 text-center text-xs text-[var(--color-ink-subtle)]">No matches</p>
        {/if}
        {#each groupOrder as group (group)}
          <p class="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">{group}</p>
          {#each flat.filter((entry) => entry.group === group) as entry (entry.kind + entry.id)}
            {@const index = flat.indexOf(entry)}
            <button
              class="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left text-sm transition-colors
                {index === cursor ? 'bg-[var(--color-surface-muted)]' : 'hover:bg-[var(--color-surface-muted)]'}"
              onmouseenter={() => (cursor = index)}
              onclick={() => select(entry)}
            >
              <span class="min-w-0 flex-1 truncate">
                {#if entry.key}<span class="mr-1.5 font-mono text-[11px] text-[var(--color-ink-subtle)]">{entry.key}</span>{/if}
                {entry.title}
              </span>
              {#if entry.subtitle}<span class="shrink-0 text-[11px] text-[var(--color-ink-subtle)]">{entry.subtitle}</span>{/if}
            </button>
          {/each}
        {/each}
      </div>
    </div>
  </div>
{/if}
