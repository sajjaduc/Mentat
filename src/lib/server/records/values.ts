/**
 * Record field-value persistence: the durable (base) half of the one field engine.
 *
 * Mirrors `tickets/values.ts` deliberately: the typed columns, normalization and
 * history append are identical, so validation cannot diverge between a Ticket and
 * any other Object Type.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type FieldChange,
  type FieldDefinition,
  fieldDefinitions,
  fieldValueHistory,
  recordFieldValues
} from '../db/schema';
import {
  EMPTY_FIELD_VALUE,
  isFieldEmpty,
  type NormalizedFieldValue,
  normalizedFromColumns,
  normalizeFieldValue
} from '../fields/values';

export interface WriteRecordFieldOptions {
  workspaceId: string;
  recordId: string;
  objectTypeId: string;
  values: Record<string, unknown>;
  actor: ActorContext;
  source?: 'human' | 'agent' | 'system' | 'extraction';
  runId?: string | null;
  /** Bypass object-type policy (system/migration writes). */
  force?: boolean;
  audit?: boolean;
}

/** Upsert typed base values and append history atomically inside a transaction. */
export function writeRecordFieldValues(
  tx: Executor,
  options: WriteRecordFieldOptions
): FieldChange[] {
  const keys = Object.keys(options.values);
  if (keys.length === 0) return [];

  const definitions = resolveRecordDefinitions(tx, options.workspaceId, keys);
  const bound = new Set(
    tx
      .select({ fieldDefinitionId: recordFieldValues.fieldDefinitionId })
      .from(recordFieldValues)
      .where(eq(recordFieldValues.recordId, options.recordId))
      .all()
      .map((row) => row.fieldDefinitionId)
  );

  const existing = readRawValues(tx, options.workspaceId, options.recordId, definitions);
  const changes: FieldChange[] = [];
  const now = Date.now();
  const source = options.source ?? inferSource(options.actor);

  for (const definition of definitions) {
    const previous = toStoredShape(existing.get(definition.id));
    const normalized = normalizeFieldValue(definition, options.values[definition.key]);
    if (sameValue(previous, normalized)) continue;

    const change: FieldChange = {
      fieldDefinitionId: definition.id,
      key: definition.key,
      name: definition.name,
      previous: previous.display,
      next: normalized.display
    };

    if (isFieldEmpty(normalized)) {
      tx.delete(recordFieldValues)
        .where(
          and(
            eq(recordFieldValues.recordId, options.recordId),
            eq(recordFieldValues.fieldDefinitionId, definition.id)
          )
        )
        .run();
    } else {
      const row = {
        valueText: normalized.valueText,
        valueNumber: normalized.valueNumber,
        valueBool: normalized.valueBool,
        valueDate: normalized.valueDate,
        valueJson: (normalized.valueJson ?? null) as never,
        searchText: normalized.searchText,
        updatedByType: options.actor.actorType,
        updatedById: options.actor.actorId,
        updatedAt: now
      };
      if (bound.has(definition.id)) {
        tx.update(recordFieldValues)
          .set(row)
          .where(
            and(
              eq(recordFieldValues.recordId, options.recordId),
              eq(recordFieldValues.fieldDefinitionId, definition.id)
            )
          )
          .run();
      } else {
        tx.insert(recordFieldValues)
          .values({
            id: uuidv7(now),
            workspaceId: options.workspaceId,
            recordId: options.recordId,
            fieldDefinitionId: definition.id,
            ...row
          })
          .run();
      }
    }

    tx.insert(fieldValueHistory)
      .values({
        id: uuidv7(now),
        workspaceId: options.workspaceId,
        ownerType: 'record',
        ownerId: options.recordId,
        fieldDefinitionId: definition.id,
        workflowId: null,
        previousValue: previous.display as never,
        newValue: normalized.display as never,
        actorType: options.actor.actorType,
        actorId: options.actor.actorId,
        actorLabel: options.actor.actorLabel,
        runId: options.runId ?? options.actor.runId ?? null,
        source,
        createdAt: now
      })
      .run();

    changes.push(change);
  }

  if (changes.length > 0 && options.audit !== false) {
    const single = changes.length === 1 ? changes[0] : null;
    writeAudit(tx, {
      workspaceId: options.workspaceId,
      action: single ? AuditActions.recordFieldChanged : AuditActions.recordFieldsChanged,
      actorType: options.actor.actorType,
      actorId: options.actor.actorId,
      actorLabel: options.actor.actorLabel,
      entityType: 'record',
      entityId: options.recordId,
      recordId: options.recordId,
      runId: options.runId ?? options.actor.runId ?? null,
      summary: single ? `Field ${single.name} changed` : `${changes.length} record fields changed`,
      data: {
        source,
        changes: changes.map((change) => ({
          fieldKey: change.key,
          previous: change.previous,
          next: change.next
        }))
      }
    });
  }

  return changes;
}

export function resolveRecordDefinitions(
  tx: Executor,
  workspaceId: string,
  keys: string[]
): FieldDefinition[] {
  const unique = [...new Set(keys.filter((key) => key.trim().length > 0))];
  if (unique.length === 0) return [];
  const byKey = new Map(
    tx
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.scope, 'record'),
          inArray(fieldDefinitions.key, unique)
        )
      )
      .all()
      .map((definition) => [definition.key, definition])
  );
  const byId = new Map(
    tx
      .select()
      .from(fieldDefinitions)
      .where(
        and(eq(fieldDefinitions.workspaceId, workspaceId), inArray(fieldDefinitions.id, unique))
      )
      .all()
      .map((definition) => [definition.id, definition])
  );

  const resolved: FieldDefinition[] = [];
  const missing: string[] = [];
  for (const key of unique) {
    const definition = byKey.get(key) ?? byId.get(key);
    if (!definition) missing.push(key);
    else resolved.push(definition);
  }
  if (missing.length > 0) {
    throw errors.validation(`Unknown record field key(s): ${missing.join(', ')}`, { missing });
  }
  return resolved;
}

interface StoredValueRow {
  fieldDefinitionId: string;
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: number | null;
  valueJson: unknown;
}

function readRawValues(
  tx: Executor,
  workspaceId: string,
  recordId: string,
  definitions: FieldDefinition[]
): Map<string, StoredValueRow> {
  if (definitions.length === 0) return new Map();
  const rows = tx
    .select({
      fieldDefinitionId: recordFieldValues.fieldDefinitionId,
      valueText: recordFieldValues.valueText,
      valueNumber: recordFieldValues.valueNumber,
      valueBool: recordFieldValues.valueBool,
      valueDate: recordFieldValues.valueDate,
      valueJson: recordFieldValues.valueJson
    })
    .from(recordFieldValues)
    .where(
      and(
        eq(recordFieldValues.workspaceId, workspaceId),
        eq(recordFieldValues.recordId, recordId),
        inArray(
          recordFieldValues.fieldDefinitionId,
          definitions.map((definition) => definition.id)
        )
      )
    )
    .all();
  return new Map(rows.map((row) => [row.fieldDefinitionId, row as StoredValueRow]));
}

function toStoredShape(row: StoredValueRow | undefined): NormalizedFieldValue {
  if (!row) return EMPTY_FIELD_VALUE;
  return normalizedFromColumns(row);
}

function sameValue(a: NormalizedFieldValue, b: NormalizedFieldValue): boolean {
  return (
    a.valueText === b.valueText &&
    a.valueNumber === b.valueNumber &&
    a.valueBool === b.valueBool &&
    a.valueDate === b.valueDate &&
    JSON.stringify(a.valueJson ?? null) === JSON.stringify(b.valueJson ?? null)
  );
}

export function readRecordFieldValues(
  db: Executor,
  workspaceId: string,
  recordId: string
): Map<string, NormalizedFieldValue> {
  const rows = db
    .select({
      fieldDefinitionId: recordFieldValues.fieldDefinitionId,
      valueText: recordFieldValues.valueText,
      valueNumber: recordFieldValues.valueNumber,
      valueBool: recordFieldValues.valueBool,
      valueDate: recordFieldValues.valueDate,
      valueJson: recordFieldValues.valueJson
    })
    .from(recordFieldValues)
    .where(
      and(eq(recordFieldValues.workspaceId, workspaceId), eq(recordFieldValues.recordId, recordId))
    )
    .all();
  return new Map(
    rows.map((row) => [row.fieldDefinitionId, normalizedFromColumns(row as StoredValueRow)])
  );
}

export function recordFieldValuesByKey(
  db: Executor,
  workspaceId: string,
  recordId: string
): Record<string, unknown> {
  const rows = db
    .select({ key: fieldDefinitions.key, value: recordFieldValues })
    .from(recordFieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, recordFieldValues.fieldDefinitionId))
    .where(
      and(eq(recordFieldValues.workspaceId, workspaceId), eq(recordFieldValues.recordId, recordId))
    )
    .all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = storedDisplay(row.value);
  }
  return result;
}

function storedDisplay(row: {
  valueText: string | null;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueDate: number | null;
  valueJson: unknown;
}): unknown {
  return (
    row.valueText ?? row.valueNumber ?? row.valueBool ?? row.valueDate ?? row.valueJson ?? null
  );
}

export async function recordFieldHistory(
  db: Executor,
  workspaceId: string,
  recordId: string,
  options: { limit?: number; fieldDefinitionId?: string } = {}
) {
  const conditions = [
    eq(fieldValueHistory.workspaceId, workspaceId),
    eq(fieldValueHistory.ownerType, 'record'),
    eq(fieldValueHistory.ownerId, recordId)
  ];
  if (options.fieldDefinitionId) {
    conditions.push(eq(fieldValueHistory.fieldDefinitionId, options.fieldDefinitionId));
  }
  return db
    .select({
      id: fieldValueHistory.id,
      fieldDefinitionId: fieldValueHistory.fieldDefinitionId,
      fieldKey: fieldDefinitions.key,
      fieldName: fieldDefinitions.name,
      previousValue: fieldValueHistory.previousValue,
      newValue: fieldValueHistory.newValue,
      actorType: fieldValueHistory.actorType,
      actorLabel: fieldValueHistory.actorLabel,
      runId: fieldValueHistory.runId,
      source: fieldValueHistory.source,
      createdAt: fieldValueHistory.createdAt
    })
    .from(fieldValueHistory)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValueHistory.fieldDefinitionId))
    .where(and(...conditions))
    .orderBy(asc(fieldValueHistory.createdAt))
    .limit(Math.min(options.limit ?? 200, 500))
    .all();
}

export function assertRequiredRecordFieldsSatisfied(
  db: Executor,
  options: {
    workspaceId: string;
    recordId: string;
    requiredFields: Array<{ key: string; name: string }>;
  }
): void {
  if (options.requiredFields.length === 0) return;
  const values = recordFieldValuesByKey(db, options.workspaceId, options.recordId);
  const missing = options.requiredFields
    .filter((field) => values[field.key] === undefined || values[field.key] === null)
    .map((field) => field.name);
  if (missing.length > 0) {
    throw errors.validation(`Missing required field(s): ${missing.join(', ')}`, { missing });
  }
}

function inferSource(actor: ActorContext): 'human' | 'agent' | 'system' | 'extraction' {
  if (actor.actorType === 'agent') return 'agent';
  if (actor.actorType === 'user') return 'human';
  if (actor.actorType === 'extraction') return 'extraction';
  return 'system';
}
