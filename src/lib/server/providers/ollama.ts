/**
 * Ollama provider (required in V1).
 *
 * Ollama is the reference implementation of ADR-0015's provider interface. Its
 * wire format is deliberately close to OpenAI's chat-completions shape, but the
 * details that matter — `/api/chat`, `options` instead of top-level sampling
 * fields, `prompt_eval_count`/`eval_count`, NDJSON streaming and a `thinking`
 * channel — are isolated here so no Ollama-specific type leaks into the runner.
 */
import { detectModelCapabilities } from './capabilities';
import {
  openProviderStream,
  providerFetchJson,
  readLineStream,
  sanitizeProviderMessage,
  truncateSnippet
} from './http';
import { applyReasoning } from './reasoning';
import {
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
  type ModelDescriptor,
  type ModelProvider,
  normalizeToolCalls,
  type ProviderHealth,
  type ProviderStreamEvent
} from './types';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_DEGRADED_THRESHOLD_MS = 2_000;

interface OllamaTagModel {
  name?: unknown;
  model?: unknown;
  size?: unknown;
  digest?: unknown;
  modified_at?: unknown;
  details?: unknown;
}

interface OllamaChatResponse {
  model?: unknown;
  message?: unknown;
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  /** Resolved API key. Attached as `Authorization: Bearer`; never logged. */
  apiKey?: string | null;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  keepAlive?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  /** Latency above which a reachable server is reported `degraded`. */
  degradedThresholdMs?: number;
  name?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function usageFromCounts(
  input: unknown,
  output: unknown
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const inputTokens = typeof input === 'number' ? input : undefined;
  const outputTokens = typeof output === 'number' ? output : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0)
  };
}

/**
 * Ollama reports `done_reason` but often closes a tool-calling turn with
 * `stop`; presence of tool calls is the more reliable signal.
 */
export function mapOllamaFinishReason(
  doneReason: unknown,
  toolCallCount: number
): GenerateResult['finishReason'] {
  if (toolCallCount > 0) return 'tool_calls';
  if (doneReason === 'length') return 'length';
  if (doneReason === 'tool_calls') return 'tool_calls';
  return 'stop';
}

/** Map one Mentat chat message to Ollama's chat message shape. */
export function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      ...(readString(message.name) ? { tool_name: message.name } : {})
    };
  }
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === 'user' && message.images && message.images.length > 0) {
    out.images = message.images;
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((call) => ({
      function: { name: call.name, arguments: call.arguments }
    }));
  }
  return out;
}

/** Map top-level Mentat generation fields onto Ollama's `options` object. */
export function buildOllamaOptions(request: GenerateRequest): Record<string, unknown> {
  const options: Record<string, unknown> = { ...(request.options ?? {}) };
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (request.topP !== undefined) options.top_p = request.topP;
  if (request.topK !== undefined) options.top_k = request.topK;
  if (request.maxOutputTokens !== undefined) options.num_predict = request.maxOutputTokens;
  if (request.stop !== undefined) options.stop = request.stop;
  if (request.seed !== undefined) options.seed = request.seed;
  return options;
}

export class OllamaProvider implements ModelProvider {
  readonly type = 'ollama';
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly keepAlive: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly queryParams: Record<string, string>;
  private readonly degradedThresholdMs: number;

  constructor(options: OllamaProviderOptions = {}) {
    this.name = options.name ?? 'Ollama';
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.healthTimeoutMs =
      options.healthTimeoutMs ?? Math.min(this.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
    this.keepAlive = options.keepAlive;
    this.headers = options.headers ?? {};
    this.queryParams = options.queryParams ?? {};
    this.degradedThresholdMs = options.degradedThresholdMs ?? DEFAULT_DEGRADED_THRESHOLD_MS;
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

  /**
   * Probe connectivity without ever throwing.
   *
   * Version failing means `unreachable`; version succeeding but tags failing (or
   * a latency above the threshold) means `degraded`, because the server can serve
   * chat but discovery is unhealthy.
   */
  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    let version: string | undefined;
    try {
      const payload = await providerFetchJson<{ version?: unknown }>(this.url('/api/version'), {
        apiKey: this.apiKey,
        headers: this.headers,
        timeoutMs: this.healthTimeoutMs
      });
      version = readString(payload.version);
    } catch (error) {
      return {
        status: 'unreachable',
        latencyMs: Date.now() - started,
        message: sanitizeProviderMessage(
          error instanceof Error ? error.message : 'Ollama is unreachable'
        )
      };
    }

    let modelCount: number | undefined;
    let tagsFailure: string | undefined;
    try {
      const payload = await providerFetchJson<{ models?: unknown }>(this.url('/api/tags'), {
        apiKey: this.apiKey,
        headers: this.headers,
        timeoutMs: this.healthTimeoutMs
      });
      modelCount = Array.isArray(payload.models) ? payload.models.length : 0;
    } catch (error) {
      tagsFailure = sanitizeProviderMessage(
        error instanceof Error ? error.message : 'model listing failed'
      );
    }

    const latencyMs = Date.now() - started;
    if (tagsFailure) {
      return {
        status: 'degraded',
        latencyMs,
        message: `Reachable but model listing failed: ${tagsFailure}`,
        ...(version !== undefined ? { version } : {})
      };
    }
    if (latencyMs > this.degradedThresholdMs) {
      return {
        status: 'degraded',
        latencyMs,
        message: `Ollama responded slowly (${latencyMs}ms)`,
        ...(version !== undefined ? { version } : {}),
        ...(modelCount !== undefined ? { modelCount } : {})
      };
    }
    return {
      status: 'healthy',
      latencyMs,
      ...(version !== undefined ? { version } : {}),
      ...(modelCount !== undefined ? { modelCount } : {})
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const payload = await providerFetchJson<{ models?: unknown }>(this.url('/api/tags'), {
      apiKey: this.apiKey,
      headers: this.headers,
      timeoutMs: this.timeoutMs
    });
    const entries = Array.isArray(payload.models) ? (payload.models as OllamaTagModel[]) : [];
    const descriptors: ModelDescriptor[] = [];
    for (const entry of entries) {
      const descriptor = this.toDescriptor(entry);
      if (descriptor) descriptors.push(descriptor);
    }
    return descriptors;
  }

  private toDescriptor(entry: OllamaTagModel): ModelDescriptor | null {
    const key = readString(entry.name) ?? readString(entry.model);
    if (!key) return null;
    const details =
      entry.details && typeof entry.details === 'object'
        ? (entry.details as Record<string, unknown>)
        : {};
    const family = readString(details.family);
    const families = Array.isArray(details.families)
      ? details.families.filter((value): value is string => typeof value === 'string')
      : undefined;
    return {
      key,
      displayName: key,
      ...(family !== undefined ? { family } : {}),
      ...(readString(details.parameter_size) !== undefined
        ? { parameterSize: readString(details.parameter_size) }
        : {}),
      ...(readString(details.quantization_level) !== undefined
        ? { quantization: readString(details.quantization_level) }
        : {}),
      capabilities: detectModelCapabilities({ key, family, families }),
      raw: entry as Record<string, unknown>
    };
  }

  private buildChatBody(request: GenerateRequest, stream: boolean): Record<string, unknown> {
    // Reasoning and its native overrides are applied first so the structural fields
    // below can never be clobbered by an override.
    const body: Record<string, unknown> = {};
    applyReasoning(body, 'ollama', {
      effort: request.reasoningEffort,
      options: request.reasoningOptions
    });
    body.model = request.model;
    body.messages = request.messages.map(toOllamaMessage);
    body.stream = stream;
    const options = buildOllamaOptions(request);
    if (Object.keys(options).length > 0) body.options = options;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
    }
    if (request.jsonSchema) body.format = request.jsonSchema;
    if (this.keepAlive) body.keep_alive = this.keepAlive;
    return body;
  }

  private parseChatResponse(
    response: OllamaChatResponse,
    request: GenerateRequest
  ): GenerateResult {
    const message =
      response.message && typeof response.message === 'object'
        ? (response.message as Record<string, unknown>)
        : {};
    const { toolCalls, parseErrors } = normalizeToolCalls(message.tool_calls);
    const usage = usageFromCounts(response.prompt_eval_count, response.eval_count);
    return {
      content: readString(message.content) ?? '',
      toolCalls,
      finishReason: mapOllamaFinishReason(response.done_reason, toolCalls.length),
      ...(usage !== undefined ? { usage } : {}),
      model: readString(response.model) ?? request.model,
      raw: parseErrors.length > 0 ? { ...response, toolCallParseErrors: parseErrors } : response
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await providerFetchJson<OllamaChatResponse>(this.url('/api/chat'), {
      method: 'POST',
      body: this.buildChatBody(request, false),
      ...this.requestOptions(request.signal, request.timeoutMs)
    });
    return this.parseChatResponse(response, request);
  }

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderStreamEvent> {
    const handle = await openProviderStream(this.url('/api/chat'), {
      method: 'POST',
      body: this.buildChatBody(request, true),
      ...this.requestOptions(request.signal, request.timeoutMs)
    });

    let started = false;
    let sawDone = false;
    let finishReason: GenerateResult['finishReason'] = 'stop';
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    const rawToolCalls: unknown[] = [];

    try {
      for await (const line of readLineStream(handle.response)) {
        if (request.signal?.aborted) return;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          yield {
            type: 'error',
            message: `Malformed stream chunk from Ollama: ${truncateSnippet(
              sanitizeProviderMessage(trimmed)
            )}`
          };
          return;
        }

        if (!started) {
          started = true;
          yield { type: 'start', model: readString(parsed.model) ?? request.model };
        }

        if (readString(parsed.error)) {
          yield { type: 'error', message: sanitizeProviderMessage(readString(parsed.error)!) };
          return;
        }

        const message =
          parsed.message && typeof parsed.message === 'object'
            ? (parsed.message as Record<string, unknown>)
            : {};
        if (readString(message.thinking)) {
          yield { type: 'reasoning', content: readString(message.thinking)! };
        }
        if (readString(message.content)) {
          yield { type: 'delta', content: readString(message.content)! };
        }
        if (Array.isArray(message.tool_calls)) rawToolCalls.push(...message.tool_calls);

        if (parsed.done === true) {
          sawDone = true;
          finishReason = mapOllamaFinishReason(parsed.done_reason, rawToolCalls.length);
          usage = usageFromCounts(parsed.prompt_eval_count, parsed.eval_count);
        }
      }
    } catch (error) {
      // A caller abort is a clean stop; anything else is a broken stream the
      // consumer should see as an error event rather than an exception.
      if (request.signal?.aborted || handle.abortedByCaller()) return;
      yield {
        type: 'error',
        message: sanitizeProviderMessage(
          error instanceof Error ? error.message : 'Ollama stream failed'
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
    // Ollama always terminates a stream with a `done` chunk; if the connection
    // dropped first, the response is truncated and must not look like success.
    if (!sawDone) {
      yield { type: 'error', message: 'Ollama stream ended before the done chunk arrived' };
      return;
    }
    if (rawToolCalls.length > 0) {
      const { toolCalls } = normalizeToolCalls(rawToolCalls);
      if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  }
}
