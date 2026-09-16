/**
 * URL state for the work surfaces.
 *
 * Tab and ticket selection live in the query string so a deep link, a refresh and
 * back/forward all reproduce what the user was looking at.
 *
 * Updates go through `goto` rather than a raw `pushState`. Both change the URL, but
 * only `goto` reliably notifies the reactive `page` object, and the surfaces derive
 * their open tab and open ticket from `page.url` — with a raw history call the URL
 * changed while the UI did not. `noScroll` and `keepFocus` keep it feeling like an
 * in-place update rather than a navigation.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';

export type QueryPatch = Record<string, string | number | boolean | null | undefined>;

/** Marker stored on the history entry that opened the ticket drawer. */
const DRAWER_MARKER = 'mentatTicketDrawer';

function currentHistoryState(): Record<string, unknown> {
  return { ...(page.state as Record<string, unknown>) };
}

/** Apply a patch to a URL, deleting keys whose value is null, undefined or empty. */
export function buildQueryUrl(base: URL, patch: QueryPatch): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

/** Navigate to a new URL without scrolling or stealing focus. */
function navigate(url: URL, options: { replace?: boolean } = {}): void {
  const state = currentHistoryState();
  const ticket = url.searchParams.get('ticket');
  if (ticket) state[DRAWER_MARKER] = true;
  else delete state[DRAWER_MARKER];
  void goto(`${url.pathname}${url.search}`, {
    replaceState: options.replace ?? false,
    noScroll: true,
    keepFocus: true,
    state
  });
}

/** Replace the query string in place — the default for tab switches. */
export function replaceQuery(patch: QueryPatch): void {
  const url = buildQueryUrl(page.url, patch);
  if (url.href === page.url.href) return;
  navigate(url, { replace: true });
}

/** Push a new history entry — used when the change should be back-navigable. */
export function pushQuery(patch: QueryPatch): void {
  const url = buildQueryUrl(page.url, patch);
  if (url.href === page.url.href) return;
  navigate(url);
}

/** Open the ticket drawer, recording that this entry may be popped on close. */
export function openTicketInUrl(ticketId: string): void {
  if (page.url.searchParams.get('ticket') === ticketId) return;
  navigate(buildQueryUrl(page.url, { ticket: ticketId }));
}

/**
 * Close the ticket drawer. When this entry was created by opening the drawer the
 * browser goes back one step (restoring the exact previous URL); otherwise the
 * parameter is simply removed with a replace.
 */
export function closeTicketInUrl(): void {
  replaceQuery({ ticket: null });
}
