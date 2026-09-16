/**
 * Deterministic fake provider.
 *
 * The execution engine's tests and local development without Ollama need a
 * provider whose behaviour is a pure function of its plan. It records every call
 * (including the request object, so tests can assert on messages, tools, options
 * and the abort signal) and never consults the wall clock for anything a test
 * asserts on. Delays are opt-in and default to zero.
 */
import {
  type GenerateRequest,
  type GenerateResult,
  type ModelDescriptor,
  type ModelProvider,
  normalizeToolCalls,
  type ProviderHealth,
  type ProviderModelCapabilities,
  type ProviderStreamEvent,
  ProviderUnavailableError,
  type ToolCallRequest
} from './types';

const DEFAULT_CAPABILITIES: ProviderModelCapabilities = {
  streaming: true,
  toolCalling: false,
  jsonMode: true,
  vision: false,
  embeddings: false,
  reasoning: false
};

export interface FakeModelSpec {
  key: string;
  displayName?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  contextWindow?: number;
  capabilities?: Partial<ProviderModelCapabilities>;
  raw?: Record<string, unknown>;
}

export interface FakeToolCallSpec {
  id?: string;
  name: string;
  /** A raw string may be malformed on purpose, to exercise the parser. */
  arguments?: string | Record<string, unknown>;
}

export interface FakeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface FakeGenerateScript {
  content?: string;
  /** Ergonomic tool calls, normalized through `normalizeToolCalls`. */
  toolCalls?: FakeToolCallSpec[];
  /** Raw OpenAI-style tool calls, normalized through `normalizeToolCalls`. */
  rawToolCalls?: unknown;
  usage?: FakeUsage;
  finishReason?: GenerateResult['finishReason'];
  model?: string;
  /** Throw instead of returning; strings become a `ProviderUnavailableError`. */
  unavailable?: string | Error;
  delayMs?: number;
}

export interface FakeStreamScript {
  /** Explicit events; when present the convenience fields below are ignored. */
  events?: ProviderStreamEvent[];
  text?: string;
  reasoning?: string;
  toolCalls?: FakeToolCallSpec[];
  usage?: FakeUsage;
  finishReason?: GenerateResult['finishReason'];
  /** Emit an error event after any configured events. */
  error?: { message: string; code?: string };
  unavailable?: string | Error;
  delayMs?: number;
}

export interface FakeProviderPlan {
  type?: string;
  name?: string;
  health?: ProviderHealth;
  models?: FakeModelSpec[];
  generate?: FakeGenerateScript | FakeGenerateScript[];
  stream?: FakeStreamScript | FakeStreamScript[];
}

export interface FakeProviderCall {
  /** Monotonic call ordinal; use it instead of a timestamp in assertions. */
  sequence: number;
  method: 'health' | 'listModels' | 'generate' | 'stream';
  request?: GenerateRequest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toUnavailable(value: string | Error): Error {
  return typeof value === 'string' ? new ProviderUnavailableError(value) : value;
}

function specToRawCall(spec: FakeToolCallSpec): Record<string, unknown> {
  return {
    ...(spec.id ? { id: spec.id } : {}),
    function: { name: spec.name, arguments: spec.arguments ?? {} }
  };
}

function resolveToolCalls(script: { toolCalls?: FakeToolCallSpec[]; rawToolCalls?: unknown }): {
  toolCalls: ToolCallRequest[];
  parseErrors: string[];
} {
  if (script.rawToolCalls !== undefined) return normalizeToolCalls(script.rawToolCalls);
  if (script.toolCalls) return normalizeToolCalls(script.toolCalls.map(specToRawCall));
  return { toolCalls: [], parseErrors: [] };
}

function buildStreamEvents(script: FakeStreamScript, model: string): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [{ type: 'start', model }];
  if (script.reasoning) events.push({ type: 'reasoning', content: script.reasoning });
  if (script.text) events.push({ type: 'delta', content: script.text });
  const { toolCalls } = resolveToolCalls(script);
  if (toolCalls.length > 0) events.push({ type: 'tool_calls', toolCalls });
  if (script.usage) events.push({ type: 'usage', usage: script.usage });
  // An error script ends the stream without a done event so consumers can tell
  // "finished" from "failed".
  if (!script.error) {
    events.push({ type: 'done', finishReason: script.finishReason ?? 'stop' });
  }
  return events;
}

export class FakeProvider implements ModelProvider {
  readonly type: string;
  readonly name: string;

  /** Every method invocation, in order. Cleared by {@link reset}. */
  calls: FakeProviderCall[] = [];

  private generateIndex = 0;
  private streamIndex = 0;

  constructor(
    private readonly plan: FakeProviderPlan = {},
    options: { type?: string; name?: string } = {}
  ) {
    this.type = options.type ?? plan.type ?? 'fake';
    this.name = options.name ?? plan.name ?? 'Fake Provider';
  }

  /** Clear recorded calls and rewind script queues so a test can re-run. */
  reset(): void {
    this.calls = [];
    this.generateIndex = 0;
    this.streamIndex = 0;
  }

  private record(method: FakeProviderCall['method'], request?: GenerateRequest): void {
    this.calls.push({
      sequence: this.calls.length,
      method,
      ...(request === undefined ? {} : { request })
    });
  }

  private nextGenerateScript(): FakeGenerateScript {
    const configured = this.plan.generate;
    if (!configured) return {};
    if (!Array.isArray(configured)) return configured;
    const script = configured[Math.min(this.generateIndex, configured.length - 1)];
    this.generateIndex += 1;
    return script ?? {};
  }

  private nextStreamScript(): FakeStreamScript {
    const configured = this.plan.stream;
    if (!configured) return {};
    if (!Array.isArray(configured)) return configured;
    const script = configured[Math.min(this.streamIndex, configured.length - 1)];
    this.streamIndex += 1;
    return script ?? {};
  }

  async health(): Promise<ProviderHealth> {
    this.record('health');
    return this.plan.health ? { ...this.plan.health } : { status: 'healthy' };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    this.record('listModels');
    return (this.plan.models ?? []).map((spec) => ({
      key: spec.key,
      displayName: spec.displayName ?? spec.key,
      ...(spec.family !== undefined ? { family: spec.family } : {}),
      ...(spec.parameterSize !== undefined ? { parameterSize: spec.parameterSize } : {}),
      ...(spec.quantization !== undefined ? { quantization: spec.quantization } : {}),
      ...(spec.contextWindow !== undefined ? { contextWindow: spec.contextWindow } : {}),
      capabilities: { ...DEFAULT_CAPABILITIES, ...spec.capabilities },
      ...(spec.raw !== undefined ? { raw: spec.raw } : {})
    }));
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.record('generate', request);
    const script = this.nextGenerateScript();
    if (script.delayMs && script.delayMs > 0) await sleep(script.delayMs);
    if (script.unavailable) throw toUnavailable(script.unavailable);

    const { toolCalls, parseErrors } = resolveToolCalls(script);
    const finishReason = script.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    return {
      content: script.content ?? '',
      toolCalls,
      finishReason,
      ...(script.usage !== undefined ? { usage: script.usage } : {}),
      model: script.model ?? request.model,
      raw: { parseErrors }
    };
  }

  stream(request: GenerateRequest): AsyncIterable<ProviderStreamEvent> {
    this.record('stream', request);
    return this.emitStream(this.nextStreamScript(), request.model);
  }

  private async *emitStream(
    script: FakeStreamScript,
    model: string
  ): AsyncGenerator<ProviderStreamEvent> {
    if (script.delayMs && script.delayMs > 0) await sleep(script.delayMs);
    if (script.unavailable) throw toUnavailable(script.unavailable);

    const events: ProviderStreamEvent[] = script.events
      ? [...script.events]
      : buildStreamEvents(script, model);
    for (const event of events) {
      if (script.delayMs && script.delayMs > 0) await sleep(script.delayMs);
      yield event;
    }
    if (script.error) {
      yield {
        type: 'error',
        message: script.error.message,
        ...(script.error.code !== undefined ? { code: script.error.code } : {})
      };
    }
  }
}
