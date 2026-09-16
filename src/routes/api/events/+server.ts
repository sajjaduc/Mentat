/**
 * Live execution stream (SSE).
 *
 * The stream is a *view over persisted facts*: when a client connects it replays
 * everything after `since` from `run_events`, then subscribes to the in-process
 * bus for new events. A browser disconnect therefore never stops or loses work —
 * reconnecting with the last sequence number receives exactly the gap.
 *
 * `since=0` means "from now": replaying an entire workspace's history into a fresh
 * browser tab would be wasteful, so the default resumes from the current head.
 */
import type { RequestHandler } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { moduleLogger } from '$server/core/logger';
import { bus, listRunEvents, type PersistedRunEvent } from '$server/execution/events';
import { resolveRequestContext } from '$server/request-context';

const log = moduleLogger('sse');

const HEARTBEAT_MS = 20_000;

export const GET: RequestHandler = async (event) => {
  const context = await resolveRequestContext(event);
  if (!context.actor) {
    return new Response('Unauthorized', { status: 401 });
  }
  const actor = context.actor;

  const url = event.url;
  const runId = url.searchParams.get('runId');
  const ticketId = url.searchParams.get('ticketId');
  const sinceParam = url.searchParams.get('since');
  const since =
    sinceParam === null ? await currentHead(context.db, actor.workspaceId) : Number(sinceParam);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown, id?: number) => {
        const lines: string[] = [];
        if (id !== undefined) lines.push(`id: ${id}`);
        lines.push(`data: ${JSON.stringify(payload)}`);
        controller.enqueue(encoder.encode(`${lines.join('\n')}\n\n`));
      };

      const sendEvent = (entry: PersistedRunEvent) => {
        send(
          {
            seq: entry.seq,
            type: entry.type,
            runId: entry.runId,
            ticketId: entry.ticketId,
            data: entry.data,
            createdAt: entry.createdAt
          },
          entry.seq
        );
      };

      // 1. Replay the gap from persistence (authoritative).
      try {
        const missed = await listRunEvents(context.db, {
          workspaceId: actor.workspaceId,
          runId: runId ?? undefined,
          ticketId: ticketId ?? undefined,
          since: Number.isFinite(since) ? since : 0,
          limit: 500
        });
        for (const entry of missed) sendEvent(entry);
        send({ type: 'stream.ready', replayed: missed.length });
      } catch (error) {
        log.warn('replay failed; continuing live', { error });
        send({ type: 'stream.ready', replayed: 0 });
      }

      // 2. Subscribe for new events.
      unsubscribe = bus.subscribe(
        {
          workspaceId: actor.workspaceId,
          runId: runId ?? undefined,
          ticketId: ticketId ?? undefined
        },
        sendEvent
      );

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // The client went away; cleanup happens in cancel().
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      log.debug('SSE client disconnected');
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
};

/**
 * Current head sequence for a workspace, so a fresh tab does not replay the whole
 * history. A single aggregate keeps this off the hot path.
 */
async function currentHead(
  db: Parameters<typeof listRunEvents>[0],
  workspaceId: string
): Promise<number> {
  const rows = await db.all<{ seq: number | null }>(
    sql`select max(seq) as seq from run_events where workspace_id = ${workspaceId}`
  );
  return rows[0]?.seq ?? 0;
}
