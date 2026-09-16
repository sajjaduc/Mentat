/**
 * Ollama capability heuristics.
 *
 * Ollama's `/api/tags` payload does not declare whether a model can call tools,
 * see images or be forced into JSON mode — only the model name and family reveal
 * it. Keeping that judgement in one pure, table-driven function means a new
 * model family is a one-line correction with one regression test, instead of a
 * guess scattered across the provider.
 *
 * The rules are intentionally conservative: a model is only offered a capability
 * when the family is known to support it, because the runner relies on
 * capabilities to refuse a tool call rather than silently degrade (ADR-0015).
 */
import type { ProviderModelCapabilities } from './types';

export interface CapabilityHints {
  /** Provider-native model tag, e.g. `llama3.1:8b`. */
  key: string;
  /** `details.family` from `/api/tags`, when present. */
  family?: string;
  /** `details.families` from `/api/tags`, when present. */
  families?: string[];
}

/** Families known to implement the tool-calling chat template. */
const TOOL_CALLING_PATTERNS: RegExp[] = [
  /llama3\.[123]/,
  /qwen2\.5/,
  /qwen3/,
  /mistral-nemo/,
  /firefunction/,
  /command-r/
];

/** Architectures with an image encoder wired into the chat template. */
const VISION_PATTERNS: RegExp[] = [
  /llava/,
  /llama3\.2-vision/,
  /qwen2\.5-?vl/,
  /qwen3-vl/,
  /minicpm-v/,
  /moondream/,
  /bakllava/,
  /gemma3/
];

/** Models that expose a separate thinking/reasoning channel. */
const REASONING_PATTERNS: RegExp[] = [
  /deepseek-r1/,
  /qwen3/,
  /qwq/,
  /magistral/,
  /reasoning/,
  /phi4-reasoning/
];

/** Embedding models have no chat surface at all. */
const EMBEDDING_PATTERNS: RegExp[] = [/embed/, /bge-/, /all-minilm/, /^e5-/, /-e5-/];

/** Base/completion checkpoints do not honour an instruct JSON format. */
const BASE_COMPLETION_PATTERNS: RegExp[] = [/-base\b/, /:base\b/, /-completion\b/];

function hintsToText(hints: CapabilityHints): string {
  return [hints.key, hints.family, ...(hints.families ?? [])]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
}

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** True when the model is an embedding model rather than a chat model. */
export function isEmbeddingModel(hints: CapabilityHints | string): boolean {
  const text = typeof hints === 'string' ? hints.toLowerCase() : hintsToText(hints);
  return matches(EMBEDDING_PATTERNS, text);
}

/** True when the model accepts images. */
export function isVisionModel(hints: CapabilityHints | string): boolean {
  const text = typeof hints === 'string' ? hints.toLowerCase() : hintsToText(hints);
  return matches(VISION_PATTERNS, text);
}

/**
 * Detect capabilities for one Ollama model tag.
 *
 * Embedding models short-circuit: they cannot stream or generate, so every
 * generative capability is false. For everything else, streaming and JSON mode
 * are the baseline and tool/vision/reasoning require a known family.
 */
export function detectModelCapabilities(
  hints: CapabilityHints | string
): ProviderModelCapabilities {
  const text = typeof hints === 'string' ? hints.toLowerCase() : hintsToText(hints);

  if (matches(EMBEDDING_PATTERNS, text)) {
    return {
      streaming: false,
      toolCalling: false,
      jsonMode: false,
      vision: false,
      embeddings: true,
      reasoning: false
    };
  }

  return {
    streaming: true,
    toolCalling: matches(TOOL_CALLING_PATTERNS, text),
    jsonMode: !matches(BASE_COMPLETION_PATTERNS, text),
    vision: matches(VISION_PATTERNS, text),
    embeddings: false,
    reasoning: matches(REASONING_PATTERNS, text)
  };
}
