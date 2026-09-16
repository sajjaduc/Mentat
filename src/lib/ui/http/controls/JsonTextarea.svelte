<script lang="ts">
/**
 * JsonTextarea: a monospace JSON field that validates without blocking typing.
 *
 * Schemas and payloads are stored as JSON, and the failure mode to avoid is a user
 * pasting malformed JSON and losing it on save. This keeps the raw text as the value,
 * shows the parse error inline, and offers a Format action only when it parses.
 */
import { parseJson } from '../json';

interface Props {
  value?: string;
  label?: string;
  hint?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
}

let {
  value = $bindable(''),
  label,
  hint,
  rows = 10,
  placeholder = '{\n  "type": "object"\n}',
  disabled = false,
  allowEmpty = true
}: Props = $props();

const parsed = $derived(parseJson(value));
const error = $derived(
  !parsed.ok ? parsed.error : !allowEmpty && value.trim().length === 0 ? 'Required' : null
);

function format() {
  const result = parseJson(value);
  if (!result.ok) return;
  value = `${JSON.stringify(result.value, null, 2)}\n`;
}

const inputId = `json-${Math.random().toString(36).slice(2, 9)}`;
</script>

<div class="space-y-1.5">
  <div class="flex items-center justify-between gap-2">
    {#if label}
      <label for={inputId} class="text-xs font-medium text-[var(--color-ink-muted)]">{label}</label>
    {:else}
      <span></span>
    {/if}
    <div class="flex items-center gap-2">
      {#if parsed.ok && value.trim().length > 0}
        <span class="text-[10px] text-[var(--color-positive)]">Valid JSON</span>
      {/if}
      <button
        type="button"
        class="text-[11px] text-[var(--color-ink-subtle)] transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
        onclick={format}
        disabled={!parsed.ok || disabled}
      >
        Format
      </button>
    </div>
  </div>
  <textarea
    id={inputId}
    bind:value
    {rows}
    {placeholder}
    {disabled}
    spellcheck="false"
    aria-invalid={error ? 'true' : undefined}
    class="w-full resize-y rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]
      {error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]'}"
  ></textarea>
  {#if error}
    <p class="text-xs text-[var(--color-danger)]">{error}</p>
  {:else if hint}
    <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">{hint}</p>
  {/if}
</div>
