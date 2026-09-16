/**
 * OpenAI-compatible contract tests (`/v1/models`, `/v1/chat/completions`).
 *
 * The same mock server serves the OpenAI wire format; capabilities come from the
 * model row (or `capabilitiesFor`) rather than being guessed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAiCompatibleProvider } from '../../../src/lib/server/providers/openai-compatible';
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
  return { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const MODELS_ROUTE = {
  '/v1/models': () =>
    jsonReply({ object: 'list', data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }] })
};

describe('OpenAiCompatibleProvider', () => {
  test('health and model listing use /v1/models', async () => {
    const server = serve({ routes: MODELS_ROUTE });
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.url,
      capabilitiesFor: (id) => ({ toolCalling: id.startsWith('gpt-4') })
    });
    const health = await provider.health();
    expect(health.status).toBe('healthy');
    expect(health.modelCount).toBe(1);

    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.key).toBe('gpt-4o-mini');
    expect(models[0]?.capabilities.toolCalling).toBe(true);
    expect(models[0]?.capabilities.streaming).toBe(true);
  });

  test('reports degraded when /v1/models fails but the host answers', async () => {
    const server = serve({ failWith: { '/v1/models': { status: 500, body: 'nope' } } });
    const health = await new OpenAiCompatibleProvider({ baseUrl: server.url }).health();
    expect(health.status).toBe('degraded');
  });

  test('generate sends OpenAI-shaped payloads and parses the response', async () => {
    const server = serve({
      routes: {
        ...MODELS_ROUTE,
        '/v1/chat/completions': () =>
          jsonReply({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'working',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'ticket.create', arguments: '{"title":"T"}' }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })
      }
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: 'sk-test' });
    const jsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const result = await provider.generate(
      request({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'create' },
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
        jsonSchema,
        temperature: 0.2,
        topP: 0.7,
        maxOutputTokens: 256,
        stop: ['STOP'],
        seed: 3
      })
    );

    const body = server.requestsFor('/v1/chat/completions')[0]!.body as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.7);
    expect(body.stop).toEqual(['STOP']);
    expect(body.seed).toBe(3);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'mentat_response', schema: jsonSchema }
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'ticket.create',
          description: 'Create',
          parameters: { type: 'object', properties: { title: { type: 'string' } } }
        }
      }
    ]);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'create' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'prev',
            type: 'function',
            function: { name: 'ticket.create', arguments: '{"title":"Old"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'prev', content: '{"ok":true}' }
    ]);

    expect(result.content).toBe('working');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.toolCalls[0]?.arguments).toEqual({ title: 'T' });
  });

  test('streams SSE, accumulating fragmented tool calls', async () => {
    const server = serve({
      routes: {
        ...MODELS_ROUTE,
        '/v1/chat/completions': () =>
          sseReply([
            {
              data: JSON.stringify({
                model: 'gpt-4o-mini',
                choices: [
                  { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
                ]
              })
            },
            { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] }) },
            { data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'lo' } }] }) },
            {
              data: JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'ticket.', arguments: '' }
                        }
                      ]
                    }
                  }
                ]
              })
            },
            {
              data: JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, function: { name: 'create', arguments: '{"title"' } }
                      ]
                    }
                  }
                ]
              })
            },
            {
              data: JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: ':"T"}' } }]
                    }
                  }
                ]
              })
            },
            {
              data: JSON.stringify({
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
              })
            },
            { data: '[DONE]' }
          ])
      }
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: 'sk-test' });
    const events = (await drain(provider.stream(request()))) as Array<{
      type: string;
      content?: string;
      toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
      usage?: Record<string, number>;
      finishReason?: string;
    }>;
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'delta',
      'delta',
      'tool_calls',
      'usage',
      'done'
    ]);
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
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  test('non-2xx responses throw a readable ProviderUnavailableError', async () => {
    const server = serve({
      failWith: { '/v1/chat/completions': { status: 429, body: 'rate limited' } }
    });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: 'sk-test' });
    await expect(provider.generate(request())).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(drain(provider.stream(request()))).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
  });
});

describe('OpenAiCompatibleProvider reasoning', () => {
  const chatRoute = () =>
    jsonReply({
      id: 'chatcmpl-r',
      object: 'chat.completion',
      model: 'o3-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    });

  test('maps a level onto reasoning_effort and off to none', async () => {
    const server = serve({ routes: { '/v1/chat/completions': chatRoute } });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: 'sk-test' });
    await provider.generate(request({ reasoningEffort: 'minimal' }));
    expect(
      (server.requestsFor('/v1/chat/completions')[0]!.body as Record<string, unknown>)
        .reasoning_effort
    ).toBe('minimal');

    const off = serve({ routes: { '/v1/chat/completions': chatRoute } });
    await new OpenAiCompatibleProvider({ baseUrl: off.url, apiKey: 'sk-test' }).generate(
      request({ reasoningEffort: 'off' })
    );
    expect(
      (off.requestsFor('/v1/chat/completions')[0]!.body as Record<string, unknown>).reasoning_effort
    ).toBe('none');
  });

  test('a native override wins over the mapped level', async () => {
    const server = serve({ routes: { '/v1/chat/completions': chatRoute } });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: 'sk-test' });
    await provider.generate(
      request({ reasoningEffort: 'low', reasoningOptions: { reasoning_effort: 'high' } })
    );
    expect(
      (server.requestsFor('/v1/chat/completions')[0]!.body as Record<string, unknown>)
        .reasoning_effort
    ).toBe('high');
  });

  test('seeds reasoning capability for the real OpenAI type only', async () => {
    const routes = {
      '/v1/models': () => jsonReply({ object: 'list', data: [{ id: 'o3-mini' }, { id: 'gpt-4o' }] })
    };
    const openai = new OpenAiCompatibleProvider({ baseUrl: serve({ routes }).url, type: 'openai' });
    const curated = await openai.listModels();
    expect(curated.find((model) => model.key === 'o3-mini')?.capabilities.reasoning).toBe(true);
    expect(curated.find((model) => model.key === 'gpt-4o')?.capabilities.reasoning).toBe(false);

    const generic = new OpenAiCompatibleProvider({
      baseUrl: serve({ routes }).url,
      type: 'openai_compatible'
    });
    const unguessed = await generic.listModels();
    expect(unguessed.find((model) => model.key === 'o3-mini')?.capabilities.reasoning).toBe(false);
  });
});
