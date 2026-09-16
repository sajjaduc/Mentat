<script lang="ts">
/**
 * Guided MCP server registration.
 *
 * Register a connection once, discover what it advertises, and import only the tools
 * you want. The "Test & discover" step talks to the server before anything is saved,
 * so a typo in the URL fails in the wizard rather than leaving a broken row behind.
 * Existing servers can be re-synced (their schemas change as the server evolves) or
 * removed here.
 */
import type { McpDiscoveredTool, McpServer, Tool } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import SelectField from '$ui/http/controls/SelectField.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import type { SecretView } from '$ui/http/types';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { groupSelectionState, toggleGroupSelection } from '../group-selection';
import ToolGroup from '../ToolGroup.svelte';

interface Props {
  onBack: () => void;
  onDone: (message: string) => void;
  /** Refresh the parent catalogue after an inline change (re-sync, remove). */
  onChanged?: () => void;
}

let { onBack, onDone, onChanged }: Props = $props();

let loading = $state(true);
let loadError = $state<string | null>(null);
let servers = $state<McpServer[]>([]);
let storedTools = $state<Tool[]>([]);
let secrets = $state<SecretView[]>([]);

let mode = $state<'list' | 'add'>('list');
let notice = $state<string | null>(null);
let error = $state<string | null>(null);

let name = $state('');
let url = $state('');
let authType = $state<'none' | 'bearer' | 'custom_header'>('none');
let secretId = $state('');
let headerName = $state('X-Api-Key');
let template = $state('{{secret}}');
let timeoutMs = $state<number | null>(null);

let discovered = $state<McpDiscoveredTool[] | null>(null);
let selected = $state<string[]>([]);
let discovering = $state(false);
let saving = $state(false);
let busyId = $state<string | null>(null);

async function load() {
  loading = true;
  loadError = null;
  try {
    const [serverResult, toolResult, secretResult] = await Promise.all([
      api.get<{ servers: McpServer[] }>('/api/mcp/servers'),
      api.get<{ stored: Tool[] }>('/api/tools'),
      api
        .get<{ secrets: SecretView[] }>('/api/secrets')
        .catch(() => ({ secrets: [] as SecretView[] }))
    ]);
    servers = serverResult.servers;
    storedTools = toolResult.stored;
    secrets = secretResult.secrets;
    mode = servers.length === 0 ? 'add' : 'list';
  } catch (failure) {
    loadError = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

const secretOptions = $derived(
  secrets.map((secret) => ({
    value: secret.id,
    label: `${secret.key}${secret.lastFour ? ` · ••••${secret.lastFour}` : ' · value hidden'}`
  }))
);

function toolCount(serverId: string): number {
  return storedTools.filter(
    (tool) => tool.kind === 'mcp' && tool.implementation.serverId === serverId
  ).length;
}

function connectionPayload() {
  return {
    name: name.trim(),
    url: url.trim(),
    authType,
    authConfig:
      authType === 'none'
        ? null
        : authType === 'bearer'
          ? { secretId }
          : { secretId, headerName: headerName.trim(), template: template.trim() },
    timeoutMs: timeoutMs ?? undefined
  };
}

async function discover() {
  if (!name.trim() || !url.trim()) {
    error = 'A name and a server URL are required.';
    return;
  }
  if (authType !== 'none' && !secretId) {
    error = 'Choose the secret that holds the credential.';
    return;
  }
  discovering = true;
  error = null;
  try {
    const result = await api.post<{ server: { tools: McpDiscoveredTool[] } }>(
      '/api/mcp/servers/preview',
      connectionPayload()
    );
    discovered = result.server.tools;
    selected = result.server.tools.map((tool) => tool.name);
  } catch (failure) {
    error = describeApiError(failure);
    discovered = null;
  } finally {
    discovering = false;
  }
}

async function save() {
  if (!discovered || selected.length === 0) {
    error = 'Discover and select at least one tool.';
    return;
  }
  saving = true;
  error = null;
  try {
    const result = await api.post<{ created: number; updated: number }>('/api/mcp/servers', {
      ...connectionPayload(),
      toolNames: selected
    });
    onDone(`Added ${result.created + result.updated} MCP tool(s) from ${name.trim()}`);
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    saving = false;
  }
}

async function resync(server: McpServer) {
  busyId = server.id;
  notice = null;
  error = null;
  try {
    const result = await api.post<{ created: number; updated: number }>(
      `/api/mcp/servers/${server.id}/discover`
    );
    notice = `${server.name}: ${result.created} added, ${result.updated} refreshed.`;
    await load();
    onChanged?.();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    busyId = null;
  }
}

async function remove(server: McpServer) {
  busyId = server.id;
  notice = null;
  error = null;
  try {
    await api.delete(`/api/mcp/servers/${server.id}`);
    notice = `Removed ${server.name}. Its tools are disabled but keep their ids.`;
    await load();
    onChanged?.();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    busyId = null;
  }
}
</script>

{#if loading}
  <Skeleton lines={4} height="2rem" />
{:else if loadError}
  <ErrorState message={loadError} onRetry={load} />
{:else}
  <div class="space-y-4">
    {#if notice}
      <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">
        {notice}
      </p>
    {/if}
    {#if error}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
    {/if}

    {#if mode === 'list'}
      <div class="space-y-2">
        {#each servers as server (server.id)}
          <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0 space-y-0.5">
                <p class="text-sm font-medium text-[var(--color-ink)]">{server.name}</p>
                <p class="truncate font-mono text-[11px] text-[var(--color-ink-subtle)]">{server.url}</p>
                <p class="text-[11px] text-[var(--color-ink-subtle)]">
                  {toolCount(server.id)} tool(s)
                  {#if server.lastDiscoveredAt}
                    · synced {new Date(server.lastDiscoveredAt).toLocaleString()}
                  {:else}
                    · never synced
                  {/if}
                </p>
                {#if server.lastError}
                  <p class="text-[11px] text-[var(--color-danger)]">{server.lastError}</p>
                {/if}
              </div>
              <div class="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busyId === server.id}
                  onclick={() => resync(server)}
                >
                  Re-sync
                </Button>
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Remove server"
                  disabled={busyId === server.id}
                  onconfirm={() => remove(server)}
                />
              </div>
            </div>
          </div>
        {/each}
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
        <Button variant="ghost" onclick={onBack}>Back</Button>
        <Button variant="primary" onclick={() => (mode = 'add')}>Add a server</Button>
      </div>
    {:else}
      <TextField label="Server name" bind:value={name} required placeholder="linear" hint="Used to group and prefix its tools." />
      <TextField label="Server URL" type="url" bind:value={url} required placeholder="https://mcp.example.com/mcp" />
      <SelectField
        label="Authentication"
        value={authType}
        options={[
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer token' },
          { value: 'custom_header', label: 'Custom header' }
        ]}
        onchange={(value) => (authType = value as typeof authType)}
      />
      {#if authType !== 'none'}
        <SelectField
          label="Secret"
          options={secretOptions}
          bind:value={secretId}
          placeholder={secretOptions.length === 0 ? 'No secrets exist yet' : 'Choose a secret'}
          hint="Create secrets under Settings → Secrets; the value is never displayed."
        />
      {/if}
      {#if authType === 'custom_header'}
        <div class="grid gap-4 sm:grid-cols-2">
          <TextField label="Header name" bind:value={headerName} />
          <TextField label="Header template" bind:value={template} hint={'Use {{secret}} for the credential.'} />
        </div>
      {/if}

      {#if !discovered}
        <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
          <Button variant="ghost" onclick={() => (servers.length > 0 ? (mode = 'list') : onBack())}>
            {servers.length > 0 ? 'Back to servers' : 'Back'}
          </Button>
          <Button variant="primary" loading={discovering} onclick={discover}>Test &amp; discover</Button>
        </div>
      {:else}
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium text-[var(--color-ink-muted)]">
              {discovered.length} tool(s) advertised · {selected.length} selected
            </p>
            <button
              type="button"
              class="text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)]"
              onclick={() =>
                (selected =
                  selected.length === discovered!.length ? [] : discovered!.map((tool) => tool.name))}
            >
              {selected.length === discovered.length ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <ToolGroup
            name={name.trim() || 'Discovered tools'}
            count={discovered.length}
            toggle={{
              state: groupSelectionState(selected, discovered.map((tool) => tool.name)),
              onToggle: () =>
                (selected = toggleGroupSelection(selected, discovered!.map((tool) => tool.name))),
              hint: 'All'
            }}
          >
            <ul class="space-y-2">
              {#each discovered as tool (tool.name)}
                <li>
                  <label class="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                      checked={selected.includes(tool.name)}
                      onchange={() =>
                        (selected = selected.includes(tool.name)
                          ? selected.filter((entry) => entry !== tool.name)
                          : [...selected, tool.name])}
                    />
                    <span class="min-w-0 space-y-0.5">
                      <span class="font-mono text-xs text-[var(--color-ink)]">{tool.name}</span>
                      <span class="block text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
                        {tool.description}
                      </span>
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          </ToolGroup>
        </div>
        <div class="flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] pt-3">
          <Button variant="ghost" onclick={() => (discovered = null)}>Back to connection</Button>
          <Button variant="primary" loading={saving} onclick={save}>
            Add server &amp; {selected.length} tool{selected.length === 1 ? '' : 's'}
          </Button>
        </div>
      {/if}
    {/if}
  </div>
{/if}
