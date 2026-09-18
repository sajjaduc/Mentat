/**
 * Domain relationships between Records (ADR-0021).
 *
 * Deliberately separate from WorkflowItem relationships: `Business HAS_POLICY
 * Policy` is durable knowledge; `work item A BLOCKS work item B` is execution
 * context. Mixing them would make one impossible to reason about independently of
 * the other.
 */
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type RecordRelationship,
  type RecordRelationshipDefinition,
  recordRelationshipDefinitions,
  recordRelationships,
  records
} from '../db/schema';
import { requireObjectType } from './object-types';

export interface RelationshipDefinitionInput {
  sourceObjectTypeId: string;
  targetObjectTypeId?: string | null;
  key?: string | null;
  name: string;
  inverseName: string;
  cardinality?: 'one_to_one' | 'one_to_many' | 'many_to_many';
  description?: string | null;
}

export async function listRelationshipDefinitions(
  db: Executor,
  actor: ActorContext,
  objectTypeId?: string | null
): Promise<RecordRelationshipDefinition[]> {
  assertPermission(actor, Permissions.objectTypeRead, 'Not permitted to read object types');
  const conditions = [eq(recordRelationshipDefinitions.workspaceId, actor.workspaceId)];
  if (objectTypeId) {
    conditions.push(eq(recordRelationshipDefinitions.sourceObjectTypeId, objectTypeId));
  }
  return db
    .select()
    .from(recordRelationshipDefinitions)
    .where(and(...conditions))
    .orderBy(asc(recordRelationshipDefinitions.position))
    .all();
}

export function defineRelationship(
  db: Executor,
  actor: ActorContext,
  input: RelationshipDefinitionInput
): RecordRelationshipDefinition {
  assertPermission(actor, Permissions.objectTypeAdmin, 'Not permitted to define relationships');
  requireObjectType(db, actor.workspaceId, input.sourceObjectTypeId);
  if (input.targetObjectTypeId) {
    requireObjectType(db, actor.workspaceId, input.targetObjectTypeId);
  }
  const name = input.name.trim();
  const inverseName = input.inverseName.trim();
  if (name.length === 0 || inverseName.length === 0) {
    throw errors.validation('Relationship and inverse names are required');
  }
  const key = normalizeRelationshipKey(input.key ?? name, name);
  const existing = db
    .select()
    .from(recordRelationshipDefinitions)
    .where(
      and(
        eq(recordRelationshipDefinitions.workspaceId, actor.workspaceId),
        eq(recordRelationshipDefinitions.sourceObjectTypeId, input.sourceObjectTypeId),
        eq(recordRelationshipDefinitions.key, key)
      )
    )
    .all()[0];
  if (existing) throw errors.conflict(`Relationship "${key}" already exists`, { key });
  const now = Date.now();
  const inserted = db
    .insert(recordRelationshipDefinitions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      sourceObjectTypeId: input.sourceObjectTypeId,
      targetObjectTypeId: input.targetObjectTypeId ?? null,
      key,
      name,
      inverseName,
      cardinality: input.cardinality ?? 'many_to_many',
      description: input.description ?? null,
      position: 0,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.internal('Failed to create relationship definition');
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.objectTypeUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record_relationship_definition',
    entityId: inserted.id,
    summary: `Relationship ${inserted.name} → ${inserted.inverseName} defined`
  });
  return inserted;
}

export interface LinkRecordsInput {
  fromRecordId: string;
  toRecordId: string;
  /** Either the definition id or its key on the source Object Type. */
  definitionId?: string | null;
  definitionKey?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  runId?: string | null;
}

export function linkRecordsSync(
  tx: Executor,
  actor: ActorContext,
  input: LinkRecordsInput
): RecordRelationship {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to link records');
  if (input.fromRecordId === input.toRecordId) {
    throw errors.validation('A record cannot be related to itself');
  }
  const from = requireRecord(tx, actor.workspaceId, input.fromRecordId);
  const to = requireRecord(tx, actor.workspaceId, input.toRecordId);
  const definition = resolveDefinition(tx, actor.workspaceId, from.objectTypeId, input);
  const now = Date.now();
  const existing = tx
    .select()
    .from(recordRelationships)
    .where(
      and(
        eq(recordRelationships.fromRecordId, input.fromRecordId),
        eq(recordRelationships.toRecordId, input.toRecordId),
        eq(recordRelationships.definitionId, definition.id)
      )
    )
    .all()[0];
  if (existing) {
    if (existing.removedAt) {
      tx.update(recordRelationships)
        .set({ removedAt: null })
        .where(eq(recordRelationships.id, existing.id))
        .run();
    }
    return existing;
  }
  const inserted = tx
    .insert(recordRelationships)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      definitionId: definition.id,
      fromRecordId: input.fromRecordId,
      toRecordId: input.toRecordId,
      note: input.note ?? null,
      metadata: (input.metadata as never) ?? null,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdByLabel: actor.actorLabel,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.internal('Failed to link records');
  tx.update(records)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(or(eq(records.id, from.id), eq(records.id, to.id)))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordRelationshipAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: from.id,
    recordId: from.id,
    runId: input.runId ?? actor.runId ?? null,
    summary: `${from.displayName} ${definition.name} ${to.displayName}`,
    data: { definitionKey: definition.key, toRecordId: to.id }
  });
  return inserted;
}

export function unlinkRecordsSync(
  tx: Executor,
  actor: ActorContext,
  input: { relationshipId: string }
): void {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to unlink records');
  const existing = tx
    .select()
    .from(recordRelationships)
    .where(
      and(
        eq(recordRelationships.workspaceId, actor.workspaceId),
        eq(recordRelationships.id, input.relationshipId)
      )
    )
    .all()[0];
  if (!existing) throw errors.notFound('Record relationship', input.relationshipId);
  tx.delete(recordRelationships).where(eq(recordRelationships.id, existing.id)).run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordRelationshipRemoved,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: existing.fromRecordId,
    recordId: existing.fromRecordId,
    summary: 'Record relationship removed'
  });
}

export interface RelatedRecord {
  relationshipId: string;
  direction: 'outgoing' | 'incoming';
  definitionId: string;
  definitionKey: string;
  label: string;
  note: string | null;
  record: { id: string; displayName: string; objectTypeId: string; key: string | null };
  createdAt: number;
}

export async function listRecordRelationships(
  db: Executor,
  actor: ActorContext,
  recordId: string
): Promise<RelatedRecord[]> {
  assertPermission(actor, Permissions.recordRead, 'Not permitted to read records');
  requireRecord(db, actor.workspaceId, recordId);
  const rows = await db
    .select({
      relationship: recordRelationships,
      definition: recordRelationshipDefinitions,
      fromRecord: records
    })
    .from(recordRelationships)
    .innerJoin(
      recordRelationshipDefinitions,
      eq(recordRelationshipDefinitions.id, recordRelationships.definitionId)
    )
    .innerJoin(records, eq(records.id, recordRelationships.fromRecordId))
    .where(
      and(
        eq(recordRelationships.workspaceId, actor.workspaceId),
        eq(recordRelationships.fromRecordId, recordId),
        isNull(recordRelationships.removedAt)
      )
    )
    .all();
  const outgoing: RelatedRecord[] = rows.map((row) => ({
    relationshipId: row.relationship.id,
    direction: 'outgoing' as const,
    definitionId: row.definition.id,
    definitionKey: row.definition.key,
    label: row.definition.name,
    note: row.relationship.note,
    record: {
      id: row.relationship.toRecordId,
      displayName: '',
      objectTypeId: '',
      key: null as string | null
    },
    createdAt: row.relationship.createdAt
  }));
  const targetIds = outgoing.map((row) => row.record.id);
  if (targetIds.length > 0) {
    const targets = await db
      .select({
        id: records.id,
        displayName: records.displayName,
        objectTypeId: records.objectTypeId,
        key: records.key
      })
      .from(records)
      .where(and(eq(records.workspaceId, actor.workspaceId), inArray(records.id, targetIds)))
      .all();
    const byId = new Map(targets.map((target) => [target.id, target]));
    for (const row of outgoing) {
      const target = byId.get(row.record.id);
      if (target) row.record = target;
    }
  }

  const incomingRows = await db
    .select({
      relationship: recordRelationships,
      definition: recordRelationshipDefinitions,
      fromRecord: records
    })
    .from(recordRelationships)
    .innerJoin(
      recordRelationshipDefinitions,
      eq(recordRelationshipDefinitions.id, recordRelationships.definitionId)
    )
    .innerJoin(records, eq(records.id, recordRelationships.fromRecordId))
    .where(
      and(
        eq(recordRelationships.workspaceId, actor.workspaceId),
        eq(recordRelationships.toRecordId, recordId),
        isNull(recordRelationships.removedAt)
      )
    )
    .all();
  const incoming: RelatedRecord[] = incomingRows.map((row) => ({
    relationshipId: row.relationship.id,
    direction: 'incoming' as const,
    definitionId: row.definition.id,
    definitionKey: row.definition.key,
    label: row.definition.inverseName,
    note: row.relationship.note,
    record: {
      id: row.fromRecord.id,
      displayName: row.fromRecord.displayName,
      objectTypeId: row.fromRecord.objectTypeId,
      key: row.fromRecord.key
    },
    createdAt: row.relationship.createdAt
  }));

  return [...outgoing, ...incoming];
}

function resolveDefinition(
  tx: Executor,
  workspaceId: string,
  sourceObjectTypeId: string,
  input: LinkRecordsInput
): RecordRelationshipDefinition {
  if (input.definitionId) {
    const byId = tx
      .select()
      .from(recordRelationshipDefinitions)
      .where(
        and(
          eq(recordRelationshipDefinitions.workspaceId, workspaceId),
          eq(recordRelationshipDefinitions.id, input.definitionId)
        )
      )
      .all()[0];
    if (!byId) throw errors.notFound('Relationship definition', input.definitionId);
    return byId;
  }
  const key = input.definitionKey?.trim();
  if (!key) throw errors.validation('A relationship definition id or key is required');
  const byKey = tx
    .select()
    .from(recordRelationshipDefinitions)
    .where(
      and(
        eq(recordRelationshipDefinitions.workspaceId, workspaceId),
        eq(recordRelationshipDefinitions.sourceObjectTypeId, sourceObjectTypeId),
        eq(recordRelationshipDefinitions.key, key)
      )
    )
    .all()[0];
  if (!byKey) throw errors.notFound('Relationship definition', key);
  return byKey;
}

function requireRecord(tx: Executor, workspaceId: string, recordId: string) {
  const row = tx
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, workspaceId), eq(records.id, recordId)))
    .all()[0];
  if (!row) throw errors.notFound('Record', recordId);
  return row;
}

function normalizeRelationshipKey(input: string, fallback: string): string {
  const key = (input || fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (key.length < 2) throw errors.validation(`Invalid relationship key "${key}"`);
  return key;
}
