/**
 * Trigger types, mirroring the `/api/triggers` contract.
 *
 * A trigger is configuration that normalizes into an internal event. The interesting
 * shape is the *mapping*: it is declarative data (`fieldPaths`, `{{template}}`s,
 * dedupe and attachment paths), not code, so the editor edits data and never emits a
 * script. `config` is modelled as one flat, mostly-optional object because the editor
 * switches on `type` and reads only the keys that type owns.
 */

export type TriggerType = 'webhook' | 'cron' | 'manual' | 'api';

export type TriggerEventStatus = 'received' | 'processed' | 'duplicate' | 'failed' | 'ignored';

export interface TriggerMapping {
  titlePath?: string;
  titleTemplate?: string;
  descriptionPath?: string;
  descriptionTemplate?: string;
  targetWorkflowId?: string;
  targetStateId?: string;
  priorityPath?: string;
  ownerUserId?: string;
  ownerTeamId?: string;
  fieldPaths?: Record<string, string>;
  fieldTemplates?: Record<string, string>;
  labels?: string[];
  attachmentPaths?: string[];
  dedupeTemplate?: string;
  parentTicketPath?: string;
}

export interface TriggerConfig {
  // cron
  expression?: string;
  timezone?: string;
  skipIfRunning?: boolean;
  // webhook
  signatureRequired?: boolean;
  signatureHeader?: string;
  /** Secret reference only; the value never leaves execution. */
  signatureSecretId?: string;
  maxPayloadBytes?: number;
  // manual / api / all
  mapping?: TriggerMapping;
  inputSchema?: unknown;
}

export interface TriggerView {
  id: string;
  workspaceId: string;
  workflowId: string;
  name: string;
  description: string | null;
  type: TriggerType;
  enabled: boolean;
  /** Opaque URL segment, not a credential; null for non-webhook triggers. */
  webhookToken: string | null;
  config: TriggerConfig;
  targetStateId: string | null;
  upsertOnDedupe: boolean;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface TriggerEvent {
  id: string;
  workspaceId: string;
  triggerId: string;
  idempotencyKey: string;
  status: TriggerEventStatus;
  source: string | null;
  /** Redacted payload snapshot for inspection. */
  payload: unknown;
  payloadBytes: number | null;
  ticketId: string | null;
  jobId: string | null;
  error: string | null;
  receivedAt: number;
  processedAt: number | null;
}

export interface FireResult {
  firedAt?: number;
  nextRunAt?: number | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface TriggerFireSummary {
  fired: Array<{
    triggerId: string;
    eventId: string | null;
    jobId: string | null;
    scheduledFor: number;
    nextRunAt: number;
    skipped: boolean;
    duplicate: boolean;
  }>;
}

export interface WorkflowOption {
  id: string;
  name: string;
  key: string;
}

export interface WorkflowStateOption {
  id: string;
  name: string;
  kind?: string;
}

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  webhook: 'Webhook',
  cron: 'Schedule',
  manual: 'Manual',
  api: 'API'
};

export const TRIGGER_TYPE_HINTS: Record<TriggerType, string> = {
  webhook: 'An external system POSTs a payload to a public URL.',
  cron: 'Mentat fires the trigger on a persisted, timezone-aware schedule.',
  manual: 'A person fires it from this page with a typed payload.',
  api: 'A caller or model fires it through the authenticated API.'
};

export const TRIGGER_EVENT_TONES: Record<
  TriggerEventStatus,
  'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted'
> = {
  received: 'accent',
  processed: 'positive',
  duplicate: 'caution',
  failed: 'danger',
  ignored: 'muted'
};
