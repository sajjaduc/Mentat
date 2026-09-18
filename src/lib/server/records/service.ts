/**
 * Record service: durable domain objects of any Object Type (ADR-0021).
 *
 * Records hold identity, typed base fields, relationships, external ids and
 * durable notes. They never hold workflow/state/ownership — that is the job of a
 * WorkflowItem. A Record may have zero, one or many WorkflowItems.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions, systemActor } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import {
  counters,
  fileRecords,
  files,
  type ObjectType,
  type RecordNote,
  type RecordRow,
  recordExternalIds,
  recordFieldValues,
  recordNoteRevisions,
  recordNotes,
  records
} from '../db/schema';
import { publishRunEvent, RunEventTypes } from '../execution/events';
import { listWorkflowFields } from '../fields/service';
import {
  assertObjectTypeValuesValid,
  findObjectTypeByKey,
  listBaseFieldsSync as listBaseFieldsSync_imported,
  requireObjectType
} from './object-types';
import { defaultKeyPrefix, type EffectiveField } from './types';
import {
  assertRequiredRecordFieldsSatisfied,
  recordFieldValuesByKey,
  resolveRecordDefinitions,
  writeRecordFieldValues
} from './values';

export interface RecordProvenanceInput {
  sourceType?: string | null;
  sourceReference?: string | null;
  sourceLabel?: string | null;
  triggerId?: string | null;
  triggerEventId?: string | null;
  externalRef?: string | null;
}

export interface CreateRecordInput {
  objectTypeId?: string | null;
  objectTypeKey?: string | null;
  /** Optional explicit display name; otherwise derived from the primary field. */
  displayName?: string | null;
  fields?: Record<string, unknown>;
  structuredData?: Record<string, unknown>;
  externalIds?: Array<{
    system: string;
    externalId: string;
    label?: string | null;
    url?: string | null;
  }>;
  provenance?: RecordProvenanceInput | null;
}

export interface RecordSummary {
  id: string;
  objectTypeId: string;
  objectTypeKey: string;
  objectTypeName: string;
  displayName: string;
  key: string | null;
  number: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface RecordDetail extends RecordSummary {
  fields: Record<string, unknown>;
  effectiveFields: EffectiveField[];
  externalIds: Array<{
    id: string;
    system: string;
    externalId: string;
    label: string | null;
    url: string | null;
  }>;
  notes: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    authorLabel: string | null;
    body: string;
    createdAt: number;
    editedAt: number | null;
  }>;
  structuredData: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
}

export async function createRecord(
  db: Executor,
  actor: ActorContext,
  input: CreateRecordInput
): Promise<RecordRow> {
  return withTransaction(db, (tx) => createRecordSync(tx, actor, input));
}

export function createRecordSync(
  tx: Executor,
  actor: ActorContext,
  input: CreateRecordInput
): RecordRow {
  assertPermission(actor, Permissions.recordCreate, 'Not permitted to create records');
  const objectType = resolveObjectType(tx, actor.workspaceId, input);
  const explicitFields = input.fields ?? {};
  const normalized = applyIdentityDefaults(tx, objectType, explicitFields);
  // The Object Type's Zod source is authoritative for direct writes too, so a
  // create cannot persist a value the schema rejects.
  assertObjectTypeValuesValid(tx, actor.workspaceId, objectType, normalized);
  const row = insertRecordRow(tx, actor, objectType, input, normalized);
  const required = listBaseFieldsSync(tx, actor.workspaceId, objectType.id).filter(
    (field) => field.required
  );
  assertRequiredRecordFieldsSatisfied(tx, {
    workspaceId: actor.workspaceId,
    recordId: row.id,
    requiredFields: required
  });
  enforceIdentityUniqueness(tx, actor.workspaceId, objectType, row.id, normalized);
  for (const external of input.externalIds ?? []) {
    setExternalIdSync(tx, actor, {
      recordId: row.id,
      system: external.system,
      externalId: external.externalId,
      label: external.label ?? null,
      url: external.url ?? null
    });
  }
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: row.id,
    recordId: row.id,
    summary: `Record ${row.displayName} created`,
    data: { objectTypeKey: objectType.key, fields: Object.keys(normalized) }
  });
  publishRunEvent(tx, {
    workspaceId: actor.workspaceId,
    recordId: row.id,
    type: RunEventTypes.recordCreated,
    data: {
      objectTypeId: objectType.id,
      objectTypeKey: objectType.key,
      displayName: row.displayName
    }
  });
  return row;
}

function resolveObjectType(
  tx: Executor,
  workspaceId: string,
  input: CreateRecordInput
): ObjectType {
  if (input.objectTypeId) return requireObjectType(tx, workspaceId, input.objectTypeId);
  if (input.objectTypeKey) {
    const found = findObjectTypeByKey(tx, workspaceId, input.objectTypeKey);
    if (!found) throw errors.notFound('Object type', input.objectTypeKey);
    return found;
  }
  throw errors.validation('An Object Type is required to create a record');
}

function applyIdentityDefaults(
  tx: Executor,
  objectType: ObjectType,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const bindings = listBaseFieldsSync(tx, objectType.workspaceId, objectType.id);
  const result = { ...fields };
  for (const binding of bindings) {
    if (
      result[binding.key] === undefined &&
      binding.defaultValue !== null &&
      binding.defaultValue !== undefined
    ) {
      result[binding.key] = binding.defaultValue;
    }
  }
  return result;
}

function insertRecordRow(
  tx: Executor,
  actor: ActorContext,
  objectType: ObjectType,
  input: CreateRecordInput,
  fields: Record<string, unknown>
): RecordRow {
  const now = Date.now();
  const settings = (objectType.settings as Record<string, unknown> | null) ?? {};
  const numbered = settings.numbered === true;
  let key: string | null = null;
  let number: number | null = null;
  if (numbered) {
    number = nextCounterSync(tx, actor.workspaceId, `record:${objectType.id}`);
    const prefix =
      typeof settings.keyPrefix === 'string' && settings.keyPrefix.length > 0
        ? settings.keyPrefix
        : defaultKeyPrefix(objectType.key);
    key = `${prefix}-${number}`;
  }
  const displayName = deriveDisplayName(fields, input.displayName, key, objectType);
  const inserted = tx
    .insert(records)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      objectTypeId: objectType.id,
      displayName,
      key,
      number,
      version: 1,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdByLabel: actor.actorLabel,
      provenance: (input.provenance as never) ?? null,
      structuredData: (input.structuredData as never) ?? null,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.internal('Failed to create record');
  if (Object.keys(fields).length > 0) {
    writeRecordFieldValues(tx, {
      workspaceId: actor.workspaceId,
      recordId: inserted.id,
      objectTypeId: objectType.id,
      values: fields,
      actor,
      source: inferSource(actor),
      audit: false
    });
  }
  // An explicit displayName always wins; only records created without one have
  // their label derived from the Object Type's primary display field.
  const hasExplicitDisplayName =
    typeof input.displayName === 'string' && input.displayName.trim().length > 0;
  return {
    ...inserted,
    displayName: hasExplicitDisplayName
      ? inserted.displayName
      : refreshDisplayName(tx, actor.workspaceId, inserted.id, objectType)
  };
}

/** Counter allocation is synchronous so it can run inside a transaction body. */
function nextCounterSync(tx: Executor, workspaceId: string, name: string): number {
  const id = `${workspaceId}:${name}`;
  const bumped = tx
    .update(counters)
    .set({ value: sql`${counters.value} + 1`, updatedAt: Date.now() })
    .where(sql`${counters.workspaceId} = ${workspaceId} AND ${counters.name} = ${name}`)
    .returning({ value: counters.value })
    .all();
  if (bumped[0]) return bumped[0].value;
  const created = tx
    .insert(counters)
    .values({ id, workspaceId, name, value: 1, updatedAt: Date.now() })
    .returning({ value: counters.value })
    .all();
  if (created[0]) return created[0].value;
  const retried = tx
    .update(counters)
    .set({ value: sql`${counters.value} + 1`, updatedAt: Date.now() })
    .where(sql`${counters.workspaceId} = ${workspaceId} AND ${counters.name} = ${name}`)
    .returning({ value: counters.value })
    .all();
  if (retried[0]) return retried[0].value;
  throw errors.internal(`Failed to allocate counter ${name}`);
}

function deriveDisplayName(
  fields: Record<string, unknown>,
  explicit: string | null | undefined,
  key: string | null,
  objectType: ObjectType
): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim().slice(0, 500);
  const primaryKey = primaryFieldKey(objectType);
  const value = primaryKey ? fields[primaryKey] : undefined;
  if (value !== undefined && value !== null && String(value).trim().length > 0) {
    return String(value).trim().slice(0, 500);
  }
  return key ?? `Untitled ${objectType.name}`;
}

function primaryFieldKey(objectType: ObjectType): string | null {
  const settings = (objectType.settings as Record<string, unknown> | null) ?? {};
  return typeof settings.primaryFieldKey === 'string' ? settings.primaryFieldKey : null;
}

/** Recompute `displayName` from the primary display field, if one is bound. */
function refreshDisplayName(
  tx: Executor,
  workspaceId: string,
  recordId: string,
  objectType: ObjectType
): string {
  const bindings = listBaseFieldsSync(tx, workspaceId, objectType.id);
  const primary = bindings.find((field) => field.isPrimaryDisplay);
  if (!primary) {
    const current = tx
      .select({ displayName: records.displayName })
      .from(records)
      .where(eq(records.id, recordId))
      .all()[0];
    return current?.displayName ?? `Untitled ${objectType.name}`;
  }
  const values = recordFieldValuesByKey(tx, workspaceId, recordId);
  const value = values[primary.key];
  const displayName =
    value !== undefined && value !== null && String(value).trim().length > 0
      ? String(value).trim().slice(0, 500)
      : (`Untitled ${objectType.name}` as string);
  tx.update(records)
    .set({ displayName, updatedAt: Date.now() })
    .where(eq(records.id, recordId))
    .run();
  return displayName;
}

function listBaseFieldsSync(
  tx: Executor,
  workspaceId: string,
  objectTypeId: string
): EffectiveField[] {
  return listBaseFieldsSync_imported(tx, workspaceId, objectTypeId).map((field) => ({
    ...field,
    source: 'base' as const
  }));
}

function enforceIdentityUniqueness(
  tx: Executor,
  workspaceId: string,
  objectType: ObjectType,
  recordId: string,
  fields: Record<string, unknown>
): void {
  const identity = listBaseFieldsSync(tx, workspaceId, objectType.id).filter(
    (field) => field.isIdentity
  );
  if (identity.length === 0) return;
  for (const field of identity) {
    const value = fields[field.key];
    if (value === undefined || value === null || String(value).trim().length === 0) continue;
    const conflict = findRecordByFieldValue(tx, workspaceId, objectType.id, field, value, recordId);
    if (conflict) {
      throw errors.conflict(
        `${objectType.name} with ${field.name} "${String(value)}" already exists`,
        { fieldKey: field.key, existingRecordId: conflict.id, displayName: conflict.displayName }
      );
    }
  }
}

function findRecordByFieldValue(
  tx: Executor,
  workspaceId: string,
  objectTypeId: string,
  field: EffectiveField,
  value: unknown,
  excludeRecordId: string
): { id: string; displayName: string } | null {
  const text = String(value).trim();
  const rows = tx
    .select({ id: records.id, displayName: records.displayName })
    .from(records)
    .innerJoin(recordFieldValues, eq(recordFieldValues.recordId, records.id))
    .where(
      and(
        eq(records.workspaceId, workspaceId),
        eq(records.objectTypeId, objectTypeId),
        isNull(records.archivedAt),
        sql`${records.id} <> ${excludeRecordId}`,
        eq(recordFieldValues.fieldDefinitionId, field.fieldDefinitionId),
        sql`(${recordFieldValues.valueText} = ${text} OR ${recordFieldValues.searchText} = ${text.toLowerCase()})`
      )
    )
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function requireRecordRow(db: Executor, workspaceId: string, recordId: string): RecordRow {
  const row = db
    .select()
    .from(records)
    .where(and(eq(records.workspaceId, workspaceId), eq(records.id, recordId)))
    .all()[0];
  if (!row) throw errors.notFound('Record', recordId);
  return row;
}

export async function requireRecord(
  db: Executor,
  actor: ActorContext,
  recordId: string
): Promise<RecordSummary> {
  assertPermission(actor, Permissions.recordRead, 'Not permitted to read records');
  return summarize(db, requireRecordRow(db, actor.workspaceId, recordId));
}

export async function getRecordDetail(
  db: Executor,
  actor: ActorContext,
  recordId: string
): Promise<RecordDetail> {
  assertPermission(actor, Permissions.recordRead, 'Not permitted to read records');
  const row = requireRecordRow(db, actor.workspaceId, recordId);
  const objectType = requireObjectType(db, actor.workspaceId, row.objectTypeId);
  const effectiveFields = await listEffectiveFields(
    db,
    actor.workspaceId,
    objectType.id,
    null,
    null
  );
  const externalIds = db
    .select({
      id: recordExternalIds.id,
      system: recordExternalIds.system,
      externalId: recordExternalIds.externalId,
      label: recordExternalIds.label,
      url: recordExternalIds.url
    })
    .from(recordExternalIds)
    .where(
      and(
        eq(recordExternalIds.workspaceId, actor.workspaceId),
        eq(recordExternalIds.recordId, recordId)
      )
    )
    .orderBy(asc(recordExternalIds.system))
    .all();
  const notes = await listRecordNotes(db, actor, recordId);
  return {
    ...(await summarize(db, row)),
    fields: recordFieldValuesByKey(db, actor.workspaceId, recordId),
    effectiveFields,
    externalIds,
    notes: notes.map((note) => ({
      id: note.id,
      authorType: note.authorType,
      authorId: note.authorId,
      authorLabel: note.authorLabel,
      body: note.body,
      createdAt: note.createdAt,
      editedAt: note.editedAt
    })),
    structuredData: (row.structuredData as Record<string, unknown> | null) ?? null,
    provenance: (row.provenance as Record<string, unknown> | null) ?? null
  };
}

export async function summarize(db: Executor, row: RecordRow): Promise<RecordSummary> {
  const objectType = requireObjectType(db, row.workspaceId, row.objectTypeId);
  return {
    id: row.id,
    objectTypeId: row.objectTypeId,
    objectTypeKey: objectType.key,
    objectTypeName: objectType.name,
    displayName: row.displayName,
    key: row.key,
    number: row.number,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt
  };
}

/**
 * Effective schema = Object Type base fields plus (optionally) the Workflow
 * overlay fields for a given workflow, each marked with provenance.
 */
export async function listEffectiveFields(
  db: Executor,
  workspaceId: string,
  objectTypeId: string,
  workflowId: string | null,
  _stateId: string | null
): Promise<EffectiveField[]> {
  const base = listBaseFieldsSync(db, workspaceId, objectTypeId);
  if (!workflowId) return base;
  const overlays = await listWorkflowFields(
    db,
    systemActor(workspaceId, 'record-schema'),
    workflowId
  );
  const baseKeys = new Set(base.map((field) => field.key));
  const overlayFields: EffectiveField[] = overlays
    .filter((overlay) => !baseKeys.has(overlay.definition.key))
    .map((overlay) => ({
      bindingId: overlay.id,
      fieldDefinitionId: overlay.fieldDefinitionId,
      key: overlay.definition.key,
      name: overlay.definition.name,
      description: overlay.definition.description,
      type: overlay.definition.type,
      options: overlay.definition.options,
      validation: overlay.definition.validation,
      display: overlay.definition.display,
      required: overlay.required,
      isIdentity: false,
      isPrimaryDisplay: false,
      isSecondaryDisplay: false,
      showInList: overlay.showInList,
      showOnCard: overlay.showOnCard,
      filterable: overlay.filterable,
      position: 1000 + overlay.position,
      defaultValue: overlay.defaultValue,
      source: 'workflow' as const
    }));
  return [...base, ...overlayFields];
}

export interface UpdateRecordInput {
  recordId: string;
  fields?: Record<string, unknown>;
  structuredData?: Record<string, unknown>;
  displayName?: string | null;
  expectedVersion?: number | null;
  source?: 'human' | 'agent' | 'system' | 'extraction';
  runId?: string | null;
  /** Base fields that must be present after the update (state requirements). */
  requiredFieldKeys?: string[];
}

export interface UpdateRecordResult {
  record: RecordRow;
  changes: Array<{ key: string; previous: unknown; next: unknown }>;
}

export async function updateRecord(
  db: Executor,
  actor: ActorContext,
  input: UpdateRecordInput
): Promise<UpdateRecordResult> {
  return withTransaction(db, (tx) => updateRecordSync(tx, actor, input));
}

export function updateRecordSync(
  tx: Executor,
  actor: ActorContext,
  input: UpdateRecordInput
): UpdateRecordResult {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to update records');
  const current = requireRecordRow(tx, actor.workspaceId, input.recordId);
  if (input.expectedVersion != null && current.version !== input.expectedVersion) {
    throw errors.versionConflict('Record', input.expectedVersion, current.version);
  }
  const objectType = requireObjectType(tx, actor.workspaceId, current.objectTypeId);
  let changes: Array<{ key: string; previous: unknown; next: unknown }> = [];
  if (input.fields && Object.keys(input.fields).length > 0) {
    // Validate the values being written against the Object Type's Zod source
    // before they land, so a direct edit cannot persist a violation.
    assertObjectTypeValuesValid(tx, actor.workspaceId, objectType, input.fields);
    changes = writeRecordFieldValues(tx, {
      workspaceId: actor.workspaceId,
      recordId: current.id,
      objectTypeId: objectType.id,
      values: input.fields,
      actor,
      source: input.source,
      runId: input.runId
    });
  }
  if (input.requiredFieldKeys && input.requiredFieldKeys.length > 0) {
    const definitions = resolveRecordDefinitions(tx, actor.workspaceId, input.requiredFieldKeys);
    assertRequiredRecordFieldsSatisfied(tx, {
      workspaceId: actor.workspaceId,
      recordId: current.id,
      requiredFields: definitions.map((definition) => ({
        key: definition.key,
        name: definition.name
      }))
    });
  }
  const now = Date.now();
  let displayName = current.displayName;
  if (input.displayName && input.displayName.trim().length > 0) {
    displayName = input.displayName.trim().slice(0, 500);
  } else if (changes.length > 0) {
    displayName = refreshDisplayName(tx, actor.workspaceId, current.id, objectType);
  }
  const updated = tx
    .update(records)
    .set({
      displayName,
      structuredData:
        input.structuredData === undefined
          ? current.structuredData
          : ((input.structuredData as never) ?? null),
      version: current.version + 1,
      lastActivityAt: now,
      updatedAt: now
    })
    .where(eq(records.id, current.id))
    .returning()
    .all()[0];
  if (!updated) throw errors.internal('Failed to update record');
  if (changes.length > 0) {
    publishRunEvent(tx, {
      workspaceId: actor.workspaceId,
      recordId: updated.id,
      type: RunEventTypes.recordFieldChanged,
      data: { changes }
    });
  }
  return { record: updated, changes };
}

export async function archiveRecord(
  db: Executor,
  actor: ActorContext,
  recordId: string
): Promise<void> {
  assertPermission(actor, Permissions.recordDelete, 'Not permitted to archive records');
  await withTransaction(db, (tx) => {
    const current = requireRecordRow(tx, actor.workspaceId, recordId);
    tx.update(records)
      .set({
        archivedAt: Date.now(),
        archivedByType: actor.actorType,
        archivedById: actor.actorId,
        updatedAt: Date.now()
      })
      .where(eq(records.id, current.id))
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.recordArchived,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'record',
      entityId: current.id,
      recordId: current.id,
      summary: `Record ${current.displayName} archived`
    });
    publishRunEvent(tx, {
      workspaceId: actor.workspaceId,
      recordId: current.id,
      type: RunEventTypes.recordArchived
    });
  });
}

// ---------------------------------------------------------------------------
// External identities
// ---------------------------------------------------------------------------

export function setExternalIdSync(
  tx: Executor,
  actor: ActorContext,
  input: {
    recordId: string;
    system: string;
    externalId: string;
    label?: string | null;
    url?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): void {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to link external ids');
  const system = input.system.trim();
  const externalId = input.externalId.trim();
  if (system.length === 0 || externalId.length === 0) {
    throw errors.validation('External id requires both a system and an id');
  }
  const existing = tx
    .select()
    .from(recordExternalIds)
    .where(
      and(
        eq(recordExternalIds.workspaceId, actor.workspaceId),
        eq(recordExternalIds.system, system),
        eq(recordExternalIds.externalId, externalId)
      )
    )
    .all()[0];
  const now = Date.now();
  if (existing) {
    if (existing.recordId !== input.recordId) {
      throw errors.conflict(`${system} id "${externalId}" is already linked to another record`, {
        recordId: existing.recordId
      });
    }
    tx.update(recordExternalIds)
      .set({
        label: input.label ?? existing.label,
        url: input.url ?? existing.url,
        metadata: (input.metadata as never) ?? existing.metadata,
        updatedAt: now
      })
      .where(eq(recordExternalIds.id, existing.id))
      .run();
    return;
  }
  tx.insert(recordExternalIds)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      recordId: input.recordId,
      system,
      externalId,
      label: input.label ?? null,
      url: input.url ?? null,
      metadata: (input.metadata as never) ?? null,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      createdAt: now,
      updatedAt: now
    })
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordExternalIdSet,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: input.recordId,
    recordId: input.recordId,
    summary: `External id ${system}:${externalId} linked`,
    data: { system, externalId }
  });
}

export function removeExternalIdSync(
  tx: Executor,
  actor: ActorContext,
  input: { recordId: string; externalIdRowId: string }
): void {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to unlink external ids');
  const existing = tx
    .select()
    .from(recordExternalIds)
    .where(
      and(
        eq(recordExternalIds.workspaceId, actor.workspaceId),
        eq(recordExternalIds.recordId, input.recordId),
        eq(recordExternalIds.id, input.externalIdRowId)
      )
    )
    .all()[0];
  if (!existing) throw errors.notFound('External id', input.externalIdRowId);
  tx.delete(recordExternalIds).where(eq(recordExternalIds.id, existing.id)).run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordExternalIdRemoved,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: input.recordId,
    recordId: input.recordId,
    summary: `External id ${existing.system}:${existing.externalId} unlinked`
  });
}

/** Resolve a record through a first-class external identity. */
export async function resolveRecordByExternalId(
  db: Executor,
  actor: ActorContext,
  system: string,
  externalId: string
): Promise<RecordSummary | null> {
  assertPermission(actor, Permissions.recordRead, 'Not permitted to read records');
  const row = db
    .select({ record: records })
    .from(recordExternalIds)
    .innerJoin(records, eq(records.id, recordExternalIds.recordId))
    .where(
      and(
        eq(recordExternalIds.workspaceId, actor.workspaceId),
        eq(recordExternalIds.system, system),
        eq(recordExternalIds.externalId, externalId),
        isNull(records.archivedAt)
      )
    )
    .all()[0];
  return row ? summarize(db, row.record) : null;
}

// ---------------------------------------------------------------------------
// Record notes (durable knowledge about the thing)
// ---------------------------------------------------------------------------

export async function addRecordNote(
  db: Executor,
  actor: ActorContext,
  input: { recordId: string; body: string; isSystem?: boolean; runId?: string | null }
): Promise<{ noteId: string }> {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to add record notes');
  const note = await withTransaction(db, (tx) => addRecordNoteSync(tx, actor, input));
  return note;
}

export function addRecordNoteSync(
  tx: Executor,
  actor: ActorContext,
  input: { recordId: string; body: string; isSystem?: boolean; runId?: string | null }
): { noteId: string } {
  const body = input.body.trim();
  if (body.length === 0) throw errors.validation('Note body is required');
  requireRecordRow(tx, actor.workspaceId, input.recordId);
  const now = Date.now();
  const id = uuidv7(now);
  tx.insert(recordNotes)
    .values({
      id,
      workspaceId: actor.workspaceId,
      recordId: input.recordId,
      authorType: actor.actorType,
      authorId: actor.actorId,
      authorLabel: actor.actorLabel,
      body,
      isSystem: input.isSystem ?? false,
      runId: input.runId ?? actor.runId ?? null,
      createdAt: now
    })
    .run();
  tx.update(records)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(eq(records.id, input.recordId))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordNoteAdded,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: input.recordId,
    recordId: input.recordId,
    runId: input.runId ?? actor.runId ?? null,
    summary: 'Record note added'
  });
  return { noteId: id };
}

/** Durable File links for a Record (evidence/knowledge, not work context). */
export async function listRecordFiles(
  db: Executor,
  actor: ActorContext,
  recordId: string
): Promise<
  Array<{
    id: string;
    fileId: string;
    relationship: string;
    caption: string | null;
    filename: string;
    mimeType: string;
    size: number;
    status: string;
    summary: string | null;
    createdAt: number;
  }>
> {
  assertPermission(actor, Permissions.recordRead, 'Not permitted to read records');
  requireRecordRow(db, actor.workspaceId, recordId);
  return db
    .select({
      id: fileRecords.id,
      fileId: fileRecords.fileId,
      relationship: fileRecords.relationship,
      caption: fileRecords.caption,
      filename: files.originalFilename,
      mimeType: files.mimeType,
      size: files.size,
      status: files.status,
      summary: files.summary,
      createdAt: fileRecords.createdAt
    })
    .from(fileRecords)
    .innerJoin(files, eq(files.id, fileRecords.fileId))
    .where(
      and(
        eq(fileRecords.workspaceId, actor.workspaceId),
        eq(fileRecords.recordId, recordId),
        isNull(fileRecords.removedAt),
        isNull(files.deletedAt)
      )
    )
    .orderBy(desc(fileRecords.createdAt))
    .all();
}

export async function listRecordNotes(
  db: Executor,
  actor: ActorContext,
  recordId: string
): Promise<RecordNote[]> {
  assertPermission(actor, Permissions.recordRead, 'Not permitted to read records');
  requireRecordRow(db, actor.workspaceId, recordId);
  return db
    .select()
    .from(recordNotes)
    .where(
      and(
        eq(recordNotes.workspaceId, actor.workspaceId),
        eq(recordNotes.recordId, recordId),
        isNull(recordNotes.deletedAt)
      )
    )
    .orderBy(desc(recordNotes.createdAt))
    .all();
}

export function editRecordNoteSync(
  tx: Executor,
  actor: ActorContext,
  input: { noteId: string; body: string }
): void {
  assertPermission(actor, Permissions.recordWrite, 'Not permitted to edit record notes');
  const existing = tx
    .select()
    .from(recordNotes)
    .where(and(eq(recordNotes.workspaceId, actor.workspaceId), eq(recordNotes.id, input.noteId)))
    .all()[0];
  if (!existing) throw errors.notFound('Record note', input.noteId);
  const body = input.body.trim();
  if (body.length === 0) throw errors.validation('Note body is required');
  const now = Date.now();
  tx.insert(recordNoteRevisions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      noteId: existing.id,
      body: existing.body,
      editedByType: actor.actorType,
      editedById: actor.actorId,
      createdAt: now
    })
    .run();
  tx.update(recordNotes)
    .set({
      body,
      editedAt: now,
      editedByType: actor.actorType,
      editedById: actor.actorId
    })
    .where(eq(recordNotes.id, existing.id))
    .run();
  writeAudit(tx, {
    workspaceId: actor.workspaceId,
    action: AuditActions.recordNoteEdited,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'record',
    entityId: existing.recordId,
    recordId: existing.recordId,
    summary: 'Record note edited'
  });
}

export function inferSource(actor: ActorContext): 'human' | 'agent' | 'system' | 'extraction' {
  if (actor.actorType === 'agent') return 'agent';
  if (actor.actorType === 'user') return 'human';
  if (actor.actorType === 'extraction') return 'extraction';
  return 'system';
}
