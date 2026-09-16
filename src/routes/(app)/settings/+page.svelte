<script lang="ts">
/**
 * Settings section: workspace identity, defaults and agent policy.
 *
 * The component owns loading and mutations; this route mounts it inside the
 * settings layout.
 */
import SettingsWorkspace from '$ui/settings/SettingsWorkspace.svelte';
</script>

<svelte:head><title>Workspace · Mentat</title></svelte:head>

<SettingsWorkspace />
