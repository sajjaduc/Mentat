<script lang="ts">
/**
 * Records index.
 *
 * A thin shell: the browser component owns loading, filtering and creation so the
 * same surface can be reused wherever records are shown.
 */
import { page } from '$app/state';
import RecordsBrowser from '$ui/records/RecordsBrowser.svelte';

const objectTypeId = $derived(page.url.searchParams.get('objectType') ?? undefined);
</script>

<div class="min-h-0 flex-1 overflow-auto">
  <div class="mx-auto max-w-6xl">
    <RecordsBrowser initialObjectTypeId={objectTypeId} />
  </div>
</div>
