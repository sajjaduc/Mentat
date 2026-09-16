<script lang="ts">
/**
 * `/files/[id]` — file detail route.
 *
 * The active tab is URL state (`?tab=`) so a link can land directly on, say, the
 * Processing tab. The data itself is fetched in the browser, per the UI brief's
 * loading pattern.
 */
import { replaceState } from '$app/navigation';
import { page } from '$app/state';
import FileDetail from '$ui/files/FileDetail.svelte';

const fileId = $derived(page.params.id ?? '');
const initialTab = $derived(page.url.searchParams.get('tab') ?? 'overview');

function onTabChange(tab: string) {
  const query = new URLSearchParams(page.url.searchParams);
  if (tab === 'overview') query.delete('tab');
  else query.set('tab', tab);
  const search = query.toString();
  replaceState(`/files/${fileId}${search ? `?${search}` : ''}`, {});
}
</script>

<svelte:head><title>File · Mentat</title></svelte:head>

<FileDetail {fileId} {initialTab} ontabchange={onTabChange} />
