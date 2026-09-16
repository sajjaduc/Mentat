<script lang="ts">
/**
 * Skills index.
 *
 * A skill is a reusable instruction package: instructions, worked examples and
 * references that an agent carries into a run. This page lists the workspace's
 * skills and is the entry point to the editor; skills are never executable on their
 * own, so nothing here runs anything.
 *
 * The list endpoint returns the current version's content, not a reference count, so
 * the "used by" figure is derived best-effort from the agents list and simply omitted
 * when that second request fails — the skill list is the page's real job.
 */
import { goto } from '$app/navigation';
import { formatRelative, pluralize, truncate } from '$shared/format';
import type { AgentView, SkillView, WorkflowOption } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import SelectField from '$ui/http/controls/SelectField.svelte';
import TextAreaField from '$ui/http/controls/TextAreaField.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Card from '$ui/primitives/Card.svelte';
import EmptyState from '$ui/primitives/EmptyState.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import { pushToast } from '$ui/toast';

let skills = $state<SkillView[] | null>(null);
let workflows = $state<WorkflowOption[]>([]);
let agents = $state<AgentView[] | null>(null);
let loading = $state(true);
let error = $state<{ message: string; code: string | null } | null>(null);
let search = $state('');

let createOpen = $state(false);
let draft = $state({ name: '', description: '', category: '', workflowId: '' });
let creating = $state(false);
let createError = $state<string | null>(null);
const categoryListId = 'skill-category-suggestions';

const workflowNames = $derived(new Map(workflows.map((workflow) => [workflow.id, workflow.name])));

/** Skill id → number of agents whose `skillIds` include it. */
const agentUsage = $derived.by(() => {
  const usage = new Map<string, number>();
  for (const agent of agents ?? []) {
    for (const skillId of agent.skillIds ?? []) {
      usage.set(skillId, (usage.get(skillId) ?? 0) + 1);
    }
  }
  return usage;
});

const filtered = $derived.by(() => {
  const needle = search.trim().toLowerCase();
  const all = skills ?? [];
  if (needle.length === 0) return all;
  return all.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      (skill.description ?? '').toLowerCase().includes(needle) ||
      (skill.category ?? '').toLowerCase().includes(needle)
  );
});

/** Skills grouped by workflow scope so a workspace-common skill is never confused with a bound one. */
const grouped = $derived.by(() => {
  const buckets = new Map<string, SkillView[]>();
  for (const skill of filtered) {
    const scope = skill.workflowId === null ? 'workspace' : 'workflow';
    const bucket = buckets.get(scope);
    if (bucket) bucket.push(skill);
    else buckets.set(scope, [skill]);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
});

async function load() {
  loading = true;
  error = null;
  try {
    const [skillResponse, workflowResponse] = await Promise.all([
      api.get<{ skills: SkillView[] }>('/api/skills'),
      api.get<{ workflows: WorkflowOption[] }>('/api/workflows')
    ]);
    skills = skillResponse.skills;
    workflows = workflowResponse.workflows;
  } catch (failure) {
    error = describeError(failure);
  } finally {
    loading = false;
  }

  // Best-effort cross-reference; a failure here must not replace the skill list.
  try {
    agents = (await api.get<{ agents: AgentView[] }>('/api/agents')).agents;
  } catch {
    agents = null;
  }
}

function describeError(failure: unknown): { message: string; code: string | null } {
  return {
    message: describeApiError(failure),
    code: failure instanceof Error && 'code' in failure ? String(failure.code) : null
  };
}

$effect(() => {
  void load();
});

function openCreate() {
  draft = { name: '', description: '', category: '', workflowId: '' };
  createError = null;
  createOpen = true;
}

function workflowLabel(skill: SkillView): string {
  if (skill.workflowId === null) return 'Workspace common';
  return workflowNames.get(skill.workflowId) ?? skill.workflowId;
}

async function createSkill(event: SubmitEvent) {
  event.preventDefault();
  if (draft.name.trim().length === 0) {
    createError = 'A skill needs a name.';
    return;
  }
  creating = true;
  createError = null;
  try {
    const response = await api.post<{ skill: SkillView }>('/api/skills', {
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      category: draft.category.trim() === '' ? null : draft.category.trim(),
      workflowId: draft.workflowId === '' ? null : draft.workflowId
    });
    createOpen = false;
    pushToast({
      tone: 'success',
      title: 'Skill created',
      description: `${response.skill.name} starts at version ${response.skill.version}.`
    });
    await goto(`/skills/${response.skill.id}`);
  } catch (failure) {
    createError = describeApiError(failure);
  } finally {
    creating = false;
  }
}
</script>

<svelte:head><title>Skills · Mentat</title></svelte:head>

<div class="p-4 md:p-6 space-y-5">
  <PageHeader
    title="Skills"
    description="Reusable instruction packages — instructions, worked examples and references — that agents carry into a run. Skills are injected into the prompt, never executed as code."
  >
    {#snippet actions()}
      <Button variant="primary" onclick={openCreate}>New skill</Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each Array.from({ length: 6 }) as _, index (index)}
        <Card>
          <Skeleton lines={3} />
        </Card>
      {/each}
    </div>
  {:else if error}
    <ErrorState message={error.message} code={error.code} onRetry={load} />
  {:else if (skills ?? []).length === 0}
    <EmptyState
      title="No skills yet"
      description="Create one when an agent should follow a repeatable procedure: a checklist, a house style, or a worked example it can copy."
    >
      <Button variant="primary" onclick={openCreate}>Create the first skill</Button>
    </EmptyState>
  {:else}
    <div class="max-w-md">
      <TextField
        label="Search skills"
        bind:value={search}
        placeholder="Name, description or category…"
        size="sm"
      />
    </div>

    {#if filtered.length === 0}
      <EmptyState
        title="No skills match that search"
        description="Try a shorter term, or clear the search to see every skill."
      />
    {:else}
      {#each grouped as [scope, scopeSkills] (scope)}
        <section class="space-y-3">
          <h2 class="text-xs font-semibold tracking-wider text-[var(--color-ink-subtle)] uppercase">
            {scope === 'workspace' ? 'Workspace common' : 'Workflow scoped'}
            <span class="font-normal normal-case">· {pluralize(scopeSkills.length, 'skill')}</span>
          </h2>
          <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {#each scopeSkills as skill (skill.id)}
              <Card interactive>
                <a href={`/skills/${skill.id}`} class="block space-y-3">
                  <div class="space-y-1.5">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <h3 class="text-sm font-semibold text-[var(--color-ink)]">{skill.name}</h3>
                      <Badge tone="muted">{workflowLabel(skill)}</Badge>
                    </div>
                    <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">
                      {skill.description
                        ? truncate(skill.description, 160)
                        : 'No description yet.'}
                    </p>
                  </div>
                  <div class="flex flex-wrap items-center gap-1.5">
                    {#if skill.category}
                      <Badge tone="neutral">{skill.category}</Badge>
                    {/if}
                    <Badge tone="muted">v{skill.version}</Badge>
                    {#if agentUsage.has(skill.id)}
                      <Badge tone="accent">
                        {pluralize(agentUsage.get(skill.id) ?? 0, 'agent')}
                      </Badge>
                    {:else}
                      <Badge tone="muted">unused</Badge>
                    {/if}
                  </div>
                  <p class="text-[11px] text-[var(--color-ink-subtle)]">
                    Updated {formatRelative(skill.updatedAt)}
                  </p>
                </a>
              </Card>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  {/if}
</div>

<Modal
  open={createOpen}
  title="New skill"
  description="Give the skill a scope and a purpose now; instructions, examples and references are edited on the next screen."
  onclose={() => (createOpen = false)}
>
  <form id="create-skill" class="space-y-4" onsubmit={createSkill}>
    <TextField
      label="Name"
      bind:value={draft.name}
      required
      placeholder="Refund escalation checklist"
    />
    <TextAreaField
      label="Description"
      bind:value={draft.description}
      rows={3}
      placeholder="When to use this skill and what it should produce."
    />
    <div class="space-y-1.5">
      <label for="skill-category" class="text-xs font-medium text-[var(--color-ink-muted)]">
        Category
      </label>
      <input
        id="skill-category"
        type="text"
        list={categoryListId}
        value={draft.category}
        maxlength={60}
        placeholder="support"
        class="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]"
        oninput={(event) => (draft.category = event.currentTarget.value)}
      />
      <p class="text-xs text-[var(--color-ink-subtle)]">
        A short grouping label. Existing categories are suggested, but you can type a new one.
      </p>
      <datalist id={categoryListId}>
        {#each [...new Set((skills ?? []).map((skill) => skill.category).filter((value): value is string => Boolean(value)))].sort() as category (category)}
          <option value={category}></option>
        {/each}
      </datalist>
    </div>
    <SelectField
      label="Workflow scope"
      bind:value={draft.workflowId}
      options={[
        { value: '', label: 'Workspace common (every workflow)' },
        ...workflows.map((workflow) => ({
          value: workflow.id,
          label: `${workflow.name} (${workflow.key})`
        }))
      ]}
      hint="Workspace-common skills are available to every agent; workflow-scoped skills are meant for agents in that workflow."
    />
    {#if createError}
      <p class="text-xs text-[var(--color-danger)]" role="alert">{createError}</p>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
    <Button type="submit" form="create-skill" variant="primary" loading={creating}>Create skill</Button>
  {/snippet}
</Modal>
