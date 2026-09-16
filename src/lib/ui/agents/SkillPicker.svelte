<script lang="ts">
/**
 * SkillPicker: choose the skills injected into an agent.
 *
 * Skills are prompt material, not executable steps: selecting one contributes its
 * instructions verbatim to the agent's context. The preview below the picker shows
 * exactly what will be injected, so the effect of a selection is inspectable before
 * it is saved.
 */
import { truncate } from '$shared/format';
import type { SkillView } from '$ui/agents/types';
import { api, describeApiError } from '$ui/api';
import CodeBlock from '$ui/http/controls/CodeBlock.svelte';
import MultiSelect from '$ui/http/controls/MultiSelect.svelte';
import Section from '$ui/http/controls/Section.svelte';
import ErrorState from '$ui/primitives/ErrorState.svelte';
import Skeleton from '$ui/primitives/Skeleton.svelte';

interface Props {
  skillIds?: string[];
}

let { skillIds = $bindable<string[]>([]) }: Props = $props();

let skills = $state<SkillView[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

async function load() {
  loading = true;
  error = null;
  try {
    skills = (await api.get<{ skills: SkillView[] }>('/api/skills')).skills;
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    loading = false;
  }
}

$effect(() => {
  void load();
});

const options = $derived(
  skills.map((skill) => ({
    value: skill.id,
    label: skill.name,
    group: skill.category ?? 'Uncategorised',
    hint: skill.description === null ? undefined : truncate(skill.description, 160),
    badge: `v${skill.version}`
  }))
);

const selectedSkills = $derived(
  skillIds
    .map((id) => skills.find((skill) => skill.id === id))
    .filter((skill): skill is SkillView => skill !== undefined)
);

const missingCount = $derived(skillIds.length - selectedSkills.length);
</script>

<Section
  title="Skills"
  description="Skills are injected into the agent's instructions — they are not executed as steps and do not call tools on their own."
>
  {#if loading}
    <Skeleton lines={3} height="2.25rem" />
  {:else if error}
    <ErrorState message={error} onRetry={load} />
  {:else}
    <MultiSelect
      label="Injected skills"
      hint="Every selected skill contributes its instructions to each run of this agent."
      searchPlaceholder="Search skills…"
      emptyLabel="No skills exist yet. Create one under Skills first."
      options={options}
      bind:selected={skillIds}
    />

    {#if missingCount > 0}
      <p class="text-xs text-[var(--color-caution)]">
        {missingCount} selected {missingCount === 1 ? 'skill is' : 'skills are'} no longer available
        and will not be injected.
      </p>
    {/if}

    {#if selectedSkills.length > 0}
      <div class="space-y-2">
        <p class="text-xs font-medium text-[var(--color-ink-muted)]">Injected instructions</p>
        {#each selectedSkills as skill (skill.id)}
          <details class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)]">
            <summary class="cursor-pointer px-3 py-2 text-xs text-[var(--color-ink)]">
              <span class="font-mono">{skill.name}</span>
              <span class="ml-2 text-[var(--color-ink-subtle)]">
                {skill.instructions.length} characters
              </span>
            </summary>
            <div class="px-3 pb-3">
              <CodeBlock
                value={skill.instructions}
                emptyLabel="This skill has no instructions yet."
                maxHeight="18rem"
              />
            </div>
          </details>
        {/each}
      </div>
    {/if}
  {/if}
</Section>
