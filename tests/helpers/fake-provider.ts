/**
 * Deterministic fake provider for execution tests.
 *
 * This is intentionally *not* the providers workstream's `FakeProvider`: the
 * execution suite must be able to run and evolve independently of that module, and
 * it needs a provider whose behaviour is scripted turn by turn so a test can say
 * "first answer with a tool call, then answer with text".
 */
import type {
  GenerateRequest,
  GenerateResult,
  ModelDescriptor,
  ModelProvider,
  ProviderHealth,
  ProviderModelCapabilities,
  ProviderStreamEvent,
  ToolCallRequest
} from '../../src/lib/server/providers/types';

export interface FakeTurn {
  /** Text the model answers with this turn. */
  content?: string;
  /** Tool calls the model requests this turn. */
  toolCalls?: Array<{
    id?: string;
    name: string;
    arguments?: Record<string, unknown>;
    rawArguments?: string;
  }>;
  finishReason?: GenerateResult['finishReason'];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Throw this error instead of answering. */
  error?: Error;
  /** Simulate an error emitted mid-stream (after any deltas). */
  streamError?: string;
  /** Emit deltas in this chunking instead of one delta per turn. */
  chunkSize?: number;
}

export interface FakeProviderOptions {
  turns: FakeTurn[];
  capabilities?: Partial<ProviderModelCapabilities>;
  health?: ProviderHealth;
  models?: ModelDescriptor[];
  /** When the script runs out, answer with this text instead of throwing. */
  fallbackContent?: string;
}

export class ScriptedProvider implements ModelProvider {
  readonly type = 'fake';
  readonly name = 'Scripted';
  readonly calls: GenerateRequest[] = [];
  private cursor = 0;

  constructor(private readonly options: FakeProviderOptions) {}

  capabilities(): ProviderModelCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      jsonMode: false,
      vision: false,
      embeddings: false,
      ...(this.options.capabilities ?? {})
    };
  }

  async health(): Promise<ProviderHealth> {
    return this.options.health ?? { status: 'healthy', latencyMs: 1 };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return (
      this.options.models ?? [
        {
          key: 'fake-model',
          displayName: 'Fake Model',
          capabilities: this.capabilities()
        }
      ]
    );
  }

  reset(): void {
    this.cursor = 0;
    this.calls.length = 0;
  }

  private nextTurn(): FakeTurn {
    const turn = this.options.turns[this.cursor];
    this.cursor += 1;
    if (turn) return turn;
    return { content: this.options.fallbackContent ?? 'Done.' };
  }

  private normalize(turn: FakeTurn): {
    content: string;
    toolCalls: ToolCallRequest[];
    finishReason: GenerateResult['finishReason'];
  } {
    const toolCalls: ToolCallRequest[] = (turn.toolCalls ?? []).map((call, index) => ({
      id: call.id ?? `call_${this.cursor}_${index}`,
      name: call.name,
      arguments: call.arguments ?? (call.rawArguments ? safeParse(call.rawArguments) : {}),
      rawArguments: call.rawArguments
    }));
    return {
      content: turn.content ?? '',
      toolCalls,
      finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(request);
    const turn = this.nextTurn();
    if (turn.error) throw turn.error;
    const normalized = this.normalize(turn);
    return {
      ...normalized,
      usage: turn.usage,
      model: request.model,
      raw: { turn: this.cursor }
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<ProviderStreamEvent> {
    this.calls.push(request);
    const turn = this.nextTurn();
    yield { type: 'start', model: request.model };
    if (turn.error) {
      yield { type: 'error', message: turn.error.message };
      return;
    }
    const normalized = this.normalize(turn);
    const chunkSize = turn.chunkSize ?? Math.max(1, normalized.content.length);
    for (let offset = 0; offset < normalized.content.length; offset += chunkSize) {
      yield { type: 'delta', content: normalized.content.slice(offset, offset + chunkSize) };
    }
    if (turn.streamError) {
      yield { type: 'error', message: turn.streamError };
      return;
    }
    if (normalized.toolCalls.length > 0) {
      yield { type: 'tool_calls', toolCalls: normalized.toolCalls };
    }
    if (turn.usage) yield { type: 'usage', usage: turn.usage };
    yield { type: 'done', finishReason: normalized.finishReason };
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A synthetic `models` row for the provider lookup seam. */
export function fakeModelRow(workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'fake-model-row',
    workspaceId,
    providerId: 'fake-provider',
    modelKey: 'fake-model',
    displayName: 'Fake Model',
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: false,
      vision: false,
      embeddings: false
    },
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as never;
}
