/**
 * Local mock upstream server for HTTP integration tests.
 *
 * Real sockets are the only way to exercise the runtime honestly: timeout, retry and
 * `Retry-After` behaviour all depend on how `fetch` reacts to a real response stream,
 * and a stubbed `fetch` would test the stub instead of the runtime. `Bun.serve` on
 * port 0 gives an ephemeral loopback port, so tests never collide.
 *
 * The server records what it received, tracks peak in-flight requests (for concurrency
 * assertions) and lets each test install a handler that can vary by request index.
 * Every test that starts a server must stop it with `server.stop()` in a `finally`.
 */
export interface MockRequestRecord {
  index: number;
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type MockHandler = (
  request: Request,
  record: MockRequestRecord,
  index: number
) => Response | Promise<Response>;

export interface MockHttpServer {
  /** Base URL, e.g. `http://127.0.0.1:53421`. */
  url: string;
  port: number;
  /** Every request the server has received, in order. */
  requests: MockRequestRecord[];
  /** Current number of requests inside the handler. */
  inFlight: number;
  /** Peak concurrent requests observed. */
  maxInFlight: number;
  setHandler(handler: MockHandler): void;
  lastRequest(): MockRequestRecord | undefined;
  stop(): Promise<void>;
}

export interface MockServerOptions {
  handler?: MockHandler;
}

/** Accepts either a bare handler or an options object, so tests stay terse. */
export function startMockServer(options: MockServerOptions | MockHandler = {}): MockHttpServer {
  const requests: MockRequestRecord[] = [];
  let handler: MockHandler =
    typeof options === 'function'
      ? options
      : (options.handler ??
        ((_request, record) =>
          Response.json({
            ok: true,
            method: record.method,
            path: record.path,
            index: record.index
          })));
  let inFlight = 0;
  let maxInFlight = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: MockRequestRecord = {
        index: requests.length,
        method: request.method,
        path: url.pathname,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text()
      };
      requests.push(record);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await handler(request, record, record.index);
      } finally {
        inFlight -= 1;
      }
    }
  });

  const port = server.port;
  if (port === undefined) throw new Error('Mock server failed to bind a port');

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    setHandler(next: MockHandler) {
      handler = next;
    },
    lastRequest() {
      return requests[requests.length - 1];
    },
    async stop() {
      await server.stop(true);
    }
  };
}

/** JSON response helper that keeps handlers terse. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}
