/**
 * Live execution feed.
 *
 * `EventSource` alone cannot honour ADR-0007: the server replays from the `since`
 * query parameter, while a browser reconnection sends `Last-Event-ID` instead. So
 * the stream is managed here — one connection at a time, re-opened with the
 * highest sequence already rendered, which means a dropout replays exactly the gap
 * and never a duplicate. Nothing polls.
 */
import type { WorkEvent } from '$ui/work/types';

export interface EventStreamOptions {
  workflowItemId?: string;
  runId?: string;
  /** Highest sequence already rendered; the server replays everything after it. */
  since?: number;
  onEvent: (event: WorkEvent) => void;
  onReady?: (info: { replayed: number }) => void;
  /** Called when the connection drops and a reconnect is scheduled. */
  onDisconnect?: () => void;
}

const MAX_BACKOFF_MS = 8000;

function parseEvent(raw: string): WorkEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'stream.ready') {
    return {
      seq: 0,
      type,
      runId: null,
      workflowItemId: null,
      data: { replayed: typeof record.replayed === 'number' ? record.replayed : 0 },
      createdAt: Date.now()
    };
  }
  return {
    seq: typeof record.seq === 'number' ? record.seq : 0,
    type,
    runId: typeof record.runId === 'string' ? record.runId : null,
    workflowItemId: typeof record.workflowItemId === 'string' ? record.workflowItemId : null,
    data: record.data,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now()
  };
}

/** Open a managed event stream. The returned function closes it for good. */
export function openEventStream(options: EventStreamOptions): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let attempt = 0;
  let lastSeq = options.since ?? 0;

  const connect = () => {
    if (closed) return;
    const params = new URLSearchParams();
    if (options.workflowItemId) params.set('workflowItemId', options.workflowItemId);
    if (options.runId) params.set('runId', options.runId);
    params.set('since', String(lastSeq));
    source = new EventSource(`/api/events?${params.toString()}`);

    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseEvent(message.data);
      if (!event) return;
      if (event.type === 'stream.ready') {
        attempt = 0;
        const replayed =
          typeof event.data === 'object' && event.data !== null
            ? Number((event.data as { replayed?: unknown }).replayed ?? 0)
            : 0;
        options.onReady?.({ replayed: Number.isFinite(replayed) ? replayed : 0 });
        return;
      }
      if (event.seq > lastSeq) lastSeq = event.seq;
      options.onEvent(event);
    };

    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      options.onDisconnect?.();
      const delay = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = null;
  };
}
