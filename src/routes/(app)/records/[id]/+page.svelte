<script lang="ts">
/**
 * Record page: a shareable full-size view of one durable Record, reusing the same
 * surface the rest of the app uses.
 */
import { page } from '$app/state';
import RecordSurface from '$ui/records/RecordSurface.svelte';

const recordId = $derived(page.params.id ?? '');
const workspaceId = $derived(page.data.workspace?.id ?? '');
const initialTab = $derived(page.url.searchParams.get('tab') ?? 'overview');
</script>

<div class="min-h-0 flex-1 overflow-auto">
  <div class="mx-auto max-w-5xl">
    {#if recordId}
      <RecordSurface {recordId} {workspaceId} {initialTab} />
    {/if}
  </div>
</div>
