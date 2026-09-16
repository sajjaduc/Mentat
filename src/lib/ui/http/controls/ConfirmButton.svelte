<script lang="ts">
/**
 * ConfirmButton: a destructive action that requires a second, deliberate click.
 *
 * Archiving a service takes its operations and derived tools with it, so the first
 * click arms the button and the second commits. Escape or blur disarms it.
 */
import Button from '$ui/primitives/Button.svelte';

interface Props {
  label: string;
  confirmLabel?: string;
  onconfirm: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
}

let {
  label,
  confirmLabel = 'Confirm',
  onconfirm,
  variant = 'danger',
  size = 'sm',
  disabled = false,
  title
}: Props = $props();

let armed = $state(false);
let busy = $state(false);

async function click() {
  if (!armed) {
    armed = true;
    return;
  }
  busy = true;
  try {
    await onconfirm();
  } finally {
    busy = false;
    armed = false;
  }
}
</script>

<div class="flex items-center gap-1.5">
  <Button
    {variant}
    {size}
    {disabled}
    loading={busy}
    {title}
    onclick={click}
    onblur={() => (armed = false)}
  >
    {armed ? confirmLabel : label}
  </Button>
  {#if armed}
    <button
      type="button"
      class="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
      onclick={() => (armed = false)}
    >
      Cancel
    </button>
  {/if}
</div>
