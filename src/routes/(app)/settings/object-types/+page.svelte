<script lang="ts">
/**
 * Object Type configuration.
 *
 * Defines the schema for a kind of thing (ADR-0021). The page is a thin shell over
 * the settings component.
 */
import ObjectTypeSettings from '$ui/records/ObjectTypeSettings.svelte';
</script>

<div class="min-h-0 flex-1 overflow-auto">
  <div class="mx-auto max-w-5xl">
    <ObjectTypeSettings />
  </div>
</div>
