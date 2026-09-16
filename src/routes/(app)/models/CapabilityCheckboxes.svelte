<script lang="ts">
/**
 * CapabilityCheckboxes: the six capability flags as a labelled checklist.
 *
 * Discovered capabilities are heuristics, so this is deliberately an editable list
 * rather than a read-only summary: an operator overriding a guess is the expected
 * workflow, not an escape hatch. Reasoning expands into the effort levels the model
 * accepts, which is how the runner knows what is safe to send.
 */
import type { ModelCapabilities, ReasoningEffort } from '$ui/agents/types';
import { CAPABILITY_KEYS, REASONING_EFFORT_LABELS, REASONING_EFFORTS } from '$ui/agents/types';

interface Props {
  value: ModelCapabilities;
  disabled?: boolean;
  onchange: (next: ModelCapabilities) => void;
}

let { value, disabled = false, onchange }: Props = $props();

function toggle(key: keyof ModelCapabilities, checked: boolean) {
  if (key === 'reasoning' && !checked) {
    // Levels are meaningless without the capability, so clear them rather than
    // leaving a stale declaration behind.
    const { reasoningEfforts: _dropped, ...rest } = value;
    onchange({ ...rest, reasoning: false });
    return;
  }
  onchange({ ...value, [key]: checked });
}

/** `undefined` means "derive from the provider"; the chips show that as all levels. */
const selectedEfforts = $derived<ReasoningEffort[]>(
  value.reasoningEfforts ?? [...REASONING_EFFORTS]
);

function toggleEffort(effort: ReasoningEffort, checked: boolean) {
  const next = checked
    ? [...new Set([...selectedEfforts, effort])]
    : selectedEfforts.filter((entry) => entry !== effort);
  onchange({
    ...value,
    reasoningEfforts: REASONING_EFFORTS.filter((entry) => next.includes(entry))
  });
}

function resetEfforts() {
  onchange({ ...value, reasoningEfforts: undefined });
}
</script>

<div class="space-y-2">
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

  {#if value.reasoning === true}
    <div
      class="space-y-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-2.5 py-2"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-medium text-[var(--color-ink-muted)]">
          Accepted reasoning levels
        </span>
        {#if !disabled}
          <button
            type="button"
            class="text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)]"
            onclick={resetEfforts}
          >
            Provider default
          </button>
        {/if}
      </div>
      <div class="flex flex-wrap gap-1.5">
        {#each REASONING_EFFORTS as effort (effort)}
          <label
            class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] {selectedEfforts.includes(
              effort
            )
              ? 'bg-[var(--color-surface)] text-[var(--color-ink)]'
              : 'text-[var(--color-ink-subtle)]'}"
          >
            <input
              type="checkbox"
              class="h-3 w-3 accent-[var(--color-accent)]"
              checked={selectedEfforts.includes(effort)}
              {disabled}
              onchange={(event) => toggleEffort(effort, event.currentTarget.checked)}
            />
            {REASONING_EFFORT_LABELS[effort]}
          </label>
        {/each}
      </div>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        The runner never sends a level the model does not accept; an unsupported setting is dropped
        and recorded as a run warning.
      </p>
    </div>
  {/if}
</div>
