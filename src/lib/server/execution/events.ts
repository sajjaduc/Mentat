/**
 * Live execution events.
 *
 * Two layers, deliberately separate:
 *  1. **Persistence** — every event is appended to `run_events` inside the same
 *     transaction as the fact it describes. This is authoritative.
 *  2. **Fan-out** — an in-process pub/sub notifies SSE connections. It is a cache,
 *     never a source of truth: a client that misses events reconnects with
 *     `since` and replays from the table.
 *
 * This is what makes "browser disconnection never stops execution" true, and it
 * keeps the door open for a future multi-process deployment to replace only the
 * fan-out (PostgreSQL LISTEN/NOTIFY) without touching execution code.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import { type RunEvent, runEvents } from '../db/schema';

export const RunEventTypes = {
  runQueued: 'run.queued',
  runStarted: 'run.started',
  runDelta: 'run.output.delta',
  runReasoning: 'run.reasoning.delta',
  /** A configuration value was ignored rather than failing the run. */
  runWarning: 'run.warning',
  stepStarted: 'step.started',
  stepCompleted: 'step.completed',
  toolStarted: 'tool.started',
  toolCompleted: 'tool.completed',
  toolFailed: 'tool.failed',
  approvalRequested: 'approval.requested',
  approvalDecided: 'approval.decided',
  retryScheduled: 'retry.scheduled',
  stateTransition: 'state.transition',
  fieldChanged: 'ticket.field.changed',
  noteAdded: 'ticket.note.added',
  fileAttached: 'ticket.file.attached',
  runPaused: 'run.paused',
  runResumed: 'run.resumed',
  runCompleted: 'run.completed',
  runFailed: 'run.failed',
  runCancelled: 'run.cancelled',
  ticketUpdated: 'ticket.updated'
} as const;

export type RunEventType = (typeof RunEventTypes)[keyof typeof RunEventTypes] | (string & {});

export interface PublishRunEventInput {
  workspaceId: string;
  runId?: string | null;
  ticketId?: string | null;
  type: RunEventType;
  data?: unknown;
}

export interface PersistedRunEvent {
  seq: number;
  id: string;
  workspaceId: string;
  runId: string | null;
  ticketId: string | null;
  type: string;
  data: unknown;
  createdAt: number;
}

/** Append an event inside the caller's transaction and notify subscribers. */
export function publishRunEvent(
  db: Executor,
  input: PublishRunEventInput,
  now: number = Date.now()
): PersistedRunEvent {
  const inserted = db
    .insert(runEvents)
    .values({
      id: uuidv7(now),
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      ticketId: input.ticketId ?? null,
      type: input.type,
      data: (input.data ?? null) as never,
      createdAt: now
    })
    .returning({ seq: runEvents.seq, id: runEvents.id })
    .all();

  const row = inserted[0];
  const event: PersistedRunEvent = {
    seq: row?.seq ?? 0,
    id: row?.id ?? uuidv7(now),
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    ticketId: input.ticketId ?? null,
    type: input.type,
    data: input.data ?? null,
    createdAt: now
  };

  // Fan-out happens after the row exists; subscribers always see committed facts
  // first when they replay from the table.
  bus.emit(event);
  return event;
}

export interface RunEventFilter {
  workspaceId: string;
  runId?: string | null;
  ticketId?: string | null;
  types?: string[];
}

export type RunEventListener = (event: PersistedRunEvent) => void;

/**
 * In-process fan-out. Subscribers are keyed by workspace so a listener can never
 * observe another tenant's events.
 */
class RunEventBus {
  private readonly listeners = new Set<{ filter: RunEventFilter; listener: RunEventListener }>();

  subscribe(filter: RunEventFilter, listener: RunEventListener): () => void {
    const entry = { filter, listener };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  emit(event: PersistedRunEvent): void {
    for (const { filter, listener } of this.listeners) {
      if (filter.workspaceId !== event.workspaceId) continue;
      if (filter.runId !== undefined && filter.runId !== event.runId) continue;
      if (filter.ticketId !== undefined && filter.ticketId !== event.ticketId) continue;
      if (filter.types && !filter.types.includes(event.type)) continue;
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break execution.
      }
    }
  }

  /** Number of active subscribers — used by diagnostics and tests. */
  size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const bus = new RunEventBus();

/**
 * Replay events from persistence. `since` is exclusive, which lets a client
 * reconnect with the last sequence it processed and receive exactly the gap.
 */
export async function listRunEvents(
  db: Executor,
  options: {
    workspaceId: string;
    runId?: string;
    ticketId?: string;
    since?: number;
    limit?: number;
  }
): Promise<PersistedRunEvent[]> {
  const conditions = [eq(runEvents.workspaceId, options.workspaceId)];
  if (options.runId) conditions.push(eq(runEvents.runId, options.runId));
  if (options.ticketId) conditions.push(eq(runEvents.ticketId, options.ticketId));
  if (options.since !== undefined) conditions.push(gt(runEvents.seq, options.since));

  const rows: RunEvent[] = await db
    .select()
    .from(runEvents)
    .where(and(...conditions))
    .orderBy(asc(runEvents.seq))
    .limit(Math.min(options.limit ?? 500, 2000))
    .all();

  return rows.map((row) => ({
    seq: row.seq,
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    ticketId: row.ticketId,
    type: row.type,
    data: row.data,
    createdAt: row.createdAt
  }));
}
