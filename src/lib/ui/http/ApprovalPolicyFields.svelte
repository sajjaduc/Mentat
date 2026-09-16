<script lang="ts">
/**
 * ApprovalPolicyFields: the approval gate for a service default or an operation.
 *
 * The condition is machine-readable data evaluated by the policy engine, never by the
 * model (ADR-0019). The editor shows the evaluation rules the runtime implements so an
 * operator can predict the gate, and says plainly that an unreadable or empty
 * condition fails closed — requiring approval instead of silently allowing the call.
 */
import { defaultApprovalPolicy, describeApprovalPolicy } from './policy';
import type { ApprovalPolicy } from './types';
import SelectField from './controls/SelectField.svelte';
import TextField from './controls/TextField.svelte';
import Toggle from './controls/Toggle.svelte';

interface Props {
  value?: ApprovalPolicy | null;
  inherited?: ApprovalPolicy | null;
  title?: string;
  inheritHint?: string;
}

let {
  value = $bindable<ApprovalPolicy | null>(null),
  inherited = null,
  title = 'Approval policy',
  inheritHint = 'When off, the service default applies.'
}: Props = $props();

const modeOptions = [
  { value: 'never', label: 'Never — run without approval' },
  { value: 'always', label: 'Always — pause every call' },
  { value: 'conditional', label: 'Conditional — evaluate the condition' }
];

function patch(changes: Partial<ApprovalPolicy>) {
  if (value) value = { ...value, ...changes };
}

function toggleOverride(next: boolean) {
  value = next ? defaultApprovalPolicy() : null;
}
</script>

<div class="space-y-4">
  <Toggle
    checked={value !== null}
    label={`Override ${title.toLowerCase()}`}
    hint={inheritHint}
    onchange={toggleOverride}
  />

  {#if value}
    <SelectField
      label="Mode"
      options={modeOptions}
      value={value.mode}
      onchange={(next) => patch({ mode: next as ApprovalPolicy['mode'] })}
    />

    {#if value.mode === 'conditional'}
      <TextField
        label="Condition"
        value={value.condition ?? ''}
        placeholder="mutations"
        hint={
          '`mutations` gates every POST/PUT/PATCH/DELETE. An expression such as `input.amount > 1000` compares a path. A JSON object such as {"input.currency":"USD"} must match every entry.'
        }
        onchange={(next) => patch({ condition: next })}
      />
    {/if}

    <TextField
      label="Reason shown to the approver"
      value={value.reason ?? ''}
      placeholder="Large refunds need a second pair of eyes"
      onchange={(next) => patch({ reason: next })}
    />

    <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
      {describeApprovalPolicy(value)}
    </p>
  {:else}
    <p class="rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
      {describeApprovalPolicy(inherited)}
    </p>
  {/if}

  <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
    Approval is decided before anything leaves the process, and the decision is made by Mentat
    against this stored policy — a model's claim that it asked for permission is never sufficient.
    A conditional policy with no readable condition fails closed.
  </p>
</div>
