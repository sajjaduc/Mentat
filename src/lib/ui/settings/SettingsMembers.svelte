<script lang="ts">
/**
 * SettingsMembers: membership, roles and status.
 *
 * The "last active owner" rule is enforced by the server, but it is shown in the
 * UI *before* the attempt: a member row states that an owner is the last active one
 * and disables the controls that the server would reject. Discovering a policy by
 * receiving a 403 is a worse experience than seeing the rule.
 */
import { page } from '$app/state';
import { formatRelative } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import DataTable from '$ui/common/DataTable.svelte';
import PageHeader from '$ui/common/PageHeader.svelte';
import Avatar from '$ui/primitives/Avatar.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';
import type { WorkspaceMember } from '$ui/types';

const workspaceId = $derived(page.data.workspace?.id ?? '');
const actorUserId = $derived(page.data.actor?.userId ?? '');

let members = $state<WorkspaceMember[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let inviteOpen = $state(false);
let inviting = $state(false);
let inviteEmail = $state('');
let inviteName = $state('');
let inviteRole = $state<'owner' | 'admin' | 'member'>('member');
let inviteTitle = $state('');
let formError = $state<string | null>(null);

const activeOwners = $derived(
  members.filter((member) => member.role === 'owner' && member.status === 'active')
);

function isLastActiveOwner(member: WorkspaceMember): boolean {
  return member.role === 'owner' && member.status === 'active' && activeOwners.length <= 1;
}

async function load() {
  if (!workspaceId) return;
  loading = true;
  error = null;
  try {
    const response = await api.get<{ members: WorkspaceMember[] }>(
      `/workspaces/${workspaceId}/members`
    );
    members = response.members;
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

async function invite() {
  if (!inviteEmail.trim()) {
    formError = 'An email address is required.';
    return;
  }
  inviting = true;
  formError = null;
  try {
    await api.post(`/workspaces/${workspaceId}/members`, {
      email: inviteEmail.trim().toLowerCase(),
      name: inviteName.trim() || undefined,
      role: inviteRole,
      title: inviteTitle.trim() || null
    });
    pushToast({ tone: 'success', title: `Invited ${inviteEmail.trim()}` });
    inviteOpen = false;
    inviteEmail = '';
    inviteName = '';
    inviteTitle = '';
    inviteRole = 'member';
    await load();
  } catch (failure) {
    formError = describeApiError(failure);
  } finally {
    inviting = false;
  }
}

async function changeRole(member: WorkspaceMember, role: 'owner' | 'admin' | 'member') {
  const previous = members;
  members = members.map((entry) => (entry.userId === member.userId ? { ...entry, role } : entry));
  try {
    await api.patch(`/workspaces/${workspaceId}/members/${member.userId}`, { role });
    pushToast({ tone: 'success', title: `${member.name} is now ${role}` });
  } catch (failure) {
    members = previous;
    pushToast({
      tone: 'error',
      title: 'Could not change role',
      description: describeApiError(failure)
    });
  }
}

async function changeStatus(member: WorkspaceMember, status: 'active' | 'suspended') {
  const previous = members;
  members = members.map((entry) => (entry.userId === member.userId ? { ...entry, status } : entry));
  try {
    await api.patch(`/workspaces/${workspaceId}/members/${member.userId}`, { status });
    pushToast({
      tone: 'success',
      title: status === 'suspended' ? `${member.name} suspended` : `${member.name} reactivated`
    });
  } catch (failure) {
    members = previous;
    pushToast({
      tone: 'error',
      title: 'Could not change status',
      description: describeApiError(failure)
    });
  }
}

async function remove(member: WorkspaceMember) {
  const previous = members;
  members = members.filter((entry) => entry.userId !== member.userId);
  try {
    await api.delete(`/workspaces/${workspaceId}/members/${member.userId}`);
    pushToast({ tone: 'success', title: `${member.name} removed` });
  } catch (failure) {
    members = previous;
    pushToast({
      tone: 'error',
      title: 'Could not remove member',
      description: describeApiError(failure)
    });
  }
}
</script>

<div class="space-y-5">
  <PageHeader
    title="Members"
    description="Who belongs to this workspace and what they may do. A workspace always keeps at least one active owner."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={() => (inviteOpen = true)}>Invite member</Button>
    {/snippet}
  </PageHeader>

  {#if error}
    <ErrorState message={error} onRetry={() => void load()} />
  {:else if loading}
    <Card class="space-y-3"><Skeleton height="1.2rem" /><Skeleton lines={4} /></Card>
  {:else if members.length === 0}
    <Card>
      <EmptyState title="No members" description="Invite a teammate by email. If they do not have an account yet, an invitation account is created." />
    </Card>
  {:else}
    <DataTable
      columns={[
        { key: 'member', label: 'Member' },
        { key: 'role', label: 'Role' },
        { key: 'status', label: 'Status' },
        { key: 'title', label: 'Title', hideBelow: 'md' },
        { key: 'actions', label: 'Actions', align: 'right' }
      ]}
      rows={members}
      rowKey={(item) => (item as WorkspaceMember).userId}
      caption="Workspace members"
    >
      {#snippet row(item)}
        {@const member = item as WorkspaceMember}
        <td class="px-3 py-2">
          <span class="flex items-center gap-2">
            <Avatar id={member.userId} name={member.name} size="sm" />
            <span class="min-w-0">
              <span class="block truncate text-xs font-medium">
                {member.name}
                {#if member.userId === actorUserId}<span class="text-[var(--color-ink-subtle)]"> (you)</span>{/if}
              </span>
              <span class="block truncate text-[11px] text-[var(--color-ink-subtle)]">{member.email}</span>
              <span class="block text-[10px] text-[var(--color-ink-subtle)]">joined {formatRelative(member.createdAt)}</span>
            </span>
          </span>
        </td>
        <td class="px-3 py-2">
          <select
            class="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 text-xs"
            aria-label="Role for {member.name}"
            value={member.role}
            onchange={(event) =>
              changeRole(member, event.currentTarget.value as 'owner' | 'admin' | 'member')}
          >
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
          <div class="mt-1 flex flex-wrap gap-1">
            {#if isLastActiveOwner(member)}
              <Badge tone="caution">Last active owner</Badge>
            {/if}
          </div>
        </td>
        <td class="px-3 py-2">
          <Badge tone={member.status === 'active' ? 'positive' : member.status === 'suspended' ? 'danger' : 'neutral'}>
            {member.status}
          </Badge>
        </td>
        <td class="hidden px-3 py-2 text-xs text-[var(--color-ink-muted)] md:table-cell">
          {member.title ?? '—'}
        </td>
        <td class="px-3 py-2">
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            {#if member.status === 'active'}
              <Button
                size="sm"
                variant="ghost"
                disabled={isLastActiveOwner(member)}
                title={isLastActiveOwner(member) ? 'The last active owner cannot be suspended' : 'Suspend this member'}
                onclick={() => changeStatus(member, 'suspended')}
              >
                Suspend
              </Button>
            {:else}
              <Button size="sm" variant="ghost" onclick={() => changeStatus(member, 'active')}>Reactivate</Button>
            {/if}
            <Button
              size="sm"
              variant="ghost"
              disabled={isLastActiveOwner(member)}
              title={isLastActiveOwner(member) ? 'The last active owner cannot be removed' : 'Remove this member'}
              onclick={() => remove(member)}
            >
              Remove
            </Button>
          </div>
        </td>
      {/snippet}
    </DataTable>

    <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
      Removing a member removes their access to this workspace. It never deletes work items, files or
      history they created, which stay attributed to them in the audit ledger.
    </p>
  {/if}
</div>

<Modal
  open={inviteOpen}
  title="Invite a member"
  description="Creates an invitation account when the email has no Mentat account yet."
  onclose={() => (inviteOpen = false)}
>
  <div class="space-y-3">
    <Input label="Email" type="email" bind:value={inviteEmail} placeholder="teammate@example.com" />
    <Input label="Name" bind:value={inviteName} placeholder="Optional" />
    <div class="grid gap-3 sm:grid-cols-2">
      <Select
        label="Role"
        options={[
          { value: 'member', label: 'Member' },
          { value: 'admin', label: 'Admin' },
          { value: 'owner', label: 'Owner' }
        ]}
        bind:value={inviteRole}
      />
      <Input label="Title" bind:value={inviteTitle} placeholder="Claims adjuster" />
    </div>
    {#if formError}<p class="text-xs text-[var(--color-danger)]">{formError}</p>}{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (inviteOpen = false)}>Cancel</Button>
      <Button variant="primary" loading={inviting} onclick={invite}>Send invite</Button>
    </div>
  </div>
</Modal>
