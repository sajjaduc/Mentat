<script lang="ts">
/**
 * WorkItem artifacts.
 *
 * Files may be uploaded here, linked from the workspace library, or attached by an
 * agent or trigger. Provenance and processing status are shown because an artifact
 * received from an email is a different claim from one a person uploaded, and the
 * pipeline may still be extracting it.
 */
import { formatBytes, formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import type { FileSummaryView, WorkItemFileLink } from '$ui/work/types';
import type { WorkItemActions } from '$ui/work-item/actions';

interface Props {
  workflowItemId: string;
  files: WorkItemFileLink[];
  actions: WorkItemActions;
}

let { workflowItemId, files, actions }: Props = $props();

let details = $state<Record<string, FileSummaryView>>({});
let uploading = $state(false);
let uploadError = $state<string | null>(null);
let linking = $state(false);
let query = $state('');
let results = $state<FileSummaryView[]>([]);
let searching = $state(false);
let fileInput: HTMLInputElement | undefined = $state();

const requested = new Set<string>();

$effect(() => {
  for (const file of files) {
    if (requested.has(file.id)) continue;
    requested.add(file.id);
    void (async () => {
      try {
        const response = await api.get<{ file: FileSummaryView }>(`/api/files/${file.id}`);
        details = { ...details, [file.id]: response.file };
      } catch {
        // Provenance is decoration; a failure must not hide the file.
      }
    })();
  }
});

function statusTone(status: string): 'positive' | 'caution' | 'danger' | 'muted' {
  if (status === 'ready') return 'positive';
  if (status === 'failed' || status === 'quarantined') return 'danger';
  if (status === 'pending' || status === 'processing') return 'caution';
  return 'muted';
}

async function upload(file: File) {
  uploading = true;
  uploadError = null;
  try {
    const form = new FormData();
    form.set('file', file);
    form.set('workflowItemId', workflowItemId);
    form.set('sourceType', 'human_upload');
    await api.upload('/api/files', form);
    await actions.refresh();
    pushToast({ tone: 'success', title: `${file.name} attached` });
  } catch (failure) {
    uploadError = describeApiError(failure);
  } finally {
    uploading = false;
    if (fileInput) fileInput.value = '';
  }
}

async function search() {
  const term = query.trim();
  if (term.length < 2) {
    results = [];
    return;
  }
  searching = true;
  try {
    const response = await api.get<{ items: FileSummaryView[] }>('/api/files', {
      filename: term,
      limit: 8
    });
    const linked = new Set(files.map((file) => file.id));
    results = response.items.filter((file) => !linked.has(file.id));
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not search files',
      description: describeApiError(failure)
    });
  } finally {
    searching = false;
  }
}

async function link(fileId: string) {
  await actions.attachFile({ fileId, relationship: 'attachment' });
  linking = false;
  query = '';
  results = [];
}
</script>

<div class="space-y-4 p-4" data-testid="artifacts-tab">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
      Files
    </h3>
    <span class="ml-auto flex items-center gap-2">
      <input
        bind:this={fileInput}
        type="file"
        class="hidden"
        aria-label="Upload file"
        onchange={(event) => {
          const file = (event.currentTarget as HTMLInputElement).files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        size="sm"
        variant="primary"
        loading={uploading}
        onclick={() => fileInput?.click()}
      >
        Upload
      </Button>
      <Button size="sm" variant="secondary" onclick={() => (linking = !linking)}>
        {linking ? 'Cancel' : 'Link existing'}
      </Button>
    </span>
  </div>

  {#if uploadError}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{uploadError}</p>
  {/if}

  {#if linking}
    <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-2">
      <Input
        value={query}
        oninput={(event) => {
          query = (event.currentTarget as HTMLInputElement).value;
          void search();
        }}
        label="Search the file library"
        placeholder="Filename"
      />
      {#if searching}
        <p class="text-xs text-[var(--color-ink-subtle)]">Searching…</p>
      {:else if results.length > 0}
        <ul class="space-y-1">
          {#each results as file (file.id)}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
                onclick={() => link(file.id)}
              >
                <span class="truncate">{file.filename}</span>
                <span class="ml-auto shrink-0 text-[10px] text-[var(--color-ink-subtle)]"
                  >{formatBytes(file.size)}</span
                >
              </button>
            </li>
          {/each}
        </ul>
      {:else if query.trim().length >= 2}
        <p class="text-xs text-[var(--color-ink-subtle)]">No matching files.</p>
      {/if}
    </div>
  {/if}

  {#if files.length === 0}
    <EmptyState
      title="No artifacts yet"
      description="Upload a file, link one from the library, or let an agent or trigger attach it."
    >
      <Button variant="primary" loading={uploading} onclick={() => fileInput?.click()}>Upload a file</Button>
    </EmptyState>
  {:else}
    <ul class="space-y-2">
      {#each files as file (file.id)}
        {@const detail = details[file.id]}
        <li
          class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2.5"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{file.filename}</p>
              <p class="text-[11px] text-[var(--color-ink-subtle)]">
                {file.mimeType || 'unknown type'} · {formatBytes(file.size)} ·
                {file.relationship}
              </p>
            </div>
            <Badge tone={statusTone(file.status)}>{file.status}</Badge>
            <button
              type="button"
              class="rounded-[var(--radius-xs)] px-1 text-[11px] text-[var(--color-ink-subtle)] hover:text-[var(--color-danger)]"
              aria-label="Unlink {file.filename}"
              title="Unlink file"
              onclick={() => actions.unlinkFile(file.id)}
            >
              ✕
            </button>
          </div>
          {#if detail}
            <p class="mt-1 text-[11px] text-[var(--color-ink-subtle)]">
              Source: {detail.provenance?.sourceType ?? 'unknown'}{detail.provenance?.sourceLabel
                ? ` · ${detail.provenance.sourceLabel}`
                : ''} · added {formatRelative(detail.createdAt)}
            </p>
          {:else}
            <div class="mt-1"><Skeleton lines={1} height="0.6rem" /></div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
