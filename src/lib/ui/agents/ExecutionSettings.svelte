<script lang="ts">
/**
 * ExecutionSettings: limits and failure behaviour for a run.
 *
 * Validation lives in the page so one range definition drives both the inline
 * message and whether Save is enabled; this component only renders the fields and
 * the messages it is handed.
 */
import Section from '$ui/http/controls/Section.svelte';
import Toggle from '$ui/http/controls/Toggle.svelte';
import Input from '$ui/primitives/Input.svelte';

interface ExecutionErrors {
  maxSteps?: string | null;
  maxOutputTokens?: string | null;
  temperature?: string | null;
  topP?: string | null;
  timeoutSeconds?: string | null;
}

interface Props {
  maxSteps?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  timeoutSeconds?: number | null;
  continueOnToolError?: boolean;
  retryOnProviderError?: boolean;
  requireApprovalForMutations?: boolean;
  errors?: ExecutionErrors;
}

let {
  maxSteps = $bindable<number | null>(null),
  maxOutputTokens = $bindable<number | null>(null),
  temperature = $bindable<number | null>(null),
  topP = $bindable<number | null>(null),
  timeoutSeconds = $bindable<number | null>(null),
  continueOnToolError = $bindable(false),
  retryOnProviderError = $bindable(false),
  requireApprovalForMutations = $bindable(false),
  errors = {}
}: Props = $props();

function numberFrom(event: Event): number | null {
  const target = event.currentTarget as HTMLInputElement | null;
  if (target === null || target.value.trim().length === 0) return null;
  const parsed = Number(target.value);
  return Number.isFinite(parsed) ? parsed : null;
}
</script>

<Section
  title="Execution"
  description="Step budget, sampling and failure behaviour applied to every run of this agent."
>
  <div class="grid gap-4 md:grid-cols-2">
    <Input
      label="Max steps"
      type="number"
      min="1"
      max="100"
      value={maxSteps ?? ''}
      error={errors.maxSteps ?? null}
      hint="Whole number from 1 to 100."
      oninput={(event) => {
        maxSteps = numberFrom(event);
      }}
    />
    <Input
      label="Max output tokens"
      type="number"
      min="1"
      value={maxOutputTokens ?? ''}
      error={errors.maxOutputTokens ?? null}
      hint="Upper bound on the model's reply."
      oninput={(event) => {
        maxOutputTokens = numberFrom(event);
      }}
    />
    <Input
      label="Temperature"
      type="number"
      min="0"
      max="2"
      step="0.1"
      value={temperature ?? ''}
      error={errors.temperature ?? null}
      hint="0 to 2. Lower is more deterministic."
      oninput={(event) => {
        temperature = numberFrom(event);
      }}
    />
    <Input
      label="Top P"
      type="number"
      min="0"
      max="1"
      step="0.05"
      value={topP ?? ''}
      error={errors.topP ?? null}
      hint="0 to 1. Nucleus sampling cutoff."
      oninput={(event) => {
        topP = numberFrom(event);
      }}
    />
    <Input
      label="Timeout (seconds)"
      type="number"
      min="5"
      max="3600"
      value={timeoutSeconds ?? ''}
      error={errors.timeoutSeconds ?? null}
      hint="5 to 3600 seconds for the whole run."
      oninput={(event) => {
        timeoutSeconds = numberFrom(event);
      }}
    />
  </div>

  <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
    <Toggle
      bind:checked={continueOnToolError}
      label="Continue after a tool error"
      hint="Record the failed call and let the agent keep working instead of ending the run."
    />
    <Toggle
      bind:checked={retryOnProviderError}
      label="Retry on provider error"
      hint="Re-issue a model call when the provider returns a transient failure."
    />
    <Toggle
      bind:checked={requireApprovalForMutations}
      label="Require approval for mutations"
      hint="Pause before a mutating tool runs until a human approves or rejects it."
    />
  </div>
</Section>
