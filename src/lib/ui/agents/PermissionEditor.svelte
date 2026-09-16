<script lang="ts">
/**
 * PermissionEditor: the explicit grant surface for an agent.
 *
 * An agent begins with nothing but read access to the ticket it is working on, so
 * every checkbox here is a decision rather than a default. Native capabilities are
 * derived from the tool registry itself, which keeps the list in step with what the
 * runner can actually enforce, and they are stored in the prefixed `mentat.*` key
 * form the registry uses.
 */
import { truncate } from '$shared/format';
import {
  NATIVE_PERMISSION_NAMESPACES,
  type NativeToolDescriptor,
  type Tool
} from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import MultiSelect from '$ui/http/controls/MultiSelect.svelte';
import Section from '$ui/http/controls/Section.svelte';
import TagsInput from '$ui/http/controls/TagsInput.svelte';
import Toggle from '$ui/http/controls/Toggle.svelte';
import type { HttpOperation } from '$ui/http/types';
import Badge from '$ui/primitives/Badge.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { namespaceForKey, ToolGroup } from './tools';

interface Props {
  native?: string[];
  httpOperationIds?: string[];
  canCreateTickets?: boolean;
  canTransferTickets?: boolean;
  canWriteWorkspaceState?: boolean;
  canUploadFiles?: boolean;
  writableFieldKeys?: string[];
}

let {
  native = $bindable<string[]>([]),
  httpOperationIds = $bindable<string[]>([]),
  canCreateTickets = $bindable(false),
  canTransferTickets = $bindable(false),
  canWriteWorkspaceState = $bindable(false),
  canUploadFiles = $bindable(false),
  writableFieldKeys = $bindable<string[]>([])
}: Props = $props();

let nativeTools = $state<NativeToolDescriptor[]>([]);
let operations = $state<HttpOperation[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    const [toolResult, operationResult] = await Promise.all([
      api.get<{ native: NativeToolDescriptor[]; stored: Tool[] }>('/api/tools'),
      api.get<{ operations: HttpOperation[] }>('/api/http/operations')
    ]);
    nativeTools = toolResult.native;
    operations = operationResult.operations;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

/** The prefixed and bare spellings of a capability key. */
function capabilityForms(key: string): string[] {
  const bare = key.startsWith('mentat.') ? key.slice('mentat.'.length) : key;
  return [key, bare];
}

function namespaceOf(key: string): string {
  return namespaceForKey(key);
}

function isGranted(key: string): boolean {
  return capabilityForms(key).some((form) => native.includes(form));
}

function toggleNative(key: string) {
  const forms = capabilityForms(key);
  const granted = forms.some((form) => native.includes(form));
  native = granted ? native.filter((entry) => !forms.includes(entry)) : [...native, key];
}

/** Grant or clear every capability in a namespace in one action. */
function toggleNativeGroup(tools: NativeToolDescriptor[], next: boolean) {
  for (const tool of tools) {
    if (isGranted(tool.key) !== next) toggleNative(tool.key);
  }
}

function nativeGroupState(tools: NativeToolDescriptor[]): 'all' | 'some' | 'none' {
  const granted = tools.filter((tool) => isGranted(tool.key)).length;
  if (granted === 0) return 'none';
  return granted === tools.length ? 'all' : 'some';
}

const NATIVE_ORDER: readonly string[] = NATIVE_PERMISSION_NAMESPACES;

const nativeGroups = $derived.by(() => {
  const groups = new Map<string, NativeToolDescriptor[]>();
  for (const tool of nativeTools) {
    const namespace = namespaceOf(tool.key);
    const bucket = groups.get(namespace);
    if (bucket) bucket.push(tool);
    else groups.set(namespace, [tool]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const aIndex = NATIVE_ORDER.indexOf(a);
    const bIndex = NATIVE_ORDER.indexOf(b);
    const aRank = aIndex === -1 ? NATIVE_ORDER.length : aIndex;
    const bRank = bIndex === -1 ? NATIVE_ORDER.length : bIndex;
    return aRank === bRank ? a.localeCompare(b) : aRank - bRank;
  });
});

const operationOptions = $derived(
  operations.map((operation) => ({
    value: operation.id,
    label: operation.key,
    group: namespaceForKey(operation.key),
    hint: `${operation.method} ${operation.path}${
      operation.description.length > 0 ? ` — ${truncate(operation.description, 120)}` : ''
    }`,
    badge: operation.enabled ? undefined : 'disabled'
  }))
);

const booleanGrants = $derived(
  [canCreateTickets, canTransferTickets, canWriteWorkspaceState, canUploadFiles].filter(Boolean)
    .length
);

const grantedCount = $derived(native.length + httpOperationIds.length + booleanGrants);

const writableScope = $derived(
  writableFieldKeys.length === 0
    ? 'No fields writable'
    : writableFieldKeys.includes('*')
      ? 'All fields writable'
      : `${writableFieldKeys.length} field${writableFieldKeys.length === 1 ? '' : 's'} writable`
);
</script>

<Section
  title="Permissions"
  description="Nothing is granted by default. An agent can always read the ticket it is working on; every other capability is a deliberate grant."
>
  {#if loading}
    <Skeleton lines={4} height="2.25rem" />
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else}
    <div
      class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-muted)] px-3 py-2"
    >
      <Badge tone={grantedCount > 0 ? 'accent' : 'muted'}>{grantedCount} granted</Badge>
      <span class="text-[11px] text-[var(--color-ink-subtle)]">{writableScope}</span>
      <span class="text-[11px] text-[var(--color-ink-subtle)]">
        Read access to the current ticket is implicit.
      </span>
    </div>

    <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
      <div class="space-y-0.5">
        <p class="text-sm font-medium text-[var(--color-ink)]">Native capabilities</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Exact tool capabilities, grouped by namespace and stored in the
          <span class="font-mono">mentat.</span> key form.
        </p>
      </div>

      {#if nativeGroups.length === 0}
        <p class="text-xs text-[var(--color-ink-subtle)]">No native capabilities are registered.</p>
      {:else}
        <div class="space-y-2">
          {#each nativeGroups as [namespace, tools] (namespace)}
            {@const granted = tools.filter((tool) => isGranted(tool.key)).length}
            <ToolGroup
              name={namespace}
              count={tools.length}
              meta={`${granted} of ${tools.length} granted`}
              toggle={{
                state: nativeGroupState(tools),
                onToggle: (next: boolean) => toggleNativeGroup(tools, next),
                hint: 'Grant group'
              }}
            >
              <div class="space-y-2.5">
                {#each tools as tool (tool.key)}
                  <label class="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                      checked={isGranted(tool.key)}
                      onchange={() => toggleNative(tool.key)}
                    />
                    <span class="min-w-0 space-y-0.5">
                      <span class="flex flex-wrap items-center gap-1.5">
                        <span class="font-mono text-xs text-[var(--color-ink)]">{tool.key}</span>
                        {#if tool.permission !== null}
                          <Badge tone="neutral">{tool.permission}</Badge>
                        {/if}
                        {#if !tool.enabled}
                          <Badge tone="caution">disabled</Badge>
                        {/if}
                      </span>
                      <span class="block text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
                        {tool.description}
                      </span>
                    </span>
                  </label>
                {/each}
              </div>
            </ToolGroup>
          {/each}
        </div>
      {/if}
    </div>

    <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
      <p class="text-sm font-medium text-[var(--color-ink)]">Ticket, file and state grants</p>
      <div class="grid gap-3 md:grid-cols-2">
        <Toggle
          bind:checked={canCreateTickets}
          label="Create tickets"
          hint="Open new tickets in the workflows this agent can reach."
        />
        <Toggle
          bind:checked={canTransferTickets}
          label="Transfer tickets"
          hint="Move a ticket to another workflow."
        />
        <Toggle
          bind:checked={canUploadFiles}
          label="Upload and delete files"
          hint="Attach new files and remove existing ones."
        />
        <Toggle
          bind:checked={canWriteWorkspaceState}
          label="Write workspace state"
          hint="Persist values in workspace-scoped state."
        />
      </div>
    </div>

    <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
      <TagsInput
        bind:values={writableFieldKeys}
        label="Writable field keys"
        hint="Empty means no fields. Add * to allow every field."
        placeholder="Add a field key…"
        emptyLabel="No fields writable."
      />
    </div>

    <div class="border-t border-[var(--color-border-subtle)] pt-4">
      <MultiSelect
        label="HTTP operations"
        hint="Operations this agent may invoke directly, in addition to any HTTP tools attached on the Tools tab. Use a group's checkbox to grant or revoke the whole namespace."
        searchPlaceholder="Search operations…"
        emptyLabel="No HTTP operations exist yet."
        options={operationOptions}
        groupToggle
        bind:selected={httpOperationIds}
      />
    </div>
  {/if}
</Section>
