<script lang="ts">
/**
 * NewToolWizard: the guided entry point for adding a tool.
 *
 * Creating a tool has four honest answers, and the wizard asks which one applies
 * before showing a form: use a capability Mentat already has, call an HTTP endpoint,
 * import an OpenAPI document, or connect an MCP server. Each path is a focused panel
 * that owns its own validation and commits the same objects the full editors do.
 */
import Modal from '$ui/primitives/Modal.svelte';
import HttpToolPanel from './wizard/HttpToolPanel.svelte';
import McpServerPanel from './wizard/McpServerPanel.svelte';
import OpenApiImportPanel from './wizard/OpenApiImportPanel.svelte';
import PlatformCapabilityPanel from './wizard/PlatformCapabilityPanel.svelte';

type Source = 'platform' | 'http' | 'openapi' | 'mcp';

interface Props {
  open?: boolean;
  onclose: () => void;
  oncreated: (message: string) => void;
  /** Refresh the catalogue without closing (used by inline MCP changes). */
  onchanged?: () => void;
}

let { open = $bindable(false), onclose, oncreated, onchanged }: Props = $props();

let source = $state<Source | null>(null);

const sources: Array<{
  id: Source;
  title: string;
  description: string;
  detail: string;
}> = [
  {
    id: 'platform',
    title: 'Platform capability',
    description: 'Use something Mentat already does',
    detail:
      'Tickets, state, data, cache and files ship as native tools. Browse them and grant to an agent — no connection needed.'
  },
  {
    id: 'http',
    title: 'HTTP API call',
    description: 'Call a REST endpoint',
    detail:
      'Create a connection and one operation, step by step. Best for a single endpoint or a small API.'
  },
  {
    id: 'openapi',
    title: 'OpenAPI document',
    description: 'Import a whole spec',
    detail:
      'Paste or upload an OpenAPI 3.x document, review the operations, and import the ones you want as tools.'
  },
  {
    id: 'mcp',
    title: 'MCP server',
    description: 'Connect a Model Context Protocol server',
    detail:
      'Register a server, discover the tools it advertises, and import them with the schemas it declares.'
  }
];

function close() {
  source = null;
  onclose();
}

function done(message: string) {
  source = null;
  oncreated(message);
  onclose();
}
</script>

<Modal
  open={open}
  title="Add a tool"
  description="What an agent can do comes from one of four places. Pick where this capability lives."
  width="46rem"
  onclose={close}
>
  {#if source === null}
    <div class="grid gap-3 sm:grid-cols-2">
      {#each sources as option (option.id)}
        <button
          type="button"
          class="flex h-full flex-col gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] p-3.5 text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
          onclick={() => (source = option.id)}
        >
          <span class="text-sm font-semibold text-[var(--color-ink)]">{option.title}</span>
          <span class="text-[11px] font-medium tracking-wide text-[var(--color-accent-ink)] uppercase">
            {option.description}
          </span>
          <span class="text-xs leading-relaxed text-[var(--color-ink-muted)]">{option.detail}</span>
        </button>
      {/each}
    </div>
  {:else if source === 'platform'}
    <PlatformCapabilityPanel onBack={() => (source = null)} onDone={done} />
  {:else if source === 'http'}
    <HttpToolPanel onBack={() => (source = null)} onDone={done} />
  {:else if source === 'openapi'}
    <OpenApiImportPanel onBack={() => (source = null)} onDone={done} />
  {:else if source === 'mcp'}
    <McpServerPanel onBack={() => (source = null)} onDone={done} onChanged={onchanged} />
  {/if}
</Modal>
