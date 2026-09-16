<script lang="ts">
/**
 * Pagination: cursor controls for keyset-paginated lists.
 *
 * The API returns an opaque `nextCursor`, so this component only ever forwards the
 * cursor the server produced. It keeps a small stack of visited cursors so "Back"
 * works without the server needing reverse pagination, and states plainly when the
 * walk is only forward.
 */
import Button from '$ui/primitives/Button.svelte';

interface Props {
  nextCursor: string | null;
  loading?: boolean;
  /** Cursor currently in use (`null` for the first page). */
  cursor: string | null;
  oncursor: (cursor: string | null) => void;
  /** Items currently rendered, for the "showing N" line. */
  count: number;
  noun?: string;
}

let { nextCursor, loading = false, cursor, oncursor, count, noun = 'records' }: Props = $props();

// Stack of cursors already visited, so Back can return to the previous page
// without a server round-trip that re-derives it.
let history = $state<Array<string | null>>([]);

$effect(() => {
  // Reset the trail when the caller moves somewhere the trail cannot explain.
  if (cursor === null && history.length > 0 && history[history.length - 1] !== null) {
    history = [];
  }
});

function goNext() {
  if (!nextCursor) return;
  history = [...history, cursor];
  oncursor(nextCursor);
}

function goBack() {
  const previous = history[history.length - 1];
  if (previous === undefined) return;
  history = history.slice(0, -1);
  oncursor(previous);
}
</script>

<div class="flex flex-wrap items-center justify-between gap-2">
  <p class="text-[11px] text-[var(--color-ink-subtle)]">
    Showing {count} {noun}{nextCursor ? ' · more available' : ' · end of results'}
  </p>
  <div class="flex items-center gap-1.5">
    {#if history.length > 0}
      <Button size="sm" variant="ghost" disabled={loading} onclick={goBack}>← Back</Button>
    {/if}
    <Button size="sm" variant="secondary" disabled={!nextCursor || loading} onclick={goNext}>
      {loading ? 'Loading…' : 'Next page →'}
    </Button>
  </div>
</div>
