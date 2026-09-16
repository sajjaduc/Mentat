/**
 * Dashboards and widget CRUD.
 *
 * A dashboard is a named collection of widget definitions plus a global filter.
 * Persisting the *declarative* widget (data source, AST, measure, grouping, time
 * range) rather than a rendered query means a dashboard re-runs against current
 * data and can reuse saved-view filters verbatim.
 *
 * Privacy mirrors saved views: a dashboard is shared with the workspace or
 * private to its creator, private resources answer `not_found` to everyone else,
 * and mutating a shared dashboard requires being its creator or a workspace
 * admin. Reads need `analytics:read`, writes need `analytics:write`.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../audit/ledger';
import {
  type ActorContext,
  assertAnyPermission,
  assertPermission,
  Permissions
} from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import {
  type Dashboard,
  type DashboardWidget,
  dashboards,
  dashboardWidgets,
  type WidgetDataSource,
  type WidgetGrouping,
  type WidgetMeasure,
  type WidgetTimeRange,
  type WidgetVisualization
} from '../db/schema';
import { combineFilters, type FilterAst, parseFilterAst } from '../filters/ast';
import { runWidget, type WidgetDefinition, type WidgetResult } from './query';

export interface DashboardLayoutItem {
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const layoutSchema = z.array(
  z.object({
    widgetId: z.string().min(1),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive()
  })
);

const dashboardDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  globalFilters: z.unknown().optional(),
  layout: layoutSchema.nullable().optional(),
  isDefault: z.boolean().optional(),
  isShared: z.boolean().optional()
});

const dashboardPatchSchema = dashboardDraftSchema.partial();

const widgetTypeSchema = z.enum([
  'kpi',
  'number',
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'table',
  'funnel',
  'aging'
]);

const dataSourceSchema = z.object({
  kind: z.enum(['tickets', 'state_history', 'field_history', 'runs', 'files']),
  workflowIds: z.array(z.string()).optional(),
  funnelStages: z
    .array(
      z.object({
        label: z.string().min(1),
        stateIds: z.array(z.string()).optional(),
        fieldKey: z.string().optional(),
        fieldValue: z.unknown().optional()
      })
    )
    .optional(),
  agingStates: z.array(z.string()).optional()
});

const measureSchema = z.object({
  aggregation: z.enum(['count', 'sum', 'avg', 'median', 'min', 'max', 'conversion', 'duration']),
  fieldKey: z.string().nullable().optional(),
  durationOf: z.enum(['time_in_state', 'cycle_time', 'time_to_state']).optional()
});

const groupingSchema = z.object({
  by: z.enum([
    'none',
    'state',
    'priority',
    'owner',
    'team',
    'label',
    'workflow',
    'field',
    'day',
    'week',
    'month'
  ]),
  fieldKey: z.string().optional(),
  limit: z.number().int().positive().optional()
});

const timeRangeSchema = z.object({
  kind: z.enum(['relative', 'absolute', 'all']),
  lastDays: z.number().positive().optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  basis: z.enum(['created', 'updated', 'entered_state']).optional()
});

const visualizationSchema = z.object({
  color: z.string().optional(),
  showLegend: z.boolean().optional(),
  showValues: z.boolean().optional(),
  stacked: z.boolean().optional(),
  valueFormat: z.enum(['number', 'currency', 'percent', 'duration']).optional(),
  currency: z.string().optional()
});

const widgetDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  type: widgetTypeSchema,
  position: z.number().int().optional(),
  size: z.enum(['sm', 'md', 'lg', 'full']).optional(),
  dataSource: dataSourceSchema,
  filter: z.unknown().optional(),
  measure: measureSchema,
  grouping: groupingSchema.nullable().optional(),
  timeRange: timeRangeSchema.nullable().optional(),
  visualization: visualizationSchema.nullable().optional(),
  savedViewId: z.string().nullable().optional()
});

const widgetPatchSchema = widgetDraftSchema.partial();

export interface DashboardDraft {
  name: string;
  description?: string | null;
  globalFilters?: unknown;
  layout?: DashboardLayoutItem[] | null;
  isDefault?: boolean;
  isShared?: boolean;
}

export type DashboardPatch = Partial<DashboardDraft>;

export interface DashboardWidgetDraft {
  title: string;
  description?: string | null;
  type: DashboardWidget['type'];
  position?: number;
  size?: DashboardWidget['size'];
  dataSource: WidgetDataSource;
  filter?: unknown;
  measure: WidgetMeasure;
  grouping?: WidgetGrouping | null;
  timeRange?: WidgetTimeRange | null;
  visualization?: WidgetVisualization | null;
  savedViewId?: string | null;
}

export type DashboardWidgetPatch = Partial<DashboardWidgetDraft>;

export interface DashboardDetail extends Dashboard {
  widgets: DashboardWidget[];
  globalFilter: FilterAst | null;
}

export interface RunDashboardOptions {
  workspaceId: string;
  dashboardId: string;
  /** Request-level filter ANDed with the dashboard's stored global filter. */
  globalFilter?: FilterAst | null;
  now?: number;
}

export interface DashboardRunResult {
  dashboard: Dashboard;
  globalFilter: FilterAst | null;
  results: Record<string, WidgetResult>;
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw errors.validation(message, { issues: result.error.issues });
  return result.data;
}

function parseFilter(input: unknown): FilterAst | null {
  try {
    return parseFilterAst(input);
  } catch (cause) {
    throw errors.validation('Invalid filter', { cause: String(cause) });
  }
}

function safeParseFilter(input: unknown): FilterAst | null {
  try {
    return parseFilterAst(input);
  } catch {
    return null;
  }
}

function assertVisible(dashboard: Dashboard, actor: ActorContext): void {
  if (dashboard.isShared) return;
  if (dashboard.createdByUserId !== null && dashboard.createdByUserId === actor.actorId) return;
  throw errors.notFound('Dashboard', dashboard.id);
}

function assertCanMutate(dashboard: Dashboard, actor: ActorContext): void {
  if (dashboard.createdByUserId !== null && dashboard.createdByUserId === actor.actorId) return;
  if (actor.permissions.has(Permissions.workspaceAdmin)) return;
  throw errors.forbidden('Only the creator or a workspace admin may change this dashboard', {
    dashboardId: dashboard.id
  });
}

async function loadDashboard(
  db: Executor,
  workspaceId: string,
  dashboardId: string
): Promise<Dashboard> {
  const rows = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.workspaceId, workspaceId), eq(dashboards.id, dashboardId)))
    .all();
  const dashboard = rows[0];
  if (!dashboard) throw errors.notFound('Dashboard', dashboardId);
  return dashboard;
}

async function loadWidget(
  db: Executor,
  workspaceId: string,
  widgetId: string
): Promise<{ widget: DashboardWidget; dashboard: Dashboard }> {
  const rows = await db
    .select()
    .from(dashboardWidgets)
    .where(and(eq(dashboardWidgets.workspaceId, workspaceId), eq(dashboardWidgets.id, widgetId)))
    .all();
  const widget = rows[0];
  if (!widget) throw errors.notFound('Dashboard widget', widgetId);
  const dashboard = await loadDashboard(db, workspaceId, widget.dashboardId);
  return { widget, dashboard };
}

async function assertNameAvailable(
  db: Executor,
  workspaceId: string,
  name: string,
  excludeId?: string
): Promise<void> {
  const rows = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.workspaceId, workspaceId), eq(dashboards.name, name)))
    .all();
  if (rows.some((row) => row.id !== excludeId)) {
    throw errors.conflict(`A dashboard named "${name}" already exists`, { name });
  }
}

export async function createDashboard(
  db: Executor,
  actor: ActorContext,
  draft: DashboardDraft
): Promise<Dashboard> {
  assertPermission(actor, Permissions.analyticsWrite);
  const parsed = parseOrThrow(dashboardDraftSchema, draft, 'Invalid dashboard');
  const globalFilter =
    parsed.globalFilters === undefined ? null : parseFilter(parsed.globalFilters);
  await assertNameAvailable(db, actor.workspaceId, parsed.name);

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const inserted = tx
      .insert(dashboards)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        name: parsed.name,
        description: parsed.description ?? null,
        globalFilters: (globalFilter ?? null) as never,
        layout: (parsed.layout ?? null) as never,
        isDefault: parsed.isDefault ?? false,
        isShared: parsed.isShared ?? true,
        createdByUserId: actor.actorId,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all();
    const dashboard = inserted[0];
    if (!dashboard) throw errors.internal('Failed to create dashboard');
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboard.id,
      summary: `Dashboard "${dashboard.name}" created`
    });
    return dashboard;
  });
}

export async function updateDashboard(
  db: Executor,
  actor: ActorContext,
  dashboardId: string,
  patch: DashboardPatch
): Promise<Dashboard> {
  assertPermission(actor, Permissions.analyticsWrite);
  const current = await loadDashboard(db, actor.workspaceId, dashboardId);
  assertVisible(current, actor);
  assertCanMutate(current, actor);

  const parsed = parseOrThrow(dashboardPatchSchema, patch, 'Invalid dashboard');
  const name = parsed.name ?? current.name;
  if (name !== current.name) await assertNameAvailable(db, actor.workspaceId, name, current.id);
  const globalFilter =
    parsed.globalFilters === undefined ? undefined : parseFilter(parsed.globalFilters);
  const now = Date.now();

  return withTransaction(db, (tx) => {
    const updated = tx
      .update(dashboards)
      .set({
        name,
        description: parsed.description === undefined ? current.description : parsed.description,
        globalFilters: (globalFilter === undefined ? current.globalFilters : globalFilter) as never,
        layout: (parsed.layout === undefined ? current.layout : parsed.layout) as never,
        isDefault: parsed.isDefault ?? current.isDefault,
        isShared: parsed.isShared ?? current.isShared,
        updatedAt: now
      })
      .where(and(eq(dashboards.workspaceId, actor.workspaceId), eq(dashboards.id, dashboardId)))
      .returning()
      .all();
    const dashboard = updated[0];
    if (!dashboard) throw errors.notFound('Dashboard', dashboardId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboard.id,
      summary: `Dashboard "${dashboard.name}" updated`
    });
    return dashboard;
  });
}

export async function deleteDashboard(
  db: Executor,
  actor: ActorContext,
  dashboardId: string
): Promise<void> {
  assertPermission(actor, Permissions.analyticsWrite);
  const current = await loadDashboard(db, actor.workspaceId, dashboardId);
  assertVisible(current, actor);
  assertCanMutate(current, actor);
  await withTransaction(db, (tx) => {
    tx.delete(dashboards)
      .where(and(eq(dashboards.workspaceId, actor.workspaceId), eq(dashboards.id, dashboardId)))
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardDeleted,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboardId,
      summary: `Dashboard "${current.name}" deleted`
    });
  });
}

export async function getDashboard(
  db: Executor,
  actor: ActorContext,
  dashboardId: string
): Promise<DashboardDetail> {
  assertPermission(actor, Permissions.analyticsRead);
  const dashboard = await loadDashboard(db, actor.workspaceId, dashboardId);
  assertVisible(dashboard, actor);
  const widgets = await db
    .select()
    .from(dashboardWidgets)
    .where(
      and(
        eq(dashboardWidgets.workspaceId, actor.workspaceId),
        eq(dashboardWidgets.dashboardId, dashboardId)
      )
    )
    .orderBy(asc(dashboardWidgets.position), asc(dashboardWidgets.createdAt))
    .all();
  return {
    ...dashboard,
    widgets,
    globalFilter: safeParseFilter(dashboard.globalFilters)
  };
}

export async function listDashboards(db: Executor, actor: ActorContext): Promise<Dashboard[]> {
  assertAnyPermission(actor, [Permissions.analyticsRead]);
  const visibility = actor.actorId
    ? sql`(${dashboards.isShared} = 1 OR ${dashboards.createdByUserId} = ${actor.actorId})`
    : sql`${dashboards.isShared} = 1`;
  return db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.workspaceId, actor.workspaceId), visibility))
    .orderBy(desc(dashboards.isDefault), asc(dashboards.name))
    .all();
}

async function nextWidgetPosition(db: Executor, dashboardId: string): Promise<number> {
  const rows = await db
    .select({ position: dashboardWidgets.position })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboardId))
    .all();
  return rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
}

export async function addWidget(
  db: Executor,
  actor: ActorContext,
  dashboardId: string,
  draft: DashboardWidgetDraft
): Promise<DashboardWidget> {
  assertPermission(actor, Permissions.analyticsWrite);
  const dashboard = await loadDashboard(db, actor.workspaceId, dashboardId);
  assertVisible(dashboard, actor);
  assertCanMutate(dashboard, actor);
  const parsed = parseOrThrow(widgetDraftSchema, draft, 'Invalid widget');
  if (parsed.filter !== undefined) parseFilter(parsed.filter);
  const position = parsed.position ?? (await nextWidgetPosition(db, dashboardId));
  const now = Date.now();

  return withTransaction(db, (tx) => {
    const inserted = tx
      .insert(dashboardWidgets)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        dashboardId,
        title: parsed.title,
        description: parsed.description ?? null,
        type: parsed.type,
        position,
        size: parsed.size ?? 'md',
        dataSource: parsed.dataSource as never,
        filter: (parsed.filter ?? null) as never,
        measure: parsed.measure as never,
        grouping: (parsed.grouping ?? null) as never,
        timeRange: (parsed.timeRange ?? null) as never,
        visualization: (parsed.visualization ?? null) as never,
        savedViewId: parsed.savedViewId ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all();
    const widget = inserted[0];
    if (!widget) throw errors.internal('Failed to create widget');
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboardId,
      summary: `Widget "${widget.title}" added`
    });
    return widget;
  });
}

export async function updateWidget(
  db: Executor,
  actor: ActorContext,
  widgetId: string,
  patch: DashboardWidgetPatch
): Promise<DashboardWidget> {
  assertPermission(actor, Permissions.analyticsWrite);
  const { widget: current, dashboard } = await loadWidget(db, actor.workspaceId, widgetId);
  assertVisible(dashboard, actor);
  assertCanMutate(dashboard, actor);
  const parsed = parseOrThrow(widgetPatchSchema, patch, 'Invalid widget');
  if (parsed.filter !== undefined) parseFilter(parsed.filter);
  const now = Date.now();

  return withTransaction(db, (tx) => {
    const updated = tx
      .update(dashboardWidgets)
      .set({
        title: parsed.title ?? current.title,
        description: parsed.description === undefined ? current.description : parsed.description,
        type: parsed.type ?? current.type,
        position: parsed.position ?? current.position,
        size: parsed.size ?? current.size,
        dataSource: (parsed.dataSource ?? current.dataSource) as never,
        filter: (parsed.filter === undefined ? current.filter : parsed.filter) as never,
        measure: (parsed.measure ?? current.measure) as never,
        grouping: (parsed.grouping === undefined ? current.grouping : parsed.grouping) as never,
        timeRange: (parsed.timeRange === undefined ? current.timeRange : parsed.timeRange) as never,
        visualization: (parsed.visualization === undefined
          ? current.visualization
          : parsed.visualization) as never,
        savedViewId: parsed.savedViewId === undefined ? current.savedViewId : parsed.savedViewId,
        updatedAt: now
      })
      .where(
        and(eq(dashboardWidgets.workspaceId, actor.workspaceId), eq(dashboardWidgets.id, widgetId))
      )
      .returning()
      .all();
    const widget = updated[0];
    if (!widget) throw errors.notFound('Dashboard widget', widgetId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboard.id,
      summary: `Widget "${widget.title}" updated`
    });
    return widget;
  });
}

export async function deleteWidget(
  db: Executor,
  actor: ActorContext,
  widgetId: string
): Promise<void> {
  assertPermission(actor, Permissions.analyticsWrite);
  const { dashboard, widget } = await loadWidget(db, actor.workspaceId, widgetId);
  assertVisible(dashboard, actor);
  assertCanMutate(dashboard, actor);
  await withTransaction(db, (tx) => {
    tx.delete(dashboardWidgets)
      .where(
        and(eq(dashboardWidgets.workspaceId, actor.workspaceId), eq(dashboardWidgets.id, widgetId))
      )
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboard.id,
      summary: `Widget "${widget.title}" deleted`
    });
  });
}

export async function setDashboardLayout(
  db: Executor,
  actor: ActorContext,
  dashboardId: string,
  layout: DashboardLayoutItem[]
): Promise<Dashboard> {
  assertPermission(actor, Permissions.analyticsWrite);
  const dashboard = await loadDashboard(db, actor.workspaceId, dashboardId);
  assertVisible(dashboard, actor);
  assertCanMutate(dashboard, actor);
  const parsed = parseOrThrow(layoutSchema, layout, 'Invalid layout');
  const now = Date.now();
  return withTransaction(db, (tx) => {
    const updated = tx
      .update(dashboards)
      .set({ layout: parsed as never, updatedAt: now })
      .where(and(eq(dashboards.workspaceId, actor.workspaceId), eq(dashboards.id, dashboardId)))
      .returning()
      .all();
    const row = updated[0];
    if (!row) throw errors.notFound('Dashboard', dashboardId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.dashboardUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'dashboard',
      entityId: dashboardId,
      summary: 'Dashboard layout updated'
    });
    return row;
  });
}

/**
 * Execute every widget on a dashboard in layout order and combine the
 * dashboard's stored global filter with an optional request-level filter. The
 * result is keyed by widget id so a UI can render widgets independently.
 */
export async function runDashboard(
  db: Executor,
  options: RunDashboardOptions
): Promise<DashboardRunResult> {
  const dashboard = await loadDashboard(db, options.workspaceId, options.dashboardId);
  const widgets = await db
    .select()
    .from(dashboardWidgets)
    .where(
      and(
        eq(dashboardWidgets.workspaceId, options.workspaceId),
        eq(dashboardWidgets.dashboardId, options.dashboardId)
      )
    )
    .orderBy(asc(dashboardWidgets.position), asc(dashboardWidgets.createdAt))
    .all();

  const stored = safeParseFilter(dashboard.globalFilters);
  const combined = combineFilters(stored, options.globalFilter ?? null);
  const results: Record<string, WidgetResult> = {};
  for (const widget of widgets) {
    const definition: WidgetDefinition = {
      type: widget.type,
      dataSource: widget.dataSource,
      filter: widget.filter,
      measure: widget.measure,
      grouping: widget.grouping,
      timeRange: widget.timeRange,
      savedViewId: widget.savedViewId
    };
    results[widget.id] = await runWidget(db, {
      workspaceId: options.workspaceId,
      widget: definition,
      globalFilter: combined,
      now: options.now
    });
  }
  return { dashboard, globalFilter: combined, results };
}
