<script lang="ts">
/**
 * Work item page.
 *
 * A shareable, full-size view of one work item. It reuses the same surface as the
 * drawer so the two can never disagree about how a field is edited or a gate is
 * decided; only the frame differs.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';
import WorkItemSurface from '$ui/work-item/WorkItemSurface.svelte';

const workflowItemId = $derived(page.params.id ?? '');
const workspaceId = $derived(page.data.workspace?.id ?? '');
const initialTab = $derived(page.url.searchParams.get('tab') ?? 'overview');
</script>

<div class="min-h-0 flex-1 overflow-hidden p-4 md:p-6">
  <div
    class="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
  >
    {#if workflowItemId}
      <WorkItemSurface
        {workflowItemId}
        {workspaceId}
        {initialTab}
        variant="page"
        onOpenWorkItem={(id) => goto(`/work-items/${id}`)}
      />
    {/if}
  </div>
</div>
