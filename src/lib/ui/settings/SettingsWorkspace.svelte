<script lang="ts">
/**
 * SettingsWorkspace: workspace identity, retention and agent policy.
 *
 * `PATCH /api/workspaces/:id` replaces the whole `settings` object, so the form
 * holds a draft of every field and sends the complete object. Sending a partial
 * object would silently drop the keys it omitted.
 */

import { untrack } from 'svelte';
import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/common/PageHeader.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import type { WorkspaceRecord } from '$ui/types';

/** The active workspace comes from the authenticated shell the layout loaded. */
const workspaceId = $derived(page.data.workspace?.id ?? '');

let workspace = $state<WorkspaceRecord | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let saving = $state(false);

let name = $state('');
let description = $state('');
let timezone = $state('UTC');
let retentionDays = $state(90);
let allowAgentTicketCreation = $state(true);
let allowAgentTransfer = $state(false);
let dailyRunLimit = $state(0);

const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney'
];

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ workspace: WorkspaceRecord }>(`/workspaces/${workspaceId}`);
    workspace = response.workspace;
    name = response.workspace.name;
    description = response.workspace.description ?? '';
    const settings = response.workspace.settings ?? {};
    timezone = settings.defaultTimezone ?? 'UTC';
    retentionDays = settings.retentionDays ?? 90;
    allowAgentTicketCreation = settings.allowAgentTicketCreation ?? true;
    allowAgentTransfer = settings.allowAgentTransfer ?? false;
    dailyRunLimit = settings.dailyRunLimit ?? 0;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  const id = workspaceId;
  if (!id) {
    loading = false;
    error = 'No workspace is active for this session.';
    return;
  }
  untrack(() => void load());
});

async function save() {
  if (!workspace) return;
  saving = true;
  try {
    const response = await api.patch<{ workspace: WorkspaceRecord }>(
      `/workspaces/${workspace.id}`,
      {
        name: name.trim(),
        description: description.trim() || null,
        settings: {
          defaultTimezone: timezone,
          retentionDays,
          allowAgentTicketCreation,
          allowAgentTransfer,
          ...(dailyRunLimit > 0 ? { dailyRunLimit } : {})
        }
      }
    );
    workspace = response.workspace;
    pushToast({ tone: 'success', title: 'Workspace settings saved' });
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not save', description: describeApiError(failure) });
  } finally {
    saving = false;
  }
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Workspace"
    description="Identity, retention and what agents are allowed to do by default. Every change is written to the audit ledger."
  />

  {#if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if workspace}
    <Card class="space-y-4">
      <h2 class="text-sm font-semibold">Identity</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <Input label="Name" bind:value={name} />
        <Input label="Slug" value={workspace.slug} readonly hint="Used in URLs; set at creation." />
      </div>
      <Textarea label="Description" bind:value={description} rows={3} />
    </Card>

    <Card class="space-y-4">
      <h2 class="text-sm font-semibold">Defaults</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <Select
          label="Default timezone"
          options={TIMEZONES.map((value) => ({ value, label: value }))}
          bind:value={timezone}
          hint="Display only; timestamps are stored in UTC epoch milliseconds."
        />
        <Input
          label="Retention (days)"
          type="number"
          min="1"
          bind:value={retentionDays}
          hint="How long derived content and audit entries are retained."
        />
      </div>
    </Card>

    <Card class="space-y-4">
      <h2 class="text-sm font-semibold">Agent policy</h2>
      <label class="flex items-start gap-2 text-xs">
        <input type="checkbox" bind:checked={allowAgentTicketCreation} class="mt-0.5" />
        <span>
          <span class="font-medium">Agents may create tickets</span>
          <span class="block text-[11px] text-[var(--color-ink-subtle)]">
            Agent-created tickets use the same validation, authorization and audit path as human ones.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-2 text-xs">
        <input type="checkbox" bind:checked={allowAgentTransfer} class="mt-0.5" />
        <span>
          <span class="font-medium">Agents may transfer tickets across workflows</span>
          <span class="block text-[11px] text-[var(--color-ink-subtle)]">
            Transfer is a controlled move: destination workflow, state, required fields and mappings
            are validated before the move commits.
          </span>
        </span>
      </label>
      <Input
        label="Daily run limit (0 = unlimited)"
        type="number"
        min="0"
        bind:value={dailyRunLimit}
        hint="Caps agent runs per day for the whole workspace."
      />
    </Card>

    <div class="flex justify-end">
      <Button variant="primary" loading={saving} onclick={save}>Save workspace</Button>
    </div>
  {/if}
</div>
