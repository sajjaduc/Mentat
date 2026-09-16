<script lang="ts">
/**
 * Application shell.
 *
 * The navigation is grouped the way the plan describes it: work surfaces first,
 * then configuration resources, then platform. Counts are live-ish: they come from
 * the last layout load and are refreshed after mutations that matter (approvals).
 *
 * The command palette is available everywhere via ⌘K / Ctrl-K, which is also how
 * keyboard-first users reach anything the sidebar hides.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { api } from '$ui/api';
import Avatar from '$ui/primitives/Avatar.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import CommandPalette from '$ui/shell/CommandPalette.svelte';
import { pushToast } from '$ui/toast';

let { data, children } = $props();

let paletteOpen = $state(false);
let userMenuOpen = $state(false);
let mobileNavOpen = $state(false);

/** One navigation model, typed once so optional counts and tones are visible. */
interface NavItem {
  href: string;
  label: string;
  icon: string;
  count?: number;
  tone?: 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted';
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

const nav: NavGroup[] = $derived([
  {
    label: 'Work',
    items: [
      { href: '/workflows', label: 'Workflows', icon: 'columns' },
      { href: '/my-work', label: 'My Work', icon: 'inbox', count: data.counts?.waitingForMe },
      {
        href: '/approvals',
        label: 'Approvals',
        icon: 'check',
        count: data.counts?.approvals,
        tone: 'accent' as const
      }
    ]
  },
  {
    label: 'Resources',
    items: [
      { href: '/agents', label: 'Agents', icon: 'spark' },
      { href: '/skills', label: 'Skills', icon: 'book' },
      { href: '/tools', label: 'Tools', icon: 'wrench' },
      { href: '/http-services', label: 'HTTP Services', icon: 'globe' },
      { href: '/files', label: 'Files', icon: 'file' }
    ]
  },
  {
    label: 'Platform',
    items: [
      { href: '/models', label: 'Models', icon: 'cpu' },
      { href: '/dashboards', label: 'Dashboards', icon: 'chart' },
      { href: '/integrations', label: 'Integrations', icon: 'plug' },
      { href: '/settings', label: 'Settings', icon: 'cog' }
    ]
  }
]);

function isActive(item: { href: string }) {
  return page.url.pathname === item.href || page.url.pathname.startsWith(`${item.href}/`);
}

function onGlobalKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    paletteOpen = true;
  }
}

async function signOut() {
  try {
    await api.post('/auth/logout');
    await goto('/login');
  } catch {
    pushToast({ tone: 'error', title: 'Could not sign out' });
  }
}

async function switchWorkspace(workspaceId: string) {
  await api.post('/auth/switch-workspace', { workspaceId });
  userMenuOpen = false;
  await goto('/workflows');
  await goto(page.url.pathname, { invalidateAll: true });
}

const icons: Record<string, string> = {
  columns: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z',
  inbox: 'M4 13h4l1 2h6l1-2h4M4 13l2-7h12l2 7v5H4z',
  check: 'M5 13l4 4L19 7',
  spark: 'M12 3v5M12 16v5M3 12h5M16 12h5M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3',
  book: 'M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 4v13',
  wrench: 'M14 6a4 4 0 105.7 3.7L21 8l-1.5-1.5-1.7 1.7A4 4 0 0014 6zM13 9l-8 8v3h3l8-8',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  cpu: 'M8 8h8v8H8zM4 10v4M20 10v4M10 4h4M10 20h4M6 6h12v12H6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  plug: 'M9 3v6M15 3v6M7 9h10v3a5 5 0 01-10 0zM12 17v4',
  cog: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l1.5-1-1-2.6-1.7.6-1.4-.8-.3-1.8H13l-.3 1.8-1.4.8-1.7-.6-1 2.6L10 12l0 .9-1.5 1 1 2.6 1.7-.6 1.4.8.3 1.8h3.2l.3-1.8 1.4-.8 1.7.6 1-2.6-1.5-1z'
};
</script>

<svelte:window onkeydown={onGlobalKey} />

<div class="flex h-full min-h-screen bg-[var(--color-canvas)]">
  {#if mobileNavOpen}
    <button
      class="fixed inset-0 z-30 bg-[color-mix(in_oklch,var(--color-ink)_25%,transparent)] md:hidden"
      aria-label="Close navigation"
      onclick={() => (mobileNavOpen = false)}
    ></button>
  {/if}

  <aside
    class="fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface)] transition-transform duration-200 md:static md:translate-x-0
      {mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}"
  >
    <div class="flex h-14 items-center gap-2 px-4">
      <span class="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-accent)] text-[11px] font-bold text-white">M</span>
      <span class="text-sm font-semibold tracking-tight">Mentat</span>
      <button
        class="ml-auto rounded-[var(--radius-sm)] px-1.5 py-1 text-[10px] text-[var(--color-ink-subtle)] hover:bg-[var(--color-surface-muted)]"
        title="Search everything (⌘K)"
        onclick={() => (paletteOpen = true)}
      >
        ⌘K
      </button>
    </div>

    <nav class="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-2 pb-4">
      {#each nav as group (group.label)}
        <div class="space-y-1">
          <p class="px-2 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">{group.label}</p>
          {#each group.items as item (item.href)}
            <a
              href={item.href}
              class="group flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-sm transition-colors
                {isActive(item) ? 'bg-[var(--color-surface-muted)] font-medium text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]'}"
              onclick={() => (mobileNavOpen = false)}
            >
              <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 {isActive(item) ? 'text-[var(--color-accent)]' : ''}" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <path d={icons[item.icon]} stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="truncate">{item.label}</span>
              {#if item.count}
                <span class="ml-auto"><Badge tone={item.tone ?? 'neutral'}>{item.count}</Badge></span>
              {/if}
            </a>
          {/each}
        </div>
      {/each}
    </nav>

    <div class="relative border-t border-[var(--color-border-subtle)] p-2">
      <button
        class="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
        onclick={() => (userMenuOpen = !userMenuOpen)}
        aria-expanded={userMenuOpen}
      >
        <Avatar id={data.actor?.userId ?? 'unknown'} name={data.workspace?.name ?? 'Workspace'} size="sm" />
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium text-[var(--color-ink)]">{data.workspace?.name ?? 'No workspace'}</span>
          <span class="block truncate text-[10px] text-[var(--color-ink-subtle)]">{data.workspaces?.length ?? 0} workspace(s)</span>
        </span>
        <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 text-[var(--color-ink-subtle)]" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M7 10l5 5 5-5" stroke-linecap="round" />
        </svg>
      </button>

      {#if userMenuOpen}
        {@const _ = setTimeout(() => {}, 0)}
        <div class="absolute bottom-14 left-2 right-2 z-50 animate-pop-in rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-overlay)]">
          {#if (data.workspaces?.length ?? 0) > 1}
            <p class="px-2 py-1 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">Switch workspace</p>
            {#each data.workspaces as workspace (workspace.workspaceId)}
              <button
                class="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
                onclick={() => switchWorkspace(workspace.workspaceId)}
              >
                <span class="truncate">{workspace.name}</span>
                <span class="ml-auto text-[10px] text-[var(--color-ink-subtle)]">{workspace.role}</span>
              </button>
            {/each}
            <div class="my-1 h-px bg-[var(--color-border-subtle)]"></div>
          {/if}
          <a href="/settings" class="block rounded-[var(--radius-sm)] px-2 py-1.5 text-xs hover:bg-[var(--color-surface-muted)]" onclick={() => (userMenuOpen = false)}>Settings</a>
          <button class="block w-full rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs text-[var(--color-danger)] hover:bg-[var(--color-surface-muted)]" onclick={signOut}>
            Sign out
          </button>
        </div>
      {/if}
    </div>
  </aside>

  <main class="flex min-w-0 flex-1 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-4 md:hidden">
      <button class="rounded-[var(--radius-sm)] p-1.5 hover:bg-[var(--color-surface-muted)]" aria-label="Open navigation" onclick={() => (mobileNavOpen = true)}>
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" />
        </svg>
      </button>
      <span class="text-sm font-semibold">Mentat</span>
    </header>
    {@render children?.()}
  </main>
</div>

<CommandPalette open={paletteOpen} onclose={() => (paletteOpen = false)} />
