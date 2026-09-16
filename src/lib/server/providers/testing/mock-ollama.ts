/**
 * In-process fake provider server.
 *
 * Provider contract tests must never touch a real Ollama (or OpenAI/Anthropic)
 * endpoint: flaky networks and model availability would make the suite useless as
 * a regression gate. This module owns one small HTTP server that speaks the wire
 * formats under test — Ollama NDJSON, OpenAI SSE and Anthropic SSE — and records
 * every request so tests can assert on the exact payload Mentat sent.
 *
 * It lives under `src` (not `tests`) because the execution workstream also drives
 * the runner against it; `tests/helpers/mock-ollama.ts` re-exports it so test
 * files have one ergonomic import path.
 *
 * The server is deliberately dumb: routes are configured by the caller and the
 * only built-in behaviour is the Ollama surface (`/api/version`, `/api/tags`,
 * `/api/chat`).
 */

/** Model entry accepted by the mock. Strings are expanded to a sensible default. */
export interface MockOllamaModelSpec {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  size?: number;
  digest?: string;
}

export interface MockRequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON body, or `null` when the body was missing/unparseable. */
  body: unknown;
  rawBody: string;
}

export interface MockReplyInit {
  status?: number;
  headers?: Record<string, string>;
  /** Delay in milliseconds applied before any bytes are written. */
  delayMs?: number;
}

/** Streaming reply: `chunks` are JSON-stringified, `lines` are written verbatim. */
export interface MockStreamReplyInit extends MockReplyInit {
  /** Inter-chunk delay in milliseconds (0 by default). */
  delayMs?: number;
  /**
   * Stop writing after this many chunks and close the stream early, simulating a
   * dropped connection that leaves the response truncated.
   */
  disconnectAfter?: number;
}

export interface MockSseEvent {
  event?: string;
  data: string;
}

export type MockReply =
  | ({ type: 'json'; body: unknown } & MockReplyInit)
  | ({ type: 'text'; body: string; contentType?: string } & MockReplyInit)
  | ({ type: 'ndjson'; chunks?: unknown[]; lines?: string[] } & MockStreamReplyInit)
  | ({ type: 'sse'; events?: MockSseEvent[]; lines?: string[] } & MockStreamReplyInit)
  /** Chunks written verbatim — used to craft partial lines and hand-made SSE. */
  | ({ type: 'raw'; chunks: string[]; contentType?: string } & MockStreamReplyInit);

export type MockRouteHandler = (
  request: MockRequestRecord,
  server: MockOllamaServer
) => MockReply | undefined | Promise<MockReply | undefined>;

export interface StartMockOllamaOptions {
  /** Models returned by `GET /api/tags`. */
  models?: Array<string | MockOllamaModelSpec>;
  /** Value returned by `GET /api/version`. */
  version?: string;
  /** Handles `POST /api/chat`; return `undefined` to use the default reply. */
  chatHandler?: MockRouteHandler;
  /**
   * Failure injection keyed by `path` or `METHOD path`, e.g. `{ '/api/tags': ... }`.
   * Takes precedence over `routes` and built-in handlers.
   */
  failWith?: Record<string, MockReply | (Omit<MockReplyInit, 'delayMs'> & { body?: unknown })>;
  /**
   * Extra routes keyed by `path` or `METHOD path`; used by OpenAI-compatible and
   * Anthropic contract tests to serve `/v1/*` on the same server.
   */
  routes?: Record<string, MockRouteHandler>;
  hostname?: string;
  /** 0 (default) asks the OS for an ephemeral port. */
  port?: number;
}

export interface MockOllamaServer {
  url: string;
  port: number;
  /** Every request the server saw, in order. */
  requests: MockRequestRecord[];
  /** Convenience filter used by assertions. */
  requestsFor(path: string): MockRequestRecord[];
  stop(): void;
}

const DEFAULT_MODELS: MockOllamaModelSpec[] = [
  { name: 'llama3.1:8b', family: 'llama', parameterSize: '8.0B', quantization: 'Q4_K_M' },
  { name: 'qwen2.5-coder:7b', family: 'qwen2', parameterSize: '7.6B', quantization: 'Q4_K_M' },
  { name: 'llava:13b', family: 'llama', parameterSize: '13B', quantization: 'Q4_0' },
  {
    name: 'nomic-embed-text:latest',
    family: 'nomic-bert',
    parameterSize: '137M',
    quantization: 'F16'
  }
];

function normalizeModel(spec: string | MockOllamaModelSpec): MockOllamaModelSpec {
  return typeof spec === 'string' ? { name: spec } : { ...spec };
}

/** Build the `/api/tags` payload shape Ollama actually returns. */
export function ollamaTagsPayload(models: Array<string | MockOllamaModelSpec>): {
  models: Array<Record<string, unknown>>;
} {
  return {
    models: models.map((entry) => {
      const spec = normalizeModel(entry);
      const family = spec.family ?? 'llama';
      return {
        name: spec.name,
        model: spec.name,
        modified_at: new Date(0).toISOString(),
        size: spec.size ?? 4_000_000_000,
        digest: spec.digest ?? '0'.repeat(64),
        details: {
          parent_model: '',
          format: 'gguf',
          family,
          families: [family],
          parameter_size: spec.parameterSize ?? '8.0B',
          quantization_level: spec.quantization ?? 'Q4_K_M'
        }
      };
    })
  };
}

export function jsonReply(body: unknown, init: MockReplyInit = {}): MockReply {
  return { type: 'json', body, ...init };
}

export function textReply(
  body: string,
  init: MockReplyInit & { contentType?: string } = {}
): MockReply {
  return { type: 'text', body, ...init };
}

export function ndjsonReply(chunks: unknown[], init: MockStreamReplyInit = {}): MockReply {
  return { type: 'ndjson', chunks, ...init };
}

export function ndjsonLinesReply(lines: string[], init: MockStreamReplyInit = {}): MockReply {
  return { type: 'ndjson', lines, ...init };
}

export function sseReply(events: MockSseEvent[], init: MockStreamReplyInit = {}): MockReply {
  return { type: 'sse', events, ...init };
}

export function sseLinesReply(lines: string[], init: MockStreamReplyInit = {}): MockReply {
  return { type: 'sse', lines, ...init };
}

/** Write raw chunks verbatim; the caller controls framing. */
export function rawReply(
  chunks: string[],
  init: MockStreamReplyInit & { contentType?: string } = {}
): MockReply {
  return { type: 'raw', chunks, ...init };
}

/**
 * Build an Ollama chat reply. `stream` selects JSON vs NDJSON; the same logical
 * response can therefore be served for streaming and non-streaming calls.
 */
export function ollamaChatReply(options: {
  stream?: boolean;
  model?: string;
  content?: string;
  thinking?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments?: unknown }>;
  doneReason?: string;
  promptEvalCount?: number;
  evalCount?: number;
  init?: MockReplyInit;
}): MockReply {
  const model = options.model ?? 'llama3.1:8b';
  const toolCalls = (options.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
    }
  }));
  const message: Record<string, unknown> = { role: 'assistant', content: options.content ?? '' };
  if (options.thinking) message.thinking = options.thinking;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const final = {
    model,
    created_at: new Date(0).toISOString(),
    message,
    done: true,
    done_reason: options.doneReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    prompt_eval_count: options.promptEvalCount ?? 7,
    eval_count: options.evalCount ?? 5
  };

  if (!options.stream) {
    return jsonReply(final, options.init);
  }

  const chunks: unknown[] = [];
  if (options.thinking) {
    chunks.push({
      model,
      message: { role: 'assistant', content: '', thinking: options.thinking },
      done: false
    });
  }
  if (options.content) {
    chunks.push({ model, message: { role: 'assistant', content: options.content }, done: false });
  }
  chunks.push(final);
  return ndjsonReply(chunks, options.init);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function streamFromLines(
  lines: string[],
  contentType: string,
  init: MockStreamReplyInit,
  transform: (line: string) => string
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (init.delayMs && init.delayMs > 0) await sleep(init.delayMs);
      for (const [index, line] of lines.entries()) {
        if (init.disconnectAfter !== undefined && index >= init.disconnectAfter) {
          // Closing mid-response models a dropped connection: the client sees the
          // response end without the protocol's terminator.
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(transform(line)));
        if (init.delayMs && init.delayMs > 0) await sleep(init.delayMs);
      }
      controller.close();
    }
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': contentType, ...init.headers }
  });
}

async function toResponse(reply: MockReply): Promise<Response> {
  if (reply.delayMs && reply.delayMs > 0 && reply.type !== 'ndjson' && reply.type !== 'sse') {
    await sleep(reply.delayMs);
  }
  switch (reply.type) {
    case 'json':
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers }
      });
    case 'text':
      return new Response(reply.body, {
        status: reply.status ?? 200,
        headers: { 'content-type': reply.contentType ?? 'text/plain', ...reply.headers }
      });
    case 'ndjson': {
      const lines = reply.lines ?? (reply.chunks ?? []).map((chunk) => JSON.stringify(chunk));
      return streamFromLines(lines, 'application/x-ndjson', reply, (line) => `${line}\n`);
    }
    case 'sse': {
      const lines =
        reply.lines ??
        (reply.events ?? []).map((event) =>
          event.event ? `event: ${event.event}\ndata: ${event.data}\n\n` : `data: ${event.data}\n\n`
        );
      return streamFromLines(lines, 'text/event-stream', reply, (line) => line);
    }
    case 'raw':
      return streamFromLines(
        reply.chunks,
        reply.contentType ?? 'text/plain',
        reply,
        (line) => line
      );
  }
}

function normalizeFailureReply(
  entry: MockReply | (Omit<MockReplyInit, 'delayMs'> & { body?: unknown })
): MockReply {
  if (typeof entry === 'object' && entry !== null && 'type' in entry) {
    return entry as MockReply;
  }
  const shaped = entry as Omit<MockReplyInit, 'delayMs'> & { body?: unknown };
  return {
    type: typeof shaped.body === 'string' ? 'text' : 'json',
    body: shaped.body ?? 'mock failure',
    status: shaped.status ?? 500,
    ...(shaped.headers ? { headers: shaped.headers } : {})
  } as MockReply;
}

export function startMockOllama(options: StartMockOllamaOptions = {}): MockOllamaServer {
  const requests: MockRequestRecord[] = [];
  const models = options.models ?? DEFAULT_MODELS;
  const version = options.version ?? '0.5.7';
  const failWith = options.failWith ?? {};
  const routes = options.routes ?? {};

  const server: MockOllamaServer = {
    url: '',
    port: 0,
    requests,
    requestsFor(path) {
      return requests.filter((entry) => entry.path === path);
    },
    stop() {
      if (started) {
        started = false;
        bunServer?.stop(true);
      }
    }
  };

  let started = false;
  let bunServer: ReturnType<typeof Bun.serve> | null = null;

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const record: MockRequestRecord = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(request.headers.entries()),
      body: null,
      rawBody: ''
    };
    requests.push(record);

    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await request.text();
      record.rawBody = raw;
      if (raw.length > 0) {
        try {
          record.body = JSON.parse(raw);
        } catch {
          record.body = null;
        }
      }
    }

    const routeKey = `${method} ${url.pathname}`;
    const failure = failWith[routeKey] ?? failWith[url.pathname];
    if (failure) return toResponse(normalizeFailureReply(failure));

    const route = routes[routeKey] ?? routes[url.pathname];
    if (route) {
      const reply = await route(record, server);
      if (reply) return toResponse(reply);
    }

    if (url.pathname === '/api/version' && method === 'GET') {
      return toResponse(jsonReply({ version }));
    }

    if (url.pathname === '/api/tags' && method === 'GET') {
      return toResponse(jsonReply(ollamaTagsPayload(models)));
    }

    if (url.pathname === '/api/chat' && method === 'POST') {
      if (options.chatHandler) {
        const reply = await options.chatHandler(record, server);
        if (reply) return toResponse(reply);
      }
      const body = (record.body ?? {}) as Record<string, unknown>;
      if (body.stream === true) {
        return toResponse(
          ndjsonReply([
            {
              model: body.model ?? 'llama3.1:8b',
              message: { role: 'assistant', content: 'Hel' },
              done: false
            },
            {
              model: body.model ?? 'llama3.1:8b',
              message: { role: 'assistant', content: 'lo' },
              done: false
            },
            {
              model: body.model ?? 'llama3.1:8b',
              message: { role: 'assistant', content: '' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 3,
              eval_count: 2
            }
          ])
        );
      }
      return toResponse(
        jsonReply({
          model: body.model ?? 'llama3.1:8b',
          message: { role: 'assistant', content: 'Hello' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 3,
          eval_count: 2
        })
      );
    }

    return new Response(JSON.stringify({ error: `no mock route for ${method} ${url.pathname}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  };

  bunServer = Bun.serve({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 0,
    fetch: handler
  });
  started = true;
  const assignedPort = bunServer.port ?? 0;
  server.port = assignedPort;
  server.url = `http://${options.hostname ?? '127.0.0.1'}:${assignedPort}`;
  return server;
}
