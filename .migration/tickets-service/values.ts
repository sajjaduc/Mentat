/**
 * Ticket field value persistence.
 *
 * All field writes go through `writeTicketFieldValues`, whether the actor is a
 * human in the UI, an agent tool call, a trigger mapping or an extraction pass.
 * That single entry point is what guarantees the field-level invariants: type
 * validation, workflow policy, state requirements, actor attribution and
 * before/after history (ADR-0005, ADR-0013).
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
  ticketFieldValues
} from '../db/schema';
import { findFieldByKey, listWorkflowFields } from '../fields/service';
import {
  EMPTY_FIELD_VALUE,
  isFieldEmpty,
  type NormalizedFieldValue,
  normalizedFromColumns,
  normalizeFieldValue
} from '../fields/values';

export interface FieldChange {
  fieldDefinitionId: string;
  key: string;
  name: string;
  previous: unknown;
  next: unknown;
}

export interface WriteFieldOptions {
  workspaceId: string;
  ticketId: string;
  workflowId: string;
  values: Record<string, unknown>;
  actor: ActorContext;
  source?: 'human' | 'agent' | 'system' | 'extraction';
  runId?: string | null;
  /** Bypass workflow editability policy. Only permitted for system actors. */
  force?: boolean;
  /** Restrict which keys may be written (agent grants). */
  allowedKeys?: Set<string> | null;
  /** Record an audit event per changed field. */
  audit?: boolean;
}

/**
 * Upsert typed values and append history. Must be called inside a transaction:
 * the value row, its history row and the audit row are one atomic unit.
 */
export function writeTicketFieldValues(tx: Executor, options: WriteFieldOptions): FieldChange[] {
  const keys = Object.keys(options.values);
  if (keys.length === 0) return [];

  const workflowFieldViews = listWorkflowFields(
    tx,
    { ...options.actor, workspaceId: options.workspaceId },
    options.workflowId
  );
  const configured = new Map(workflowFieldViews.map((view) => [view.definition.key, view]));

  const definitions = resolveDefinitions(tx, options.workspaceId, keys);
  const existing = readRawValues(
    tx,
    options.workspaceId,
    options.ticketId,
    definitions.map((definition) => definition.id)
  );

  const changes: FieldChange[] = [];
  const now = Date.now();
  const source = options.source ?? inferSource(options.actor);

  for (const definition of definitions) {
    const view = configured.get(definition.key);
    if (!view && !options.force) {
      throw errors.validation(`Field "${definition.key}" is not configured on this workflow`, {
        fieldKey: definition.key
      });
    }
    if (view && !view.editable && !options.force) {
      throw errors.policyDenied(`Field "${definition.name}" is read-only in this workflow`, {
        fieldKey: definition.key
      });
    }
    if (options.allowedKeys && !options.allowedKeys.has(definition.key) && !options.force) {
      throw errors.policyDenied(`Not permitted to write field "${definition.key}"`, {
        fieldKey: definition.key
      });
    }

    const raw = options.values[definition.key];
    const normalized = normalizeFieldValue(definition, raw);
    const previousRow = existing.get(definition.id);
    const previous = previousRow ? toStoredShape(previousRow) : EMPTY_FIELD_VALUE;

    if (sameValue(previous, normalized)) continue;

    if (isFieldEmpty(normalized)) {
      if (previousRow) {
        tx.delete(ticketFieldValues)
          .where(
            and(
              eq(ticketFieldValues.ticketId, options.ticketId),
              eq(ticketFieldValues.fieldDefinitionId, definition.id)
            )
          )
          .run();
      }
    } else if (previousRow) {
      tx.update(ticketFieldValues)
        .set({
          valueText: normalized.valueText,
          valueNumber: normalized.valueNumber,
          valueBool: normalized.valueBool,
          valueDate: normalized.valueDate,
          valueJson: normalized.valueJson as never,
          searchText: normalized.searchText,
          updatedByType: options.actor.actorType,
          updatedById: options.actor.actorId,
          updatedAt: now
        })
        .where(eq(ticketFieldValues.id, previousRow.id))
        .run();
    } else {
      tx.insert(ticketFieldValues)
        .values({
          id: uuidv7(now),
          workspaceId: options.workspaceId,
          ticketId: options.ticketId,
          fieldDefinitionId: definition.id,
          valueText: normalized.valueText,
          valueNumber: normalized.valueNumber,
          valueBool: normalized.valueBool,
          valueDate: normalized.valueDate,
          valueJson: normalized.valueJson as never,
          searchText: normalized.searchText,
          updatedByType: options.actor.actorType,
          updatedById: options.actor.actorId,
          updatedAt: now
        })
        .run();
    }

    // History is append-only: the previous value is never lost, even when the
    // field is later detached from the workflow.
    tx.insert(fieldValueHistory)
      .values({
        id: uuidv7(now),
        workspaceId: options.workspaceId,
        ownerType: 'ticket',
        ownerId: options.ticketId,
        fieldDefinitionId: definition.id,
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

    changes.push({
      fieldDefinitionId: definition.id,
      key: definition.key,
      name: definition.name,
      previous: previous.display,
      next: normalized.display
    });
  }

  if (changes.length > 0 && options.audit !== false) {
    writeAudit(tx, {
      workspaceId: options.workspaceId,
      action:
        changes.length === 1 ? AuditActions.ticketFieldChanged : AuditActions.ticketFieldsChanged,
      actorType: options.actor.actorType,
      actorId: options.actor.actorId,
      actorLabel: options.actor.actorLabel,
      entityType: 'ticket',
      entityId: options.ticketId,
      ticketId: options.ticketId,
      workflowId: options.workflowId,
      runId: options.runId ?? options.actor.runId ?? null,
      summary:
        changes.length === 1
          ? `${changes[0]?.name} set to ${formatForSummary(changes[0]?.next)}`
          : `${changes.length} fields updated`,
      data: {
        changes: changes.map((change) => ({
          fieldKey: change.key,
          previous: change.previous,
          next: change.next
        })),
        source
      },
      occurredAt: now
    });
  }

  return changes;
}

function inferSource(actor: ActorContext): 'human' | 'agent' | 'system' | 'extraction' {
  switch (actor.actorType) {
    case 'user':
      return 'human';
    case 'agent':
      return 'agent';
    case 'extraction':
      return 'extraction';
    default:
      return 'system';
  }
}

function formatForSummary(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80);
  return String(value);
}

/**
 * Resolve field keys to definitions. Unknown keys are rejected rather than stored
 * in `structured_data`, so a typo can never silently become an unqueryable value.
 */
export function resolveDefinitions(
  tx: Executor,
  workspaceId: string,
  keys: string[]
): FieldDefinition[] {
  const direct = keys
    .map((key) => findFieldByKey(tx, workspaceId, key, 'ticket'))
    .filter((definition): definition is FieldDefinition => definition !== null);

  const unresolved = keys.filter((key) => !direct.some((definition) => definition.key === key));
  const byId: FieldDefinition[] = [];
  if (unresolved.length > 0) {
    const idCandidates = unresolved.filter((key) => key.length === 36);
    if (idCandidates.length > 0) {
      const rows = tx
        .select()
        .from(fieldDefinitions)
        .where(
          and(
            eq(fieldDefinitions.workspaceId, workspaceId),
            eq(fieldDefinitions.scope, 'ticket'),
            inArray(fieldDefinitions.id, idCandidates)
          )
        )
        .all();
      byId.push(...rows);
    }
  }

  const resolved = [...direct, ...byId];
  const missing = keys.filter(
    (key) => !resolved.some((definition) => definition.key === key || definition.id === key)
  );
  if (missing.length > 0) {
    throw errors.validation(`Unknown field key(s): ${missing.join(', ')}`, { keys: missing });
  }
  return resolved;
}

interface StoredValueRow {
  id: string;
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
  ticketId: string,
  fieldDefinitionIds: string[]
): Map<string, StoredValueRow> {
  if (fieldDefinitionIds.length === 0) return new Map();
  const rows = tx
    .select()
    .from(ticketFieldValues)
    .where(
      and(
        eq(ticketFieldValues.workspaceId, workspaceId),
        eq(ticketFieldValues.ticketId, ticketId),
        inArray(ticketFieldValues.fieldDefinitionId, fieldDefinitionIds)
      )
    )
    .all();
  return new Map(rows.map((row) => [row.fieldDefinitionId, row as StoredValueRow]));
}

function toStoredShape(row: StoredValueRow): NormalizedFieldValue {
  return normalizedFromColumns({
    valueText: row.valueText,
    valueNumber: row.valueNumber,
    valueBool: row.valueBool,
    valueDate: row.valueDate,
    valueJson: row.valueJson
  });
}

/**
 * Compare on the stored representation, not on the raw input, so re-submitting the
 * same value (for example a form save) does not create a spurious history entry.
 */
function sameValue(a: NormalizedFieldValue, b: NormalizedFieldValue): boolean {
  return (
    a.valueText === b.valueText &&
    a.valueNumber === b.valueNumber &&
    a.valueBool === b.valueBool &&
    a.valueDate === b.valueDate &&
    JSON.stringify(a.valueJson ?? null) === JSON.stringify(b.valueJson ?? null)
  );
}

export interface TicketFieldView {
  definition: FieldDefinition;
  value: NormalizedFieldValue;
  /** Config from the workflow field binding when the field is attached. */
  config?: {
    required: boolean;
    visible: boolean;
    editable: boolean;
    showOnCard: boolean;
    showInList: boolean;
    requiredInStates: string[] | null;
  };
}

export function readTicketFieldValues(
  db: Executor,
  workspaceId: string,
  ticketId: string
): Map<string, NormalizedFieldValue> {
  const rows = db
    .select({ value: ticketFieldValues, definition: fieldDefinitions })
    .from(ticketFieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, ticketFieldValues.fieldDefinitionId))
    .where(
      and(eq(ticketFieldValues.workspaceId, workspaceId), eq(ticketFieldValues.ticketId, ticketId))
    )
    .all();

  const out = new Map<string, NormalizedFieldValue>();
  for (const row of rows) {
    out.set(row.value.fieldDefinitionId, toStoredShape(row.value as StoredValueRow));
  }
  return out;
}

export function fieldValuesByKey(
  db: Executor,
  workspaceId: string,
  ticketId: string
): Record<string, unknown> {
  const rows = db
    .select({ value: ticketFieldValues, definition: fieldDefinitions })
    .from(ticketFieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, ticketFieldValues.fieldDefinitionId))
    .where(
      and(eq(ticketFieldValues.workspaceId, workspaceId), eq(ticketFieldValues.ticketId, ticketId))
    )
    .all();

  const out: Record<string, unknown> = {};
  for (const row of rows) {
    out[row.definition.key] = toStoredShape(row.value as StoredValueRow).display;
  }
  return out;
}

/** Field-change history for a ticket, newest first. */
export function ticketFieldHistory(
  db: Executor,
  workspaceId: string,
  ticketId: string,
  options: { limit?: number; fieldDefinitionId?: string } = {}
) {
  const conditions = [
    eq(fieldValueHistory.workspaceId, workspaceId),
    eq(fieldValueHistory.ownerType, 'ticket'),
    eq(fieldValueHistory.ownerId, ticketId)
  ];
  if (options.fieldDefinitionId) {
    conditions.push(eq(fieldValueHistory.fieldDefinitionId, options.fieldDefinitionId));
  }
  return db
    .select({ history: fieldValueHistory, definition: fieldDefinitions })
    .from(fieldValueHistory)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fieldValueHistory.fieldDefinitionId))
    .where(and(...conditions))
    .orderBy(asc(fieldValueHistory.createdAt))
    .limit(Math.min(options.limit ?? 200, 500))
    .all();
}

/**
 * Verify that every field required for the given state currently has a value.
 * Called before a state entry so a requirement cannot be bypassed.
 */
export function assertRequiredFieldsSatisfied(
  db: Executor,
  options: {
    workspaceId: string;
    ticketId: string;
    workflowId: string;
    stateId: string;
    requiredFields: FieldDefinition[];
  }
): void {
  if (options.requiredFields.length === 0) return;
  const values = readTicketFieldValues(db, options.workspaceId, options.ticketId);
  const missing = options.requiredFields.filter((definition) => {
    const value = values.get(definition.id);
    return !value || isFieldEmpty(value);
  });
  if (missing.length > 0) {
    throw errors.precondition(
      `Required field(s) missing: ${missing.map((definition) => definition.name).join(', ')}`,
      {
        fieldKeys: missing.map((definition) => definition.key),
        fieldNames: missing.map((definition) => definition.name)
      }
    );
  }
}
