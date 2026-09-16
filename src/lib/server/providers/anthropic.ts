/**
 * Anthropic provider (`/v1/messages`).
 *
 * Anthropic's protocol differs from OpenAI in ways the runner must respect:
 * the system prompt is a top-level field, tool results are `tool_result` blocks
 * inside a user message, and extended-thinking output arrives as `thinking`
 * blocks that must never be folded back into assistant-visible content.
 */
import {
  openProviderStream,
  providerFetchJson,
  providerHttpStatus,
  readLineStream,
  sanitizeProviderMessage,
  truncateSnippet
} from './http';
import { applyReasoning, detectReasoningSupport } from './reasoning';
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

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/** Claude models call tools; JSON mode and vision are opt-in per model row. */
const DEFAULT_CAPABILITIES: ProviderModelCapabilities = {
  streaming: true,
  toolCalling: true,
  jsonMode: false,
  vision: false,
  embeddings: false,
  reasoning: false
};

export interface AnthropicProviderOptions {
  baseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  name?: string;
  /** `anthropic-version` header; defaults to a recent stable version. */
  version?: string;
  headers?: Record<string, string>;
  capabilitiesFor?: (modelKey: string) => Partial<ProviderModelCapabilities>;
  /** Fallback `max_tokens`; Anthropic requires the field on every request. */
  maxTokens?: number;
}

interface AnthropicModelEntry {
  id?: unknown;
  display_name?: unknown;
}

interface AnthropicContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function usageFromAnthropic(
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

export function mapAnthropicFinishReason(
  reason: unknown,
  hasToolCalls: boolean
): GenerateResult['finishReason'] {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (hasToolCalls) return 'tool_calls';
  return 'stop';
}

function toAnthropicImageBlock(image: string): Record<string, unknown> {
  const match = /^data:([^;]+);base64,(.*)$/.exec(image);
  if (match) {
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  }
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } };
}

function messageToBlocks(message: ChatMessage): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
  if (message.images) {
    for (const image of message.images) blocks.push(toAnthropicImageBlock(image));
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
  }
  return blocks;
}

/**
 * Convert Mentat messages into Anthropic's `messages` array, hoisting the system
 * prompt out and grouping consecutive tool results into one user turn (Anthropic
 * requires `tool_result` blocks to be carried by a user message).
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const converted: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.length > 0) systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content
      };
      const previous = converted[converted.length - 1];
      const isToolResultTurn =
        previous?.role === 'user' &&
        Array.isArray(previous.content) &&
        (previous.content as Array<Record<string, unknown>>).every(
          (entry) => entry.type === 'tool_result'
        );
      if (isToolResultTurn) {
        (previous!.content as unknown[]).push(block);
      } else {
        converted.push({ role: 'user', content: [block] });
      }
      continue;
    }
    converted.push({ role: message.role, content: messageToBlocks(message) });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: converted
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly type = 'anthropic';
  readonly name: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly capabilitiesFor:
    | ((modelKey: string) => Partial<ProviderModelCapabilities>)
    | undefined;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.name = options.name ?? 'Anthropic';
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.healthTimeoutMs =
      options.healthTimeoutMs ?? Math.min(this.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
    this.headers = {
      'anthropic-version': options.version ?? DEFAULT_ANTHROPIC_VERSION,
      ...(options.headers ?? {})
    };
    this.capabilitiesFor = options.capabilitiesFor;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Anthropic authenticates with `x-api-key`, not a bearer token. */
  private requestOptions(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
    return {
      apiKey: this.apiKey,
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: '',
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
        apiKeyHeader: 'x-api-key',
        apiKeyPrefix: '',
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
          error instanceof Error ? error.message : 'Anthropic is unreachable'
        )
      };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const payload = await providerFetchJson<{ data?: unknown }>(this.url('/v1/models'), {
      apiKey: this.apiKey,
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: '',
      headers: this.headers,
      timeoutMs: this.timeoutMs
    });
    const entries = Array.isArray(payload.data) ? (payload.data as AnthropicModelEntry[]) : [];
    const descriptors: ModelDescriptor[] = [];
    for (const entry of entries) {
      const key = readString(entry.id);
      if (!key) continue;
      const detected = detectReasoningSupport({ providerType: 'anthropic', key });
      descriptors.push({
        key,
        displayName: readString(entry.display_name) ?? key,
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          reasoning: detected.reasoning,
          ...(detected.reasoningEfforts ? { reasoningEfforts: detected.reasoningEfforts } : {}),
          ...(this.capabilitiesFor?.(key) ?? {})
        },
        raw: entry as Record<string, unknown>
      });
    }
    return descriptors;
  }

  private buildMessageBody(request: GenerateRequest): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(request.messages);
    let systemPrompt = system;
    if (request.jsonSchema) {
      // Anthropic has no native JSON mode; the closest honest fallback is an
      // explicit instruction. Model rows that cannot follow it should declare
      // `jsonMode: false` so the runner does not request it.
      const instruction = `Respond with a single valid JSON object matching this schema: ${JSON.stringify(
        request.jsonSchema
      )}`;
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction;
    }

    const body: Record<string, unknown> = {};
    applyReasoning(body, 'anthropic', {
      effort: request.reasoningEffort,
      options: request.reasoningOptions
    });
    body.model = request.model;
    body.max_tokens = request.maxOutputTokens ?? this.maxTokens;
    body.messages = messages;
    if (systemPrompt) body.system = systemPrompt;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }));
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop !== undefined) body.stop_sequences = request.stop;
    return body;
  }

  private parseMessage(
    response: Record<string, unknown>,
    request: GenerateRequest
  ): GenerateResult {
    const blocks = Array.isArray(response.content)
      ? (response.content as AnthropicContentBlock[])
      : [];
    const content = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    const toolRaw = blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        ...(readString(block.id) ? { id: block.id } : {}),
        function: { name: block.name, arguments: block.input ?? {} }
      }));
    const { toolCalls, parseErrors } = normalizeToolCalls(toolRaw);
    const usageRecord =
      response.usage && typeof response.usage === 'object'
        ? (response.usage as Record<string, unknown>)
        : {};
    const usage = usageFromAnthropic(usageRecord.input_tokens, usageRecord.output_tokens);
    return {
      content,
      toolCalls,
      finishReason: mapAnthropicFinishReason(response.stop_reason, toolCalls.length > 0),
      ...(usage !== undefined ? { usage } : {}),
      model: readString(response.model) ?? request.model,
      raw: parseErrors.length > 0 ? { ...response, toolCallParseErrors: parseErrors } : response
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await providerFetchJson<Record<string, unknown>>(this.url('/v1/messages'), {
      method: 'POST',
      body: this.buildMessageBody(request),
      ...this.requestOptions(request.signal, request.timeoutMs)
    });
    return this.parseMessage(response, request);
  }

  async *stream(request: GenerateRequest): AsyncGenerator<ProviderStreamEvent> {
    const handle = await openProviderStream(this.url('/v1/messages'), {
      method: 'POST',
      body: this.buildMessageBody(request),
      ...this.requestOptions(request.signal, request.timeoutMs)
    });

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let started = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finishReason: GenerateResult['finishReason'] = 'stop';

    try {
      for await (const line of readLineStream(handle.response)) {
        if (request.signal?.aborted) return;
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload.length === 0) continue;

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

        const type = readString(parsed.type);
        if (type === 'message_start') {
          const message =
            parsed.message && typeof parsed.message === 'object'
              ? (parsed.message as Record<string, unknown>)
              : {};
          if (!started) {
            started = true;
            yield { type: 'start', model: readString(message.model) ?? request.model };
          }
          const usage =
            message.usage && typeof message.usage === 'object'
              ? (message.usage as Record<string, unknown>)
              : {};
          if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
        } else if (type === 'content_block_start') {
          const block =
            parsed.content_block && typeof parsed.content_block === 'object'
              ? (parsed.content_block as Record<string, unknown>)
              : {};
          if (block.type === 'tool_use') {
            const index = typeof parsed.index === 'number' ? parsed.index : 0;
            toolBlocks.set(index, {
              id: readString(block.id) ?? `tool_${index}`,
              name: readString(block.name) ?? '',
              json: ''
            });
          }
        } else if (type === 'content_block_delta') {
          const delta =
            parsed.delta && typeof parsed.delta === 'object'
              ? (parsed.delta as Record<string, unknown>)
              : {};
          if (delta.type === 'thinking_delta') {
            if (readString(delta.thinking)) {
              yield { type: 'reasoning', content: readString(delta.thinking)! };
            }
          } else if (delta.type === 'text_delta') {
            if (readString(delta.text)) yield { type: 'delta', content: readString(delta.text)! };
          } else if (delta.type === 'input_json_delta') {
            const index = typeof parsed.index === 'number' ? parsed.index : 0;
            const entry = toolBlocks.get(index);
            if (entry && typeof delta.partial_json === 'string') entry.json += delta.partial_json;
          }
        } else if (type === 'message_delta') {
          const delta =
            parsed.delta && typeof parsed.delta === 'object'
              ? (parsed.delta as Record<string, unknown>)
              : {};
          if (readString(delta.stop_reason)) {
            finishReason = mapAnthropicFinishReason(delta.stop_reason, toolBlocks.size > 0);
          }
          const usage =
            parsed.usage && typeof parsed.usage === 'object'
              ? (parsed.usage as Record<string, unknown>)
              : {};
          if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
        } else if (type === 'error') {
          const error =
            parsed.error && typeof parsed.error === 'object'
              ? (parsed.error as Record<string, unknown>)
              : {};
          yield {
            type: 'error',
            message: sanitizeProviderMessage(readString(error.message) ?? 'Anthropic stream error')
          };
          return;
        }
      }
    } catch (error) {
      if (request.signal?.aborted || handle.abortedByCaller()) return;
      yield {
        type: 'error',
        message: sanitizeProviderMessage(
          error instanceof Error ? error.message : 'Anthropic stream failed'
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
    if (toolBlocks.size > 0) {
      const raw = [...toolBlocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => ({
          id: entry.id,
          function: { name: entry.name, arguments: entry.json.length > 0 ? entry.json : '{}' }
        }));
      const { toolCalls } = normalizeToolCalls(raw);
      if (toolCalls.length > 0) yield { type: 'tool_calls', toolCalls };
    }
    const usage = usageFromAnthropic(inputTokens, outputTokens);
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  }
}
