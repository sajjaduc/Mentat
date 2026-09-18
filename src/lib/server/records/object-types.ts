/**
 * Object Types: the schema for a kind of thing (ADR-0021).
 *
 * An Object Type is workspace-level. Workflows reference one; Records instantiate
 * one. Field definitions are workspace-scoped and bound to an Object Type through
 * `object_type_fields`, which keeps the typed-field engine single and reusable.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import {
  type FieldOptions,
  type FieldType,
  type FieldValidation,
  fieldDefinitions,
  type ObjectType,
  objectTypeFields,
  objectTypes,
  records,
  workflows
} from '../db/schema';
import { ensureFieldDefinition, FIELD_KEY_PATTERN } from '../fields/service';
import { compileZodSource, type ProjectedZodField } from '../schemas/zod-source';
import { defaultPluralName, type ObjectTypeFieldView, type ObjectTypeSummary } from './types';

export interface CreateObjectTypeInput {
  key?: string | null;
  name: string;
  pluralName?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  settings?: Record<string, unknown> | null;
}

export interface ObjectTypeFieldInput {
  /** Existing workspace field definition. */
  fieldDefinitionId?: string | null;
  /** Create a definition inline. */
  key?: string | null;
  name?: string | null;
  description?: string | null;
  type?: FieldType;
  options?: Record<string, unknown> | null;
  validation?: Record<string, unknown> | null;
  display?: Record<string, unknown> | null;
  position?: number;
  required?: boolean;
  isIdentity?: boolean;
  isPrimaryDisplay?: boolean;
  isSecondaryDisplay?: boolean;
  showInList?: boolean;
  showOnCard?: boolean;
  filterable?: boolean;
  defaultValue?: unknown;
}

export function findObjectTypeByKey(
  db: Executor,
  workspaceId: string,
  key: string
): ObjectType | null {
  return (
    db
      .select()
      .from(objectTypes)
      .where(
        and(
          eq(objectTypes.workspaceId, workspaceId),
          eq(objectTypes.key, key),
          isNull(objectTypes.archivedAt)
        )
      )
      .all()[0] ?? null
  );
}

export function requireObjectType(
  db: Executor,
  workspaceId: string,
  objectTypeId: string
): ObjectType {
  const row = db
    .select()
    .from(objectTypes)
    .where(and(eq(objectTypes.workspaceId, workspaceId), eq(objectTypes.id, objectTypeId)))
    .all()[0];
  if (!row) throw errors.notFound('Object type', objectTypeId);
  return row;
}

/**
 * The Object Type a workflow processes. Every workflow must name one explicitly;
 * there is no implicit default (ADR-0021).
 */
export function objectTypeForWorkflow(db: Executor, workflowId: string): ObjectType | null {
  const workflow = db
    .select({ workspaceId: workflows.workspaceId, objectTypeId: workflows.objectTypeId })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .all()[0];
  if (!workflow) return null;
  if (!workflow.objectTypeId) {
    throw errors.precondition('This workflow has no Object Type configured', { workflowId });
  }
  return requireObjectType(db, workflow.workspaceId, workflow.objectTypeId);
}

export async function listObjectTypes(
  db: Executor,
  actor: ActorContext
): Promise<ObjectTypeSummary[]> {
  assertPermission(actor, Permissions.workflowRead, 'Not permitted to read object types');
  const rows = await db
    .select()
    .from(objectTypes)
    .where(and(eq(objectTypes.workspaceId, actor.workspaceId), isNull(objectTypes.archivedAt)))
    .orderBy(asc(objectTypes.position), asc(objectTypes.name))
    .all();

  const fieldCounts = countBy(
    await db
      .select({ objectTypeId: objectTypeFields.objectTypeId, count: sql<number>`count(*)` })
      .from(objectTypeFields)
      .where(eq(objectTypeFields.workspaceId, actor.workspaceId))
      .groupBy(objectTypeFields.objectTypeId)
      .all()
  );
  const recordCounts = countBy(
    await db
      .select({ objectTypeId: records.objectTypeId, count: sql<number>`count(*)` })
      .from(records)
      .where(and(eq(records.workspaceId, actor.workspaceId), isNull(records.archivedAt)))
      .groupBy(records.objectTypeId)
      .all()
  );

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    pluralName: row.pluralName,
    description: row.description,
    icon: row.icon,
    color: row.color,
    isSystem: row.isSystem,
    position: row.position,
    settings: (row.settings as Record<string, unknown>) ?? {},
    fieldCount: fieldCounts.get(row.id) ?? 0,
    recordCount: recordCounts.get(row.id) ?? 0
  }));
}

function countBy(rows: Array<{ objectTypeId: string; count: number }>): Map<string, number> {
  return new Map(rows.map((row) => [row.objectTypeId, Number(row.count)]));
}

export function createObjectType(
  db: Executor,
  actor: ActorContext,
  input: CreateObjectTypeInput
): ObjectType {
  assertPermission(actor, Permissions.workflowAdmin, 'Not permitted to define object types');
  const name = input.name.trim();
  if (name.length === 0) throw errors.validation('Object type name is required');
  const key = normalizeObjectTypeKey(input.key ?? name, name);
  if (findObjectTypeByKey(db, actor.workspaceId, key)) {
    throw errors.conflict(`An object type with key "${key}" already exists`, { key });
  }
  const now = Date.now();
  const maxPosition =
    db
      .select({ position: sql<number>`coalesce(max(${objectTypes.position}), -1)` })
      .from(objectTypes)
      .where(eq(objectTypes.workspaceId, actor.workspaceId))
      .all()[0]?.position ?? -1;
  const inserted = db
    .insert(objectTypes)
    .values({
      id: uuidv7(now),
      workspaceId: actor.workspaceId,
      key,
      name,
      pluralName: (input.pluralName?.trim() || defaultPluralName(name)).slice(0, 120),
      description: input.description ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      settings: (input.settings as never) ?? null,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      position: Number(maxPosition) + 1,
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .all()[0];
  if (!inserted) throw errors.internal('Failed to create object type');
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.objectTypeCreated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'object_type',
    entityId: inserted.id,
    summary: `Object type ${inserted.name} created`,
    data: { key: inserted.key }
  });
  return inserted;
}

export function updateObjectType(
  db: Executor,
  actor: ActorContext,
  input: Partial<CreateObjectTypeInput> & { objectTypeId: string }
): ObjectType {
  assertPermission(actor, Permissions.workflowAdmin, 'Not permitted to edit object types');
  const current = requireObjectType(db, actor.workspaceId, input.objectTypeId);
  const updated = db
    .update(objectTypes)
    .set({
      name: input.name?.trim() || current.name,
      pluralName: input.pluralName?.trim() || current.pluralName,
      description: input.description === undefined ? current.description : input.description,
      icon: input.icon === undefined ? current.icon : input.icon,
      color: input.color === undefined ? current.color : input.color,
      settings:
        input.settings === undefined ? current.settings : ((input.settings as never) ?? null),
      updatedAt: Date.now()
    })
    .where(eq(objectTypes.id, current.id))
    .returning()
    .all()[0];
  if (!updated) throw errors.internal('Failed to update object type');
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.objectTypeUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'object_type',
    entityId: updated.id,
    summary: `Object type ${updated.name} updated`
  });
  return updated;
}

export function archiveObjectType(db: Executor, actor: ActorContext, objectTypeId: string): void {
  assertPermission(actor, Permissions.workflowAdmin, 'Not permitted to archive object types');
  const current = requireObjectType(db, actor.workspaceId, objectTypeId);
  if (current.isSystem) {
    throw errors.conflict('System object types cannot be archived', { objectTypeId });
  }
  const live = db
    .select({ count: sql<number>`count(*)` })
    .from(records)
    .where(and(eq(records.objectTypeId, objectTypeId), isNull(records.archivedAt)))
    .all()[0]?.count;
  if (Number(live) > 0) {
    throw errors.conflict('Archive the records of this object type first', {
      objectTypeId,
      records: Number(live)
    });
  }
  db.update(objectTypes)
    .set({ archivedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(objectTypes.id, objectTypeId))
    .run();
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.objectTypeArchived,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'object_type',
    entityId: objectTypeId,
    summary: `Object type ${current.name} archived`
  });
}

/** Base (Object Type) schema for one type, ordered for display. */
export async function listBaseFields(
  db: Executor,
  workspaceId: string,
  objectTypeId: string
): Promise<ObjectTypeFieldView[]> {
  requireObjectType(db, workspaceId, objectTypeId);
  return listBaseFieldsSync(db, workspaceId, objectTypeId);
}

/** Synchronous variant so services can call it inside a transaction body. */
export function listBaseFieldsSync(
  executor: Executor,
  workspaceId: string,
  objectTypeId: string
): ObjectTypeFieldView[] {
  const rows = executor
    .select({ binding: objectTypeFields, definition: fieldDefinitions })
    .from(objectTypeFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, objectTypeFields.fieldDefinitionId))
    .where(
      and(
        eq(objectTypeFields.workspaceId, workspaceId),
        eq(objectTypeFields.objectTypeId, objectTypeId),
        isNull(fieldDefinitions.archivedAt)
      )
    )
    .orderBy(asc(objectTypeFields.position), asc(fieldDefinitions.name))
    .all();
  return rows.map(({ binding, definition }) => ({
    bindingId: binding.id,
    fieldDefinitionId: definition.id,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    options: definition.options,
    validation: definition.validation,
    display: definition.display,
    required: binding.required,
    isIdentity: binding.isIdentity,
    isPrimaryDisplay: binding.isPrimaryDisplay,
    isSecondaryDisplay: binding.isSecondaryDisplay,
    showInList: binding.showInList,
    showOnCard: binding.showOnCard,
    filterable: binding.filterable,
    position: binding.position,
    defaultValue: binding.defaultValue
  }));
}

/**
 * Validate the values a direct Record write is about to persist against the
 * Object Type's authoritative Zod schema, when one was authored as source.
 *
 * Direct writes — the browser editor, `records.create`, `records.update` and
 * `records.setFields` — are partial and bypass the workflow submission contract,
 * so without this a base-schema violation could be persisted. Only the keys being
 * written are checked, and an empty value counts as "unset" rather than a
 * violation. Date and datetime values are rendered as ISO strings first because
 * the field engine stores epoch milliseconds while Zod date formats validate ISO.
 */
export function assertObjectTypeValuesValid(
  db: Executor,
  workspaceId: string,
  objectType: ObjectType,
  values: Record<string, unknown>
): void {
  const source = objectType.settings?.zodSchema;
  if (!source) return;
  const compiled = compileZodSource(source);
  if (!compiled.ok || !compiled.object) return;
  const shape = compiled.object.shape;
  const types = new Map(
    listBaseFieldsSync(db, workspaceId, objectType.id).map((field) => [field.key, field.type])
  );
  const candidate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!(key in shape) || isEmptyWriteValue(value)) continue;
    candidate[key] = normalizeWriteValue(types.get(key), value);
  }
  if (Object.keys(candidate).length === 0) return;
  const parsed = z.object(shape).partial().safeParse(candidate);
  if (!parsed.success) {
    throw errors.validation(`${objectType.name} record failed its Object Type schema`, {
      objectTypeId: objectType.id,
      objectTypeKey: objectType.key,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message
      })),
      source: 'object_type_schema'
    });
  }
}

/** The field engine stores an empty value by deleting the row; "unset" is not a violation. */
function isEmptyWriteValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function normalizeWriteValue(type: FieldType | undefined, value: unknown): unknown {
  if (type !== 'date' && type !== 'datetime') return value;
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return value;
  const iso = new Date(ms).toISOString();
  return type === 'date' ? iso.slice(0, 10) : iso;
}

/** Replace-all binding of base fields for an object type. */
export async function setBaseFields(
  db: Executor,
  actor: ActorContext,
  objectTypeId: string,
  entries: ObjectTypeFieldInput[]
): Promise<ObjectTypeFieldView[]> {
  assertPermission(actor, Permissions.workflowAdmin, 'Not permitted to edit object types');
  const objectType = requireObjectType(db, actor.workspaceId, objectTypeId);
  if (objectType.isSystem) {
    throw errors.conflict('System object type fields are managed by Mentat', { objectTypeId });
  }
  const now = Date.now();
  const definitionIds: string[] = [];
  for (const entry of entries) {
    const definitionId = entry.fieldDefinitionId ?? createInlineField(db, actor, entry);
    const definition = db
      .select()
      .from(fieldDefinitions)
      .where(eq(fieldDefinitions.id, definitionId))
      .all()[0];
    if (!definition || definition.workspaceId !== actor.workspaceId) {
      throw errors.validation(`Unknown field definition ${definitionId}`);
    }
    if (definition.scope !== 'record') {
      throw errors.validation(
        `Field "${definition.key}" is scoped to ${definition.scope}; object type fields must be record-scoped`
      );
    }
    definitionIds.push(definitionId);
  }
  if (new Set(definitionIds).size !== definitionIds.length) {
    throw errors.validation('The same field cannot be bound twice');
  }

  db.delete(objectTypeFields).where(eq(objectTypeFields.objectTypeId, objectTypeId)).run();
  for (const [index, entry] of entries.entries()) {
    db.insert(objectTypeFields)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        objectTypeId,
        fieldDefinitionId: definitionIds[index] as string,
        position: entry.position ?? index,
        required: entry.required ?? false,
        isIdentity: entry.isIdentity ?? false,
        isPrimaryDisplay: entry.isPrimaryDisplay ?? false,
        isSecondaryDisplay: entry.isSecondaryDisplay ?? false,
        showInList: entry.showInList ?? true,
        showOnCard: entry.showOnCard ?? false,
        filterable: entry.filterable ?? true,
        defaultValue: (entry.defaultValue as never) ?? null,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }
  // Replacing the fields directly makes the typed bindings authoritative again;
  // a Zod source saved earlier would otherwise silently override this edit.
  clearObjectTypeZodSource(db, objectType);
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.objectTypeUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'object_type',
    entityId: objectTypeId,
    summary: `Object type ${objectType.name} schema updated`,
    data: { fields: definitionIds.length }
  });
  return listBaseFields(db, actor.workspaceId, objectTypeId);
}

/** Persist a Zod source (or clear it) in an Object Type's settings. */
function writeObjectTypeZodSource(
  db: Executor,
  objectType: ObjectType,
  source: string | null
): void {
  const settings = { ...(objectType.settings ?? {}) };
  if (source === null) {
    delete settings.zodSchema;
  } else {
    settings.zodSchema = source;
  }
  db.update(objectTypes)
    .set({
      settings: Object.keys(settings).length > 0 ? (settings as never) : null,
      updatedAt: Date.now()
    })
    .where(eq(objectTypes.id, objectType.id))
    .run();
}

function clearObjectTypeZodSource(db: Executor, objectType: ObjectType): void {
  if (!objectType.settings?.zodSchema) return;
  writeObjectTypeZodSource(db, objectType, null);
}

export interface ObjectTypeSchemaSaveResult {
  /** The stored, trimmed Zod source. */
  source: string;
  fields: ObjectTypeFieldView[];
  projected: ProjectedZodField[];
}

/**
 * Author an Object Type's schema as Zod source (ADR-0023).
 *
 * The source becomes the authoritative contract for base record fields and is
 * stored verbatim so it can be tested while authoring and run again at validation
 * time. The bound field definitions are replaced with its projection so lists,
 * filters and history keep working.
 */
export async function setObjectTypeZodSchema(
  db: Executor,
  actor: ActorContext,
  objectTypeId: string,
  source: string
): Promise<ObjectTypeSchemaSaveResult> {
  assertPermission(actor, Permissions.objectTypeAdmin, 'Not permitted to edit object types');
  const objectType = requireObjectType(db, actor.workspaceId, objectTypeId);
  if (objectType.isSystem) {
    throw errors.conflict('System object type fields are managed by Mentat', { objectTypeId });
  }

  const compiled = compileZodSource(source);
  if (!compiled.ok) throw errors.validation(compiled.message);
  if (!compiled.object) {
    throw errors.validation(
      'The Object Type schema must be a Zod object, for example z.object({}).'
    );
  }
  if (compiled.invalidKeys.length > 0) {
    throw errors.validation(
      `These keys cannot be field keys: ${compiled.invalidKeys.join(', ')}. Use lowercase letters, numbers and underscores, starting with a letter.`,
      { keys: compiled.invalidKeys }
    );
  }
  if (compiled.fields.length === 0) {
    throw errors.validation('The Object Type schema declares no fields.');
  }

  const entries: ObjectTypeFieldInput[] = compiled.fields.map((field, index) => ({
    key: field.key,
    name: field.name,
    description: field.description,
    type: field.type,
    options: (field.options as unknown as Record<string, unknown>) ?? null,
    validation: (field.validation as unknown as Record<string, unknown>) ?? null,
    defaultValue: field.defaultValue,
    position: index,
    required: field.required,
    // `.meta({ identity: true, primary: true, list: false, card: true })` lets a
    // schema keep binding behaviour without a per-field form.
    isIdentity: field.isIdentity,
    isPrimaryDisplay: field.isPrimaryDisplay || (index === 0 && field.meta.primary === undefined),
    showInList: field.showInList,
    showOnCard: field.showOnCard,
    filterable: field.filterable
  }));

  const fields = await setBaseFields(db, actor, objectTypeId, entries);
  writeObjectTypeZodSource(db, objectType, compiled.source);
  writeAudit(db, {
    workspaceId: actor.workspaceId,
    action: AuditActions.objectTypeUpdated,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    entityType: 'object_type',
    entityId: objectTypeId,
    summary: `Object type ${objectType.name} schema updated from Zod source`,
    data: { fieldKeys: compiled.fields.map((field) => field.key) }
  });

  return { source: compiled.source, fields, projected: compiled.fields };
}

function createInlineField(db: Executor, actor: ActorContext, entry: ObjectTypeFieldInput): string {
  const name = (entry.name ?? '').trim();
  if (name.length === 0) throw errors.validation('Field name is required');
  if (!entry.type) throw errors.validation('Field type is required');
  const key = (entry.key ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!FIELD_KEY_PATTERN.test(key)) {
    throw errors.validation(`Invalid field key "${key}"`);
  }
  const definition = ensureFieldDefinition(db, actor, {
    key,
    name,
    type: entry.type,
    scope: 'record',
    description: entry.description ?? null,
    options: (entry.options as FieldOptions | null) ?? null,
    validation: (entry.validation as FieldValidation | null) ?? null,
    defaultValue: entry.defaultValue
  });
  return definition.id;
}

function normalizeObjectTypeKey(input: string, fallbackName: string): string {
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (key.length < 2) {
    throw errors.validation(`Object type key "${key}" is too short (from "${fallbackName}")`, {
      key
    });
  }
  return key;
}
