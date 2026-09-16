/**
 * Reasoning-effort vocabulary and provider mappings.
 *
 * Thinking models expose very different knobs: Ollama takes a top-level `think`
 * (boolean or level), OpenAI-compatible endpoints a `reasoning_effort`, and
 * Anthropic an `output_config.effort` plus a `thinking` toggle. Mentat stores one
 * portable level and each provider translates it, so an agent's configuration
 * survives a model change.
 *
 * Which levels a model accepts is a model *capability* (`reasoningEfforts`), not a
 * guess made at request time: discovery seeds it from the table below and an
 * operator can correct it in the model editor. A level the model does not declare
 * is never sent — the runner drops it and records a warning instead.
 *
 * A provider-native escape hatch (`reasoningOptions`) covers knobs the levels
 * cannot express, e.g. an explicit Anthropic thinking budget.
 */
import {
  isReasoningEffort,
  normalizeReasoningEfforts,
  REASONING_EFFORTS,
  type ReasoningEffort
} from '../../shared/reasoning';
import type { ProviderModelCapabilities } from './types';

export { isReasoningEffort, normalizeReasoningEfforts, REASONING_EFFORTS, type ReasoningEffort };

/**
 * Levels a provider's models typically accept when a model declares reasoning but
 * not an explicit effort set. `off` is a real value everywhere it is listed; a
 * model that cannot disable thinking (e.g. Ollama's GPT-OSS) declares a narrower
 * set during detection instead.
 */
export const PROVIDER_REASONING_EFFORTS: Record<string, ReasoningEffort[]> = {
  ollama: ['off', 'low', 'medium', 'high', 'max'],
  openai: ['off', 'minimal', 'low', 'medium', 'high', 'max'],
  openai_compatible: ['off', 'minimal', 'low', 'medium', 'high', 'max'],
  anthropic: ['off', 'low', 'medium', 'high', 'max'],
  fake: ['off', 'minimal', 'low', 'medium', 'high', 'max']
};

const OLLAMA_REASONING_PATTERNS: RegExp[] = [
  /deepseek-r1/,
  /qwen3/,
  /qwq/,
  /magistral/,
  /reasoning/,
  /phi4-reasoning/,
  /gpt-oss/
];

const OPENAI_REASONING_PATTERNS: RegExp[] = [
  /^o[1-4]/,
  /gpt-5/,
  /gpt-oss/,
  /deepseek-r1/,
  /qwen3/,
  /qwq/,
  /magistral/,
  /reasoning/
];

const ANTHROPIC_REASONING_PATTERNS: RegExp[] = [
  /claude-3[-.]7/,
  /claude-(opus|sonnet|haiku)-4/,
  /claude-(opus|sonnet|haiku)-[5-9]/,
  /claude-(fable|mythos)/
];

const GPT_OSS_PATTERN = /gpt-oss/;

export interface ReasoningModelHints {
  providerType: string;
  /** Provider-native model tag, e.g. `qwen3:8b` or `claude-sonnet-4-6`. */
  key: string;
  family?: string;
  families?: string[];
}

function hintsToText(hints: ReasoningModelHints): string {
  return [hints.key, hints.family, ...(hints.families ?? [])]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
}

function patternsFor(providerType: string): RegExp[] | null {
  if (providerType === 'ollama') return OLLAMA_REASONING_PATTERNS;
  if (providerType === 'anthropic') return ANTHROPIC_REASONING_PATTERNS;
  // A generic OpenAI-compatible endpoint may host anything, so it is deliberately
  // not guessed from the name; only the real OpenAI API has a known taxonomy.
  if (providerType === 'openai') return OPENAI_REASONING_PATTERNS;
  return null;
}

/**
 * Best-effort reasoning capabilities for a discovered model.
 *
 * Conservative in the same way as the other capability heuristics: a model is only
 * offered reasoning controls when its family is known to support them. Unknown or
 * non-chat providers return `reasoning: false`, and an operator corrects the row in
 * the model editor when the guess is wrong.
 */
export function detectReasoningSupport(hints: ReasoningModelHints): {
  reasoning: boolean;
  reasoningEfforts?: ReasoningEffort[];
} {
  const patterns = patternsFor(hints.providerType);
  if (patterns === null) return { reasoning: false };
  const text = hintsToText(hints);
  if (!patterns.some((pattern) => pattern.test(text))) return { reasoning: false };
  if (hints.providerType === 'ollama' && GPT_OSS_PATTERN.test(text)) {
    // Ollama documents that GPT-OSS requires one of low/medium/high; the trace
    // cannot be fully disabled, so `off` is not offered.
    return { reasoning: true, reasoningEfforts: ['low', 'medium', 'high'] };
  }
  return {
    reasoning: true,
    reasoningEfforts: [...(PROVIDER_REASONING_EFFORTS[hints.providerType] ?? REASONING_EFFORTS)]
  };
}

/**
 * The levels a model with these capabilities accepts.
 *
 * An empty result means "reasoning controls are not available", which the UI uses
 * to hide the selector and the runner uses to drop any configured level.
 */
export function supportedReasoningEfforts(
  capabilities:
    | Pick<ProviderModelCapabilities, 'reasoning' | 'reasoningEfforts'>
    | null
    | undefined,
  providerType?: string
): ReasoningEffort[] {
  if (!capabilities?.reasoning) return [];
  const declared = normalizeReasoningEfforts(capabilities.reasoningEfforts);
  if (declared) return declared;
  if (providerType && PROVIDER_REASONING_EFFORTS[providerType]) {
    return [...PROVIDER_REASONING_EFFORTS[providerType]];
  }
  return [...REASONING_EFFORTS];
}

export interface ReasoningSetting {
  /** A portable level, when one is configured. */
  effort?: ReasoningEffort;
  /** Provider-native keys merged into the request after the level is mapped. */
  options?: Record<string, unknown>;
}

export interface ReasoningRequestSources {
  /** Supported levels for the resolved model; empty disables reasoning controls. */
  supported: ReasoningEffort[];
  /** Explicit per-call request; highest precedence. */
  request?: ReasoningSetting | null;
  /** Agent execution config. */
  agent?: ReasoningSetting | null;
  /** Model inference defaults; lowest precedence and the fallback. */
  model?: ReasoningSetting | null;
}

export interface ResolvedReasoning {
  effort?: ReasoningEffort;
  /** Merged provider-native overrides; agent keys win over model keys. */
  options: Record<string, unknown>;
  /** Present when a configured level was dropped because the model rejects it. */
  warning?: string;
}

/**
 * Pick the effective reasoning level and merge native overrides.
 *
 * Precedence follows the documented generation contract — request > agent > model
 * — but an unsupported value never reaches the provider: the next source that the
 * model *does* accept wins, and the dropped value is reported as a warning rather
 * than failing the run.
 */
export function resolveReasoning(sources: ReasoningRequestSources): ResolvedReasoning {
  const candidates: Array<{ label: string; effort: ReasoningEffort }> = [];
  const consider = (label: string, setting: ReasoningSetting | null | undefined): void => {
    if (setting && isReasoningEffort(setting.effort)) {
      candidates.push({ label, effort: setting.effort });
    }
  };
  consider('request', sources.request);
  consider('agent', sources.agent);
  consider('model', sources.model);

  const supported = new Set(sources.supported);
  const chosen = candidates.find((candidate) => supported.has(candidate.effort));
  const dropped = candidates.filter((candidate) => !supported.has(candidate.effort));

  const options: Record<string, unknown> = {
    ...(sources.model?.options ?? {}),
    ...(sources.agent?.options ?? {}),
    ...(sources.request?.options ?? {})
  };

  const resolved: ResolvedReasoning = { options };
  if (chosen) resolved.effort = chosen.effort;
  if (dropped.length > 0) {
    const labels = dropped
      .map((candidate) => `${candidate.label} "${candidate.effort}"`)
      .join(', ');
    resolved.warning =
      sources.supported.length === 0
        ? `Reasoning is not supported by this model, so ${labels} was ignored.`
        : `${labels} is not accepted by this model (supported: ${sources.supported.join(
            ', '
          )}); the setting was ignored.`;
  }
  return resolved;
}

/** Shape of the reasoning fields shared by an agent's execution config and model defaults. */
export interface ReasoningConfigFields {
  reasoningEffort?: ReasoningEffort;
  reasoningOptions?: Record<string, unknown>;
}

/** Extract a reasoning setting from config, or `null` when nothing is configured. */
export function reasoningSettingFrom(
  source: ReasoningConfigFields | null | undefined
): ReasoningSetting | null {
  if (!source) return null;
  const setting: ReasoningSetting = {};
  if (isReasoningEffort(source.reasoningEffort)) setting.effort = source.reasoningEffort;
  if (source.reasoningOptions && Object.keys(source.reasoningOptions).length > 0) {
    setting.options = source.reasoningOptions;
  }
  return setting.effort === undefined && setting.options === undefined ? null : setting;
}

/** Ollama's top-level `think`: `false` disables, levels tune the trace length. */
export function toOllamaThink(
  effort: ReasoningEffort
): boolean | 'low' | 'medium' | 'high' | 'max' {
  if (effort === 'off') return false;
  if (effort === 'minimal') return 'low';
  return effort;
}

/** OpenAI's `reasoning_effort`; `off` maps to `none`. */
export function toOpenAiReasoningEffort(effort: ReasoningEffort): string {
  return effort === 'off' ? 'none' : effort;
}

/** Anthropic's `output_config.effort`, with `off` disabling thinking instead. */
export function toAnthropicReasoning(effort: ReasoningEffort): Record<string, unknown> {
  if (effort === 'off') return { thinking: { type: 'disabled' } };
  const mapped = effort === 'minimal' ? 'low' : effort;
  return { output_config: { effort: mapped } };
}

/**
 * Merge a resolved reasoning setting into a provider request body.
 *
 * The level is translated first, then `options` are applied verbatim so a
 * provider-native override wins. Callers apply this *before* setting structural
 * fields (`model`, `messages`, `stream`, `tools`) so an override can never corrupt
 * the conversation.
 */
export function applyReasoning(
  body: Record<string, unknown>,
  providerType: string,
  setting: ReasoningSetting | null | undefined
): void {
  if (!setting) return;
  if (setting.effort) {
    if (providerType === 'ollama') body.think = toOllamaThink(setting.effort);
    else if (providerType === 'anthropic')
      Object.assign(body, toAnthropicReasoning(setting.effort));
    else body.reasoning_effort = toOpenAiReasoningEffort(setting.effort);
  }
  if (setting.options) Object.assign(body, setting.options);
}
