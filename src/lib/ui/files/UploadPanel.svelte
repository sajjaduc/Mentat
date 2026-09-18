<script lang="ts">
/**
 * UploadPanel: drag-and-drop and file-picker upload with optional associations.
 *
 * Two decisions are deliberate:
 *
 *  - **Optimistic rows.** A queued file appears in the list immediately and is
 *    replaced by the server's record when ingestion finishes, so a slow upload
 *    never looks like a dead button. The temporary row is visibly marked.
 *  - **Honest dedupe wording.** When the server answers `deduplicated: true` the
 *    panel says the bytes already existed and were reused. It never claims the
 *    upload "created" storage it did not create.
 */

import { formatBytes } from '$shared/format';
import { describeApiError } from '$ui/api';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import type { UploadResult } from '$ui/types';
import { uploadFile } from './upload';

export interface QueuedUpload {
  id: string;
  filename: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  result: UploadResult | null;
  error: string | null;
}

interface Props {
  workflows: Array<{ value: string; label: string }>;
  /** Resolve a work item key from an id, when the user pastes an id or key. */
  onresolveWorkItem?: (input: string) => Promise<string | null>;
  onuploaded: (
    result: UploadResult,
    context: { workflowItemId: string | null; workflowId: string | null }
  ) => void;
  /** Called the moment a file enters the queue, so the list can show a placeholder row. */
  onstarted?: (context: {
    filename: string;
    size: number;
    workflowItemId: string | null;
    workflowId: string | null;
  }) => void;
  /** Called when an upload fails, so the placeholder row can be withdrawn. */
  onfailed?: (filename: string) => void;
  onclose: () => void;
}

let { workflows, onuploaded, onclose, onresolveWorkItem, onstarted, onfailed }: Props = $props();

let queue = $state<QueuedUpload[]>([]);
let workItemInput = $state('');
let workflowId = $state('');
let workflowItemId = $state<string | null>(null);
let workItemError = $state<string | null>(null);
let dragging = $state(false);
let input: HTMLInputElement | undefined = $state();
let aborters = new Map<string, AbortController>();

const pendingCount = $derived(queue.filter((entry) => entry.status === 'uploading').length);
const doneCount = $derived(queue.filter((entry) => entry.status === 'done').length);

async function resolveWorkItem() {
  workItemError = null;
  const raw = workItemInput.trim();
  if (raw.length === 0) {
    workflowItemId = null;
    return;
  }
  if (onresolveWorkItem) {
    const resolved = await onresolveWorkItem(raw);
    if (!resolved) {
      workItemError = 'No work item with that id or key was found in this workspace.';
      workflowItemId = null;
      return;
    }
    workflowItemId = resolved;
    return;
  }
  workflowItemId = raw;
}

async function enqueue(files: FileList | File[]) {
  const list = Array.from(files);
  if (list.length === 0) return;
  await resolveWorkItem();

  for (const file of list) {
    const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: QueuedUpload = {
      id,
      filename: file.name,
      size: file.size,
      progress: 0,
      status: 'uploading',
      result: null,
      error: null
    };
    queue = [...queue, entry];
    onstarted?.({
      filename: file.name,
      size: file.size,
      workflowItemId,
      workflowId: workflowId || null
    });
    const controller = new AbortController();
    aborters.set(id, controller);

    uploadFile({
      file,
      workflowItemId,
      workflowId: workflowId || null,
      signal: controller.signal,
      onProgress: (fraction) => {
        queue = queue.map((item) => (item.id === id ? { ...item, progress: fraction } : item));
      }
    })
      .then((result) => {
        queue = queue.map((item) =>
          item.id === id ? { ...item, progress: 1, status: 'done', result } : item
        );
        onuploaded(result, { workflowItemId, workflowId: workflowId || null });
      })
      .catch((failure: unknown) => {
        queue = queue.map((item) =>
          item.id === id ? { ...item, status: 'error', error: describeApiError(failure) } : item
        );
        onfailed?.(file.name);
      })
      .finally(() => {
        aborters.delete(id);
      });
  }
  if (input) input.value = '';
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  dragging = false;
  if (event.dataTransfer?.files) void enqueue(event.dataTransfer.files);
}

function cancel(id: string) {
  aborters.get(id)?.abort();
}
</script>

<div class="space-y-4 p-5">
  <div
    class="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed px-4 py-8 text-center transition-colors
      {dragging ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]'}"
    role="presentation"
    ondragover={(event) => {
      event.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <svg
      viewBox="0 0 24 24"
      class="h-6 w-6 text-[var(--color-ink-subtle)]"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <path d="M12 16V4m0 0L8 8m4-4 4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke-linecap="round" />
    </svg>
    <p class="text-sm font-medium">Drop files here</p>
    <p class="text-xs text-[var(--color-ink-subtle)]">
      Every byte is hashed with SHA-256 before storage, so identical content is stored once per
      workspace.
    </p>
    <input
      bind:this={input}
      type="file"
      multiple
      class="sr-only"
      aria-label="Choose files to upload"
      onchange={(event) => {
        if (event.currentTarget.files) void enqueue(event.currentTarget.files);
      }}
    />
    <Button size="sm" onclick={() => input?.click()}>Choose files</Button>
  </div>

  <div class="grid gap-3 sm:grid-cols-2">
    <div>
      <Select
        label="Workflow context (optional)"
        options={[{ value: '', label: 'No workflow context' }, ...workflows]}
        bind:value={workflowId}
        hint="The file is a workspace object; a workflow context records how it is interpreted."
      />
    </div>
    <div>
      <Input
        label="Linked work item (optional)"
        bind:value={workItemInput}
        placeholder="Work item id or key"
        error={workItemError}
        onblur={resolveWorkItem}
        hint={workflowItemId ? `Will link to ${workflowItemId}` : 'Link now or attach it later from the file page.'}
      />
    </div>
  </div>

  {#if queue.length > 0}
    <ul class="space-y-2">
      {#each queue as entry (entry.id)}
        <li
          class="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3"
        >
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{entry.filename}</span>
            <span class="text-[11px] text-[var(--color-ink-subtle)]">{formatBytes(entry.size)}</span>
            {#if entry.status === 'uploading'}
              <Button size="sm" variant="ghost" onclick={() => cancel(entry.id)}>Cancel</Button>
            {/if}
          </div>

          {#if entry.status === 'uploading'}
            <div class="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
              <div
                class="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-150"
                style="width: {Math.round(entry.progress * 100)}%"
              ></div>
            </div>
            <p class="text-[11px] text-[var(--color-ink-subtle)]" role="status">
              Uploading… {Math.round(entry.progress * 100)}%
            </p>
          {:else if entry.status === 'done' && entry.result}
            <p class="text-[11px] text-[var(--color-positive)]" role="status">
              {#if entry.result.deduplicated}
                Stored. These bytes already existed in this workspace, so the existing blob was
                reused — {formatBytes(entry.result.size)} were not written twice.
              {:else}
                Stored as a new blob ({formatBytes(entry.result.size)}).
              {/if}
              {#if entry.result.reusedFile}
                A logical file record already existed and was reused.
              {/if}
              {#if entry.result.processingQueued}
                Processing was queued.
              {/if}
            </p>
          {:else if entry.status === 'error'}
            <p class="text-[11px] text-[var(--color-danger)]" role="alert">{entry.error}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
    A File is a durable, content-addressed document that can be linked to many work items.
    Uploading the same bytes again preserves a new provenance entry while storage stays
    deduplicated.
  </p>

  <div class="flex justify-end gap-2">
    <Button variant="ghost" onclick={onclose}>Close</Button>
    {#if pendingCount === 0 && doneCount > 0}
      <Button variant="primary" onclick={onclose}>Done</Button>
    {/if}
  </div>
</div>
