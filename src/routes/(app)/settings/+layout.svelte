<script lang="ts">
/**
 * Settings layout: sectioned navigation with deep-linkable sub-routes.
 *
 * Each section is a real URL (`/settings/members`, `/settings/secrets`) rather than
 * an in-page switcher, so a setting can be linked to, bookmarked and returned to by
 * name. The sidebar states what each section is about, because a security-relevant
 * setting should never be reached by guessing.
 */
import { page } from '$app/state';

const sections = [
  {
    href: '/settings',
    label: 'Workspace',
    description: 'Name, timezone, retention and agent policy'
  },
  {
    href: '/settings/members',
    label: 'Members',
    description: 'Roles, invitations and suspensions'
  },
  { href: '/settings/teams', label: 'Teams', description: 'Grouping for ownership and gates' },
  {
    href: '/settings/object-types',
    label: 'Object Types',
    description: 'Record schemas and the AI submission contract'
  },
  { href: '/settings/secrets', label: 'Secrets', description: 'Write-only encrypted values' },
  {
    href: '/settings/environment',
    label: 'Environment',
    description: 'Inherited, overridden and local variables'
  },
  {
    href: '/settings/overrides',
    label: 'Overrides',
    description: 'Use as-is, override or fork'
  },
  { href: '/settings/storage', label: 'Storage', description: 'Where raw bytes live' },
  { href: '/settings/jobs', label: 'Jobs', description: 'Durable queue, leases and attempts' },
  { href: '/settings/audit', label: 'Audit', description: 'Append-only ledger' }
];

let { children } = $props();

function isActive(href: string): boolean {
  if (href === '/settings') return page.url.pathname === '/settings';
  return page.url.pathname.startsWith(href);
}
</script>

<div class="flex min-h-full flex-col gap-6 p-4 md:flex-row md:p-6">
  <nav class="md:w-56 md:shrink-0" aria-label="Settings sections">
    <p class="mb-2 px-2 text-[10px] font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Settings
    </p>
    <ul class="flex flex-wrap gap-1 md:flex-col md:flex-nowrap">
      {#each sections as section (section.href)}
        <li>
          <a
            href={section.href}
            aria-current={isActive(section.href) ? 'page' : undefined}
            class="block rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs transition-colors
              {isActive(section.href)
                ? 'bg-[var(--color-surface-muted)] font-medium text-[var(--color-ink)]'
                : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]'}"
          >
            <span class="block">{section.label}</span>
            <span class="hidden text-[10px] text-[var(--color-ink-subtle)] md:block">{section.description}</span>
          </a>
        </li>
      {/each}
    </ul>
  </nav>
  <div class="min-w-0 flex-1">{@render children?.()}</div>
</div>
