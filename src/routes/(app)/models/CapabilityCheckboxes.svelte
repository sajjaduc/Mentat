<script lang="ts">
/**
 * CapabilityCheckboxes: the six capability flags as a labelled checklist.
 *
 * Discovered capabilities are heuristics, so this is deliberately an editable list
 * rather than a read-only summary: an operator overriding a guess is the expected
 * workflow, not an escape hatch.
 */
import type { ModelCapabilities } from '$ui/agents/types';
import { CAPABILITY_KEYS } from '$ui/agents/types';

interface Props {
  value: ModelCapabilities;
  disabled?: boolean;
  onchange: (next: ModelCapabilities) => void;
}

let { value, disabled = false, onchange }: Props = $props();

function toggle(key: keyof ModelCapabilities, checked: boolean) {
  onchange({ ...value, [key]: checked });
}
</script>

<div class="grid gap-2 sm:grid-cols-2">
  {#each CAPABILITY_KEYS as capability (capability.key)}
    <label
      class="flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] px-2.5 py-2 {disabled
        ? 'cursor-not-allowed opacity-60'
        : 'cursor-pointer hover:bg-[var(--color-surface-muted)]'}"
    >
      <input
        type="checkbox"
        class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
        checked={value[capability.key] === true}
        {disabled}
        onchange={(event) => toggle(capability.key, event.currentTarget.checked)}
      />
      <span class="space-y-0.5">
        <span class="block text-xs font-medium text-[var(--color-ink)]">{capability.label}</span>
        <span class="block text-[11px] leading-relaxed text-[var(--color-ink-subtle)]"
          >{capability.hint}</span
        >
      </span>
    </label>
  {/each}
</div>
