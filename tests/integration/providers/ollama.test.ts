/**
 * Ollama contract tests.
 *
 * Every case runs against the in-process mock server so the suite never depends
 * on a real Ollama install; the wire format is asserted from the recorded request
 * body rather than from provider internals.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { OllamaProvider } from '../../../src/lib/server/providers/ollama';
import {
  type GenerateRequest,
  ProviderUnavailableError
} from '../../../src/lib/server/providers/types';
import {
  type MockOllamaServer,
  ndjsonLinesReply,
  ndjsonReply,
  ollamaChatReply,
  rawReply,
  startMockOllama
} from '../../helpers/mock-ollama';

const servers: MockOllamaServer[] = [];

function serve(options: Parameters<typeof startMockOllama>[0] = {}): MockOllamaServer {
  const server = startMockOllama(options);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function providerFor(server: MockOllamaServer, overrides: Partial<{ timeoutMs: number }> = {}) {
  return new OllamaProvider({ baseUrl: server.url, timeoutMs: 2000, ...overrides });
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('OllamaProvider.health', () => {
  test('reports healthy with version and model count', async () => {
    const server = serve({ models: ['llama3.1:8b', 'qwen2.5:7b'] });
    const health = await providerFor(server).health();
    expect(health.status).toBe('healthy');
    expect(health.version).toBe('0.5.7');
    expect(health.modelCount).toBe(2);
    expect(typeof health.latencyMs).toBe('number');
    expect(server.requestsFor('/api/version')).toHaveLength(1);
  });

  test('reports degraded when the server is reachable but tags fails', async () => {
    const server = serve({ failWith: { '/api/tags': { status: 500, body: 'tags exploded' } } });
    const health = await providerFor(server).health();
    expect(health.status).toBe('degraded');
    expect(health.version).toBe('0.5.7');
    expect(health.message).toContain('tags');
  });

  test('reports unreachable when the port is closed instead of throwing', async () => {
    const server = serve();
    const url = server.url;
    server.stop();
    const health = await new OllamaProvider({ baseUrl: url, timeoutMs: 500 }).health();
    expect(health.status).toBe('unreachable');
    expect(health.message).toBeTruthy();
  });
});

describe('OllamaProvider.listModels', () => {
  test('parses /api/tags metadata and applies capability heuristics', async () => {
    const server = serve({
      models: [
        { name: 'llama3.1:8b', family: 'llama', parameterSize: '8.0B', quantization: 'Q4_K_M' },
        { name: 'llava:13b', family: 'llama', parameterSize: '13B', quantization: 'Q4_0' },
        {
          name: 'nomic-embed-text:latest',
          family: 'nomic-bert',
          parameterSize: '137M',
          quantization: 'F16'
        }
      ]
    });
    const models = await providerFor(server).listModels();
    expect(models).toHaveLength(3);
    expect(models[0]?.key).toBe('llama3.1:8b');
    expect(models[0]?.family).toBe('llama');
    expect(models[0]?.parameterSize).toBe('8.0B');
    expect(models[0]?.quantization).toBe('Q4_K_M');
    expect(models[0]?.capabilities.toolCalling).toBe(true);
    expect(models[1]?.capabilities.vision).toBe(true);
    expect(models[1]?.capabilities.toolCalling).toBe(false);
    expect(models[2]?.capabilities.embeddings).toBe(true);
    expect(models[2]?.capabilities.streaming).toBe(false);
  });

  test('surfaces a readable ProviderUnavailableError on a non-2xx response', async () => {
    const server = serve({ failWith: { '/api/tags': { status: 503, body: 'no models' } } });
    await expect(providerFor(server).listModels()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('OllamaProvider.generate', () => {
  test('sends the expected payload and parses content, tool calls and usage', async () => {
    const server = serve({
      chatHandler: () =>
        ollamaChatReply({
          content: 'working on it',
          toolCalls: [{ id: 'call_1', name: 'ticket.create', arguments: { title: 'T' } }],
          promptEvalCount: 11,
          evalCount: 4,
          doneReason: 'tool_calls'
        })
    });
    const jsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const result = await providerFor(server).generate(
      request({
        messages: [
          { role: 'system', content: 'you are helpful' },
          { role: 'user', content: 'create a ticket', images: ['base64-image'] },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'prev', name: 'ticket.create', arguments: { title: 'Old' } }]
          },
          { role: 'tool', content: '{"created":true}', toolCallId: 'prev', name: 'ticket.create' }
        ],
        tools: [
          {
            name: 'ticket.create',
            description: 'Create a ticket',
            parameters: { type: 'object', properties: { title: { type: 'string' } } }
          }
        ],
        jsonSchema,
        temperature: 0.3,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 100,
        stop: ['END'],
        seed: 5,
        options: { num_ctx: 2048 }
      })
    );

    const body = server.requestsFor('/api/chat')[0]!.body as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.model).toBe('llama3.1:8b');
    expect(body.format).toEqual(jsonSchema);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'create a ticket',
      images: ['base64-image']
    });
    expect(messages[2]?.role).toBe('assistant');
    const assistantTools = messages[2]?.tool_calls as Array<Record<string, unknown>>;
    expect(assistantTools[0]?.function).toMatchObject({
      name: 'ticket.create',
      arguments: { title: 'Old' }
    });
    expect(messages[3]).toMatchObject({ role: 'tool', content: '{"created":true}' });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'ticket.create',
        description: 'Create a ticket',
        parameters: { type: 'object', properties: { title: { type: 'string' } } }
      }
    });
    expect(body.options).toEqual({
      num_ctx: 2048,
      temperature: 0.3,
      top_p: 0.8,
      top_k: 40,
      num_predict: 100,
      stop: ['END'],
      seed: 5
    });

    expect(result.content).toBe('working on it');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.model).toBe('llama3.1:8b');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15 });
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'ticket.create',
      arguments: { title: 'T' }
    });
  });

  test('maps done_reason length to a length finish reason', async () => {
    const server = serve({
      chatHandler: () => ollamaChatReply({ content: 'truncated', doneReason: 'length' })
    });
    const result = await providerFor(server).generate(request());
    expect(result.finishReason).toBe('length');
  });

  test('a malformed tool call yields parsed-empty arguments without crashing', async () => {
    const server = serve({
      chatHandler: () =>
        ollamaChatReply({ content: '', toolCalls: [{ name: 'broken', arguments: '{"nope"' }] })
    });
    const result = await providerFor(server).generate(request());
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.arguments).toEqual({});
    expect(result.toolCalls[0]?.rawArguments).toBe('{"nope"');
    expect(result.finishReason).toBe('tool_calls');
  });

  test('non-2xx responses throw a readable ProviderUnavailableError', async () => {
    const server = serve({ failWith: { '/api/chat': { status: 500, body: 'model exploded' } } });
    let thrown: unknown;
    try {
      await providerFor(server).generate(request());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderUnavailableError);
    const error = thrown as ProviderUnavailableError;
    expect(error.message).toContain('500');
    expect(error.message).toContain('model exploded');
  });
});

describe('OllamaProvider.stream', () => {
  test('emits start/delta/reasoning/usage/done in order with concatenated content', async () => {
    const server = serve({
      chatHandler: () =>
        ndjsonReply([
          {
            model: 'llama3.1:8b',
            message: { role: 'assistant', content: '', thinking: 'hmm' },
            done: false
          },
          { model: 'llama3.1:8b', message: { role: 'assistant', content: 'Hel' }, done: false },
          { model: 'llama3.1:8b', message: { role: 'assistant', content: 'lo' }, done: false },
          {
            model: 'llama3.1:8b',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 6,
            eval_count: 2
          }
        ])
    });
    const events = await drain(providerFor(server).stream(request()));
    const types = events.map((event) => (event as { type: string }).type);
    expect(types).toEqual(['start', 'reasoning', 'delta', 'delta', 'usage', 'done']);
    const content = events
      .filter((event) => (event as { type: string }).type === 'delta')
      .map((event) => (event as { content: string }).content)
      .join('');
    expect(content).toBe('Hello');
    expect(events.find((event) => (event as { type: string }).type === 'reasoning')).toEqual({
      type: 'reasoning',
      content: 'hmm'
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  test('parses a partial trailing line that has no newline terminator', async () => {
    const server = serve({
      chatHandler: () =>
        rawReply([
          '{"model":"m","message":{"content":"Hel"},"done":false}\n',
          '{"model":"m","message":{"content":"lo"},"done":false}\n',
          '{"model":"m","message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":1,"eval_count":2}'
        ])
    });
    const events = await drain(providerFor(server).stream(request()));
    const content = events
      .filter((event) => (event as { type: string }).type === 'delta')
      .map((event) => (event as { content: string }).content)
      .join('');
    expect(content).toBe('Hello');
    expect(events.some((event) => (event as { type: string }).type === 'done')).toBe(true);
  });

  test('a mid-stream provider error yields an error event and does not throw', async () => {
    const server = serve({
      chatHandler: () =>
        ndjsonLinesReply([
          '{"model":"m","message":{"content":"a"},"done":false}',
          '{"error":"kaboom"}'
        ])
    });
    const events = await drain(providerFor(server).stream(request()));
    const errorEvent = events.find((event) => (event as { type: string }).type === 'error') as
      | { type: 'error'; message: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain('kaboom');
  });

  test('a mid-stream disconnect yields an error event and does not throw', async () => {
    const server = serve({
      chatHandler: () =>
        ndjsonReply(
          [
            { model: 'm', message: { content: 'a' }, done: false },
            { model: 'm', message: { content: 'b' }, done: false },
            { model: 'm', message: { content: 'c' }, done: true }
          ],
          { disconnectAfter: 1 }
        )
    });
    const events = await drain(providerFor(server).stream(request()));
    expect(events.some((event) => (event as { type: string }).type === 'error')).toBe(true);
  });

  test('aborting the signal stops the stream promptly', async () => {
    const chunks = Array.from({ length: 10 }, (_, index) => ({
      model: 'm',
      message: { content: `c${index}` },
      done: false
    }));
    const server = serve({ chatHandler: () => ndjsonReply(chunks, { delayMs: 20 }) });
    const controller = new AbortController();
    const events: Array<{ type: string }> = [];
    for await (const event of providerFor(server).stream(request({ signal: controller.signal }))) {
      events.push(event as { type: string });
      if ((event as { type: string }).type === 'delta') controller.abort();
    }
    const deltas = events.filter((event) => event.type === 'delta');
    expect(deltas.length).toBeLessThan(5);
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  test('non-2xx responses reject the stream with a readable error', async () => {
    const server = serve({ failWith: { '/api/chat': { status: 401, body: 'unauthorized' } } });
    await expect(drain(providerFor(server).stream(request()))).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
  });
});

describe('OllamaProvider reasoning', () => {
  test('maps a reasoning level onto the top-level think field', async () => {
    const server = serve();
    await providerFor(server).generate(request({ reasoningEffort: 'high' }));
    const body = server.requestsFor('/api/chat')[0]!.body as Record<string, unknown>;
    expect(body.think).toBe('high');
  });

  test('turns thinking off with think=false and lets an override win', async () => {
    const off = serve();
    await providerFor(off).generate(request({ reasoningEffort: 'off' }));
    expect((off.requestsFor('/api/chat')[0]!.body as Record<string, unknown>).think).toBe(false);

    const overridden = serve();
    await providerFor(overridden).generate(
      request({ reasoningEffort: 'low', reasoningOptions: { think: 'max' } })
    );
    expect((overridden.requestsFor('/api/chat')[0]!.body as Record<string, unknown>).think).toBe(
      'max'
    );
  });
});
