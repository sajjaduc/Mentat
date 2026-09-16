/**
 * OpenAI-compatible provider (`/v1/models`, `/v1/chat/completions`).
 *
 * This covers OpenAI itself plus the many servers that speak the same protocol
 * (vLLM, LM Studio, OpenRouter, llama.cpp's server). Capabilities are *not*
 * guessed from the model name: the caller supplies them per model row (or via
 * `capabilitiesFor`), because an OpenAI-compatible endpoint may host anything.
 */
import {
  openProviderStream,
  providerFetchJson,
  providerHttpStatus,
  readLineStream,
  sanitizeProviderMessage,
  truncateSnippet
} from './http';
import {
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
  type ModelDescriptor,
  type ModelProvider,
  normalizeToolCalls,
  type ProviderHealth,
  type ProviderModelCapabilities,
  type ProviderStreamEvent
} from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/** Conservative defaults; a model row or `capabilitiesFor` corrects them. */
const DEFAULT_CAPABILITIES: ProviderModelCapabilities = {
  streaming: true,
  toolCalling: false,
  jsonMode: true,
  vision: false,
  embeddings: false,
  reasoning: false
};

export interface OpenAiCompatibleProviderOptions {
  baseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  /** Distinguishes OpenAI from a generic compatible endpoint in the registry. */
  type?: 'openai' | 'openai_compatible';
  name?: string;
  organization?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  capabilitiesFor?: (modelKey: string) => Partial<ProviderModelCapabilities>;
  /**
   * Request `stream_options.include_usage` while streaming. OpenAI supports it;
   * some compatible servers reject unknown fields, so it can be disabled.
   */
  includeUsageInStream?: boolean;
}

interface OpenAiModelEntry {
  id?: unknown;
  owned_by?: unknown;
  created?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function usageFromOpenAi(
  usage: unknown
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : undefined;
  const outputTokens =
    typeof record.completion_tokens === 'number' ? record.completion_tokens : undefined;
  const totalTokens = typeof record.total_tokens === 'number' ? record.total_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)
  };
}

export function mapOpenAiFinishReason(
  reason: unknown,
  hasToolCalls: boolean
): GenerateResult['finishReason'] {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  if (hasToolCalls) return 'tool_calls';
  return 'stop';
}

function toImageUrl(image: string): string {
  return image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
}

/** Map one Mentat message to OpenAI's chat message shape. */
export function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content
    };
  }

  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === 'user' && message.images && message.images.length > 0) {
    out.content = [
      { type: 'text', text: message.content },
      ...message.images.map((image) => ({
        type: 'image_url',
        image_url: { url: toImageUrl(image) }
      }))
    ];
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    out.content = message.content.length > 0 ? message.content : null;
    out.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }));
  }
  return out;
}

interface ToolAccumulatorEntry {
  id?: string;
  name: string;
  args: string;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly type: 'openai' | 'openai_compatible';
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly queryParams: Record<string, string>;
  private readonly capabilitiesFor:
    | ((modelKey: string) => Partial<ProviderModelCapabilities>)
    | undefined;
  private readonly includeUsageInStream: boolean;

  constructor(options: OpenAiCompatibleProviderOptions = {}) {
    this.type = options.type ?? 'openai_compatible';
    this.name = options.name ?? (this.type === 'openai' ? 'OpenAI' : 'OpenAI-compatible');
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.healthTimeoutMs =
      options.healthTimeoutMs ?? Math.min(this.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
    this.headers = {
      ...(options.organization ? { 'openai-organization': options.organization } : {}),
      ...(options.headers ?? {})
    };
    this.queryParams = options.queryParams ?? {};
    this.capabilitiesFor = options.capabilitiesFor;
    this.includeUsageInStream = options.includeUsageInStream ?? true;
  }

  private url(path: string): string {
    const search = new URLSearchParams(this.queryParams).toString();
    return `${this.baseUrl}${path}${search.length > 0 ? `?${search}` : ''}`;
  }

  private requestOptions(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
    return {
      apiKey: this.apiKey,
      headers: this.headers,
      signal,
      timeoutMs: timeoutMs ?? this.timeoutMs
    };
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const payload = await providerFetchJson<{ data?: unknown }>(this.url('/v1/models'), {
        apiKey: this.apiKey,
        headers: this.headers,
        timeoutMs: this.healthTimeoutMs
      });
      return {
        status: 'healthy',
        latencyMs: Date.now() - started,
        modelCount: Array.isArray(payload.data) ? payload.data.length : 0
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const status = providerHttpStatus(error);
      if (status !== undefined) {
        return {
          status: 'degraded',
          latencyMs,
          message: sanitizeProviderMessage(
            error instanceof Error ? error.message : `HTTP ${status}`
          )
        };
      }
      return {
        status: 'unreachable',
        latencyMs,
        message: sanitizeProviderMessage(
          error instanceof Error ? error.message : 'Provider is unreachable'
        )
      };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const payload = await providerFetchJson<{ data?: unknown }>(this.url('/v1/models'), {
      apiKey: this.apiKey,
      headers: this.headers,
      timeoutMs: this.timeoutMs
    });
    const entries = Array.isArray(payload.data) ? (payload.data as OpenAiModelEntry[]) : [];
    const descriptors: ModelDescriptor[] = [];
    for (const entry of entries) {
      const key = readString(entry.id);
      if (!key) continue;
      descriptors.push({
        key,
        displayName: key,
        capabilities: { ...DEFAULT_CAPABILITIES, ...(this.capabilitiesFor?.(key) ?? {}) },
        raw: entry as Record<string, unknown>
      });
    }
    return descriptors;
  }

  private buildChatBody(request: GenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAiMessage),
      stream
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
    }
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'mentat_response', schema: request.jsonSchema }
      };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.seed !== undefined) body.seed = request.seed;
    if (stream && this.includeUsageInStream) body.stream_options = { include_usage: true };
    return body;
  }

  private parseCompletion(
    response: Record<string, unknown>,
    request: GenerateRequest
  ): GenerateResult {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message =
      choice.message && typeof choice.message === 'object'
        ? (choice.message as Record<string, unknown>)
        : {};
    const { toolCalls, parseErrors } = normalizeToolCalls(message.tool_calls);
    const usage = usageFromOpenAi(response.usage);
    return {
      content: readString(message.content) ?? '',
      toolCalls,
      finishReason: mapOpenAiFinishReason(choice.finish_reason, toolCalls.length > 0),
      ...(usage !== undefined ? { usage } : {}),
      model: readString(response.model) ?? request.model,
      raw: parseErrors.length > 0 ? { ...response, toolCallParseErrors: parseErrors } : response
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await providerFetchJson<Record<string, unknown>>(
      this.url('/v1/chat/completions'),
      {
        method: 'POST',
        body: this.buildChatBody(request, false),
        ...this.requestOptions(request.signal, request.timeoutMs)
      }
    );
    return this.parseCompletion(response, request);
  }

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderStreamEvent> {
    const handle = await openProviderStream(this.url('/v1/chat/completions'), {
      method: 'POST',
      body: this.buildChatBody(request, true),
      ...this.requestOptions(request.signal, request.timeoutMs)
    });

    const toolAccumulator = new Map<number, ToolAccumulatorEntry>();
    let started = false;
    let finishReason: GenerateResult['finishReason'] = 'stop';
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    try {
      for await (const line of readLineStream(handle.response)) {
        if (request.signal?.aborted) return;
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') break;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          yield {
            type: 'error',
            message: `Malformed SSE chunk: ${truncateSnippet(sanitizeProviderMessage(payload))}`
          };
          return;
        }

        if (!started) {
          started = true;
          yield { type: 'start', model: readString(parsed.model) ?? request.model };
        }

        const streamUsage = usageFromOpenAi(parsed.usage);
        if (streamUsage) usage = streamUsage;

        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        const delta =
          choice.delta && typeof choice.delta === 'object'
            ? (choice.delta as Record<string, unknown>)
            : {};

        const reasoning = readString(delta.reasoning_content) ?? readString(delta.reasoning);
        if (reasoning) yield { type: 'reasoning', content: reasoning };
        if (readString(delta.content)) yield { type: 'delta', content: readString(delta.content)! };

        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const call = rawCall as Record<string, unknown>;
            const index = typeof call.index === 'number' ? call.index : 0;
            const entry = toolAccumulator.get(index) ?? { name: '', args: '' };
            if (readString(call.id)) entry.id = readString(call.id);
            const fn =
              call.function && typeof call.function === 'object'
                ? (call.function as Record<string, unknown>)
                : {};
            if (readString(fn.name)) entry.name += readString(fn.name)!;
            if (typeof fn.arguments === 'string') entry.args += fn.arguments;
            toolAccumulator.set(index, entry);
          }
        }

        if (readString(choice.finish_reason)) {
          finishReason = mapOpenAiFinishReason(choice.finish_reason, toolAccumulator.size > 0);
        }
      }
    } catch (error) {
      if (request.signal?.aborted || handle.abortedByCaller()) return;
      yield {
        type: 'error',
        message: sanitizeProviderMessage(
          error instanceof Error ? error.message : 'Provider stream failed'
        )
      };
      return;
    } finally {
      handle.cleanup();
    }

    if (!started) {
      started = true;
      yield { type: 'start', model: request.model };
    }
    if (toolAccumulator.size > 0) {
      const raw = [...toolAccumulator.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => ({
          ...(entry.id ? { id: entry.id } : {}),
          function: { name: entry.name, arguments: entry.args.length > 0 ? entry.args : '{}' }
        }));
      const { toolCalls } = normalizeToolCalls(raw);
      if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  }
}
