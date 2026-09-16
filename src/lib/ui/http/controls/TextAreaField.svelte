<script lang="ts">
/**
 * TextAreaField: a two-way multi-line field, optionally monospace for templates and
 * prose that must keep its formatting. Complements {@link TextField} for the same
 * primitive-binding reason.
 */
import Textarea from '$ui/primitives/Textarea.svelte';

interface Props {
  value?: string;
  label?: string;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
  id?: string;
  class?: string;
  onchange?: (value: string) => void;
}

let {
  value = $bindable(''),
  label,
  hint,
  error = null,
  placeholder,
  rows,
  mono = false,
  disabled = false,
  id,
  class: className = '',
  onchange
}: Props = $props();
</script>

<Textarea
  {label}
  {hint}
  {error}
  {placeholder}
  {rows}
  {mono}
  {disabled}
  {id}
  {value}
  class={className}
  oninput={(event) => {
    value = event.currentTarget.value;
    onchange?.(value);
  }}
/>
