<script lang="ts">
/**
 * WidgetEditor: author or edit one declarative widget.
 *
 * A widget is *not* a rendered query — it is the question: data source + filter +
 * measure + grouping + time range + visualisation (ADR-0017). That is why the
 * editor exposes exactly those parts and why the dashboard re-runs against current
 * data.
 *
 * Two widget families get a different editor because they are genuinely different
 * questions:
 *
 *  - **Funnel** stages are an explicit ordered list of milestones (states and/or
 *    field values). Board order is never offered or inferred, because workflows
 *    branch.
 *  - **Aging** selects the states whose dwell time should be measured, and states
 *    plainly that the numbers come from recorded history.
 *
 * The local filter reuses `FilterBuilder`, and the same AST is what `?filter=`
 * carries on the ticket list — there is no second filtering language.
 */
import { api, describeApiError } from '$ui/api';
import FilterBuilder from '$ui/common/FilterBuilder.svelte';
import { type FilterAst, type FilterGroup, parseFilter } from '$ui/filters';
import Badge from '$ui/primitives/Badge.svelte';
import Button from '$ui/primitives/Button.svelte';
import Input from '$ui/primitives/Input.svelte';
import Modal from '$ui/primitives/Modal.svelte';
import Select from '$ui/primitives/Select.svelte';
import Textarea from '$ui/primitives/Textarea.svelte';
import {
  type DashboardWidget,
  type FunnelStageDefinition,
  type SavedView,
  WIDGET_TYPES,
  type WidgetAggregation,
  type WidgetDataSource,
  type WidgetGroupingBy,
  type WidgetMeasure,
  type WidgetTimeRange,
  type WidgetType,
  type WidgetVisualization,
  type WorkflowStateRecord,
  type WorkflowSummary
} from '$ui/types';

interface Props {
  open: boolean;
  dashboardId: string;
  /** `null` creates a widget; a value edits it. */
  widget: DashboardWidget | null;
  workflows: WorkflowSummary[];
  savedViews: SavedView[];
  fieldOptions: Array<{ key: string; label: string; type: string }>;
  onclose: () => void;
  onsaved: (widget: DashboardWidget) => void;
}

let { open, dashboardId, widget, workflows, savedViews, fieldOptions, onclose, onsaved }: Props =
  $props();

let draft = $state<WidgetDraft>(blankDraft());
let saving = $state(false);
let error = $state<string | null>(null);
let filterOpen = $state(false);
let statesByWorkflow = $state<Record<string, WorkflowStateRecord[]>>({});

interface WidgetDraft {
  title: string;
  description: string;
  type: WidgetType;
  size: 'sm' | 'md' | 'lg' | 'full';
  dataSourceKind: WidgetDataSource['kind'];
  workflowIds: string[];
  funnelStages: FunnelStageDefinition[];
  agingStates: string[];
  aggregation: WidgetAggregation;
  measureFieldKey: string;
  durationOf: 'time_in_state' | 'cycle_time' | 'time_to_state';
  groupingBy: WidgetGroupingBy;
  groupingFieldKey: string;
  timeKind: 'relative' | 'absolute' | 'all';
  lastDays: number;
  fromIso: string;
  toIso: string;
  basis: 'created' | 'updated' | 'entered_state';
  savedViewId: string;
  filter: FilterAst | null;
  color: string;
  showLegend: boolean;
  showValues: boolean;
  stacked: boolean;
  valueFormat: 'number' | 'currency' | 'percent' | 'duration';
  currency: string;
}

function blankDraft(): WidgetDraft {
  return {
    title: '',
    description: '',
    type: 'kpi',
    size: 'md',
    dataSourceKind: 'tickets',
    workflowIds: [],
    funnelStages: [],
    agingStates: [],
    aggregation: 'count',
    measureFieldKey: '',
    durationOf: 'time_in_state',
    groupingBy: 'none',
    groupingFieldKey: '',
    timeKind: 'all',
    lastDays: 30,
    fromIso: '',
    toIso: '',
    basis: 'created',
    savedViewId: '',
    filter: null,
    color: '',
    showLegend: true,
    showValues: false,
    stacked: false,
    valueFormat: 'number',
    currency: 'USD'
  };
}

function draftFrom(widgetValue: DashboardWidget | null): WidgetDraft {
  if (!widgetValue) return blankDraft();
  return {
    title: widgetValue.title,
    description: widgetValue.description ?? '',
    type: widgetValue.type,
    size: widgetValue.size,
    dataSourceKind: widgetValue.dataSource.kind,
    workflowIds: widgetValue.dataSource.workflowIds ?? [],
    funnelStages: widgetValue.dataSource.funnelStages ?? [],
    agingStates: widgetValue.dataSource.agingStates ?? [],
    aggregation: widgetValue.measure.aggregation,
    measureFieldKey: widgetValue.measure.fieldKey ?? '',
    durationOf: widgetValue.measure.durationOf ?? 'time_in_state',
    groupingBy: widgetValue.grouping?.by ?? 'none',
    groupingFieldKey: widgetValue.grouping?.fieldKey ?? '',
    timeKind: widgetValue.timeRange?.kind ?? 'all',
    lastDays: widgetValue.timeRange?.lastDays ?? 30,
    fromIso: widgetValue.timeRange?.from ? toIso(widgetValue.timeRange.from) : '',
    toIso: widgetValue.timeRange?.to ? toIso(widgetValue.timeRange.to) : '',
    basis: widgetValue.timeRange?.basis ?? 'created',
    savedViewId: widgetValue.savedViewId ?? '',
    filter: parseFilter(widgetValue.filter ? JSON.stringify(widgetValue.filter) : null),
    color: widgetValue.visualization?.color ?? '',
    showLegend: widgetValue.visualization?.showLegend ?? true,
    showValues: widgetValue.visualization?.showValues ?? false,
    stacked: widgetValue.visualization?.stacked ?? false,
    valueFormat: widgetValue.visualization?.valueFormat ?? 'number',
    currency: widgetValue.visualization?.currency ?? 'USD'
  };
}

$effect(() => {
  if (open) {
    draft = draftFrom(widget);
    error = null;
    void ensureStates(draft.workflowIds);
  }
});

const workflowOptions = $derived(
  workflows.map((entry) => ({ value: entry.id, label: entry.name }))
);

const stateOptions = $derived.by(() => {
  const seen = new Map<string, string>();
  for (const workflowId of draft.workflowIds) {
    for (const state of statesByWorkflow[workflowId] ?? []) {
      seen.set(
        state.id,
        `${state.name} (${workflows.find((w) => w.id === workflowId)?.name ?? ''})`
      );
    }
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
});

async function ensureStates(workflowIds: string[]) {
  await Promise.all(
    workflowIds
      .filter((id) => !statesByWorkflow[id])
      .map(async (id) => {
        try {
          const response = await api.get<{ states: WorkflowStateRecord[] }>(
            `/workflows/${id}/states`
          );
          statesByWorkflow = { ...statesByWorkflow, [id]: response.states };
        } catch {
          statesByWorkflow = { ...statesByWorkflow, [id]: [] };
        }
      })
  );
}

function toggleWorkflow(id: string) {
  draft.workflowIds = draft.workflowIds.includes(id)
    ? draft.workflowIds.filter((entry) => entry !== id)
    : [...draft.workflowIds, id];
  void ensureStates(draft.workflowIds);
}

function addStage() {
  draft.funnelStages = [
    ...draft.funnelStages,
    { label: `Stage ${draft.funnelStages.length + 1}`, stateIds: [] }
  ];
}

function updateStage(index: number, patch: Partial<FunnelStageDefinition>) {
  draft.funnelStages = draft.funnelStages.map((stage, position) =>
    position === index ? { ...stage, ...patch } : stage
  );
}

function moveStage(index: number, delta: number) {
  const next = index + delta;
  if (next < 0 || next >= draft.funnelStages.length) return;
  const stages = [...draft.funnelStages];
  const [moved] = stages.splice(index, 1);
  if (!moved) return;
  stages.splice(next, 0, moved);
  draft.funnelStages = stages;
}

function removeStage(index: number) {
  draft.funnelStages = draft.funnelStages.filter((_, position) => position !== index);
}

function toggleAgingState(stateId: string) {
  draft.agingStates = draft.agingStates.includes(stateId)
    ? draft.agingStates.filter((entry) => entry !== stateId)
    : [...draft.agingStates, stateId];
}

function onFilterChange(next: FilterGroup | null) {
  draft.filter = next;
}

function buildBody(): WidgetBody {
  const dataSource: WidgetDataSource = {
    kind: draft.dataSourceKind,
    ...(draft.workflowIds.length > 0 ? { workflowIds: draft.workflowIds } : {}),
    ...(draft.type === 'funnel' ? { funnelStages: draft.funnelStages } : {}),
    ...(draft.type === 'aging' ? { agingStates: draft.agingStates } : {})
  };
  const measure: WidgetMeasure = {
    aggregation: draft.aggregation,
    ...(draft.aggregation !== 'count' && draft.measureFieldKey
      ? { fieldKey: draft.measureFieldKey }
      : {}),
    ...(draft.aggregation === 'duration' ? { durationOf: draft.durationOf } : {})
  };
  const grouping =
    draft.groupingBy === 'none'
      ? null
      : {
          by: draft.groupingBy,
          ...(draft.groupingBy === 'field' && draft.groupingFieldKey
            ? { fieldKey: draft.groupingFieldKey }
            : {})
        };
  const timeRange: WidgetTimeRange = { kind: draft.timeKind, basis: draft.basis };
  if (draft.timeKind === 'relative') timeRange.lastDays = draft.lastDays;
  if (draft.timeKind === 'absolute') {
    if (draft.fromIso) timeRange.from = Date.parse(draft.fromIso);
    if (draft.toIso) timeRange.to = Date.parse(draft.toIso);
  }
  const visualization: WidgetVisualization = {
    showLegend: draft.showLegend,
    showValues: draft.showValues,
    stacked: draft.stacked,
    valueFormat: draft.valueFormat,
    ...(draft.valueFormat === 'currency' ? { currency: draft.currency } : {}),
    ...(draft.color ? { color: draft.color } : {})
  };
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    type: draft.type,
    size: draft.size,
    dataSource,
    filter: draft.filter,
    measure,
    grouping,
    timeRange,
    visualization,
    savedViewId: draft.savedViewId || null
  };
}

interface WidgetBody {
  title: string;
  description: string | null;
  type: WidgetType;
  size: 'sm' | 'md' | 'lg' | 'full';
  dataSource: WidgetDataSource;
  filter: FilterAst | null;
  measure: WidgetMeasure;
  grouping: { by: WidgetGroupingBy; fieldKey?: string } | null;
  timeRange: WidgetTimeRange;
  visualization: WidgetVisualization;
  savedViewId: string | null;
}

async function save() {
  if (draft.title.trim().length === 0) {
    error = 'A widget needs a title.';
    return;
  }
  if (draft.type === 'funnel' && draft.funnelStages.length < 2) {
    error = 'A funnel needs at least two ordered milestones.';
    return;
  }
  saving = true;
  error = null;
  try {
    const body = buildBody();
    if (widget) {
      const response = await api.patch<{ widget: DashboardWidget }>(`/widgets/${widget.id}`, body);
      onsaved(response.widget);
    } else {
      const response = await api.post<{ widget: DashboardWidget }>(
        `/dashboards/${dashboardId}/widgets`,
        body
      );
      onsaved(response.widget);
    }
    onclose();
  } catch (failure) {
    error = describeApiError(failure);
  } finally {
    saving = false;
  }
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

const isFunnel = $derived(draft.type === 'funnel');
const isAging = $derived(draft.type === 'aging');
const needsField = $derived(['sum', 'avg', 'median', 'min', 'max'].includes(draft.aggregation));
const fieldPickerOptions = $derived([
  { value: '', label: 'Choose a field' },
  ...fieldOptions.map((field) => ({ value: field.key, label: `${field.label} (${field.type})` }))
]);
</script>

<Modal
  open={open}
  title={widget ? `Edit “${widget.title}”` : 'Add a widget'}
  description="A widget is a declarative question. It re-runs against current data; the filter language is the same one the ticket list uses."
  width="46rem"
  onclose={onclose}
>
  <div class="space-y-4">
    <div class="grid gap-3 sm:grid-cols-2">
      <Input label="Title" bind:value={draft.title} placeholder="Open claims by state" />
      <Select
        label="Visualisation"
        options={WIDGET_TYPES.map((value) => ({ value, label: value }))}
        bind:value={draft.type}
      />
    </div>
    <Textarea label="Description" bind:value={draft.description} rows={2} />
    <Select
      label="Size in the grid"
      options={[
        { value: 'sm', label: 'Small' },
        { value: 'md', label: 'Medium' },
        { value: 'lg', label: 'Large' },
        { value: 'full', label: 'Full width' }
      ]}
      bind:value={draft.size}
    />

    <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <legend class="px-1 text-xs font-semibold">Data source</legend>
      <div class="grid gap-2 sm:grid-cols-2">
        <Select
          label="Source"
          options={[
            { value: 'tickets', label: 'Tickets' },
            { value: 'state_history', label: 'State history intervals' },
            { value: 'field_history', label: 'Field value history' },
            { value: 'runs', label: 'Agent runs' },
            { value: 'files', label: 'Files' }
          ]}
          bind:value={draft.dataSourceKind}
        />
        <Select
          label="Saved view (reuse its filter)"
          options={[
            { value: '', label: 'None' },
            ...savedViews.map((view) => ({ value: view.id, label: view.name }))
          ]}
          bind:value={draft.savedViewId}
        />
      </div>
      <div>
        <p class="mb-1 text-xs font-medium text-[var(--color-ink-muted)]">Workflows (all when none selected)</p>
        <div class="flex flex-wrap gap-2">
          {#each workflowOptions as option (option.value)}
            <label class="inline-flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={draft.workflowIds.includes(option.value)}
                onchange={() => toggleWorkflow(option.value)}
              />
              {option.label}
            </label>
          {/each}
          {#if workflowOptions.length === 0}
            <span class="text-xs text-[var(--color-ink-subtle)]">No workflows in this workspace.</span>
          {/if}
        </div>
      </div>
    </fieldset>

    {#if isFunnel}
      <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <legend class="px-1 text-xs font-semibold">Funnel milestones (explicit order)</legend>
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          Select the milestone order yourself. Board order is never used to infer stage order because
          workflows branch. Each milestone may require states, a field value, or both.
        </p>
        <ol class="space-y-2">
          {#each draft.funnelStages as stage, index (index)}
            <li class="space-y-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] p-2">
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-[var(--color-ink-subtle)]">{index + 1}</span>
                <Input
                  label="Label"
                  value={stage.label}
                  oninput={(event) => updateStage(index, { label: event.currentTarget.value })}
                />
                <div class="flex items-end gap-1 pb-0.5">
                  <Button size="sm" variant="ghost" title="Move up" onclick={() => moveStage(index, -1)}>↑</Button>
                  <Button size="sm" variant="ghost" title="Move down" onclick={() => moveStage(index, 1)}>↓</Button>
                  <Button size="sm" variant="ghost" title="Remove" onclick={() => removeStage(index)}>✕</Button>
                </div>
              </div>
              <div class="grid gap-2 sm:grid-cols-2">
                <Select
                  label="States that satisfy this milestone"
                  options={stateOptions}
                  placeholder="No state requirement"
                  value={stage.stateIds?.[0] ?? ''}
                  onchange={(event) =>
                    updateStage(index, {
                      stateIds: event.currentTarget.value ? [event.currentTarget.value] : []
                    })}
                />
                <Select
                  label="Field value requirement"
                  options={fieldPickerOptions}
                  value={stage.fieldKey ?? ''}
                  onchange={(event) => updateStage(index, { fieldKey: event.currentTarget.value })}
                />
              </div>
              {#if stage.fieldKey}
                <Input
                  label="Field value"
                  value={String(stage.fieldValue ?? '')}
                  oninput={(event) => updateStage(index, { fieldValue: event.currentTarget.value })}
                />
              {/if}
            </li>
          {/each}
        </ol>
        <Button size="sm" variant="secondary" onclick={addStage}>+ Add milestone</Button>
      </fieldset>
    {:else if isAging}
      <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <legend class="px-1 text-xs font-semibold">States to measure</legend>
        <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
          Dwell time is read from <code class="font-mono">ticket_state_history</code> intervals, not
          from current ticket rows. An interval still open is measured against now, so in-progress
          work is counted rather than dropped.
        </p>
        <div class="flex flex-wrap gap-2">
          {#each stateOptions as option (option.value)}
            <label class="inline-flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={draft.agingStates.includes(option.value)}
                onchange={() => toggleAgingState(option.value)}
              />
              {option.label}
            </label>
          {/each}
          {#if stateOptions.length === 0}
            <span class="text-xs text-[var(--color-ink-subtle)]">Select a workflow to list its states.</span>
          {/if}
        </div>
      </fieldset>
    {:else}
      <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <legend class="px-1 text-xs font-semibold">Measure</legend>
        <div class="grid gap-2 sm:grid-cols-2">
          <Select
            label="Aggregation"
            options={[
              { value: 'count', label: 'Count' },
              { value: 'sum', label: 'Sum' },
              { value: 'avg', label: 'Average' },
              { value: 'median', label: 'Median' },
              { value: 'min', label: 'Minimum' },
              { value: 'max', label: 'Maximum' },
              { value: 'conversion', label: 'Conversion (needs funnel stages)' },
              { value: 'duration', label: 'Duration' }
            ]}
            bind:value={draft.aggregation}
          />
          {#if needsField}
            <Select label="Field" options={fieldPickerOptions} bind:value={draft.measureFieldKey} />
          {/if}
          {#if draft.aggregation === 'duration'}
            <Select
              label="Duration of"
              options={[
                { value: 'time_in_state', label: 'Time in state' },
                { value: 'cycle_time', label: 'Cycle time' },
                { value: 'time_to_state', label: 'Time to state' }
              ]}
              bind:value={draft.durationOf}
            />
          {/if}
        </div>
      </fieldset>

      <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
        <legend class="px-1 text-xs font-semibold">Grouping</legend>
        <div class="grid gap-2 sm:grid-cols-2">
          <Select
            label="Group by"
            options={[
              { value: 'none', label: 'None' },
              { value: 'state', label: 'State' },
              { value: 'priority', label: 'Priority' },
              { value: 'owner', label: 'Owner' },
              { value: 'team', label: 'Team' },
              { value: 'label', label: 'Label' },
              { value: 'workflow', label: 'Workflow' },
              { value: 'field', label: 'Ticket field' },
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' }
            ]}
            bind:value={draft.groupingBy}
          />
          {#if draft.groupingBy === 'field'}
            <Select label="Grouping field" options={fieldPickerOptions} bind:value={draft.groupingFieldKey} />
          {/if}
        </div>
      </fieldset>
    {/if}

    <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <legend class="px-1 text-xs font-semibold">Time range</legend>
      <div class="grid gap-2 sm:grid-cols-3">
        <Select
          label="Range"
          options={[
            { value: 'all', label: 'All time' },
            { value: 'relative', label: 'Relative (last N days)' },
            { value: 'absolute', label: 'Absolute' }
          ]}
          bind:value={draft.timeKind}
        />
        {#if draft.timeKind === 'relative'}
          <Input label="Last N days" type="number" min="1" bind:value={draft.lastDays} />
        {/if}
        <Select
          label="Basis"
          options={[
            { value: 'created', label: 'Created' },
            { value: 'updated', label: 'Updated' },
            { value: 'entered_state', label: 'Entered state' }
          ]}
          bind:value={draft.basis}
        />
      </div>
      {#if draft.timeKind === 'absolute'}
        <div class="grid gap-2 sm:grid-cols-2">
          <Input label="From" type="date" bind:value={draft.fromIso} />
          <Input label="To" type="date" bind:value={draft.toIso} />
        </div>
      {/if}
    </fieldset>

    <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <legend class="px-1 text-xs font-semibold">Local filter</legend>
      <p class="text-[11px] leading-relaxed text-[var(--color-ink-subtle)]">
        The dashboard's global filter is ANDed with this one. Both are the same AST as the ticket
        list and a saved view.
      </p>
      <Button size="sm" variant="secondary" onclick={() => (filterOpen = !filterOpen)} aria-expanded={filterOpen}>
        {filterOpen ? 'Hide filter builder' : 'Build a filter'}
        {#if draft.filter}<Badge tone="accent">on</Badge>{/if}
      </Button>
      {#if filterOpen}
        <FilterBuilder
          value={draft.filter}
          allow={['system', 'field', 'state', 'workflow']}
          ticketFields={fieldOptions}
          workflowOptions={workflowOptions}
          stateOptions={stateOptions}
          onchange={onFilterChange}
        />
      {/if}
    </fieldset>

    <fieldset class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] p-3">
      <legend class="px-1 text-xs font-semibold">Visualisation</legend>
      <div class="grid gap-2 sm:grid-cols-2">
        <Select
          label="Value format"
          options={[
            { value: 'number', label: 'Number' },
            { value: 'currency', label: 'Currency' },
            { value: 'percent', label: 'Percent' },
            { value: 'duration', label: 'Duration' }
          ]}
          bind:value={draft.valueFormat}
        />
        {#if draft.valueFormat === 'currency'}
          <Input label="Currency code" bind:value={draft.currency} placeholder="USD" />
        {/if}
      </div>
      <div class="flex flex-wrap gap-3 text-xs">
        <label class="inline-flex items-center gap-1.5">
          <input type="checkbox" bind:checked={draft.showLegend} /> Show legend
        </label>
        <label class="inline-flex items-center gap-1.5">
          <input type="checkbox" bind:checked={draft.showValues} /> Show values
        </label>
        <label class="inline-flex items-center gap-1.5">
          <input type="checkbox" bind:checked={draft.stacked} /> Stacked
        </label>
      </div>
    </fieldset>

    {#if error}
      <p class="rounded-[var(--radius-md)] bg-[color-mix(in_oklch,var(--color-danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]" role="alert">
        {error}
      </p>
    {/if}

    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={onclose}>Cancel</Button>
      <Button variant="primary" loading={saving} onclick={save}>
        {widget ? 'Save widget' : 'Add widget'}
      </Button>
    </div>
  </div>
</Modal>
