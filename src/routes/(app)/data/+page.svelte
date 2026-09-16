<script lang="ts">
/**
 * `/data` — workspace-level collections, agent state and cache.
 *
 * The component owns loading and mutations; this route mounts it.
 */
import DataWorkspace from '$ui/data/DataWorkspace.svelte';
</script>

<svelte:head><title>Workflow data · Mentat</title></svelte:head>

<DataWorkspace />
