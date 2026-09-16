<script lang="ts">
  /**
   * Root layout: global styles and the toast layer.
   *
   * Kept minimal on purpose. The application chrome lives in the `(app)` group so
   * the sign-in screen does not inherit a sidebar it cannot populate.
   */
  import '../app.css';
  import Toasts from '$ui/primitives/Toasts.svelte';
  let { children } = $props();
</script>

{@render children?.()}
<Toasts />
