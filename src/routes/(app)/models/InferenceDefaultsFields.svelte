<script lang="ts">
/**
 * InferenceDefaultsFields: the numeric generation defaults plus stop sequences.
 *
 * Values are edited as raw text and only parsed when committed, so a half-typed `0.`
 * is never normalised out from under the cursor. An effect commits the parsed shape
 * back to the bindable `value` whenever a field changes, which keeps the parent the
 * single owner of the saved shape without every input repeating the same call.
 */

import type { ModelInferenceDefaults } from '$ui/agents/types';
import TagsInput from '$ui/http/controls/TagsInput.svelte';
import Input from '$ui/primitives/Input.svelte';

interface Props {
  value?: ModelInferenceDefaults;
  disabled?: boolean;
}

let { value = $bindable<ModelInferenceDefaults>({}), disabled = false }: Props = $props();

const initial = { ...value };

function numberText(input: number | undefined): string {
  return input === undefined ? '' : String(input);
}

function toNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

let temperature = $state(numberText(initial.temperature));
let topP = $state(numberText(initial.topP));
let topK = $state(numberText(initial.topK));
let numCtx = $state(numberText(initial.numCtx));
let numPredict = $state(numberText(initial.numPredict));
let seed = $state(numberText(initial.seed));
let repeatPenalty = $state(numberText(initial.repeatPenalty));
let stop = $state<string[]>([...(initial.stop ?? [])]);

function build(): ModelInferenceDefaults {
  const built: ModelInferenceDefaults = {};
  const temperatureValue = toNumber(temperature);
  if (temperatureValue !== undefined) built.temperature = temperatureValue;
  const topPValue = toNumber(topP);
  if (topPValue !== undefined) built.topP = topPValue;
  const topKValue = toNumber(topK);
  if (topKValue !== undefined) built.topK = topKValue;
  const numCtxValue = toNumber(numCtx);
  if (numCtxValue !== undefined) built.numCtx = numCtxValue;
  const numPredictValue = toNumber(numPredict);
  if (numPredictValue !== undefined) built.numPredict = numPredictValue;
  const seedValue = toNumber(seed);
  if (seedValue !== undefined) built.seed = seedValue;
  const repeatPenaltyValue = toNumber(repeatPenalty);
  if (repeatPenaltyValue !== undefined) built.repeatPenalty = repeatPenaltyValue;
  if (stop.length > 0) built.stop = [...stop];
  return built;
}

$effect(() => {
  value = build();
});

function setTemperature(raw: string) {
  temperature = raw;
}

function setTopP(raw: string) {
  topP = raw;
}

function setTopK(raw: string) {
  topK = raw;
}

function setNumCtx(raw: string) {
  numCtx = raw;
}

function setNumPredict(raw: string) {
  numPredict = raw;
}

function setSeed(raw: string) {
  seed = raw;
}

function setRepeatPenalty(raw: string) {
  repeatPenalty = raw;
}
</script>

<div class="space-y-3">
  <div class="grid gap-3 sm:grid-cols-3">
    <Input label="Temperature" type="number" step="0.1" min="0" value={temperature} {disabled} oninput={(event) => setTemperature(event.currentTarget.value)} />
    <Input label="Top P" type="number" step="0.05" min="0" max="1" value={topP} {disabled} oninput={(event) => setTopP(event.currentTarget.value)} />
    <Input label="Top K" type="number" step="1" min="0" value={topK} {disabled} oninput={(event) => setTopK(event.currentTarget.value)} />
    <Input label="Context (num_ctx)" type="number" step="1" min="1" value={numCtx} {disabled} oninput={(event) => setNumCtx(event.currentTarget.value)} />
    <Input label="Max output (num_predict)" type="number" step="1" min="1" value={numPredict} {disabled} oninput={(event) => setNumPredict(event.currentTarget.value)} />
    <Input label="Seed" type="number" step="1" value={seed} {disabled} oninput={(event) => setSeed(event.currentTarget.value)} />
    <Input label="Repeat penalty" type="number" step="0.05" min="0" value={repeatPenalty} {disabled} oninput={(event) => setRepeatPenalty(event.currentTarget.value)} />
  </div>

  <TagsInput
    bind:values={stop}
    label="Stop sequences"
    hint="Commit with Enter or comma; a stop sequence ends generation when it appears."
    placeholder="e.g. </s>"
    emptyLabel="None."
    {disabled}
  />
</div>
