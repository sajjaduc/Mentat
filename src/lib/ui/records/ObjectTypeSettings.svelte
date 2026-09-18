<script lang="ts">
/**
 * Object Type settings: define the schema for a kind of thing.
 *
 * The schema is authored as Zod source in one box (ADR-0023): it is tested against a
 * JSON sample before saving, then stored verbatim and compiled at validation time.
 * The typed fields below are a read-only projection of it, which is what keeps
 * record lists, filters and history working without a second source of truth.
 */
import { describeApiError } from '$ui/api';
import PageHeader from '$ui/common/PageHeader.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { recordsApi } from '$ui/records/api';
import type { ObjectTypeFieldView, ObjectTypeSummary } from '$ui/records/types';
import { schemaApi } from '$ui/schema/api';
import {
  describeDefaultValue,
  describeFieldChoices,
  describeFieldValidation
} from '$ui/schema/field-summary';
import { buildStarterZodSchema } from '$ui/schema/starter';
import ZodFieldMappingGuide from '$ui/schema/ZodFieldMappingGuide.svelte';
import ZodSchemaBox from '$ui/schema/ZodSchemaBox.svelte';
import { pushToast } from '$ui/toast';

let types = $state<ObjectTypeSummary[]>([]);
let selectedId = $state('');
let fields = $state<ObjectTypeFieldView[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let saving = $state(false);
let schemaSaving = $state(false);
let starter = $state('');
let draftName = $state('');
let draftPlural = $state('');
let draftDescription = $state('');

const selected = $derived(types.find((type) => type.id === selectedId) ?? null);
const schemaSource = $derived(String(selected?.settings?.zodSchema ?? ''));
const primaryField = $derived(fields.find((field) => field.isPrimaryDisplay) ?? null);

async function load() {
  loading = true;
  error = null;
  try {
    types = await recordsApi.listObjectTypes();
    if (!selectedId && types[0]) await select(types[0].id);
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

async function select(id: string) {
  selectedId = id;
  starter = '';
  const type = types.find((entry) => entry.id === id);
  draftName = type?.name ?? '';
  draftPlural = type?.pluralName ?? '';
  draftDescription = type?.description ?? '';
  fields = await recordsApi.objectTypeFields(id);
}

async function createType() {
  const name = draftName.trim();
  if (name === '') return;
  try {
    const created = await recordsApi.createObjectType({ name });
    types = await recordsApi.listObjectTypes();
    await select(created.id);
    pushToast({ tone: 'success', title: `${created.name} created` });
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  }
}

async function saveMetadata() {
  if (!selected) return;
  saving = true;
  try {
    await recordsApi.updateObjectType(selected.id, {
      name: draftName.trim(),
      pluralName: draftPlural.trim(),
      description: draftDescription.trim()
    });
    types = await recordsApi.listObjectTypes();
    pushToast({ tone: 'success', title: 'Object Type updated' });
  } catch (failure) {
    pushToast({ tone: 'error', title: describeApiError(failure) });
  } finally {
    saving = false;
  }
}

async function saveSchema(source: string) {
  if (!selected) return;
  schemaSaving = true;
  try {
    const result = await schemaApi.saveObjectType(selected.id, source);
    fields = result.fields;
    types = await recordsApi.listObjectTypes();
    starter = '';
    pushToast({ tone: 'success', title: 'Schema saved' });
  } catch (failure) {
    // Rethrow so the box shows the validation message inline at the point of edit.
    pushToast({ tone: 'error', title: describeApiError(failure) });
    throw failure;
  } finally {
    schemaSaving = false;
  }
}

function generateStarter() {
  starter = buildStarterZodSchema(
    fields.map((field) => ({
      key: field.key,
      name: field.name,
      type: field.type,
      required: field.required,
      options: field.options,
      isIdentity: field.isIdentity,
      isPrimaryDisplay: field.isPrimaryDisplay,
      showInList: field.showInList,
      showOnCard: field.showOnCard,
      filterable: field.filterable
    }))
  );
}

$effect(() => {
  void load();
});
</script>

<div class="space-y-4 p-4 sm:p-6">
  <PageHeader
    eyebrow="Settings"
    title="Object Types"
    description="Define the schema for each kind of Record as Zod source. Records are validated against it whenever they are written — from the record editor, record tools or an AI submission."
  />

  {#if loading}
    <Skeleton class="h-64 w-full" />
  {:else if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else}
    <Card>
      <div class="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Select
          label="Object Type"
          options={types.map((type) => ({
            value: type.id,
            label: `${type.name}${type.isSystem ? ' (system)' : ''} · ${type.recordCount} records`
          }))}
          bind:value={selectedId}
          onchange={(event) => void select((event.currentTarget as HTMLSelectElement).value)}
        />
        <Button variant="secondary" onclick={() => void createType()}>Create from name</Button>
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-3">
        <Input label="New Object Type name" bind:value={draftName} placeholder="Policy" />
        <Input label="Plural name" bind:value={draftPlural} placeholder="Policies" />
        <Input label="Description" bind:value={draftDescription} />
      </div>
      <div class="mt-3 flex justify-end">
        <Button loading={saving} disabled={!selected} onclick={() => void saveMetadata()}>
          Save definition
        </Button>
      </div>
    </Card>

    {#if selected}
      <Card>
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-medium text-[var(--color-ink)]">Schema</h2>
          {#if selected.isSystem}
            <Badge tone="muted">System schema — managed by Mentat</Badge>
          {/if}
        </div>

        {#if selected.isSystem}
          <p class="text-xs text-[var(--color-ink-subtle)]">
            This Object Type ships with Mentat; its schema cannot be edited.
          </p>
        {:else}
          {#if schemaSource === ''}
            <div
              class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)]/50 p-3"
            >
              <p class="text-xs text-[var(--color-ink-muted)]">
                This Object Type has typed fields but no Zod source yet. Generate a starter schema
                from them, then test and save it.
              </p>
              <Button size="sm" variant="secondary" onclick={generateStarter}>
                Generate starter schema
              </Button>
            </div>
          {/if}

          <ZodSchemaBox
            value={schemaSource}
            draftSeed={starter}
            saving={schemaSaving}
            saveLabel="Save schema"
            hint="Paste a Zod object expression. It is stored as-is and compiled whenever a record is validated."
            onSave={saveSchema}
          />
        {/if}
      </Card>

      <ZodFieldMappingGuide />

      <Card>
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-medium text-[var(--color-ink)]">
            Fields {#if schemaSource !== ''}<span class="font-normal text-[var(--color-ink-subtle)]">(from the schema)</span>{/if}
          </h2>
          <span class="text-[11px] text-[var(--color-ink-subtle)]">{fields.length} field{fields.length === 1 ? '' : 's'}</span>
        </div>
        {#if fields.length === 0}
          <p class="text-xs text-[var(--color-ink-subtle)]">
            No fields yet. Save a Zod schema above to create them.
          </p>
        {:else}
          <p class="mb-2 text-[11px] text-[var(--color-ink-subtle)]">
            {#if primaryField}
              Display name comes from <span class="font-mono">{primaryField.key}</span>. Set
              <span class="font-mono">primary: true</span> on another field to change it.
            {:else}
              No field is marked primary, so records show “Untitled {selected?.name ?? 'record'}”.
              Add <span class="font-mono">primary: true</span> to the field that should label them.
            {/if}
          </p>
          <div class="space-y-2">
            {#each fields as field (field.bindingId)}
              {@const choices = describeFieldChoices(field.options)}
              {@const validation = describeFieldValidation(field.validation)}
              {@const fallback = describeDefaultValue(field.defaultValue)}
              <div class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] p-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs font-medium text-[var(--color-ink)]">{field.name}</span>
                  <span class="font-mono text-[11px] text-[var(--color-ink-subtle)]">{field.key}</span>
                  <Badge tone={field.type === 'json' ? 'muted' : 'accent'}>{field.type}</Badge>
                  <Badge tone={field.required ? 'neutral' : 'muted'}>
                    {field.required ? 'required' : 'optional'}
                  </Badge>
                  {#if field.isIdentity}<Badge tone="caution">identity</Badge>{/if}
                  {#if field.isPrimaryDisplay}<Badge tone="positive">primary</Badge>{/if}
                  {#if field.isSecondaryDisplay}<Badge tone="muted">secondary</Badge>{/if}
                  {#if !field.showInList}<Badge tone="muted">hidden in list</Badge>{/if}
                  {#if field.showOnCard}<Badge tone="muted">on card</Badge>{/if}
                  {#if !field.filterable}<Badge tone="muted">not filterable</Badge>{/if}
                </div>
                {#if field.description}
                  <p class="mt-1 text-[11px] text-[var(--color-ink-muted)]">{field.description}</p>
                {/if}
                <div class="mt-1 space-y-0.5">
                  {#if choices}
                    <p class="text-[11px] text-[var(--color-ink-subtle)]">
                      Choices: <span class="text-[var(--color-ink-muted)]">{choices}</span>
                    </p>
                  {/if}
                  {#if validation}
                    <p class="text-[11px] text-[var(--color-ink-subtle)]">
                      Validation: <span class="font-mono">{validation}</span>
                    </p>
                  {/if}
                  {#if fallback}
                    <p class="text-[11px] text-[var(--color-ink-subtle)]">
                      Default: <span class="font-mono">{fallback}</span>
                    </p>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </Card>
    {/if}
  {/if}
</div>
