/**
 * Provider contract.
 *
 * `AgentRunner` and every other consumer depend on this interface, never on Ollama
 * directly (ADR-0015). A provider declares its capabilities explicitly so the
 * runner can refuse to send tools to a model that cannot call them instead of
 * silently degrading.
 */
import type { ReasoningEffort } from './reasoning';

export interface ModelDescriptor {
  /** Provider-native identifier, e.g. `llama3.1:8b`. */
  key: string;
  displayName: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  contextWindow?: number;
  capabilities: ProviderModelCapabilities;
  /** Raw provider payload, kept for diagnostics. */
  raw?: Record<string, unknown>;
}

export interface ProviderModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
  vision: boolean;
  embeddings: boolean;
  /** True when the model exposes controllable reasoning/thinking. */
  reasoning?: boolean;
  /**
   * Portable reasoning levels the model accepts. Absent means "derive from the
   * provider type" (see `supportedReasoningEfforts`); an empty array means none.
   */
  reasoningEfforts?: ReasoningEffort[];
}

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unreachable';
  latencyMs?: number;
  message?: string;
  version?: string;
  modelCount?: number;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolDefinitionForModel {
  /** Semantic name the model must call, e.g. `hubspot.get_contact`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Raw arguments string, preserved when a model emits invalid JSON. */
  rawArguments?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set on assistant messages that request tool invocations. */
  toolCalls?: ToolCallRequest[];
  /** Set on tool result messages. */
  toolCallId?: string;
  name?: string;
  images?: string[];
}

export interface GenerateRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinitionForModel[];
  /** Request a JSON-shaped response when the model supports it. */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stop?: string[];
  seed?: number;
  /** Portable reasoning level; unsupported levels are dropped before this point. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Provider-native reasoning keys merged into the request body after the level is
   * translated, so an override wins. Structural fields (`model`, `messages`,
   * `stream`, `tools`) are always set afterwards and cannot be overridden.
   */
  reasoningOptions?: Record<string, unknown>;
  /** Provider-specific options passed through verbatim (e.g. Ollama `num_ctx`). */
  options?: Record<string, unknown>;
  /** Abort a long-running generation when the run is cancelled. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GenerateResult {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error' | 'cancelled';
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  model: string;
  raw?: unknown;
}

export type ProviderStreamEvent =
  | { type: 'start'; model: string }
  /** Incremental text the UI can append directly. */
  | { type: 'delta'; content: string }
  /** Incremental reasoning/thinking text, rendered differently from content. */
  | { type: 'reasoning'; content: string }
  /** Tool calls are emitted complete once the provider closes the message. */
  | { type: 'tool_calls'; toolCalls: ToolCallRequest[] }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { type: 'done'; finishReason: GenerateResult['finishReason'] }
  | { type: 'error'; message: string; code?: string };

export interface ModelProvider {
  readonly type: string;
  readonly name: string;

  health(): Promise<ProviderHealth>;
  listModels(): Promise<ModelDescriptor[]>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<ProviderStreamEvent>;
}

export class ProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable';
  constructor(
    message: string,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class ProviderCapabilityError extends Error {
  readonly code = 'provider_capability';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderCapabilityError';
  }
}

/**
 * Normalize an OpenAI-style `tool_calls` payload (Ollama's format matches it)
 * into Mentat's shape, tolerating models that emit malformed JSON arguments.
 */
export function normalizeToolCalls(raw: unknown): {
  toolCalls: ToolCallRequest[];
  parseErrors: string[];
} {
  const toolCalls: ToolCallRequest[] = [];
  const parseErrors: string[] = [];
  if (!Array.isArray(raw)) return { toolCalls, parseErrors };

  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const fn = (record.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name : undefined;
    if (!name) continue;
    const id =
      typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : `call_${index}_${Date.now()}`;

    const rawArguments =
      typeof fn.arguments === 'string'
        ? fn.arguments
        : fn.arguments && typeof fn.arguments === 'object'
          ? JSON.stringify(fn.arguments)
          : '{}';

    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        parseErrors.push(`${name}: arguments must be a JSON object`);
      }
    } catch (error) {
      parseErrors.push(`${name}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }

    toolCalls.push({ id, name, arguments: args, rawArguments });
  }

  return { toolCalls, parseErrors };
}
