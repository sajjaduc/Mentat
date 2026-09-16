/**
 * The fake provider is the deterministic substrate for the execution suite and
 * for local development without Ollama. These tests pin its scripting surface so
 * other workstreams can rely on it.
 */
import { describe, expect, test } from 'bun:test';
import { FakeProvider } from '../../../src/lib/server/providers/fake';
import {
  type GenerateRequest,
  ProviderUnavailableError
} from '../../../src/lib/server/providers/types';

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return { model: 'fake-1', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

describe('FakeProvider', () => {
  test('reports the configured health without throwing', async () => {
    const configured = new FakeProvider({
      health: { status: 'degraded', latencyMs: 12, message: 'slow', version: '9.9.9' }
    });
    await expect(configured.health()).resolves.toEqual({
      status: 'degraded',
      latencyMs: 12,
      message: 'slow',
      version: '9.9.9'
    });
  });

  test('lists models with capability overrides merged over conservative defaults', async () => {
    const configured = new FakeProvider({
      models: [
        {
          key: 'fake-1',
          displayName: 'Fake One',
          capabilities: { toolCalling: true, vision: true }
        },
        { key: 'fake-2' }
      ]
    });
    const models = await configured.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]?.displayName).toBe('Fake One');
    expect(models[0]?.capabilities).toEqual({
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      vision: true,
      embeddings: false,
      reasoning: false
    });
    expect(models[1]?.capabilities.toolCalling).toBe(false);
  });

  test('generates configured content, tool calls, usage and finish reason', async () => {
    const configured = new FakeProvider({
      generate: {
        content: 'done',
        toolCalls: [{ id: 'call_7', name: 'ticket.create', arguments: { title: 'X' } }],
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        finishReason: 'tool_calls'
      }
    });
    const result = await configured.generate(request());
    expect(result.content).toBe('done');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 5, totalTokens: 8 });
    expect(result.toolCalls[0]?.id).toBe('call_7');
    expect(result.toolCalls[0]?.arguments).toEqual({ title: 'X' });
  });

  test('normalizes malformed tool-call arguments instead of crashing', async () => {
    const configured = new FakeProvider({
      generate: { toolCalls: [{ name: 'broken', arguments: '{"oops"' }] }
    });
    const result = await configured.generate(request());
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.arguments).toEqual({});
    expect(result.toolCalls[0]?.rawArguments).toBe('{"oops"');
    expect(result.finishReason).toBe('tool_calls');
  });

  test('supports a length finish reason', async () => {
    const configured = new FakeProvider({
      generate: { content: 'partial', finishReason: 'length' }
    });
    await expect(configured.generate(request())).resolves.toMatchObject({
      content: 'partial',
      finishReason: 'length'
    });
  });

  test('can throw a ProviderUnavailableError', async () => {
    const configured = new FakeProvider({ generate: { unavailable: 'ollama is down' } });
    await expect(configured.generate(request())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test('streams a configured event sequence and terminates in order', async () => {
    const configured = new FakeProvider({
      stream: {
        events: [
          { type: 'start', model: 'fake-1' },
          { type: 'delta', content: 'a' },
          { type: 'delta', content: 'b' },
          { type: 'usage', usage: { outputTokens: 2 } },
          { type: 'done', finishReason: 'stop' }
        ]
      }
    });
    const seen: string[] = [];
    for await (const event of configured.stream(request())) seen.push(event.type);
    expect(seen).toEqual(['start', 'delta', 'delta', 'usage', 'done']);
  });

  test('builds a stream from convenience fields and can fail mid-stream', async () => {
    const configured = new FakeProvider({
      stream: { text: 'hello', reasoning: 'thinking', error: { message: 'boom', code: 'model' } }
    });
    const events = [];
    for await (const event of configured.stream(request())) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['start', 'reasoning', 'delta', 'error']);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'boom', code: 'model' });
  });

  test('records every call with its request and resets cleanly', async () => {
    const signal = new AbortController().signal;
    const configured = new FakeProvider();
    await configured.health();
    await configured.listModels();
    await configured.generate(request({ tools: [], options: { num_ctx: 2048 }, signal }));
    for await (const _event of configured.stream(request({ signal }))) {
      // drain
    }

    expect(configured.calls.map((call) => call.method)).toEqual([
      'health',
      'listModels',
      'generate',
      'stream'
    ]);
    const recorded = configured.calls.find((call) => call.method === 'generate');
    expect(recorded?.request?.options).toEqual({ num_ctx: 2048 });
    expect(recorded?.request?.signal).toBe(signal);
    expect(configured.calls.map((call) => call.sequence)).toEqual([0, 1, 2, 3]);

    configured.reset();
    expect(configured.calls).toEqual([]);
  });

  test('a generate script array is consumed one call at a time', async () => {
    const configured = new FakeProvider({
      generate: [{ content: 'first' }, { content: 'second' }]
    });
    expect((await configured.generate(request())).content).toBe('first');
    expect((await configured.generate(request())).content).toBe('second');
    // Past the end, the last script is reused so runners never get undefined.
    expect((await configured.generate(request())).content).toBe('second');
  });
});
