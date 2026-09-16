<script lang="ts">
/**
 * CronConfig: authoring a schedule without guessing.
 *
 * The expression is validated in the browser with the same conservative five-field
 * grammar the server accepts, described in plain language, and previewed as the next
 * three instants in the chosen timezone. "Run now" asks the server to run the
 * scheduler once, which fires every schedule that is currently due.
 */

import { pluralize } from '$shared/format';
import { api, describeApiError } from '$ui/api';
import Toggle from '$ui/http/controls/Toggle.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Select from '$ui/primitives/Select.svelte';
import {
  describeCron,
  formatInTimezone,
  nextCronRuns,
  timezoneOptions,
  validateCronExpression
} from './cron';
import TriggerMappingEditor from './TriggerMappingEditor.svelte';
import type { TriggerFireSummary, TriggerMapping, WorkflowOption } from './types';

interface Props {
  expression?: string;
  timezone?: string;
  skipIfRunning?: boolean;
  mapping?: TriggerMapping;
  workflows: WorkflowOption[];
  enabled: boolean;
  onfired?: () => void;
}

let {
  expression = $bindable('0 9 * * 1-5'),
  timezone = $bindable('UTC'),
  skipIfRunning = $bindable(false),
  mapping = $bindable({}),
  workflows,
  enabled,
  onfired
}: Props = $props();

let tickBusy = $state(false);
let tickMessage = $state<string | null>(null);
let tickError = $state<string | null>(null);

const expressionError = $derived(validateCronExpression(expression));
const cadence = $derived(describeCron(expression));
const preview = $derived(nextCronRuns(expression, timezone, 3));

const zoneOptions = $derived.by(() => {
  const zones = timezoneOptions();
  const options = zones.map((zone) => ({ value: zone, label: zone }));
  if (timezone.length > 0 && !zones.includes(timezone)) {
    options.unshift({ value: timezone, label: `${timezone} (not recognised)` });
  }
  return options;
});

async function runNow() {
  tickBusy = true;
  tickError = null;
  tickMessage = null;
  try {
    const result = await api.post<TriggerFireSummary>('/api/triggers/schedule/tick');
    const fired = result.fired;
    const skipped = fired.filter((entry) => entry.skipped).length;
    const duplicates = fired.filter((entry) => entry.duplicate).length;
    const parts = [`${pluralize(fired.length, 'schedule')} fired`];
    if (skipped > 0) parts.push(`${skipped} skipped (already running)`);
    if (duplicates > 0) parts.push(`${duplicates} duplicate`);
    tickMessage =
      fired.length === 0 ? 'No schedules were due, so nothing fired.' : `${parts.join(', ')}.`;
    onfired?.();
  } catch (failure) {
    tickError = describeApiError(failure);
  } finally {
    tickBusy = false;
  }
}
</script>

<div class="space-y-5">
  <div class="grid gap-4 md:grid-cols-[2fr_1fr]">
    <Input
      label="Cron expression"
      value={expression}
      placeholder="0 9 * * 1-5"
      hint="Five fields: minute hour day-of-month month day-of-week. Lists, ranges and steps are supported."
      error={expression.length > 0 ? expressionError : null}
      oninput={(event) => (expression = event.currentTarget.value)}
      class="font-mono"
    />
    <Select
      label="Timezone"
      options={zoneOptions}
      value={timezone}
      onchange={(event) => (timezone = event.currentTarget.value)}
    />
  </div>

  <div class="space-y-1.5">
    <p class="text-sm text-[var(--color-ink)]">{cadence}</p>
    {#if !expressionError}
      {#if preview.ok}
        <div>
          <p class="text-xs font-medium text-[var(--color-ink-muted)]">Next three runs</p>
          <ul class="mt-1 space-y-0.5">
            {#each preview.runs as run (run)}
              <li class="font-mono text-xs text-[var(--color-ink-muted)]">
                {formatInTimezone(run, timezone)}
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="text-xs text-[var(--color-ink-subtle)]">{preview.error}</p>
      {/if}
    {/if}
  </div>

  <Toggle
    bind:checked={skipIfRunning}
    label="Skip when a run is already in flight"
    hint="Prevents overlapping executions when a scheduled run takes longer than its interval."
  />

  <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p class="text-sm font-medium text-[var(--color-ink)]">Run now</p>
        <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
          Runs the scheduler once. Every schedule that is due fires — including this one if its
          next run has arrived.
        </p>
      </div>
      <Button size="sm" variant="secondary" loading={tickBusy} onclick={runNow}>Run now</Button>
    </div>
    {#if tickMessage}
      <p class="text-xs text-[var(--color-positive)]">{tickMessage}</p>
    {/if}
    {#if tickError}
      <p class="text-xs text-[var(--color-danger)]">{tickError}</p>
    {/if}
    {#if !enabled}
      <p class="text-xs text-[var(--color-ink-subtle)]">
        This trigger is disabled, so the scheduler will not fire it.
      </p>
    {/if}
  </div>

  <div class="space-y-3 border-t border-[var(--color-border-subtle)] pt-4">
    <div>
      <p class="text-sm font-semibold text-[var(--color-ink)]">Payload mapping</p>
      <p class="text-xs leading-relaxed text-[var(--color-ink-subtle)]">
        Decide what a scheduled firing creates. A schedule has no external payload, so use
        templates over values the trigger can resolve rather than incoming paths.
      </p>
    </div>
    <TriggerMappingEditor bind:mapping {workflows} />
  </div>
</div>
