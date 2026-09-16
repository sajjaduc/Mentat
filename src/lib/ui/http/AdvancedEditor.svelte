<script lang="ts">
/**
 * AdvancedEditor: the semantic, model-facing half of an operation.
 *
 * ADR-0014 draws the line this tab makes visible: the model sees the key, name,
 * description and schemas — never the transport. Exposing the operation derives a tool
 * row automatically, and `enabled`/`exposeAsTool` are what actually gate a model's
 * access, so they are grouped here with the archive action.
 */

import ConfirmButton from './controls/ConfirmButton.svelte';
import NumberField from './controls/NumberField.svelte';
import Section from './controls/Section.svelte';
import TextAreaField from './controls/TextAreaField.svelte';
import TextField from './controls/TextField.svelte';
import Toggle from './controls/Toggle.svelte';
import type { OperationDraft } from './draft';

interface Props {
  draft: OperationDraft;
  currentKey: string | null;
  onArchive: () => void;
  archiving?: boolean;
}

let { draft, currentKey, onArchive, archiving = false }: Props = $props();

const exposed = $derived(draft.exposeAsTool && draft.enabled);
</script>

<div class="space-y-5">
  <Section
    title="Semantic tool"
    description="This is what an agent sees. The key is namespaced, lowercase and stable — models call it by this name."
  >
    <div class="grid gap-3 sm:grid-cols-2">
      <TextField
        label="Tool key"
        value={draft.key}
        placeholder="hubspot.get_contact"
        hint="Lowercase letters, digits, dots, dashes or underscores."
        onchange={(next) => (draft.key = next)}
      />
      <TextField
        label="Display name"
        value={draft.name}
        placeholder="Get contact"
        onchange={(next) => (draft.name = next)}
      />
    </div>
    <TextAreaField
      label="Description"
      value={draft.description}
      rows={3}
      placeholder="Explain when a model should call this and what it returns."
      onchange={(next) => (draft.description = next)}
    />
    <div class="grid gap-3 sm:grid-cols-2">
      <Toggle
        checked={draft.exposeAsTool}
        label="Expose as a tool"
        hint="Keeps a matching tool row in sync so an agent can be granted it."
        onchange={(next) => (draft.exposeAsTool = next)}
      />
      <Toggle
        checked={draft.enabled}
        label="Enabled"
        hint="A disabled operation cannot be invoked, tested by a model, or exposed."
        onchange={(next) => (draft.enabled = next)}
      />
    </div>
    <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
      {exposed
        ? `Agents can be granted the tool "${draft.key || 'unnamed'}".`
        : 'Not exposed to agents. Nothing in Mentat can call this operation.'}
    </p>
  </Section>

  <Section
    title="Transport details"
    description="Overrides for this operation only; leave empty to inherit the service value."
  >
    <div class="grid gap-3 sm:grid-cols-2">
      <NumberField
        label="Timeout (ms)"
        min={100}
        max={120000}
        value={draft.timeoutMs}
        placeholder="Inherit service"
        onchange={(next) => (draft.timeoutMs = next)}
      />
      <NumberField
        label="Position"
        min={0}
        value={draft.position}
        hint="Orders operations within the service."
        onchange={(next) => (draft.position = next ?? 0)}
      />
    </div>
  </Section>

  <Section
    title="Archive"
    description="Archiving hides the operation and disables its derived tool. Existing request logs stay readable."
  >
    <ConfirmButton
      label="Archive operation"
      confirmLabel="Confirm archive"
      disabled={currentKey === null || archiving}
      onconfirm={onArchive}
      title={currentKey === null ? 'Save the operation before archiving it' : undefined}
    />
    {#if currentKey === null}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        This operation has not been created yet, so there is nothing to archive.
      </p>
    {/if}
  </Section>
</div>
