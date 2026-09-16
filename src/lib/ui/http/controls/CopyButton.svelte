<script lang="ts">
/**
 * CopyButton: clipboard affordance for keys, URLs and generated commands. It never
 * copies anything the caller did not hand it, and it degrades silently when the
 * browser denies clipboard access instead of throwing.
 */
import Button from '$ui/primitives/Button.svelte';

interface Props {
  text: string;
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
}

let { text, label = 'Copy', size = 'sm', variant = 'ghost' }: Props = $props();
let copied = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
    }, 1600);
  } catch {
    // Clipboard permission is a browser policy, not an application error.
  }
}
</script>

<Button {size} {variant} disabled={text.length === 0} onclick={copy} title={`Copy ${label.toLowerCase()}`}>
  {copied ? 'Copied' : label}
</Button>
