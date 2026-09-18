<script lang="ts">
/**
 * `/files` — the Files browser route.
 *
 * The page owns URL state so a filtered file list is a shareable link: the filter
 * AST, search term, mode and metadata filters all live in the query string. The
 * browser component does the fetching; this file translates between the URL and
 * its inputs.
 */
import { replaceState } from '$app/navigation';
import { page } from '$app/state';
import FilesBrowser from '$ui/files/FilesBrowser.svelte';
import { parseFilter } from '$ui/filters';

const params = $derived(page.url.searchParams);

function read(name: string): string {
  return params.get(name) ?? '';
}

const initialMode = $derived(read('mode') === 'content' ? 'content' : 'metadata');

function onUrlChange(next: Record<string, string>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value && value.length > 0) query.set(key, value);
  }
  const search = query.toString();
  replaceState(`/files${search ? `?${search}` : ''}`, {});
}
</script>

<svelte:head><title>Files · Mentat</title></svelte:head>

<FilesBrowser
  initialFilter={parseFilter(read('filter'))}
  initialSearch={read('q')}
  initialMode={initialMode}
  initialWorkflowId={read('workflowId')}
  initialStatus={read('status')}
  initialMimeType={read('mimeType')}
  initialWorkItemId={read('workItem')}
  initialFilename={read('filename')}
  onurlchange={onUrlChange}
/>
