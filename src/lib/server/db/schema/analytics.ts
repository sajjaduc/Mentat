/**
 * Dashboards and widgets.
 *
 * Analytics is derived from immutable history (`ticket_state_history`,
 * `field_value_history`) rather than from current ticket rows alone, because
 * current state cannot answer "how many entered Claims last month" or "how long
 * did tickets spend in Human Review" (ADR-0017).
 *
 * A widget is a declarative query: data source + filter AST + measure + grouping +
 * time range + visualization. The same filter AST used by ticket lists powers
 * widgets, so there is no second filtering language.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, json, primaryId, updatedAt } from './_helpers';
import { users, workspaces } from './tenancy';

export type WidgetType =
  | 'kpi'
  | 'number'
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'table'
  | 'funnel'
  | 'aging';

export interface WidgetDataSource {
  kind: 'state_history' | 'field_history' | 'runs' | 'files' | 'records' | 'workflow_items';
  workflowIds?: string[];
  /** For funnels: explicitly ordered milestones. Kanban order is never inferred. */
  funnelStages?: Array<{
    label: string;
    stateIds?: string[];
    fieldKey?: string;
    fieldValue?: unknown;
  }>;
  /** For aging: which states to measure dwell time in. */
  agingStates?: string[];
}

export interface WidgetMeasure {
  aggregation: 'count' | 'sum' | 'avg' | 'median' | 'min' | 'max' | 'conversion' | 'duration';
  /** Field key for sum/avg over a ticket field; `null` means count of rows. */
  fieldKey?: string | null;
  /** Duration measure: time spent in `stateId` or between milestones. */
  durationOf?: 'time_in_state' | 'cycle_time' | 'time_to_state';
}

export interface WidgetGrouping {
  by:
    | 'none'
    | 'objectType'
    | 'state'
    | 'priority'
    | 'owner'
    | 'team'
    | 'label'
    | 'workflow'
    | 'field'
    | 'day'
    | 'week'
    | 'month';
  fieldKey?: string;
  limit?: number;
}

export interface WidgetTimeRange {
  kind: 'relative' | 'absolute' | 'all';
  lastDays?: number;
  from?: number;
  to?: number;
  /** Which timestamp the range applies to. */
  basis?: 'created' | 'updated' | 'entered_state';
}

export interface WidgetVisualization {
  color?: string;
  showLegend?: boolean;
  showValues?: boolean;
  stacked?: boolean;
  valueFormat?: 'number' | 'currency' | 'percent' | 'duration';
  currency?: string;
}

export const dashboards = sqliteTable(
  'dashboards',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Workspace/dashboard-level filters applied on top of each widget's own. */
    globalFilters: json<unknown>('global_filters'),
    layout: json<Array<{ widgetId: string; x: number; y: number; w: number; h: number }>>('layout'),
    isDefault: bool('is_default'),
    isShared: bool('is_shared', true),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('dashboards_name_unique').on(table.workspaceId, table.name),
    index('dashboards_workspace_idx').on(table.workspaceId)
  ]
);

export const dashboardWidgets = sqliteTable(
  'dashboard_widgets',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dashboardId: text('dashboard_id')
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    type: text('type').$type<WidgetType>().notNull(),
    position: integer('position').notNull().default(0),
    size: text('size').$type<'sm' | 'md' | 'lg' | 'full'>().notNull().default('md'),
    dataSource: json<WidgetDataSource>('data_source').notNull(),
    filter: json<unknown>('filter'),
    measure: json<WidgetMeasure>('measure').notNull(),
    grouping: json<WidgetGrouping>('grouping'),
    timeRange: json<WidgetTimeRange>('time_range'),
    visualization: json<WidgetVisualization>('visualization'),
    /** Reference to a saved view whose filter should be reused. */
    savedViewId: text('saved_view_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [index('dashboard_widgets_dashboard_idx').on(table.dashboardId, table.position)]
);

export type Dashboard = typeof dashboards.$inferSelect;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
