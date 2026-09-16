/**
 * Append-only audit ledger.
 *
 * `writeAudit` is synchronous and takes an `Executor` so that the ledger row is
 * committed in the *same transaction* as the domain change it describes. A domain
 * write that succeeds without its audit row is a bug, and this API makes that
 * impossible to express by accident.
 *
 * Everything written here is redacted first, using both structural rules and the
 * process-wide secret registry.
 */
import { and, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import type { Executor } from '../db/client';
import type { ActorType } from '../db/schema';
import { type AuditAction, type AuditEvent, auditEvents } from '../db/schema';

// Canonical action names live with the schema so every module shares one list.
export { AuditActions } from '../db/schema/audit';

export interface AuditInput {
  /** Null for platform-level events that belong to no tenant. */
  workspaceId: string | null;
  action: AuditAction;
  actorType?: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ticketId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  fileId?: string | null;
  approvalId?: string | null;
  summary?: string | null;
  data?: unknown;
  occurredAt?: number;
}

/**
 * Write one ledger row inside the caller's transaction.
 * Returns the sequence ordinal so callers can stream/tail deterministically.
 */
export function writeAudit(executor: Executor, input: AuditInput): number {
  const redactor = createRedactor(registeredSecretValues());
  const now = input.occurredAt ?? Date.now();
  const rows = executor
    .insert(auditEvents)
    .values({
      workspaceId: input.workspaceId,
      action: input.action,
      actorType: input.actorType ?? 'system',
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ? redactor.string(input.actorLabel) : null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      ticketId: input.ticketId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      jobId: input.jobId ?? null,
      fileId: input.fileId ?? null,
      approvalId: input.approvalId ?? null,
      summary: input.summary ? redactor.string(input.summary) : null,
      data: input.data === undefined ? null : (redactor.value(input.data) as never),
      occurredAt: now,
      createdAt: now
    })
    .returning({ seq: auditEvents.seq })
    .all();
  return rows[0]?.seq ?? 0;
}

export interface AuditQuery {
  workspaceId: string;
  ticketId?: string;
  entityType?: string;
  entityId?: string;
  runId?: string;
  fileId?: string;
  actions?: string[];
  actorType?: ActorType;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: number;
  order?: 'asc' | 'desc';
}

/** Keyset-paginated ledger query. Ordered by the monotonic `seq` ordinal. */
export async function queryAudit(executor: Executor, query: AuditQuery): Promise<AuditEvent[]> {
  const conditions: SQL[] = [eq(auditEvents.workspaceId, query.workspaceId)];
  if (query.ticketId) conditions.push(eq(auditEvents.ticketId, query.ticketId));
  if (query.entityType) conditions.push(eq(auditEvents.entityType, query.entityType));
  if (query.entityId) conditions.push(eq(auditEvents.entityId, query.entityId));
  if (query.runId) conditions.push(eq(auditEvents.runId, query.runId));
  if (query.fileId) conditions.push(eq(auditEvents.fileId, query.fileId));
  if (query.actorType) conditions.push(eq(auditEvents.actorType, query.actorType));
  if (query.actions && query.actions.length > 0) {
    conditions.push(inArray(auditEvents.action, query.actions));
  }
  if (query.since !== undefined) conditions.push(gte(auditEvents.seq, query.since));
  if (query.until !== undefined) conditions.push(lte(auditEvents.seq, query.until));
  if (query.cursor !== undefined) {
    conditions.push(
      query.order === 'asc'
        ? sql`${auditEvents.seq} > ${query.cursor}`
        : sql`${auditEvents.seq} < ${query.cursor}`
    );
  }

  const order = query.order ?? 'desc';
  return executor
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(order === 'asc' ? auditEvents.seq : desc(auditEvents.seq))
    .limit(Math.min(query.limit ?? 100, 500))
    .all();
}

/** Count ledger rows matching a filter; used by ticket/analytics summaries. */
export async function countAudit(executor: Executor, query: AuditQuery): Promise<number> {
  const conditions: SQL[] = [eq(auditEvents.workspaceId, query.workspaceId)];
  if (query.ticketId) conditions.push(eq(auditEvents.ticketId, query.ticketId));
  if (query.actions && query.actions.length > 0) {
    conditions.push(inArray(auditEvents.action, query.actions));
  }
  const rows = await executor
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(and(...conditions))
    .all();
  return rows[0]?.count ?? 0;
}
