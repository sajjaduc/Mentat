<script lang="ts">
/**
 * BodyEditor: how an operation's input becomes a request body.
 *
 * The four modes map exactly onto the runtime's `applyBodyMapping`:
 *  - `none` sends no body;
 *  - `json` sends a field-mapped object (or the whole input, with passthrough);
 *  - `form` sends the same fields as `application/x-www-form-urlencoded`;
 *  - `raw` renders a `{{param}}` template as text.
 * The editor shows the template with placeholders highlighted so a typo is visible
 * before a model ever calls the operation.
 */

import SelectField from './controls/SelectField.svelte';
import TextAreaField from './controls/TextAreaField.svelte';
import TextField from './controls/TextField.svelte';
import Toggle from './controls/Toggle.svelte';
import ParametersTable from './ParametersTable.svelte';
import TemplatePreview from './TemplatePreview.svelte';
import type { HttpBodyMapping } from './types';

interface Props {
  body?: HttpBodyMapping;
}

let { body = $bindable<HttpBodyMapping>({ mode: 'none' }) }: Props = $props();

const modeOptions = [
  { value: 'none', label: 'None — no request body' },
  { value: 'json', label: 'JSON — field-mapped object' },
  { value: 'form', label: 'Form — URL-encoded fields' },
  { value: 'raw', label: 'Raw — a {{param}} template' }
];

function setMode(mode: string) {
  const next = mode as HttpBodyMapping['mode'];
  body = { ...body, mode: next };
}
</script>

<div class="space-y-4">
  <SelectField
    label="Body mode"
    options={modeOptions}
    value={body.mode}
    onchange={setMode}
  />

  {#if body.mode !== 'none'}
    <TextField
      label="Content type"
      value={body.contentType ?? ''}
      placeholder={body.mode === 'json' ? 'application/json' : body.mode === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain'}
      hint="Leave empty to use the mode's default."
      onchange={(next) => (body.contentType = next.length > 0 ? next : undefined)}
    />
  {/if}

  {#if body.mode === 'json'}
    <Toggle
      checked={body.passthrough === true}
      label="Passthrough the whole input"
      hint="Sends the input object — or its `body` property — verbatim instead of mapping fields."
      onchange={(next) => (body.passthrough = next)}
    />
  {/if}

  {#if body.mode === 'json' || body.mode === 'form'}
    {#if body.mode === 'json' && body.passthrough}
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Passthrough is on, so the field map below is ignored. The model supplies an
        <code class="font-mono">object</code> parameter named <code class="font-mono">body</code>.
      </p>
    {:else}
      <div class="space-y-1.5">
        <p class="text-xs font-medium text-[var(--color-ink-muted)]">Body fields</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Each field maps an input parameter onto the wire body. The wire name defaults to the
          parameter name, and constants or defaults are filled in when the caller omits a value.
        </p>
      </div>
      <ParametersTable
        parameters={body.fields ?? []}
        showLocation={false}
        emptyLabel="No body fields yet. Add one for each value the request body should carry."
        addLabel="Add body field"
        onchange={(next) => (body.fields = next.length > 0 ? next : undefined)}
      />
    {/if}
  {/if}

  {#if body.mode === 'raw'}
    <TextAreaField
      label="Body template"
      value={body.template ?? ''}
      mono
      rows={6}
      placeholder={'{\n  "query": "{{query}}"\n}'}
      hint={'Each {{param}} is replaced with the matching input value at execution time.'}
      onchange={(next) => (body.template = next.length > 0 ? next : undefined)}
    />
    <TemplatePreview value={body.template ?? ''} />
  {/if}
</div>
