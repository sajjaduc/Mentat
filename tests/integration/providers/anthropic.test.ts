/**
 * Anthropic contract tests (`/v1/models`, `/v1/messages`).
 *
 * Anthropic differs from OpenAI on two points the runner depends on: tool results
 * travel as `tool_result` blocks inside a user message, and extended-thinking
 * blocks must never be folded back into assistant content.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AnthropicProvider } from '../../../src/lib/server/providers/anthropic';
import {
  type GenerateRequest,
  ProviderUnavailableError
} from '../../../src/lib/server/providers/types';
import {
  jsonReply,
  type MockOllamaServer,
  sseReply,
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

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: 'claude-3-5-sonnet-latest',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const MODELS_ROUTE = {
  '/v1/models': () =>
    jsonReply({
      data: [{ id: 'claude-3-5-sonnet-latest', display_name: 'Claude 3.5 Sonnet', type: 'model' }]
    })
};

describe('AnthropicProvider', () => {
  test('health and listing use /v1/models with the x-api-key header', async () => {
    const server = serve({ routes: MODELS_ROUTE });
    const provider = new AnthropicProvider({ baseUrl: server.url, apiKey: 'sk-ant-test' });
    const health = await provider.health();
    expect(health.status).toBe('healthy');
    expect(health.modelCount).toBe(1);
    const models = await provider.listModels();
    expect(models[0]?.key).toBe('claude-3-5-sonnet-latest');
    expect(models[0]?.capabilities.toolCalling).toBe(true);
    const recorded = server.requestsFor('/v1/models')[0]!;
    expect(recorded.headers['x-api-key']).toBe('sk-ant-test');
    expect(recorded.headers['anthropic-version']).toBeTruthy();
  });

  test('generate maps system, tool use, tool results and reasoning correctly', async () => {
    const server = serve({
      routes: {
        ...MODELS_ROUTE,
        '/v1/messages': () =>
          jsonReply({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-3-5-sonnet-latest',
            content: [
              { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
              { type: 'text', text: 'working' },
              { type: 'tool_use', id: 'toolu_1', name: 'ticket.create', input: { title: 'T' } }
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 }
          })
      }
    });
    const provider = new AnthropicProvider({ baseUrl: server.url, apiKey: 'sk-ant-test' });
    const result = await provider.generate(
      request({
        messages: [
          { role: 'system', content: 'you are careful' },
          { role: 'user', content: 'create', images: ['abc123'] },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'prev', name: 'ticket.create', arguments: { title: 'Old' } }]
          },
          { role: 'tool', content: '{"ok":true}', toolCallId: 'prev' }
        ],
        tools: [
          {
            name: 'ticket.create',
            description: 'Create',
            parameters: { type: 'object', properties: { title: { type: 'string' } } }
          }
        ],
        temperature: 0.2,
        topP: 0.7,
        maxOutputTokens: 256,
        stop: ['STOP']
      })
    );

    const body = server.requestsFor('/v1/messages')[0]!.body as Record<string, unknown>;
    expect(body.system).toBe('you are careful');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.7);
    expect(body.stop_sequences).toEqual(['STOP']);
    expect(body.tools).toEqual([
      {
        name: 'ticket.create',
        description: 'Create',
        input_schema: { type: 'object', properties: { title: { type: 'string' } } }
      }
    ]);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'create' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }
        ]
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'prev', name: 'ticket.create', input: { title: 'Old' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'prev', content: '{"ok":true}' }]
      }
    ]);

    // Thinking blocks never leak into assistant-visible content.
    expect(result.content).toBe('working');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.toolCalls[0]).toMatchObject({
      id: 'toolu_1',
      name: 'ticket.create',
      arguments: { title: 'T' }
    });
    expect(JSON.stringify(result.content)).not.toContain('secret reasoning');
  });

  test('streams Anthropic SSE, mapping thinking, text and tool-use blocks', async () => {
    const server = serve({
      routes: {
        ...MODELS_ROUTE,
        '/v1/messages': () =>
          sseReply([
            {
              event: 'message_start',
              data: JSON.stringify({
                type: 'message_start',
                message: {
                  id: 'msg_1',
                  model: 'claude-3-5-sonnet-latest',
                  usage: { input_tokens: 10, output_tokens: 0 }
                }
              })
            },
            {
              event: 'content_block_start',
              data: JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking' }
              })
            },
            {
              event: 'content_block_delta',
              data: JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'hmm' }
              })
            },
            {
              event: 'content_block_stop',
              data: JSON.stringify({ type: 'content_block_stop', index: 0 })
            },
            {
              event: 'content_block_start',
              data: JSON.stringify({
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'text', text: '' }
              })
            },
            {
              event: 'content_block_delta',
              data: JSON.stringify({
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'text_delta', text: 'Hel' }
              })
            },
            {
              event: 'content_block_delta',
              data: JSON.stringify({
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'text_delta', text: 'lo' }
              })
            },
            {
              event: 'content_block_stop',
              data: JSON.stringify({ type: 'content_block_stop', index: 1 })
            },
            {
              event: 'content_block_start',
              data: JSON.stringify({
                type: 'content_block_start',
                index: 2,
                content_block: { type: 'tool_use', id: 'toolu_1', name: 'ticket.create' }
              })
            },
            {
              event: 'content_block_delta',
              data: JSON.stringify({
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: '{"title"' }
              })
            },
            {
              event: 'content_block_delta',
              data: JSON.stringify({
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: ':"T"}' }
              })
            },
            {
              event: 'content_block_stop',
              data: JSON.stringify({ type: 'content_block_stop', index: 2 })
            },
            {
              event: 'message_delta',
              data: JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 5 }
              })
            },
            { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) }
          ])
      }
    });
    const provider = new AnthropicProvider({ baseUrl: server.url, apiKey: 'sk-ant-test' });
    const events = (await drain(provider.stream(request()))) as Array<{
      type: string;
      content?: string;
      toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
      usage?: Record<string, number>;
      finishReason?: string;
    }>;
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'reasoning',
      'delta',
      'delta',
      'tool_calls',
      'usage',
      'done'
    ]);
    expect(events.find((event) => event.type === 'reasoning')?.content).toBe('hmm');
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => event.content)
        .join('')
    ).toBe('Hello');
    expect(events.find((event) => event.type === 'tool_calls')?.toolCalls?.[0]).toMatchObject({
      name: 'ticket.create',
      arguments: { title: 'T' }
    });
    expect(events.find((event) => event.type === 'usage')?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  test('non-2xx responses throw a readable ProviderUnavailableError', async () => {
    const server = serve({ failWith: { '/v1/messages': { status: 400, body: 'bad request' } } });
    const provider = new AnthropicProvider({ baseUrl: server.url, apiKey: 'sk-ant-test' });
    await expect(provider.generate(request())).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(drain(provider.stream(request()))).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
  });
});
