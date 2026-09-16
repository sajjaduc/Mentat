/**
 * HTTP service/operation/tool persistence.
 *
 * Repositories are deliberately dumb: they take a `workspaceId` and never check a
 * permission. That split is what makes tenant isolation auditable — *every* query in
 * this file filters by workspace, so a caller cannot forget, while policy (who may do
 * this) lives one layer up in `service.ts`.
 *
 * All functions are synchronous because `bun:sqlite` is; that is what lets the service
 * layer run a mutation and its audit row inside one `withTransaction` callback without
 * ever awaiting inside a transaction (ADR-0004).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import {
  type HttpOperation,
  type HttpService,
  httpOperations,
  httpServices,
  type NewHttpOperation,
  type NewHttpService,
  type Tool,
  tools
} from '../db/schema';

export interface ListServiceOptions {
  includeArchived?: boolean;
  workflowId?: string | null;
}

export function listServiceRows(
  db: Executor,
  workspaceId: string,
  options: ListServiceOptions = {}
): HttpService[] {
  const conditions = [eq(httpServices.workspaceId, workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(httpServices.archivedAt));
  if (options.workflowId !== undefined && options.workflowId !== null) {
    conditions.push(eq(httpServices.workflowId, options.workflowId));
  }
  return db
    .select()
    .from(httpServices)
    .where(and(...conditions))
    .orderBy(asc(httpServices.name))
    .all();
}

export function findServiceRow(
  db: Executor,
  workspaceId: string,
  serviceId: string
): HttpService | null {
  return (
    db
      .select()
      .from(httpServices)
      .where(and(eq(httpServices.workspaceId, workspaceId), eq(httpServices.id, serviceId)))
      .limit(1)
      .all()[0] ?? null
  );
}

export function findServiceRowByName(
  db: Executor,
  workspaceId: string,
  name: string,
  workflowId: string | null
): HttpService | null {
  const conditions = [
    eq(httpServices.workspaceId, workspaceId),
    eq(httpServices.name, name),
    isNull(httpServices.archivedAt)
  ];
  conditions.push(
    workflowId === null ? isNull(httpServices.workflowId) : eq(httpServices.workflowId, workflowId)
  );
  return (
    db
      .select()
      .from(httpServices)
      .where(and(...conditions))
      .limit(1)
      .all()[0] ?? null
  );
}

export function insertServiceRow(db: Executor, values: NewHttpService): HttpService {
  const row = db.insert(httpServices).values(values).returning().all()[0];
  if (!row) throw new Error('Failed to insert http_service row');
  return row;
}

export function updateServiceRow(
  db: Executor,
  workspaceId: string,
  serviceId: string,
  patch: Partial<NewHttpService>
): HttpService | null {
  return (
    db
      .update(httpServices)
      .set(patch)
      .where(and(eq(httpServices.workspaceId, workspaceId), eq(httpServices.id, serviceId)))
      .returning()
      .all()[0] ?? null
  );
}

export interface ListOperationOptions {
  includeArchived?: boolean;
  serviceId?: string;
  enabledOnly?: boolean;
}

export function listOperationRows(
  db: Executor,
  workspaceId: string,
  options: ListOperationOptions = {}
): HttpOperation[] {
  const conditions = [eq(httpOperations.workspaceId, workspaceId)];
  if (!options.includeArchived) conditions.push(isNull(httpOperations.archivedAt));
  if (options.serviceId) conditions.push(eq(httpOperations.serviceId, options.serviceId));
  if (options.enabledOnly) conditions.push(eq(httpOperations.enabled, true));
  return db
    .select()
    .from(httpOperations)
    .where(and(...conditions))
    .orderBy(asc(httpOperations.position), asc(httpOperations.key))
    .all();
}

export function findOperationRow(
  db: Executor,
  workspaceId: string,
  operationId: string
): HttpOperation | null {
  return (
    db
      .select()
      .from(httpOperations)
      .where(and(eq(httpOperations.workspaceId, workspaceId), eq(httpOperations.id, operationId)))
      .limit(1)
      .all()[0] ?? null
  );
}

export function findOperationRowByKey(
  db: Executor,
  workspaceId: string,
  key: string
): HttpOperation | null {
  return (
    db
      .select()
      .from(httpOperations)
      .where(and(eq(httpOperations.workspaceId, workspaceId), eq(httpOperations.key, key)))
      .limit(1)
      .all()[0] ?? null
  );
}

export function insertOperationRow(db: Executor, values: NewHttpOperation): HttpOperation {
  const row = db.insert(httpOperations).values(values).returning().all()[0];
  if (!row) throw new Error('Failed to insert http_operation row');
  return row;
}

export function updateOperationRow(
  db: Executor,
  workspaceId: string,
  operationId: string,
  patch: Partial<NewHttpOperation>
): HttpOperation | null {
  return (
    db
      .update(httpOperations)
      .set(patch)
      .where(and(eq(httpOperations.workspaceId, workspaceId), eq(httpOperations.id, operationId)))
      .returning()
      .all()[0] ?? null
  );
}

export function findToolRow(db: Executor, workspaceId: string, toolId: string): Tool | null {
  return (
    db
      .select()
      .from(tools)
      .where(and(eq(tools.workspaceId, workspaceId), eq(tools.id, toolId)))
      .limit(1)
      .all()[0] ?? null
  );
}

export function findToolRowByKey(db: Executor, workspaceId: string, key: string): Tool | null {
  return (
    db
      .select()
      .from(tools)
      .where(and(eq(tools.workspaceId, workspaceId), eq(tools.key, key)))
      .limit(1)
      .all()[0] ?? null
  );
}
