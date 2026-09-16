<script lang="ts">
/**
 * SelectField: a two-way select. The frozen `Select` primitive cannot be bound
 * two-way, so this wrapper wires the `change` event itself.
 */
import Select from '$ui/primitives/Select.svelte';
import type { Option } from '$ui/primitives/types';

interface Props {
  value?: string;
  options: Option[];
  label?: string;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  onchange?: (value: string) => void;
}

let {
  value = $bindable(''),
  options,
  label,
  hint,
  error = null,
  placeholder,
  disabled = false,
  id,
  onchange
}: Props = $props();
</script>

<Select
  {options}
  {label}
  {hint}
  {error}
  {placeholder}
  {disabled}
  {id}
  {value}
  onchange={(event) => {
    value = event.currentTarget.value;
    onchange?.(value);
  }}
/>
