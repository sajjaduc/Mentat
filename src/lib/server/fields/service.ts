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
  type FieldOptions,
  type FieldScope,
  type FieldType,
  type FieldValidation,
  fieldDefinitions,
  type WorkflowField,
  workflowFields,
  workflowItemFieldValues,
  workflowItems,
  workflowStates,
  workflows
} from '../db/schema';
import { compileZodSource, type ProjectedZodField } from '../schemas/zod-source';
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
  scope: FieldScope = 'workflowItem'
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
  const scope = input.scope ?? 'workflowItem';
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

export interface EnsureFieldInput {
  key: string;
  name: string;
  type: FieldType;
  scope: FieldScope;
  description?: string | null;
  options?: FieldOptions | null;
  validation?: FieldValidation | null;
  defaultValue?: unknown;
}

/**
 * Find a workspace field definition by key (including archived rows) or create it.
 *
 * Used when a Zod source is projected onto the field engine: saving the same schema
 * twice must not create duplicate definitions, and a field previously archived must
 * be revived rather than conflict with the unique (workspace, scope, key) index.
 * When the projected metadata differs from the stored definition, the definition is
 * updated so the field engine keeps matching the schema.
 */
export function ensureFieldDefinition(
  db: Executor,
  actor: ActorContext,
  input: EnsureFieldInput
): FieldDefinition {
  const key = normalizeFieldKey(input.key, input.name);
  const existing = db
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, actor.workspaceId),
        eq(fieldDefinitions.scope, input.scope),
        eq(fieldDefinitions.key, key)
      )
    )
    .limit(1)
    .all()[0];

  if (!existing) {
    return createFieldDefinition(db, actor, {
      key,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      scope: input.scope,
      options: (input.options as unknown as Record<string, unknown>) ?? null,
      validation: (input.validation as unknown as Record<string, unknown>) ?? null,
      defaultValue: input.defaultValue
    });
  }

  if (existing.archivedAt !== null) {
    db.update(fieldDefinitions)
      .set({ archivedAt: null, updatedAt: Date.now() })
      .where(eq(fieldDefinitions.id, existing.id))
      .run();
  }

  const options = (input.options as unknown as Record<string, unknown>) ?? null;
  const validation = (input.validation as unknown as Record<string, unknown>) ?? null;
  const changed =
    existing.type !== input.type ||
    existing.name !== input.name ||
    JSON.stringify(existing.options ?? null) !== JSON.stringify(options) ||
    JSON.stringify(existing.validation ?? null) !== JSON.stringify(validation);
  if (!changed) return existing;

  return updateFieldDefinition(db, actor, {
    fieldId: existing.id,
    name: input.name,
    description: input.description ?? null,
    type: input.type,
    options,
    validation
  });
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
    .from(workflowItemFieldValues)
    .where(eq(workflowItemFieldValues.fieldDefinitionId, fieldId))
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
    // Overlay fields come from the workflow's Object Type schema: both
    // workflow-item-scoped and record-scoped definitions are valid (ADR-0021).
    const wrongScope = found.filter(
      (row) => row.scope !== 'workflowItem' && row.scope !== 'record'
    );
    if (wrongScope.length > 0) {
      throw errors.validation(
        'Only workflow-item- or record-scoped fields can be attached to a workflow',
        { fieldDefinitionIds: wrongScope.map((row) => row.id) }
      );
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

export interface WorkflowSchemaSaveResult {
  /** The stored, trimmed Zod source. */
  source: string;
  fields: WorkflowFieldView[];
  projected: ProjectedZodField[];
}

/**
 * Author a workflow's overlay schema as Zod source (ADR-0023).
 *
 * The source becomes the authoritative contract for the overlay; the workflow's
 * bound fields are replaced with its projection. Display/state flags already set on
 * a field with the same key are preserved, so re-saving a schema does not discard
 * "required in states", card/list visibility or transfer requirements.
 */
export function setWorkflowZodSchema(
  db: Executor,
  actor: ActorContext,
  workflowId: string,
  source: string
): WorkflowSchemaSaveResult {
  assertPermission(actor, Permissions.workflowWrite, 'Not permitted to configure fields');
  const workflow = requireWorkflow(db, actor.workspaceId, workflowId);
  const compiled = compileZodSource(source);
  if (!compiled.ok) throw errors.validation(compiled.message);
  if (!compiled.object) {
    throw errors.validation('The workflow schema must be a Zod object, for example z.object({}).');
  }
  if (compiled.invalidKeys.length > 0) {
    throw errors.validation(
      `These keys cannot be field keys: ${compiled.invalidKeys.join(', ')}. Use lowercase letters, numbers and underscores, starting with a letter.`,
      { keys: compiled.invalidKeys }
    );
  }
  if (compiled.fields.length === 0) {
    throw errors.validation('The workflow schema declares no fields.');
  }

  const existing = new Map(
    listWorkflowFields(db, actor, workflowId).map((view) => [view.definition.key, view])
  );
  const entries: WorkflowFieldInput[] = compiled.fields.map((field, index) => {
    const definition = ensureFieldDefinition(db, actor, {
      key: field.key,
      name: field.name,
      type: field.type,
      scope: 'workflowItem',
      description: field.description,
      options: field.options,
      validation: field.validation,
      defaultValue: field.defaultValue
    });
    const previous = existing.get(field.key);
    return {
      fieldDefinitionId: definition.id,
      position: index,
      required: field.required,
      visible: previous?.visible ?? true,
      editable: previous?.editable ?? true,
      defaultValue: field.defaultValue ?? previous?.defaultValue ?? null,
      requiredInStates: previous?.requiredInStates ?? null,
      // `.meta({ card, list, filterable })` overrides; otherwise the flags already
      // set on this key survive a re-save.
      showOnCard: field.meta.card ?? previous?.showOnCard ?? false,
      showInList: field.meta.list ?? previous?.showInList ?? true,
      filterable: field.meta.filterable ?? previous?.filterable ?? true,
      requiredForTransfer: previous?.requiredForTransfer ?? false
    };
  });

  const fields = setWorkflowFields(db, actor, workflowId, entries);
  const settings = { ...(workflow.settings ?? {}) };
  settings.zodSchema = compiled.source;
  db.update(workflows)
    .set({ settings: settings as never, updatedAt: Date.now() })
    .where(eq(workflows.id, workflowId))
    .run();

  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.workflowUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'workflow',
    entityId: workflowId,
    workflowId,
    summary: `Workflow ${workflow.name} schema updated from Zod source`,
    data: { fieldKeys: compiled.fields.map((field) => field.key) }
  });

  return { source: compiled.source, fields, projected: compiled.fields };
}

/**
 * Fields that must hold a value *while the ticket is in* `stateId`.
 *
 * Enforced when the ticket **leaves** the state: a requirement attached to a state
 * is something the work in that state is supposed to produce — a review outcome, for
 * example — so requiring it on entry would make the state impossible to enter.
 */
export function fieldsRequiredWhileIn(
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
      const requiredInStates = row.workflowField.requiredInStates as string[] | null;
      return Array.isArray(requiredInStates) && requiredInStates.includes(stateId);
    })
    .map((row) => row.definition);
}

/**
 * Fields marked universally required on the workflow. These must hold a value in
 * every state, so they are enforced on entry as well as on exit.
 */
export function alwaysRequiredFields(
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
        eq(workflowFields.required, true),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .all();
  return rows.map((row) => row.definition);
}

/** Backwards-compatible alias kept for callers that mean "required in this state". */
export const requiredFieldsForState = fieldsRequiredWhileIn;

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

/** Count work items currently holding values for a field — used by the field admin UI. */
export function fieldUsage(db: Executor, workspaceId: string, fieldId: string): number {
  const rows = db
    .select({ count: sql<number>`count(*)` })
    .from(workflowItemFieldValues)
    .where(
      and(
        eq(workflowItemFieldValues.workspaceId, workspaceId),
        eq(workflowItemFieldValues.fieldDefinitionId, fieldId)
      )
    )
    .all();
  return rows[0]?.count ?? 0;
}

/** Work items that reference the field at all (for impact warnings before archiving). */
export function fieldReferencedWorkItems(
  db: Executor,
  workspaceId: string,
  fieldId: string
): number {
  const rows = db
    .select({ count: sql<number>`count(distinct ${workflowItems.id})` })
    .from(workflowItemFieldValues)
    .innerJoin(workflowItems, eq(workflowItems.id, workflowItemFieldValues.workflowItemId))
    .where(
      and(
        eq(workflowItemFieldValues.workspaceId, workspaceId),
        eq(workflowItemFieldValues.fieldDefinitionId, fieldId)
      )
    )
    .all();
  return rows[0]?.count ?? 0;
}
