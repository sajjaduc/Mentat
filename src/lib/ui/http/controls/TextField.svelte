<script lang="ts">
/**
 * TextField: a two-way text input.
 *
 * The frozen `Input` primitive spreads its props onto `<input>` but does not declare
 * `$bindable`, so `bind:value` on it is one-way. This wrapper owns the value and wires
 * the DOM event, which is what makes a form field actually editable.
 */
import type { HTMLInputAttributes } from 'svelte/elements';
import Input from '$ui/primitives/Input.svelte';

interface Props {
  value?: string;
  label?: string;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'password' | 'search';
  size?: 'sm' | 'md';
  disabled?: boolean;
  required?: boolean;
  id?: string;
  autocomplete?: HTMLInputAttributes['autocomplete'];
  name?: string;
  onchange?: (value: string) => void;
}

let {
  value = $bindable(''),
  label,
  hint,
  error = null,
  placeholder,
  type = 'text',
  size = 'md',
  disabled = false,
  required = false,
  id,
  autocomplete,
  name,
  onchange
}: Props = $props();
</script>

<Input
  {label}
  {hint}
  {error}
  {placeholder}
  {type}
  {size}
  {disabled}
  {required}
  {id}
  {autocomplete}
  {name}
  {value}
  oninput={(event) => {
    value = event.currentTarget.value;
    onchange?.(value);
  }}
/>
