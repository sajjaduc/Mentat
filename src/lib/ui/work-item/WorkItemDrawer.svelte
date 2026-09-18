<script lang="ts">
/**
 * WorkItem drawer.
 *
 * A thin wrapper so opening a workItem never navigates: the drawer renders in place,
 * the URL carries `?workItem=` and the surface below owns all data and mutations.
 */
import Drawer from '$ui/primitives/Drawer.svelte';
import WorkItemSurface from '$ui/work-item/WorkItemSurface.svelte';

interface Props {
  workflowItemId: string;
  workspaceId?: string;
  onclose: () => void;
  onOpenWorkItem: (workflowItemId: string) => void;
  onTransferred?: () => void;
}

let { workflowItemId, workspaceId = '', onclose, onOpenWorkItem, onTransferred }: Props = $props();
</script>

<Drawer open={true} title="Work item detail" width="48rem" onclose={onclose}>
  <WorkItemSurface {workflowItemId} {workspaceId} variant="drawer" {onOpenWorkItem} {onTransferred} />
</Drawer>
