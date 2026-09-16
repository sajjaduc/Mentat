/**
 * Field definitions and workflow field configuration.
 *
 * A field definition is workspace-scoped and reusable across workflows; a
 * `workflow_fields` row is what makes a definition *apply* to a workflow, with its
 * own ordering, requiredness, visibility, editability, state-specific
 * requirements and board/list display settings.
 *
 * Reusable workspace definitions are also how cross-workflow transfer avoids
 * mapping in the common case (ADR-0011): when Intake and Claims both use
 * `customer_email`, no mapping is needed.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type FieldDefinition,
  type FieldScope,
  type FieldType,
  fieldDefinitions,
  ticketFieldValues,
  tickets,
  type WorkflowField,
  workflowFields,
  workflowStates
} from '../db/schema';
import { requireWorkflow } from '../workflows/service';

export interface WorkflowFieldView extends WorkflowField {
  definition: FieldDefinition;
}

export interface CreateFieldInput {
  key?: string;
  name: string;
  description?: string | null;
  type: FieldType;
  scope?: FieldScope;
  options?: Record<string, unknown> | null;
  defaultValue?: unknown;
  validation?: Record<string, unknown> | null;
  display?: Record<string, unknown> | null;
}

export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

export function normalizeFieldKey(input: string, fallbackName?: string): string {
  const source = (input.trim() || fallbackName || '').toLowerCase();
  const key = source
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!FIELD_KEY_PATTERN.test(key)) {
    throw errors.validation(
      'Field key must start with a letter and contain only lowercase letters, numbers and underscores (2-48 characters)',
      { key }
    );
  }
  return key;
}

export function requireFieldDefinition(
  db: Executor,
  workspaceId: string,
  fieldId: string
): FieldDefinition {
  const rows = db
    .select()
    .from(fieldDefinitions)
    .where(and(eq(fieldDefinitions.id, fieldId), eq(fieldDefinitions.workspaceId, workspaceId)))
    .limit(1)
    .all();
  const field = rows[0];
  if (!field) throw errors.notFound('Field definition', fieldId);
  return field;
}

export function findFieldByKey(
  db: Executor,
  workspaceId: string,
  key: string,
  scope: FieldScope = 'ticket'
): FieldDefinition | null {
  const rows = db
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, scope),
        eq(fieldDefinitions.key, key),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function listFieldDefinitions(
  db: Executor,
  actor: ActorContext,
  options: { scope?: FieldScope; includeArchived?: boolean } = {}
): FieldDefinition[] {
  assertPermission(actor, Permissions.workspaceRead);
  const conditions = [eq(fieldDefinitions.workspaceId, actor.workspaceId)];
  if (options.scope) conditions.push(eq(fieldDefinitions.scope, options.scope));
  if (!options.includeArchived) conditions.push(isNull(fieldDefinitions.archivedAt));
  return db
    .select()
    .from(fieldDefinitions)
    .where(and(...conditions))
    .orderBy(asc(fieldDefinitions.name))
    .all();
}

export function createFieldDefinition(
  db: Executor,
  actor: ActorContext,
  input: CreateFieldInput
): FieldDefinition {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to define fields');
  const scope = input.scope ?? 'ticket';
  const key = normalizeFieldKey(input.key ?? input.name, input.name);
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Field name is required');

  if (findFieldByKey(db, actor.workspaceId, key, scope)) {
    throw errors.conflict(`A ${scope} field with key "${key}" already exists`, { key, scope });
  }

  validateFieldConfiguration(input.type, input.options ?? null, input.validation ?? null);

  const now = Date.now();
  const inserted = db
    .insert(fieldDefinitions)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      key,
      name,
      description: input.description ?? null,
      type: input.type,
      scope,
      options: (input.options as never) ?? null,
      defaultValue: (input.defaultValue as never) ?? null,
      validation: (input.validation as never) ?? null,
      display: (input.display as never) ?? null,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all();
  const field = inserted[0];
  if (!field) throw errors.internal('Failed to create field definition');

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'field_definition',
    entityId: field.id,
    summary: `Field ${field.name} (${field.key}) created`,
    data: { type: field.type, scope: field.scope }
  });

  return field;
}

function validateFieldConfiguration(
  type: FieldType,
  options: Record<string, unknown> | null,
  validation: Record<string, unknown> | null
): void {
  const choices = (options?.choices ?? null) as Array<{ value?: unknown; label?: unknown }> | null;
  if (type === 'select' || type === 'multi_select') {
    if (!Array.isArray(choices) || choices.length === 0) {
      throw errors.validation('Select fields require at least one choice');
    }
    for (const choice of choices) {
      if (typeof choice?.value !== 'string' || choice.value.trim().length === 0) {
        throw errors.validation('Every select choice needs a non-empty value');
      }
      if (typeof choice?.label !== 'string' || choice.label.trim().length === 0) {
        throw errors.validation('Every select choice needs a non-empty label');
      }
    }
    const values = choices.map((choice) => choice.value as string);
    if (new Set(values).size !== values.length) {
      throw errors.validation('Select choice values must be unique');
    }
  }
  if (type !== 'select' && type !== 'multi_select' && choices && choices.length > 0) {
    throw errors.validation('Only select and multi-select fields may declare choices');
  }
  if (validation?.pattern !== undefined) {
    if (typeof validation.pattern !== 'string') {
      throw errors.validation('Validation pattern must be a string');
    }
    try {
      new RegExp(validation.pattern);
    } catch {
      throw errors.validation('Validation pattern is not a valid regular expression');
    }
  }
}

export function updateFieldDefinition(
  db: Executor,
  actor: ActorContext,
  input: Partial<CreateFieldInput> & { fieldId: string }
): FieldDefinition {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit fields');
  const current = requireFieldDefinition(db, actor.workspaceId, input.fieldId);
  if (current.isSystem && input.type && input.type !== current.type) {
    throw errors.precondition('The type of a system field cannot be changed');
  }

  const type = input.type ?? current.type;
  const options =
    input.options === undefined
      ? (current.options as Record<string, unknown> | null)
      : input.options;
  const validation =
    input.validation === undefined
      ? (current.validation as Record<string, unknown> | null)
      : input.validation;
  validateFieldConfiguration(type, options, validation);

  const updated = db
    .update(fieldDefinitions)
    .set({
      name: input.name?.trim() ?? current.name,
      description: input.description === undefined ? current.description : input.description,
      type,
      options: (options as never) ?? null,
      defaultValue:
        input.defaultValue === undefined
          ? current.defaultValue
          : ((input.defaultValue as never) ?? null),
      validation: (validation as never) ?? null,
      display: input.display === undefined ? current.display : ((input.display as never) ?? null),
      updatedAt: Date.now()
    })
    .where(eq(fieldDefinitions.id, input.fieldId))
    .returning()
    .all();
  const field = updated[0];
  if (!field) throw errors.notFound('Field definition', input.fieldId);

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'field_definition',
    entityId: field.id,
    summary: `Field ${field.name} updated`,
    data: { type: field.type }
  });
  return field;
}

/**
 * Archive rather than delete: existing ticket values and their history keep
 * referencing the definition, so deleting the row would destroy provenance.
 */
export function archiveFieldDefinition(db: Executor, actor: ActorContext, fieldId: string): void {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to edit fields');
  const field = requireFieldDefinition(db, actor.workspaceId, fieldId);
  if (field.isSystem) throw errors.precondition('System fields cannot be archived');

  const valueCount = db
    .select({ count: sql<number>`count(*)` })
    .from(ticketFieldValues)
    .where(eq(ticketFieldValues.fieldDefinitionId, fieldId))
    .all();

  const now = Date.now();
  db.update(fieldDefinitions)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(fieldDefinitions.id, fieldId))
    .run();
  db.delete(workflowFields).where(eq(workflowFields.fieldDefinitionId, fieldId)).run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'field_definition',
    entityId: fieldId,
    summary: `Field ${field.name} archived`,
    data: { retainedValues: valueCount[0]?.count ?? 0 }
  });
}

export interface WorkflowFieldInput {
  fieldDefinitionId: string;
  position?: number;
  required?: boolean;
  visible?: boolean;
  editable?: boolean;
  defaultValue?: unknown;
  requiredInStates?: string[] | null;
  showOnCard?: boolean;
  showInList?: boolean;
  filterable?: boolean;
  requiredForTransfer?: boolean;
}

export function listWorkflowFields(
  db: Executor,
  actor: ActorContext,
  workflowId: string
): WorkflowFieldView[] {
  assertPermission(actor, Permissions.workflowRead);
  requireWorkflow(db, actor.workspaceId, workflowId);
  const rows = db
    .select({ workflowField: workflowFields, definition: fieldDefinitions })
    .from(workflowFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowFields.fieldDefinitionId))
    .where(
      and(
        eq(workflowFields.workspaceId, actor.workspaceId),
        eq(workflowFields.workflowId, workflowId),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .orderBy(asc(workflowFields.position))
    .all();
  return rows.map((row) => ({ ...row.workflowField, definition: row.definition }));
}

/**
 * Replace a workflow's field configuration. Fields absent from `entries` are
 * detached from the workflow — their historical values are untouched.
 */
export function setWorkflowFields(
  db: Executor,
  actor: ActorContext,
  workflowId: string,
  entries: WorkflowFieldInput[]
): WorkflowFieldView[] {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to configure fields');
  requireWorkflow(db, actor.workspaceId, workflowId);

  const definitionIds = entries.map((entry) => entry.fieldDefinitionId);
  if (new Set(definitionIds).size !== definitionIds.length) {
    throw errors.validation('A field may only be configured once per workflow');
  }
  if (definitionIds.length > 0) {
    const found = db
      .select({ id: fieldDefinitions.id, scope: fieldDefinitions.scope })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, actor.workspaceId),
          inArray(fieldDefinitions.id, definitionIds)
        )
      )
      .all();
    const foundIds = new Set(found.map((row) => row.id));
    const missing = definitionIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw errors.validation('Unknown field definition(s)', { fieldDefinitionIds: missing });
    }
    const wrongScope = found.filter((row) => row.scope !== 'ticket');
    if (wrongScope.length > 0) {
      throw errors.validation('Only ticket-scoped fields can be attached to a workflow', {
        fieldDefinitionIds: wrongScope.map((row) => row.id)
      });
    }
  }

  const states = db
    .select({ id: workflowStates.id })
    .from(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId))
    .all();
  const stateIds = new Set(states.map((state) => state.id));
  for (const entry of entries) {
    for (const stateId of entry.requiredInStates ?? []) {
      if (!stateIds.has(stateId)) {
        throw errors.validation(`State ${stateId} does not belong to this workflow`);
      }
    }
  }

  const now = Date.now();
  db.delete(workflowFields).where(eq(workflowFields.workflowId, workflowId)).run();

  const inserted: WorkflowFieldView[] = [];
  for (const [index, entry] of entries.entries()) {
    const definition = requireFieldDefinition(db, actor.workspaceId, entry.fieldDefinitionId);
    const row = db
      .insert(workflowFields)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        workflowId,
        fieldDefinitionId: entry.fieldDefinitionId,
        position: entry.position ?? index,
        required: entry.required ?? false,
        visible: entry.visible ?? true,
        editable: entry.editable ?? true,
        defaultValue: (entry.defaultValue as never) ?? null,
        requiredInStates: (entry.requiredInStates as never) ?? null,
        showOnCard: entry.showOnCard ?? false,
        showInList: entry.showInList ?? true,
        filterable: entry.filterable ?? true,
        requiredForTransfer: entry.requiredForTransfer ?? false,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all();
    const workflowField = row[0];
    if (workflowField) inserted.push({ ...workflowField, definition });
  }

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow',
    entityId: workflowId,
    workflowId,
    summary: `Workflow field configuration updated (${entries.length} fields)`,
    data: { fieldKeys: inserted.map((view) => view.definition.key) }
  });

  return inserted;
}

/**
 * Fields that must have a value before the ticket may be in `stateId`.
 * Enforced on entry so a state's requirements cannot be bypassed by any actor.
 */
export function requiredFieldsForState(
  db: Executor,
  workspaceId: string,
  workflowId: string,
  stateId: string
): FieldDefinition[] {
  const rows = db
    .select({ definition: fieldDefinitions, workflowField: workflowFields })
    .from(workflowFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowFields.fieldDefinitionId))
    .where(
      and(
        eq(workflowFields.workspaceId, workspaceId),
        eq(workflowFields.workflowId, workflowId),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .all();

  return rows
    .filter((row) => {
      if (row.workflowField.required) return true;
      const requiredInStates = row.workflowField.requiredInStates as string[] | null;
      return Array.isArray(requiredInStates) && requiredInStates.includes(stateId);
    })
    .map((row) => row.definition);
}

/** Field definitions required before a ticket may be transferred out of the workflow. */
export function requiredFieldsForTransfer(
  db: Executor,
  workspaceId: string,
  workflowId: string
): FieldDefinition[] {
  const rows = db
    .select({ definition: fieldDefinitions })
    .from(workflowFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowFields.fieldDefinitionId))
    .where(
      and(
        eq(workflowFields.workspaceId, workspaceId),
        eq(workflowFields.workflowId, workflowId),
        eq(workflowFields.requiredForTransfer, true),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .all();
  return rows.map((row) => row.definition);
}

/** Field keys an agent is allowed to write, intersected with the agent's grants. */
export function writableFieldKeys(
  workflowFieldViews: WorkflowFieldView[],
  agentWritableFieldKeys: string[] | undefined
): Set<string> {
  const editable = workflowFieldViews
    .filter((view) => view.editable)
    .map((view) => view.definition.key);
  if (!agentWritableFieldKeys || agentWritableFieldKeys.length === 0) return new Set<string>();
  if (agentWritableFieldKeys.includes('*')) return new Set(editable);
  return new Set(editable.filter((key) => agentWritableFieldKeys.includes(key)));
}

/** Count tickets currently holding values for a field — used by the field admin UI. */
export function fieldUsage(db: Executor, workspaceId: string, fieldId: string): number {
  const rows = db
    .select({ count: sql<number>`count(*)` })
    .from(ticketFieldValues)
    .where(
      and(
        eq(ticketFieldValues.workspaceId, workspaceId),
        eq(ticketFieldValues.fieldDefinitionId, fieldId)
      )
    )
    .all();
  return rows[0]?.count ?? 0;
}

/** Tickets that reference the field at all (for impact warnings before archiving). */
export function fieldReferencedTickets(db: Executor, workspaceId: string, fieldId: string): number {
  const rows = db
    .select({ count: sql<number>`count(distinct ${tickets.id})` })
    .from(ticketFieldValues)
    .innerJoin(tickets, eq(tickets.id, ticketFieldValues.ticketId))
    .where(
      and(
        eq(ticketFieldValues.workspaceId, workspaceId),
        eq(ticketFieldValues.fieldDefinitionId, fieldId)
      )
    )
    .all();
  return rows[0]?.count ?? 0;
}
