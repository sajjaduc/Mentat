/**
 * Manual and API triggers.
 *
 * Why this is its own entry point: a human clicking "run" and an API caller
 * posting an input must produce exactly the same durable event as a webhook. This
 * module does not create tickets directly — it validates the declared input
 * schema, dedupes on a caller-supplied idempotency key, and enqueues the same
 * internal event path, so mapping, redaction and audit cannot drift.
 */
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { assertAnyPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import type { ManualTriggerConfig, TriggerEventStatus } from '../db/schema';
import {
  attachJobToEvent,
  enqueueTriggerJob,
  insertTriggerEvent,
  redactTriggerPayload,
  triggerJobDedupeKey
} from './events';
import { recordFire, requireTriggerRow } from './service';

export interface FireManualInput {
  triggerId: string;
  /** Caller/model supplied inputs, validated against `config.inputSchema`. */
  input?: Record<string, unknown>;
  /** Caller-supplied key that makes a retried API call idempotent. */
  idempotencyKey?: string | null;
  source?: string | null;
}

export interface FireManualResult {
  eventId: string;
  duplicate: boolean;
  ticketId: string | null;
  jobId: string | null;
  status: TriggerEventStatus;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // Unknown keyword: do not pretend to validate it.
      return true;
  }
}

/**
 * Validate inputs against the trigger's declarative input schema. The schema is
 * stored as JSON, so the supported vocabulary is the JSON-Schema subset that
 * `required` + `properties[].type` covers; unknown keywords are ignored rather
 * than rejected so a richer schema authoring UI can land later.
 */
export function validateManualInput(inputSchema: unknown, input: Record<string, unknown>): void {
  if (inputSchema === null || inputSchema === undefined) return;
  if (typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return;
  const schema = inputSchema as { required?: unknown; properties?: unknown };

  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const missing = required.filter((key) => {
    const value = input[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    throw errors.validation(`Missing required trigger input: ${missing.join(', ')}`, { missing });
  }

  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const [key, definition] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const type =
      definition && typeof definition === 'object'
        ? (definition as { type?: unknown }).type
        : undefined;
    if (typeof type !== 'string') continue;
    if (!matchesJsonType(type, value)) {
      throw errors.validation(`Trigger input "${key}" must be of type ${type}`, {
        key,
        expected: type,
        actual: Array.isArray(value) ? 'array' : typeof value
      });
    }
  }
}

/**
 * Fire a manual/API trigger. Requires `trigger:write` or `run:execute`: starting
 * work is an execution action, not merely reading configuration.
 */
export async function fireManual(
  db: Executor,
  actor: ActorContext,
  options: FireManualInput
): Promise<FireManualResult> {
  assertAnyPermission(actor, [Permissions.triggerWrite, Permissions.runExecute]);
  const trigger = requireTriggerRow(db, actor.workspaceId, options.triggerId);
  if (trigger.type !== 'manual' && trigger.type !== 'api') {
    throw errors.validation(
      `Trigger "${trigger.name}" is a ${trigger.type} trigger and cannot be fired manually`,
      { triggerId: trigger.id, type: trigger.type }
    );
  }
  if (!trigger.enabled) {
    throw errors.precondition(`Trigger "${trigger.name}" is disabled`, { triggerId: trigger.id });
  }

  const config = (trigger.config ?? {}) as ManualTriggerConfig;
  const input = options.input ?? {};
  validateManualInput(config.inputSchema, input);

  const idempotencyKey =
    options.idempotencyKey && options.idempotencyKey.trim().length > 0
      ? options.idempotencyKey.trim()
      : `${trigger.id}:${uuidv7()}`;
  const source = options.source ?? 'manual';
  const now = Date.now();

  const eventResult = await withTransaction(db, (tx) => {
    const result = insertTriggerEvent(tx, {
      workspaceId: trigger.workspaceId,
      triggerId: trigger.id,
      idempotencyKey,
      source,
      // The caller's inputs *are* the payload, so a mapping authored against
      // `{{subject}}` behaves the same for manual and webhook triggers.
      payload: redactTriggerPayload(input),
      payloadBytes: null,
      receivedAt: now
    });
    if (result.duplicate) {
      writeAudit(tx, {
        workspaceId: trigger.workspaceId,
        action: AuditActions.triggerDuplicate,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'trigger_event',
        entityId: result.event.id,
        ticketId: result.ticketId,
        workflowId: trigger.workflowId,
        summary: `Duplicate manual fire for "${trigger.name}" ignored`,
        data: { triggerId: trigger.id, idempotencyKey },
        occurredAt: now
      });
    } else {
      recordFire(tx, trigger.id, { firedAt: now });
      writeAudit(tx, {
        workspaceId: trigger.workspaceId,
        action: AuditActions.triggerReceived,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        entityType: 'trigger_event',
        entityId: result.event.id,
        workflowId: trigger.workflowId,
        summary: `Manual trigger "${trigger.name}" fired`,
        data: { triggerId: trigger.id, idempotencyKey },
        occurredAt: now
      });
    }
    return result;
  });

  if (eventResult.duplicate) {
    return {
      eventId: eventResult.event.id,
      duplicate: true,
      ticketId: eventResult.ticketId,
      jobId: eventResult.event.jobId,
      status: eventResult.event.status
    };
  }

  const job = await enqueueTriggerJob(db, {
    workspaceId: trigger.workspaceId,
    triggerId: trigger.id,
    eventId: eventResult.event.id,
    // Manual fires ride the generic inbound-event job; both registered trigger
    // job types delegate to the same processor, so the type is just routing.
    type: 'trigger.webhook',
    dedupeKey: triggerJobDedupeKey(trigger, eventResult.event.id),
    source,
    reference: idempotencyKey,
    actor
  });
  attachJobToEvent(db, eventResult.event.id, job.id);

  return {
    eventId: eventResult.event.id,
    duplicate: false,
    ticketId: null,
    jobId: job.id,
    status: 'received'
  };
}
