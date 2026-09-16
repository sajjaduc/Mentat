<script lang="ts">
/**
 * OperationLine: the Postman-style `Method | URL/path` row.
 *
 * The path is edited as a template and previewed with placeholders highlighted, so a
 * `{{param}}` that has no matching path parameter is visibly wrong before the operation
 * is saved.
 */

import SelectField from './controls/SelectField.svelte';
import TextField from './controls/TextField.svelte';
import type { OperationDraft } from './draft';
import TemplatePreview from './TemplatePreview.svelte';
import type { HttpMethod } from './types';
import { HTTP_METHODS } from './types';

interface Props {
  draft: OperationDraft;
  baseUrl: string;
  missing?: string[];
}

let { draft, baseUrl, missing = [] }: Props = $props();

const methodOptions = HTTP_METHODS.map((method) => ({ value: method, label: method }));
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-end gap-3">
    <div class="w-28 shrink-0">
      <SelectField
        label="Method"
        options={methodOptions}
        value={draft.method}
        onchange={(next) => (draft.method = next as HttpMethod)}
      />
    </div>
    <div class="min-w-[16rem] flex-1">
      <TextField
        label="Path template"
        value={draft.path}
        placeholder={'/contacts/{{id}}'}
        hint={`Relative to ${baseUrl || 'the service base URL'}.`}
        onchange={(next) => (draft.path = next)}
      />
    </div>
  </div>
  <TemplatePreview
    value={`${baseUrl}${draft.path}`}
    {missing}
    empty="Enter a base URL and path to preview the request."
  />
</div>
