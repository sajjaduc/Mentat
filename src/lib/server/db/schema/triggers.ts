/**
 * Triggers: webhook, cron and manual/API entry points.
 *
 * Every trigger normalizes into an internal event. Webhooks are idempotent by
 * `(triggerId, idempotencyKey)`, cron schedules are claimed by workers so multiple
 * processes cannot double-fire, and manual/API triggers reuse the same event path
 * as the automated ones.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { users, workspaces } from './tenancy';

export type TriggerType = 'webhook' | 'cron' | 'manual' | 'api';

export interface WebhookTriggerConfig {
  /** Require an HMAC signature over the raw body. */
  signatureRequired?: boolean;
  signatureHeader?: string;
  signatureSecretId?: string;
  /** How the incoming payload maps onto a Record + WorkflowItem. */
  mapping?: TriggerMapping;
  /** Reject payloads larger than this. */
  maxPayloadBytes?: number;
}

export interface CronTriggerConfig {
  expression: string;
  timezone?: string;
  mapping?: TriggerMapping;
  /** Skip a fire when the previous one is still running. */
  skipIfRunning?: boolean;
}

export interface ManualTriggerConfig {
  mapping?: TriggerMapping;
  /** Inputs the caller/model must provide. */
  inputSchema?: unknown;
}

/**
 * Declarative mapping from an external payload to a Record and the WorkflowItem
 * that starts work on it. Mapping is data, not code, so an incoming
 * email/webhook can populate typed fields, attach files and request an initial
 * state without bespoke database work.
 */
export interface TriggerMapping {
  /** Dot-path into the payload, e.g. `data.customer.email`. */
  titlePath?: string;
  titleTemplate?: string;
  descriptionPath?: string;
  descriptionTemplate?: string;
  targetWorkflowId?: string;
  targetStateId?: string;
  priorityPath?: string;
  ownerUserId?: string;
  ownerTeamId?: string;
  /** `{ fieldKey: dotPath | { template } }` */
  fieldPaths?: Record<string, string>;
  fieldTemplates?: Record<string, string>;
  /** @deprecated Labels are a legacy Ticket concept; ignored by the universal mapper. */
  labels?: string[];
  /** `payload.attachments[]` entries become ingested files. */
  attachmentPaths?: string[];
  /** Dedupe key template; prevents duplicate records/work on webhook redelivery. */
  dedupeTemplate?: string;
  /** When true the created work item is a child of the work item for the record at `parentRecordPath`. */
  parentRecordPath?: string;
}

export const triggers = sqliteTable(
  'triggers',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').$type<TriggerType>().notNull(),
    enabled: bool('enabled', true),
    /** Opaque path segment for webhook URLs; not a credential by itself. */
    webhookToken: text('webhook_token'),
    config: json<WebhookTriggerConfig | CronTriggerConfig | ManualTriggerConfig>('config'),
    /** State created/updated work should enter; null means the workflow default. */
    targetStateId: text('target_state_id'),
    /** When true existing work matching the dedupe key is updated, not duplicated. */
    upsertOnDedupe: bool('upsert_on_dedupe'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    lastFiredAt: epochMs('last_fired_at'),
    nextRunAt: epochMs('next_run_at'),
    lastError: text('last_error'),
    fireCount: integer('fire_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('triggers_name_unique').on(table.workspaceId, table.workflowId, table.name),
    uniqueIndex('triggers_token_unique').on(table.webhookToken),
    index('triggers_schedule_idx').on(table.enabled, table.nextRunAt),
    index('triggers_workspace_idx').on(table.workspaceId, table.workflowId)
  ]
);

export type TriggerEventStatus = 'received' | 'processed' | 'duplicate' | 'failed' | 'ignored';

export const triggerEvents = sqliteTable(
  'trigger_events',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    triggerId: text('trigger_id')
      .notNull()
      .references(() => triggers.id, { onDelete: 'cascade' }),
    /** Caller-supplied or derived; uniqueness makes redelivery safe. */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').$type<TriggerEventStatus>().notNull().default('received'),
    source: text('source'),
    /** Redacted payload snapshot for inspection and replay. */
    payload: json<unknown>('payload'),
    payloadBytes: integer('payload_bytes'),
    /** Universal-model subject the event produced, when it created/found work. */
    recordId: text('record_id'),
    workflowItemId: text('workflow_item_id'),
    jobId: text('job_id'),
    error: text('error'),
    receivedAt: integer('received_at').notNull(),
    processedAt: epochMs('processed_at')
  },
  (table) => [
    uniqueIndex('trigger_events_idempotency_unique').on(table.triggerId, table.idempotencyKey),
    index('trigger_events_trigger_idx').on(table.workspaceId, table.triggerId, table.receivedAt)
  ]
);

export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;
export type TriggerEvent = typeof triggerEvents.$inferSelect;
