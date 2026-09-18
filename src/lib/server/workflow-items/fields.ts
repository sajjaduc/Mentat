/**
 * Workflow-item field values: the workflow-overlay half of the one field engine.
 *
 * Base values belong to the Record; overlay values belong to the participation.
 * Overlay values survive completion/transfer as history, which is what makes
 * "what did the renewal quote say?" answerable after the item is closed.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type FieldDefinition,
  fieldDefinitions,
  fieldValueHistory,
  workflowItemFieldValues
} from '../db/schema';
import { listWorkflowFields } from '../fields/service';
import {
  EMPTY_FIELD_VALUE,
  isFieldEmpty,
  type NormalizedFieldValue,
  normalizedFromColumns,
  normalizeFieldValue
} from '../fields/values';
import { listBaseFieldsSync } from '../records/object-types';
import { readRecordFieldValues, writeRecordFieldValues } from '../records/values';
import type { FieldChange } from './types';

export type { FieldChange } from './types';

export interface WriteWorkflowItemFieldOptions {
  workspaceId: string;
  workflowItemId: string;
  workflowId: string;
  recordId: string;
  objectTypeId: string;
  values: Record<string, unknown>;
  actor: ActorContext;
  source?: 'human' | 'agent' | 'system' | 'extraction';
  runId?: string | null;
  audit?: boolean;
  /** Bypass the workflow's read-only (`editable: false`) policy. */
  force?: boolean;
}

/**
 * Route each supplied key to the base (Record) or overlay (WorkflowItem) store.
 * A key bound to the workflow wins over the same key on the Object Type, which is
 * how a workflow can reinterpret a base field contextually.
 */
export function writeWorkflowItemFieldValues(
  tx: Executor,
  options: WriteWorkflowItemFieldOptions
): FieldChange[] {
  const keys = Object.keys(options.values);
  if (keys.length === 0) return [];

  const overlays = new Map(
    listWorkflowFields(tx, options.actor, options.workflowId).map((view) => [
      view.definition.key,
      view
    ])
  );
  const base = new Map(
    listBaseFieldsSync(tx, options.workspaceId, options.objectTypeId).map((field) => [
      field.key,
      field
    ])
  );

  const baseValues: Record<string, unknown> = {};
  const overlayValues: Array<{ definition: FieldDefinition; value: unknown }> = [];
  const unknown: string[] = [];

  for (const key of keys) {
    if (overlays.has(key)) {
      const view = overlays.get(key) as { definition: FieldDefinition; editable: boolean };
      if (!view.editable && !options.force) {
        throw errors.policyDenied(`Field "${view.definition.name}" is read-only in this workflow`, {
          fieldKey: key
        });
      }
      overlayValues.push({
        definition: view.definition,
        value: options.values[key]
      });
    } else if (base.has(key)) {
      baseValues[key] = options.values[key];
    } else {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    throw errors.validation(`Unknown field key(s): ${unknown.join(', ')}`, { missing: unknown });
  }

  const changes: FieldChange[] = [];
  if (Object.keys(baseValues).length > 0) {
    changes.push(
      ...writeRecordFieldValues(tx, {
        workspaceId: options.workspaceId,
        recordId: options.recordId,
        objectTypeId: options.objectTypeId,
        values: baseValues,
        actor: options.actor,
        source: options.source,
        runId: options.runId,
        audit: options.audit
      })
    );
  }
  if (overlayValues.length > 0) {
    changes.push(...writeOverlayValues(tx, options, overlayValues));
  }
  return changes;
}

function writeOverlayValues(
  tx: Executor,
  options: WriteWorkflowItemFieldOptions,
  entries: Array<{ definition: FieldDefinition; value: unknown }>
): FieldChange[] {
  const definitions = entries.map((entry) => entry.definition);
  const existing = readOverlayRows(tx, options.workspaceId, options.workflowItemId, definitions);
  const changes: FieldChange[] = [];
  const now = Date.now();
  const source = options.source ?? inferSource(options.actor);

  for (const entry of entries) {
    const previous = existing.get(entry.definition.id) ?? EMPTY_FIELD_VALUE;
    const normalized = normalizeFieldValue(entry.definition, entry.value);
    if (sameValue(previous, normalized)) continue;
    changes.push({
      fieldDefinitionId: entry.definition.id,
      key: entry.definition.key,
      name: entry.definition.name,
      previous: previous.display,
      next: normalized.display
    });

    if (isFieldEmpty(normalized)) {
      tx.delete(workflowItemFieldValues)
        .where(
          and(
            eq(workflowItemFieldValues.workflowItemId, options.workflowItemId),
            eq(workflowItemFieldValues.fieldDefinitionId, entry.definition.id)
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
      if (existing.has(entry.definition.id)) {
        tx.update(workflowItemFieldValues)
          .set(row)
          .where(
            and(
              eq(workflowItemFieldValues.workflowItemId, options.workflowItemId),
              eq(workflowItemFieldValues.fieldDefinitionId, entry.definition.id)
            )
          )
          .run();
      } else {
        tx.insert(workflowItemFieldValues)
          .values({
            id: uuidv7(now),
            workspaceId: options.workspaceId,
            workflowItemId: options.workflowItemId,
            workflowId: options.workflowId,
            fieldDefinitionId: entry.definition.id,
            ...row
          })
          .run();
      }
    }

    tx.insert(fieldValueHistory)
      .values({
        id: uuidv7(now),
        workspaceId: options.workspaceId,
        ownerType: 'workflow_item',
        ownerId: options.workflowItemId,
        fieldDefinitionId: entry.definition.id,
        workflowId: options.workflowId,
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
  }

  if (changes.length > 0 && options.audit !== false) {
    writeAudit(tx, {
      workspaceId: options.workspaceId,
      action:
        changes.length === 1
          ? AuditActions.workflowItemFieldChanged
          : AuditActions.workflowItemFieldsChanged,
      actorType: options.actor.actorType,
      actorId: options.actor.actorId,
      actorLabel: options.actor.actorLabel,
      entityType: 'workflow_item',
      entityId: options.workflowItemId,
      recordId: options.recordId,
      workflowItemId: options.workflowItemId,
      workflowId: options.workflowId,
      runId: options.runId ?? options.actor.runId ?? null,
      summary: `${changes.length} workflow field(s) changed`,
      data: { changes }
    });
  }
  return changes;
}

function readOverlayRows(
  tx: Executor,
  workspaceId: string,
  workflowItemId: string,
  definitions: FieldDefinition[]
): Map<string, NormalizedFieldValue> {
  if (definitions.length === 0) return new Map();
  const rows = tx
    .select({
      fieldDefinitionId: workflowItemFieldValues.fieldDefinitionId,
      valueText: workflowItemFieldValues.valueText,
      valueNumber: workflowItemFieldValues.valueNumber,
      valueBool: workflowItemFieldValues.valueBool,
      valueDate: workflowItemFieldValues.valueDate,
      valueJson: workflowItemFieldValues.valueJson
    })
    .from(workflowItemFieldValues)
    .where(
      and(
        eq(workflowItemFieldValues.workspaceId, workspaceId),
        eq(workflowItemFieldValues.workflowItemId, workflowItemId),
        inArray(
          workflowItemFieldValues.fieldDefinitionId,
          definitions.map((definition) => definition.id)
        )
      )
    )
    .all();
  return new Map(rows.map((row) => [row.fieldDefinitionId, normalizedFromColumns(row)]));
}

/** merged view: overlay value wins over the record base value. */
export function workflowItemFieldValuesByKey(
  db: Executor,
  workspaceId: string,
  workflowItemId: string,
  recordId: string
): Record<string, unknown> {
  const result: Record<string, unknown> = readBaseValues(db, workspaceId, recordId);
  const rows = db
    .select({ key: fieldDefinitions.key, value: workflowItemFieldValues })
    .from(workflowItemFieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowItemFieldValues.fieldDefinitionId))
    .where(
      and(
        eq(workflowItemFieldValues.workspaceId, workspaceId),
        eq(workflowItemFieldValues.workflowItemId, workflowItemId)
      )
    )
    .all();
  for (const row of rows) {
    result[row.key] =
      row.value.valueText ??
      row.value.valueNumber ??
      row.value.valueBool ??
      row.value.valueDate ??
      row.value.valueJson ??
      null;
  }
  return result;
}

function readBaseValues(
  db: Executor,
  workspaceId: string,
  recordId: string
): Record<string, unknown> {
  const values = readRecordFieldValues(db, workspaceId, recordId);
  if (values.size === 0) return {};
  const definitions = db
    .select({ id: fieldDefinitions.id, key: fieldDefinitions.key })
    .from(fieldDefinitions)
    .where(inArray(fieldDefinitions.id, [...values.keys()]))
    .all();
  const result: Record<string, unknown> = {};
  for (const definition of definitions) {
    result[definition.key] = values.get(definition.id)?.display ?? null;
  }
  return result;
}

/** Ordered overlay history for one participation. */
export async function workflowItemFieldHistory(
  db: Executor,
  workspaceId: string,
  workflowItemId: string,
  options: { limit?: number } = {}
) {
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
      source: fieldValueHistory.source,
      createdAt: fieldValueHistory.createdAt
    })
    .from(fieldValueHistory)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValueHistory.fieldDefinitionId))
    .where(
      and(
        eq(fieldValueHistory.workspaceId, workspaceId),
        eq(fieldValueHistory.ownerType, 'workflow_item'),
        eq(fieldValueHistory.ownerId, workflowItemId)
      )
    )
    .orderBy(asc(fieldValueHistory.createdAt))
    .limit(Math.min(options.limit ?? 200, 500))
    .all();
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

function inferSource(actor: ActorContext): 'human' | 'agent' | 'system' | 'extraction' {
  if (actor.actorType === 'agent') return 'agent';
  if (actor.actorType === 'user') return 'human';
  if (actor.actorType === 'extraction') return 'extraction';
  return 'system';
}
