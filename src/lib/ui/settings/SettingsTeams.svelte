<script lang="ts">
/**
 * SettingsTeams: create teams and manage their membership.
 *
 * A team is how work is grouped for ownership and human-gate authorization, so
 * membership is edited as a whole set (the API replaces it) rather than by
 * incremental adds — that keeps "who is in this team" unambiguous.
 *
 * Honesty note on renaming: the API exposes `POST /api/teams` and
 * `PUT /api/teams/:id/members` but no `PATCH /api/teams/:id`. Renaming is therefore
 * implemented as create-then-replace-members, and the UI says plainly that the team
 * gets a new id and that any ticket owned by the old team must be reassigned.
 */

import { page } from '$app/state';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/common/PageHeader.svelte';
import Avatar from '$ui/primitives/Avatar.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import { pushToast } from '$ui/toast';
import type { TeamRecord, WorkspaceMember } from '$ui/types';

const workspaceId = $derived(page.data.workspace?.id ?? '');

let teams = $state<TeamRecord[]>([]);
let members = $state<WorkspaceMember[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let createOpen = $state(false);
let editing = $state<TeamRecord | null>(null);
let renaming = $state<TeamRecord | null>(null);
let busy = $state(false);

let name = $state('');
let description = $state('');
let color = $state('');
let memberIds = $state<string[]>([]);
let renameDraft = $state('');
let formError = $state<string | null>(null);

const memberName = $derived(new Map(members.map((member) => [member.userId, member.name])));

async function load() {
  loading = true;
  error = null;
  try {
    const [teamResponse, memberResponse] = await Promise.all([
      api.get<{ teams: TeamRecord[] }>('/teams'),
      workspaceId
        ? api.get<{ members: WorkspaceMember[] }>(`/workspaces/${workspaceId}/members`)
        : Promise.resolve({ members: [] as WorkspaceMember[] })
    ]);
    teams = teamResponse.teams;
    members = memberResponse.members;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void workspaceId;
  void load();
});

function openCreate() {
  name = '';
  description = '';
  color = '';
  memberIds = [];
  formError = null;
  createOpen = true;
}

function openEdit(team: TeamRecord) {
  editing = team;
  name = team.name;
  description = team.description ?? '';
  color = team.color ?? '';
  memberIds = [...team.memberIds];
  formError = null;
}

async function saveMembers() {
  const team = editing;
  if (!team) return;
  busy = true;
  formError = null;
  try {
    await api.put(`/teams/${team.id}/members`, { userIds: memberIds });
    teams = teams.map((entry) =>
      entry.id === team.id ? { ...entry, memberIds: [...memberIds] } : entry
    );
    pushToast({ tone: 'success', title: `${team.name} membership updated` });
    editing = null;
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

async function create() {
  if (!name.trim()) {
    formError = 'A team needs a name.';
    return;
  }
  busy = true;
  formError = null;
  try {
    const response = await api.post<{ team: TeamRecord }>('/teams', {
      name: name.trim(),
      description: description.trim() || null,
      color: color.trim() || null,
      memberIds
    });
    teams = [...teams, response.team];
    createOpen = false;
    pushToast({ tone: 'success', title: `Created ${response.team.name}` });
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    busy = false;
  }
}

/**
 * Rename by creating a replacement team and moving its members. The old team is
 * left in place rather than deleted, because tickets may reference it and the API
 * offers no delete route; the replacement is what future assignments should use.
 */
async function rename() {
  if (!renaming || !renameDraft.trim()) return;
  busy = true;
  try {
    const response = await api.post<{ team: TeamRecord }>('/teams', {
      name: renameDraft.trim(),
      description: renaming.description,
      color: renaming.color,
      memberIds: renaming.memberIds
    });
    teams = [...teams, response.team];
    pushToast({
      tone: 'success',
      title: `Created “${response.team.name}”`,
      description: `“${renaming.name}” was kept because tickets may still reference it. Reassign them, then stop using the old team.`
    });
    renaming = null;
    renameDraft = '';
  } catch (failure) {
    pushToast({ tone: 'error', title: 'Could not rename', description: describeApiError(failure) });
  } finally {
    busy = false;
  }
}

function toggleMember(userId: string) {
  memberIds = memberIds.includes(userId)
    ? memberIds.filter((id) => id !== userId)
    : [...memberIds, userId];
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Teams"
    description="Teams group people for ticket ownership and human-gate authorization. Membership is replaced as a whole set."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={openCreate}>New team</Button>
    {/snippet}
  </PageHeader>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={3} /></Card>
  {:else if teams.length === 0}
    <Card>
      <EmptyState title="No teams yet" description="Create a team to group owners and to scope which teams may approve a human gate." />
    </Card>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2">
      {#each teams as team (team.id)}
        <Card class="space-y-2">
          <div class="flex items-center gap-2">
            <span
              class="h-3 w-3 rounded-full"
              style="background-color: {team.color ?? 'var(--color-accent)'}"
              aria-hidden="true"
            ></span>
            <p class="min-w-0 flex-1 truncate text-sm font-semibold">{team.name}</p>
            <Badge tone="neutral">{team.memberIds.length} member(s)</Badge>
          </div>
          <p class="text-xs text-[var(--color-ink-muted)]">{team.description ?? 'No description.'}</p>
          <ul class="flex flex-wrap gap-1.5">
            {#each team.memberIds as userId (userId)}
              <li class="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[11px]">
                <Avatar id={userId} name={memberName.get(userId) ?? null} size="xs" />
                {memberName.get(userId) ?? userId.slice(0, 8)}
              </li>
            {/each}
            {#if team.memberIds.length === 0}
              <li class="text-[11px] text-[var(--color-ink-subtle)]">No members</li>
            {/if}
          </ul>
          <div class="flex justify-end gap-1.5">
            <Button size="sm" variant="secondary" onclick={() => openEdit(team)}>Manage members</Button>
            <Button size="sm" variant="ghost" onclick={() => { renaming = team; renameDraft = `${team.name} (renamed)`; }}>
              Rename
            </Button>
          </div>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<Modal
  open={createOpen}
  title="New team"
  description="Teams are workspace-scoped and can be assigned ticket ownership."
  onclose={() => (createOpen = false)}
>
  <div class="space-y-3">
    <Input label="Name" bind:value={name} placeholder="Claims adjusters" />
    <Textarea label="Description" bind:value={description} rows={2} />
    <Input label="Colour" bind:value={color} placeholder="Optional CSS colour" />
    <fieldset class="space-y-1.5">
      <legend class="text-xs font-medium text-[var(--color-ink-muted)]">Members</legend>
      <div class="flex flex-wrap gap-2">
        {#each members as member (member.userId)}
          <label class="inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={memberIds.includes(member.userId)} onchange={() => toggleMember(member.userId)} />
            {member.name}
          </label>
        {/each}
      </div>
    </fieldset>
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={create}>Create team</Button>
    </div>
  </div>
</Modal>

<Modal
  open={editing !== null}
  title={editing ? `Manage ${editing.name}` : 'Manage team'}
  description="The member list is replaced as a whole set."
  onclose={() => (editing = null)}
>
  <div class="space-y-3">
    <div class="flex flex-wrap gap-2">
      {#each members as member (member.userId)}
        <label class="inline-flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={memberIds.includes(member.userId)} onchange={() => toggleMember(member.userId)} />
          <Avatar id={member.userId} name={member.name} size="xs" />
          {member.name}
          {#if member.status !== 'active'}
            <Badge tone="neutral">{member.status}</Badge>
          {/if}
        </label>
      {/each}
      {#if members.length === 0}
        <p class="text-xs text-[var(--color-ink-subtle)]">This workspace has no members.</p>
      {/if}
    </div>
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={saveMembers}>Save membership</Button>
    </div>
  </div>
</Modal>

<Modal
  open={renaming !== null}
  title="Rename team"
  description="The API exposes no PATCH for teams, so renaming creates a replacement team with the same members."
  onclose={() => (renaming = null)}
>
  <div class="space-y-3">
    <Input label="New name" bind:value={renameDraft} />
    <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-caution)_18%,transparent)] px-3 py-2 text-[11px] leading-relaxed">
      The replacement has a new id. The original team is left in place because tickets may still
      reference it; reassign those tickets to the new team before removing the old one from use.
    </p>
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (renaming = null)}>Cancel</Button>
      <Button variant="primary" loading={busy} onclick={rename}>Create replacement</Button>
    </div>
  </div>
</Modal>
