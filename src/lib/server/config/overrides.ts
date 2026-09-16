/**
 * Workspace ⇄ workflow resource bindings.
 *
 * Why this exists: the product promise is "always show effective configuration
 * and provenance" (Use as-is / Override / Fork). Following ADR-0006, each
 * resource keeps its own table and a single `workspace_overrides` row records the
 * *binding* — which workspace resource a workflow-scoped resource derives from,
 * how it relates (mode), and which fields were changed.
 *
 * Removing a binding row resumes inheritance, which is why nothing here is
 * soft-deleted: provenance is current state, and the audit ledger keeps history.
 */
import { and, eq } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import type { BindableResourceType, ResourceBindingMode } from '../db/schema';
import { workspaceOverrides } from '../db/schema';

export const BINDABLE_RESOURCE_TYPES: readonly BindableResourceType[] = [
  'agent',
  'skill',
  'tool',
  'http_service',
  'http_operation',
  'field_definition',
  'collection',
  'provider',
  'model',
  'secret',
  'environment_variable'
];

export interface OverrideView {
  id: string;
  workspaceId: string;
  workflowId: string;
  resourceType: BindableResourceType;
  resourceId: string;
  sourceResourceId: string | null;
  mode: ResourceBindingMode;
  overriddenFields: string[];
  createdAt: number;
  updatedAt: number;
}

/** Effective binding for one resource in one workflow. */
export interface BindingResolution {
  workflowId: string;
  resourceType: BindableResourceType;
  resourceId: string;
  mode: ResourceBindingMode;
  sourceResourceId: string | null;
  overriddenFields: string[];
  /** Uses a shared workspace resource as-is. */
  inherited: boolean;
  /** Has no workspace source at all. */
  local: boolean;
  /** Independent local copy of a source. */
  forked: boolean;
  /** True when an explicit binding row exists. */
  exists: boolean;
}

export interface EffectiveConfigurationGroup {
  resourceType: BindableResourceType;
  counts: { inherited: number; overridden: number; local: number; forked: number };
  bindings: BindingResolution[];
}

export interface EffectiveConfiguration {
  workspaceId: string;
  workflowId: string;
  groups: EffectiveConfigurationGroup[];
  totals: { inherited: number; overridden: number; local: number; forked: number };
}

export interface SetOverrideInput {
  workflowId: string;
  resourceType: BindableResourceType;
  resourceId: string;
  /** The workspace-level resource this one derives from. */
  sourceResourceId?: string | null;
  mode: ResourceBindingMode;
  overriddenFields?: string[];
}

function assertResourceType(value: string): asserts value is BindableResourceType {
  if (!(BINDABLE_RESOURCE_TYPES as readonly string[]).includes(value)) {
    throw errors.validation(`Unknown bindable resource type "${value}"`, {
      resourceType: value
    });
  }
}

function assertMode(value: string): asserts value is ResourceBindingMode {
  if (value !== 'use_asis' && value !== 'override' && value !== 'fork') {
    throw errors.validation(`Unknown binding mode "${value}"`, { mode: value });
  }
}

function requireNonEmpty(value: string | null | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errors.validation(`${label} is required`);
  }
  return value;
}

function toView(row: typeof workspaceOverrides.$inferSelect): OverrideView {
  if (!row.workflowId) {
    // Bindings are workflow-scoped by definition; a null workflow row cannot be
    // produced by this module and would make the provenance UI lie.
    throw errors.internal('Override row is missing its workflow scope', { overrideId: row.id });
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workflowId: row.workflowId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    sourceResourceId: row.sourceResourceId,
    mode: row.mode,
    overriddenFields: row.overriddenFields ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * Record (or replace) a binding. `use_asis` and `fork` describe a relationship
 * without field changes; `override` requires the workspace source it inherits
 * from and the names of the fields it replaces.
 */
export async function setOverride(
  db: Executor,
  actor: ActorContext,
  input: SetOverrideInput
): Promise<OverrideView> {
  assertPermission(
    actor,
    Permissions.configWrite,
    'Not permitted to change configuration bindings'
  );
  const workflowId = requireNonEmpty(input.workflowId, 'workflowId');
  const resourceId = requireNonEmpty(input.resourceId, 'resourceId');
  assertResourceType(input.resourceType);
  assertMode(input.mode);

  if (input.mode === 'override' && !input.sourceResourceId) {
    throw errors.validation('An override binding requires the sourceResourceId it overrides');
  }
  const overriddenFields = [
    ...new Set((input.overriddenFields ?? []).map((field) => field.trim()))
  ];
  if (overriddenFields.some((field) => field.length === 0)) {
    throw errors.validation('overriddenFields must not contain empty names');
  }
  if (input.mode === 'use_asis' && overriddenFields.length > 0) {
    throw errors.validation('A use_asis binding cannot override fields; use mode "override"');
  }
  const sourceResourceId = input.sourceResourceId ?? (input.mode === 'fork' ? null : resourceId);

  const row = await withTransaction(db, (tx) => {
    const existing = tx
      .select()
      .from(workspaceOverrides)
      .where(
        and(
          eq(workspaceOverrides.workspaceId, actor.workspaceId),
          eq(workspaceOverrides.workflowId, workflowId),
          eq(workspaceOverrides.resourceType, input.resourceType),
          eq(workspaceOverrides.resourceId, resourceId)
        )
      )
      .limit(1)
      .all()[0];

    const now = Date.now();
    const persisted = existing
      ? tx
          .update(workspaceOverrides)
          .set({ sourceResourceId, mode: input.mode, overriddenFields, updatedAt: now })
          .where(eq(workspaceOverrides.id, existing.id))
          .returning()
          .all()[0]
      : tx
          .insert(workspaceOverrides)
          .values({
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            workflowId,
            resourceType: input.resourceType,
            resourceId,
            sourceResourceId,
            mode: input.mode,
            overriddenFields,
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .all()[0];
    if (!persisted) throw errors.internal('Failed to persist override', { resourceId });

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.overrideSet,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: input.resourceType,
      entityId: resourceId,
      workflowId,
      summary: `${input.resourceType} "${resourceId}" bound as ${input.mode}`,
      data: {
        resourceType: input.resourceType,
        resourceId,
        sourceResourceId,
        mode: input.mode,
        overriddenFields
      }
    });
    return persisted;
  });

  return toView(row);
}

/** Remove a binding; the workflow resumes inheriting the workspace resource. */
export async function removeOverride(
  db: Executor,
  actor: ActorContext,
  input: { workflowId: string; resourceType: BindableResourceType; resourceId: string }
): Promise<void> {
  assertPermission(
    actor,
    Permissions.configWrite,
    'Not permitted to change configuration bindings'
  );
  const workflowId = requireNonEmpty(input.workflowId, 'workflowId');
  const resourceId = requireNonEmpty(input.resourceId, 'resourceId');
  assertResourceType(input.resourceType);

  await withTransaction(db, (tx) => {
    const deleted = tx
      .delete(workspaceOverrides)
      .where(
        and(
          eq(workspaceOverrides.workspaceId, actor.workspaceId),
          eq(workspaceOverrides.workflowId, workflowId),
          eq(workspaceOverrides.resourceType, input.resourceType),
          eq(workspaceOverrides.resourceId, resourceId)
        )
      )
      .returning()
      .all()[0];
    if (!deleted) throw errors.notFound('Override', resourceId);

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.overrideRemoved,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: input.resourceType,
      entityId: resourceId,
      workflowId,
      summary: `Override for ${input.resourceType} "${resourceId}" removed; inheritance resumed`,
      data: { resourceType: input.resourceType, resourceId }
    });
  });
}

export function getOverride(
  db: Executor,
  actor: ActorContext,
  input: { workflowId: string; resourceType: BindableResourceType; resourceId: string }
): OverrideView | null {
  assertPermission(actor, Permissions.configRead, 'Not permitted to read configuration');
  assertResourceType(input.resourceType);
  const row = db
    .select()
    .from(workspaceOverrides)
    .where(
      and(
        eq(workspaceOverrides.workspaceId, actor.workspaceId),
        eq(workspaceOverrides.workflowId, input.workflowId),
        eq(workspaceOverrides.resourceType, input.resourceType),
        eq(workspaceOverrides.resourceId, input.resourceId)
      )
    )
    .limit(1)
    .all()[0];
  return row ? toView(row) : null;
}

export function listOverrides(
  db: Executor,
  actor: ActorContext,
  options: { workflowId?: string; resourceType?: BindableResourceType } = {}
): OverrideView[] {
  assertPermission(actor, Permissions.configRead, 'Not permitted to read configuration');
  if (options.resourceType) assertResourceType(options.resourceType);
  const conditions = [eq(workspaceOverrides.workspaceId, actor.workspaceId)];
  if (options.workflowId) conditions.push(eq(workspaceOverrides.workflowId, options.workflowId));
  if (options.resourceType)
    conditions.push(eq(workspaceOverrides.resourceType, options.resourceType));
  return db
    .select()
    .from(workspaceOverrides)
    .where(and(...conditions))
    .orderBy(workspaceOverrides.resourceType, workspaceOverrides.resourceId)
    .all()
    .map(toView);
}

function toResolution(
  row: OverrideView | undefined,
  resourceId: string,
  workflowId: string,
  resourceType: BindableResourceType
): BindingResolution {
  if (!row) {
    // No explicit binding means the workflow sees the workspace resource as-is.
    return {
      workflowId,
      resourceType,
      resourceId,
      mode: 'use_asis',
      sourceResourceId: resourceId,
      overriddenFields: [],
      inherited: true,
      local: false,
      forked: false,
      exists: false
    };
  }
  const local = row.sourceResourceId === null;
  return {
    workflowId,
    resourceType,
    resourceId,
    mode: row.mode,
    sourceResourceId: row.sourceResourceId,
    overriddenFields: row.overriddenFields,
    inherited: !local && row.mode === 'use_asis',
    local,
    forked: row.mode === 'fork',
    exists: true
  };
}

/**
 * Effective mode, source and changed fields for one resource in one workflow.
 * `exists: false` means "inherited with no binding row", which the UI renders as
 * *Inherited* rather than as missing configuration.
 */
export function resolveBinding(
  db: Executor,
  actor: ActorContext,
  input: { workflowId: string; resourceType: BindableResourceType; resourceId: string }
): BindingResolution {
  assertPermission(actor, Permissions.configRead, 'Not permitted to read configuration');
  assertResourceType(input.resourceType);
  const row = getOverride(db, actor, input);
  return toResolution(row ?? undefined, input.resourceId, input.workflowId, input.resourceType);
}

/** Everything bound in a workflow, grouped by resource type with UI counts. */
export function listEffectiveConfiguration(
  db: Executor,
  actor: ActorContext,
  workflowId: string
): EffectiveConfiguration {
  assertPermission(actor, Permissions.configRead, 'Not permitted to read configuration');
  const overrides = listOverrides(db, actor, { workflowId });

  const byType = new Map<BindableResourceType, BindingResolution[]>();
  for (const override of overrides) {
    const resolution = toResolution(
      override,
      override.resourceId,
      workflowId,
      override.resourceType
    );
    const list = byType.get(override.resourceType) ?? [];
    list.push(resolution);
    byType.set(override.resourceType, list);
  }

  const groups: EffectiveConfigurationGroup[] = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resourceType, bindings]) => {
      const counts = { inherited: 0, overridden: 0, local: 0, forked: 0 };
      for (const binding of bindings) {
        if (binding.local) counts.local += 1;
        else if (binding.mode === 'override') counts.overridden += 1;
        else if (binding.mode === 'fork') counts.forked += 1;
        else counts.inherited += 1;
      }
      return { resourceType, counts, bindings };
    });

  const totals = { inherited: 0, overridden: 0, local: 0, forked: 0 };
  for (const group of groups) {
    totals.inherited += group.counts.inherited;
    totals.overridden += group.counts.overridden;
    totals.local += group.counts.local;
    totals.forked += group.counts.forked;
  }

  return { workspaceId: actor.workspaceId, workflowId, groups, totals };
}
