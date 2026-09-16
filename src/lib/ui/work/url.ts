/**
 * URL state for the work surfaces.
 *
 * Tab and ticket selection live in the query string so a deep link, a refresh and
 * back/forward all reproduce what the user was looking at. Updates go through the
 * History API (`pushState` / `replaceState`) instead of the router: query-only
 * changes must not re-run loaders or remount the page, and closing the ticket
 * drawer has to restore the previous URL rather than push a new navigation.
 */
import { pushState, replaceState } from '$app/navigation';
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

/** Replace the query string in place — the default for tab switches. */
export function replaceQuery(patch: QueryPatch): void {
  const url = buildQueryUrl(page.url, patch);
  if (url.href === page.url.href) return;
  const state = currentHistoryState();
  if (patch.ticket) state[DRAWER_MARKER] = true;
  if (patch.ticket === null) delete state[DRAWER_MARKER];
  replaceState(url, state);
}

/** Push a new history entry — used when the change should be back-navigable. */
export function pushQuery(patch: QueryPatch): void {
  const url = buildQueryUrl(page.url, patch);
  if (url.href === page.url.href) return;
  const state = currentHistoryState();
  if (patch.ticket) state[DRAWER_MARKER] = true;
  if (patch.ticket === null) delete state[DRAWER_MARKER];
  pushState(url, state);
}

/** Open the ticket drawer, recording that this entry may be popped on close. */
export function openTicketInUrl(ticketId: string): void {
  if (page.url.searchParams.get('ticket') === ticketId) return;
  const url = buildQueryUrl(page.url, { ticket: ticketId });
  const state = currentHistoryState();
  state[DRAWER_MARKER] = true;
  pushState(url, state);
}

/**
 * Close the ticket drawer. When this entry was created by opening the drawer the
 * browser goes back one step (restoring the exact previous URL); otherwise the
 * parameter is simply removed with a replace.
 */
export function closeTicketInUrl(): void {
  const state = currentHistoryState();
  if (state[DRAWER_MARKER] === true) {
    delete state[DRAWER_MARKER];
    replaceState(buildQueryUrl(page.url, { ticket: null }), state);
    return;
  }
  replaceQuery({ ticket: null });
}
