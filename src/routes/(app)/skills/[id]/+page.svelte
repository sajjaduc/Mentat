<script lang="ts">
/**
 * Skill editor.
 *
 * A skill is versioned content, not a row: every save appends an immutable snapshot
 * that runs pin, so this page edits a *draft* and PATCHes the whole content in one
 * call. There is no version-history endpoint for skills yet, so the Version tab states
 * that honestly instead of inventing rows.
 *
 * Everything here is client-fetched (see the UI brief), and the page renders
 * loading → error → not-found/content.
 */
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { formatDateTime } from '$shared/format';
import { ParameterList } from '$ui/agents/tools';
import type {
  NativeToolDescriptor,
  SkillExample,
  SkillReference,
  SkillView,
  Tool,
  WorkflowOption
} from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import ConfirmButton from '$ui/http/controls/ConfirmButton.svelte';
import MultiSelect from '$ui/http/controls/MultiSelect.svelte';
import PageHeader from '$ui/http/controls/PageHeader.svelte';
import Section from '$ui/http/controls/Section.svelte';
import SelectField from '$ui/http/controls/SelectField.svelte';
import TextAreaField from '$ui/http/controls/TextAreaField.svelte';
import TextField from '$ui/http/controls/TextField.svelte';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';
import Tabs from '$ui/primitives/Tabs.svelte';
import { pushToast } from '$ui/toast';

interface Draft {
  name: string;
  description: string;
  category: string;
  instructions: string;
  examples: SkillExample[];
  references: SkillReference[];
  recommendedToolKeys: string[];
}

const TABS = [
  { id: 'identity', label: 'Identity' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'examples', label: 'Examples' },
  { id: 'references', label: 'References' },
  { id: 'tools', label: 'Recommended tools' },
  { id: 'version', label: 'Version' }
] as const;

const skillId = $derived(page.params.id);

let skill = $state<SkillView | null>(null);
let draft = $state<Draft>({
  name: '',
  description: '',
  category: '',
  instructions: '',
  examples: [],
  references: [],
  recommendedToolKeys: []
});
let workflows = $state<WorkflowOption[]>([]);
let nativeTools = $state<NativeToolDescriptor[]>([]);
let storedTools = $state<Tool[]>([]);
let activeTab = $state<string>('identity');
let loading = $state(true);
let error = $state<{ message: string; code: string | null } | null>(null);
let savedSnapshot = $state('');
let saving = $state(false);
let archiving = $state(false);

const charCount = $derived(draft.instructions.length);
const tokenEstimate = $derived(Math.ceil(charCount / 4));
/** A draft is dirty when its full content differs from the last saved snapshot. */
const dirty = $derived(JSON.stringify(draft) !== savedSnapshot);

const toolOptions = $derived([
  ...nativeTools.map((tool) => ({
    value: tool.key,
    label: tool.key,
    group: 'Native capabilities',
    hint: tool.description,
    badge: 'native'
  })),
  ...storedTools.map((tool) => ({
    value: tool.key,
    label: tool.key,
    group: 'Stored tools',
    hint: tool.description,
    badge: tool.kind === 'http' ? 'HTTP' : 'native'
  }))
]);

const workflowName = $derived.by(() => {
  const scopeId = skill?.workflowId;
  if (!scopeId) return null;
  return workflows.find((workflow) => workflow.id === scopeId)?.name ?? scopeId;
});

async function load() {
  loading = true;
  error = null;
  try {
    const response = await api.get<{ skill: SkillView }>(`/api/skills/${skillId}`);
    skill = response.skill;
    draft = toDraft(response.skill);
    savedSnapshot = JSON.stringify(draft);
  } catch (failure) {
    error = describeError(failure);
    skill = null;
  } finally {
    loading = false;
  }

  try {
    const [toolsResponse, workflowsResponse] = await Promise.all([
      api.get<{ native: NativeToolDescriptor[]; stored: Tool[] }>('/api/tools'),
      api.get<{ workflows: WorkflowOption[] }>('/api/workflows')
    ]);
    nativeTools = toolsResponse.native;
    storedTools = toolsResponse.stored;
    workflows = workflowsResponse.workflows;
  } catch {
    // Supporting data only: the editor remains usable without the pickers.
    nativeTools = [];
    storedTools = [];
    workflows = [];
  }
}

function toDraft(source: SkillView): Draft {
  return {
    name: source.name,
    description: source.description ?? '',
    category: source.category ?? '',
    instructions: source.instructions,
    examples: source.examples.map((example) => ({ ...example })),
    references: source.references.map((reference) => ({ ...reference })),
    recommendedToolKeys: [...source.recommendedToolKeys]
  };
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

function addExample() {
  draft.examples.push({ title: '', input: '', output: '', notes: '' });
}

function removeExample(index: number) {
  draft.examples.splice(index, 1);
}

function addReference() {
  draft.references.push({ title: '', url: '', content: '' });
}

function removeReference(index: number) {
  draft.references.splice(index, 1);
}

/** Only http(s) and site-relative URLs become links; anything else renders as text. */
function safeHref(url: string | undefined): string | null {
  const trimmed = (url ?? '').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

async function save() {
  if (!skill) return;
  if (draft.name.trim().length === 0) {
    pushToast({ tone: 'error', title: 'A skill needs a name' });
    activeTab = 'identity';
    return;
  }
  saving = true;
  try {
    const response = await api.patch<{ skill: SkillView }>(`/api/skills/${skill.id}`, {
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      category: draft.category.trim() === '' ? null : draft.category.trim(),
      instructions: draft.instructions,
      examples: draft.examples,
      references: draft.references,
      recommendedToolKeys: draft.recommendedToolKeys
    });
    skill = response.skill;
    draft = toDraft(response.skill);
    savedSnapshot = JSON.stringify(draft);
    pushToast({
      tone: 'success',
      title: 'Skill saved',
      description: `Version ${response.skill.version} is now the current snapshot.`
    });
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not save the skill',
      description: describeApiError(failure)
    });
  } finally {
    saving = false;
  }
}

async function archive() {
  if (!skill) return;
  archiving = true;
  try {
    await api.delete(`/api/skills/${skill.id}`);
    pushToast({
      tone: 'success',
      title: 'Skill archived',
      description: `${skill.name} was archived.`
    });
    await goto('/skills');
  } catch (failure) {
    pushToast({
      tone: 'error',
      title: 'Could not archive the skill',
      description: describeApiError(failure)
    });
  } finally {
    archiving = false;
  }
}
</script>

<svelte:head><title>{skill ? `${skill.name} · Skills · Mentat` : 'Skill · Mentat'}</title></svelte:head>

<div class="p-4 md:p-6 space-y-5">
  <PageHeader
    title={skill?.name ?? 'Skill'}
    description={skill?.description ?? 'Instructions, worked examples and references an agent carries into a run.'}
    backHref="/skills"
    backLabel="All skills"
  >
    {#snippet actions()}
      {#if dirty}
        <span class="text-xs text-[var(--color-caution)]">Unsaved changes</span>
      {/if}
      <Button variant="primary" loading={saving} disabled={!dirty || saving} onclick={save}>
        Save
      </Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <div class="space-y-5">
      <Skeleton lines={2} />
      <div class="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
        <Skeleton lines={8} />
      </div>
    </div>
  {:else if error}
    <ErrorState message={error.message} code={error.code} onRetry={load} />
  {:else if !skill}
    <ErrorState message="This skill could not be found." onRetry={load} />
  {:else}
    <Tabs
      tabs={[...TABS]}
      active={activeTab}
      onselect={(id) => (activeTab = id)}
      class="scrollbar-thin overflow-x-auto"
    />

    {#if activeTab === 'identity'}
      <Section
        title="Identity"
        description="How this skill is named, described and scoped. Workflow scope is fixed at creation because a workflow-scoped skill belongs to that workflow's agents."
      >
        <TextField label="Name" bind:value={draft.name} required />
        <TextAreaField
          label="Description"
          bind:value={draft.description}
          rows={3}
          hint="When to use this skill and what a good result looks like."
        />
        <div class="space-y-1.5">
          <label for="skill-detail-category" class="text-xs font-medium text-[var(--color-ink-muted)]">
            Category
          </label>
          <input
            id="skill-detail-category"
            type="text"
            value={draft.category}
            maxlength={60}
            placeholder="support"
            class="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]"
            oninput={(event) => (draft.category = event.currentTarget.value)}
          />
        </div>
        <SelectField
          label="Workflow scope"
          value={skill.workflowId ?? ''}
          disabled
          options={[
            { value: '', label: 'Workspace common (every workflow)' },
            ...(skill.workflowId
              ? [{ value: skill.workflowId, label: workflowName ?? skill.workflowId }]
              : [])
          ]}
          hint="Scope is decided when the skill is created; the update endpoint does not accept a workflow change."
        />
      </Section>
    {:else if activeTab === 'instructions'}
      <Section
        title="Instructions"
        description="The procedure itself. Written as directives to the agent; injected into the prompt verbatim for every run that references this skill."
      >
        <TextAreaField
          label="Instructions"
          bind:value={draft.instructions}
          rows={18}
          mono
          placeholder="1. Confirm the customer's identity against the order record.&#10;2. …"
        />
        <p class="text-xs text-[var(--color-ink-subtle)]">
          <span class="font-mono text-[var(--color-ink-muted)]">{charCount}</span> characters ·
          roughly
          <span class="font-mono text-[var(--color-ink-muted)]">{tokenEstimate}</span> tokens
          <span class="text-[var(--color-ink-subtle)]"> (estimated at 4 characters per token)</span>
        </p>
      </Section>
    {:else if activeTab === 'examples'}
      <Section
        title="Examples"
        description="Worked input/output pairs. They teach shape and tone; they are not executed."
      >
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={addExample}>Add example</Button>
        {/snippet}

        {#if draft.examples.length === 0}
          <p class="text-xs text-[var(--color-ink-subtle)]">
            No examples yet. An example is the cheapest way to pin down an output format.
          </p>
        {/if}

        {#each draft.examples as example, index (index)}
          <div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-4">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium text-[var(--color-ink-muted)]">Example {index + 1}</p>
              <Button size="sm" variant="ghost" onclick={() => removeExample(index)}>Remove</Button>
            </div>
            <div class="space-y-1.5">
              <label
                for={`example-title-${index}`}
                class="text-xs font-medium text-[var(--color-ink-muted)]">Title</label
              >
              <input
                id={`example-title-${index}`}
                type="text"
                value={example.title}
                placeholder="Missing delivery date"
                class="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]"
                oninput={(event) => (example.title = event.currentTarget.value)}
              />
            </div>
            <div class="grid gap-3 md:grid-cols-2">
              <TextAreaField
                label="Input"
                bind:value={example.input}
                rows={4}
                mono
                placeholder="The prompt or work item context"
              />
              <TextAreaField
                label="Output"
                bind:value={example.output}
                rows={4}
                mono
                placeholder="The response the agent should produce"
              />
            </div>
            <TextAreaField
              label="Notes"
              bind:value={example.notes}
              rows={2}
              placeholder="Why this example matters"
            />
          </div>
        {/each}
      </Section>
    {:else if activeTab === 'references'}
      <Section
        title="References"
        description="Supporting material the agent may cite. A URL is rendered as a real link; content is pasted context."
      >
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={addReference}>Add reference</Button>
        {/snippet}

        {#if draft.references.length === 0}
          <p class="text-xs text-[var(--color-ink-subtle)]">
            No references yet. Add a policy document, a spec, or a few paragraphs of context.
          </p>
        {/if}

        {#each draft.references as reference, index (index)}
          <div class="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <p class="text-xs font-medium text-[var(--color-ink-muted)]">Reference {index + 1}</p>
                {#if safeHref(reference.url)}
                  <a
                    href={safeHref(reference.url)}
                    target="_blank"
                    rel="noreferrer"
                    class="truncate font-mono text-[11px] text-[var(--color-accent)] hover:underline"
                  >
                    {reference.url}
                  </a>
                {/if}
              </div>
              <Button size="sm" variant="ghost" onclick={() => removeReference(index)}>Remove</Button>
            </div>
            <div class="space-y-1.5">
              <label
                for={`reference-title-${index}`}
                class="text-xs font-medium text-[var(--color-ink-muted)]">Title</label
              >
              <input
                id={`reference-title-${index}`}
                type="text"
                value={reference.title}
                placeholder="Refund policy 2025"
                class="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)]"
                oninput={(event) => (reference.title = event.currentTarget.value)}
              />
            </div>
            <TextField
              label="URL"
              bind:value={reference.url}
              type="url"
              placeholder="https://intranet.example.com/policies/refunds"
              hint="http(s) links open in a new tab; other values are shown as text only."
            />
            <TextAreaField
              label="Content"
              bind:value={reference.content}
              rows={4}
              placeholder="Pasted excerpts the agent may quote."
            />
          </div>
        {/each}
      </Section>
    {:else if activeTab === 'tools'}
      <Section
        title="Recommended tools"
        description="A hint to whoever wires this skill into an agent: these are tools the skill assumes. Granting them still happens on the agent's own permissions and tool list."
      >
        <MultiSelect
          label="Recommended keys"
          bind:selected={draft.recommendedToolKeys}
          options={toolOptions}
          hint="Native capabilities are granted through an agent's permissions.native; stored tool ids go into the agent's toolIds. Recommending a key here does not grant anything by itself."
          searchPlaceholder="Search tools and capabilities…"
          emptyLabel="No tools are registered in this workspace yet."
        />
        <p class="text-xs text-[var(--color-ink-subtle)]">
          Approval for a stored tool is enforced by Mentat before the call is made — never by
          the model.
        </p>
        {#if draft.recommendedToolKeys.length > 0}
          <div class="space-y-2 border-t border-[var(--color-border-subtle)] pt-4">
            <p class="text-xs font-medium text-[var(--color-ink-muted)]">Input schemas</p>
            {#each draft.recommendedToolKeys as key (key)}
              {@const native = nativeTools.find((tool) => tool.key === key)}
              {@const stored = storedTools.find((tool) => tool.key === key)}
              {@const schema = native?.inputSchema ?? stored?.inputSchema ?? null}
              <div class="space-y-1">
                <p class="font-mono text-xs text-[var(--color-ink)]">{key}</p>
                <ParameterList schema={schema} emptyLabel="No declared input parameters." />
              </div>
            {/each}
          </div>
        {/if}
      </Section>
    {:else}
      <Section
        title="Version"
        description="Skills are versioned content: each save appends an immutable snapshot that a run pins, so history can never be rewritten."
      >
        <div class="flex flex-wrap items-center gap-2">
          <Badge tone="accent">Version {skill.version}</Badge>
          <span class="text-xs text-[var(--color-ink-subtle)]">
            Current snapshot
            <code class="font-mono text-[11px] text-[var(--color-ink-muted)]"
              >{skill.currentVersionId ?? 'none'}</code
            >
          </span>
        </div>
        <dl class="grid gap-3 text-xs sm:grid-cols-2">
          <div class="space-y-0.5">
            <dt class="text-[var(--color-ink-muted)]">Created</dt>
            <dd class="text-[var(--color-ink)]">{formatDateTime(skill.createdAt)}</dd>
          </div>
          <div class="space-y-0.5">
            <dt class="text-[var(--color-ink-muted)]">Last saved</dt>
            <dd class="text-[var(--color-ink)]">{formatDateTime(skill.updatedAt)}</dd>
          </div>
        </dl>
        <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Listing historical versions is not exposed by the API yet — there is no
          <code class="font-mono">/api/skills/:id/versions</code> endpoint, so only the current
          snapshot is shown here. Older snapshots still exist and are what an in-flight run pins;
          they simply cannot be browsed from the UI today.
        </p>
        <div class="space-y-2 border-t border-[var(--color-border-subtle)] pt-4">
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">Archive this skill</p>
          <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
            Archiving hides the skill from pickers but keeps every snapshot. Mentat refuses while
            any agent still references it; detach those agents first.
          </p>
          <ConfirmButton
            label="Archive skill"
            confirmLabel="Confirm archive"
            disabled={archiving}
            onconfirm={archive}
          />
        </div>
      </Section>
    {/if}
  {/if}
</div>
