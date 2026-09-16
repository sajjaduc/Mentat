<script lang="ts">
/**
 * `/dashboards/[id]` — dashboard detail.
 *
 * The id comes from the route params; the dashboard and its widget results are
 * fetched in the browser.
 */
import { page } from '$app/state';
import DashboardView from '$ui/analytics/DashboardView.svelte';

const dashboardId = $derived(page.params.id ?? '');
</script>

<svelte:head><title>Dashboard · Mentat</title></svelte:head>

<DashboardView {dashboardId} />
