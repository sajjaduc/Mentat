<script lang="ts">
/**
 * Human-gate decision panel.
 *
 * A gate is not an approval: it stops automatic progression and asks a permitted
 * human to choose an allowed outgoing transition, sometimes with a required
 * comment and required field values. The panel shows exactly what is required
 * before the round trip, and it records every decision that has been made.
 */
import { formatRelative } from '$shared/format';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import FieldInput from '$ui/work/FieldInput.svelte';
import type {
  AvailableTransition,
  GateDecision,
  HumanGateConfig,
  MemberOption,
  TeamOption,
  WorkflowState,
  WorkItemFieldConfig
} from '$ui/work/types';
import type { TransitionRequest } from '$ui/work-item/actions';

interface Props {
  gate: HumanGateConfig;
  /** The gated state; named `current` so it cannot be mistaken for the `$state` rune. */
  current: WorkflowState;
  transitions: AvailableTransition[];
  fieldConfig: WorkItemFieldConfig[];
  values: Record<string, unknown>;
  decisions: GateDecision[];
  members?: MemberOption[];
  teams?: TeamOption[];
  pending?: boolean;
  error?: string | null;
  onDecide: (request: TransitionRequest) => void;
}

let {
  gate,
  current,
  transitions,
  fieldConfig,
  values,
  decisions,
  members = [],
  teams = [],
  pending = false,
  error = null,
  onDecide
}: Props = $props();

let comment = $state('');
let drafts = $state<Record<string, unknown>>({});

const allowed = $derived(transitions.filter((transition) => transition.allowed));
const requiredKeys = $derived(gate.requiredFieldKeys ?? []);
const requiredConfigs = $derived(
  requiredKeys
    .map((key) => fieldConfig.find((config) => config.key === key))
    .filter((config): config is WorkItemFieldConfig => config !== undefined)
);
const missing = $derived(
  requiredConfigs.filter((config) => {
    const value = drafts[config.key] ?? values[config.key];
    return value === null || value === undefined || value === '';
  })
);
const requiresComment = $derived(gate.requiredComment === true);
const canDecide = $derived(
  !pending && missing.length === 0 && (!requiresComment || comment.trim() !== '')
);

function decide(transition: AvailableTransition) {
  onDecide({
    transitionId: transition.id,
    comment: comment.trim() === '' ? undefined : comment.trim(),
    fieldValues: Object.keys(drafts).length > 0 ? drafts : undefined
  });
}
</script>

<section
  class="space-y-3 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--color-caution)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-caution)_7%,var(--color-surface))] p-3"
  data-testid="human-gate-panel"
>
  <header class="flex items-center gap-2">
    <Badge tone="caution" dot={true}>Human gate</Badge>
    <p class="text-xs text-[var(--color-ink-muted)]">
      {current.name} waits for a human decision; agents cannot leave it.
    </p>
  </header>

  {#if gate.instructions}
    <p class="text-xs leading-relaxed text-[var(--color-ink-muted)]">{gate.instructions}</p>
  {/if}

  {#if gate.allowedRoles && gate.allowedRoles.length > 0}
    <p class="text-[11px] text-[var(--color-ink-subtle)]">
      Permitted roles: {gate.allowedRoles.join(', ')}.
    </p>
  {/if}

  {#if requiredConfigs.length > 0}
    <div class="space-y-2">
      <p class="text-[11px] font-medium text-[var(--color-ink-muted)]">Required before exit</p>
      {#each requiredConfigs as config (config.key)}
        <div class="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2">
          <FieldInput
            {config}
            value={drafts[config.key] ?? values[config.key] ?? null}
            {members}
            {teams}
            error={missing.some((entry) => entry.key === config.key) ? 'Required by this gate' : null}
            onchange={(value) => {
              drafts = { ...drafts, [config.key]: value };
            }}
          />
        </div>
      {/each}
    </div>
  {/if}

  <div>
    <Textarea
      value={comment} oninput={(event) => (comment = (event.currentTarget as HTMLTextAreaElement).value)}
      label={requiresComment ? 'Decision comment (required)' : 'Decision comment (optional)'}
      rows={2}
      error={requiresComment && comment.trim() === '' && pending ? 'A comment is required' : null}
      placeholder="Why is this the right decision?"
    />
  </div>

  {#if error}
    <p class="text-xs text-[var(--color-danger)]" role="alert">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#each allowed as transition (transition.id)}
      <Button variant="primary" size="sm" disabled={!canDecide} loading={pending} onclick={() => decide(transition)}>
        {transition.name}
      </Button>
    {/each}
    {#if allowed.length === 0}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        You do not have a permitted transition out of this state.
      </p>
    {/if}
  </div>

  {#if !canDecide && missing.length > 0}
    <p class="text-[11px] text-[var(--color-caution)]">
      Fill in the required field{missing.length === 1 ? '' : 's'} to continue.
    </p>
  {/if}

  {#if decisions.length > 0}
    <div class="border-t border-[var(--color-border-subtle)] pt-2">
      <p class="text-[11px] font-medium text-[var(--color-ink-muted)]">Recorded decisions</p>
      <ul class="mt-1 space-y-1">
        {#each decisions as decision (decision.id)}
          <li class="text-[11px] text-[var(--color-ink-muted)]">
            <span class="font-medium">{decision.outcome}</span>
            · {decision.decidedByLabel ?? 'Unknown'} · {formatRelative(decision.createdAt)}
            {#if decision.comment}
              <span class="block text-[var(--color-ink-subtle)]">“{decision.comment}”</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
