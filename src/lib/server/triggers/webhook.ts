/**
 * Inbound webhook handling.
 *
 * Why the work is split this way: the HTTP request must return quickly and must
 * never lose a delivery. Receiving therefore does only the four things that must
 * happen before responding — resolve the trigger, authenticate, enforce size,
 * and persist an idempotent event — then enqueues a durable job. Mapping the
 * payload to a ticket happens in the worker (`trigger.webhook`), so a slow or
 * failing integration call cannot block the sender.
 *
 * Security posture: the token is the addressing credential, the HMAC signature is
 * the authenticity check, and the persisted payload is always redacted. Secret
 * plaintext is resolved only to verify the signature and is registered with the
 * process redactor immediately (ADR-0020).
 */
import { createHash } from 'node:crypto';
import { AuditActions, writeAudit } from '../audit/ledger';
import type { ActorContext } from '../core/context';
import { hmacSha256Hex, timingSafeEqualString } from '../core/crypto';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import type { Trigger, TriggerEventStatus, WebhookTriggerConfig } from '../db/schema';
import { resolveSecretValue } from '../secrets/service';
import {
  attachJobToEvent,
  enqueueTriggerJob,
  insertTriggerEvent,
  redactTriggerPayload,
  triggerJobDedupeKey
} from './events';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_SIGNATURE_HEADER,
  findTriggerByWebhookToken,
  recordFire
} from './service';

export type WebhookHeaders = Record<string, string | string[] | undefined> | Headers;

/** Headers whose value identifies a delivery; the first present one wins. */
export const IDEMPOTENCY_HEADERS = ['idempotency-key', 'x-idempotency-key', 'x-github-delivery'];

export interface ReceiveWebhookInput {
  /** Opaque token from the webhook URL. */
  token: string;
  /** Raw bytes exactly as received — signatures are computed over these. */
  rawBody: Uint8Array | string;
  headers?: WebhookHeaders;
  /** Free-form origin hint, e.g. `github` or `incoming_email`. */
  source?: string | null;
}

export interface WebhookReceiveResult {
  duplicate: boolean;
  ignored: boolean;
  eventId: string;
  /** Original ticket id on a duplicate; null when the event is not processed yet. */
  ticketId: string | null;
  jobId: string | null;
  status: TriggerEventStatus;
}

export function toBodyBytes(rawBody: Uint8Array | string): Uint8Array {
  return typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
}

function bodyText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** SHA-256 hex of the body; also the fallback idempotency key. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function headerMap(headers?: WebhookHeaders): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers) return map;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      map.set(key.toLowerCase(), value);
    });
    return map;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') map.set(key.toLowerCase(), first);
  }
  return map;
}

/**
 * Idempotency key for a delivery. Explicit headers win because a sender that
 * knows its own delivery id can make retries free; otherwise the body hash makes
 * byte-identical redelivery free.
 */
export function computeIdempotencyKey(
  headers: WebhookHeaders | undefined,
  body: Uint8Array
): string {
  const map = headerMap(headers);
  for (const name of IDEMPOTENCY_HEADERS) {
    const value = map.get(name);
    if (value && value.trim().length > 0) return value.trim();
  }
  return sha256Hex(body);
}

/**
 * Accept both the GitHub-style `sha256=<hex>` form and a bare hex digest. A
 * malformed value parses to null and is treated as a failed verification.
 */
export function parseSignatureHeader(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const digest = trimmed.toLowerCase().startsWith('sha256=') ? trimmed.slice(7).trim() : trimmed;
  return /^[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

/** Constant-time HMAC verification over the raw body. */
export function verifyWebhookSignature(
  secret: string,
  body: Uint8Array,
  provided: string | null | undefined
): boolean {
  const parsed = parseSignatureHeader(provided);
  if (!parsed) return false;
  const expected = hmacSha256Hex(secret, bodyText(body), 'hex');
  return timingSafeEqualString(parsed, expected.toLowerCase());
}

/** Parse JSON when possible; non-JSON bodies are preserved under `raw`. */
export function parseWebhookPayload(body: Uint8Array): unknown {
  const text = bodyText(body);
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * Enforce the trigger's signature policy. Resolving the secret is the only place
 * plaintext is produced; it is registered with the redactor immediately.
 */
function enforceSignature(
  db: Executor,
  trigger: Trigger,
  config: WebhookTriggerConfig,
  body: Uint8Array,
  headers: Map<string, string>
): void {
  if (!config.signatureRequired) return;
  const headerName = config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
  const provided = headers.get(headerName.toLowerCase()) ?? null;
  if (!provided) {
    throw errors.unauthorized(`Missing webhook signature header "${headerName}"`);
  }
  if (!config.signatureSecretId) {
    throw errors.validation(
      'This webhook requires a signature but has no signature secret configured'
    );
  }
  const secret = resolveSecretValue(db, {
    workspaceId: trigger.workspaceId,
    secretId: config.signatureSecretId,
    purpose: 'webhook signature verification'
  });
  if (!verifyWebhookSignature(secret, body, provided)) {
    throw errors.unauthorized('Invalid webhook signature');
  }
}

/**
 * Receive one webhook delivery.
 *
 * Returns `{ duplicate: true }` (with the original ticket id when known) when the
 * idempotency key was already received, so a sender may safely retry.
 */
export async function receiveWebhook(
  db: Executor,
  actor: ActorContext,
  input: ReceiveWebhookInput
): Promise<WebhookReceiveResult> {
  const body = toBodyBytes(input.rawBody);
  const headers = headerMap(input.headers);
  const now = Date.now();

  const trigger = findTriggerByWebhookToken(db, input.token);
  // Unknown token and another workspace's trigger are the same response: a
  // webhook caller must not be able to probe tenant boundaries.
  if (!trigger || trigger.workspaceId !== actor.workspaceId) {
    throw errors.notFound('Webhook trigger');
  }

  const config = (trigger.config ?? {}) as WebhookTriggerConfig;
  const maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (body.length > maxPayloadBytes) {
    throw errors.validation(
      `Webhook payload is ${body.length} bytes, exceeding the ${maxPayloadBytes} byte limit`,
      { size: body.length, maxPayloadBytes }
    );
  }

  enforceSignature(db, trigger, config, body, headers);

  const idempotencyKey = computeIdempotencyKey(input.headers, body);
  const source = input.source ?? 'webhook';
  const payloadBytes = body.length;

  if (!trigger.enabled) {
    // Accepted but not processed. Recording the event keeps the delivery
    // observable and keeps redelivery idempotent without creating work.
    const result = await withTransaction(db, (tx) => {
      const inserted = insertTriggerEvent(tx, {
        workspaceId: trigger.workspaceId,
        triggerId: trigger.id,
        idempotencyKey,
        source,
        payload: redactTriggerPayload(parseWebhookPayload(body)),
        payloadBytes,
        receivedAt: now,
        status: 'ignored'
      });
      writeAudit(tx, {
        workspaceId: trigger.workspaceId,
        action: AuditActions.triggerReceived,
        actorType: 'system',
        entityType: 'trigger_event',
        entityId: inserted.event.id,
        workflowId: trigger.workflowId,
        summary: `Webhook for disabled trigger "${trigger.name}" ignored`,
        data: { triggerId: trigger.id, ignored: true, duplicate: inserted.duplicate },
        occurredAt: now
      });
      return inserted;
    });
    return {
      duplicate: result.duplicate,
      ignored: true,
      eventId: result.event.id,
      ticketId: result.ticketId,
      jobId: null,
      status: 'ignored'
    };
  }

  const eventResult = await withTransaction(db, (tx) => {
    const result = insertTriggerEvent(tx, {
      workspaceId: trigger.workspaceId,
      triggerId: trigger.id,
      idempotencyKey,
      source,
      payload: redactTriggerPayload(parseWebhookPayload(body)),
      payloadBytes,
      receivedAt: now
    });
    if (result.duplicate) {
      writeAudit(tx, {
        workspaceId: trigger.workspaceId,
        action: AuditActions.triggerDuplicate,
        actorType: 'system',
        entityType: 'trigger_event',
        entityId: result.event.id,
        ticketId: result.ticketId,
        workflowId: trigger.workflowId,
        summary: `Duplicate webhook delivery for "${trigger.name}" ignored`,
        data: { triggerId: trigger.id, idempotencyKey },
        occurredAt: now
      });
    } else {
      recordFire(tx, trigger.id, { firedAt: now });
      writeAudit(tx, {
        workspaceId: trigger.workspaceId,
        action: AuditActions.triggerReceived,
        actorType: 'system',
        entityType: 'trigger_event',
        entityId: result.event.id,
        workflowId: trigger.workflowId,
        summary: `Webhook received by "${trigger.name}"`,
        data: { triggerId: trigger.id, idempotencyKey, payloadBytes, source },
        occurredAt: now
      });
    }
    return result;
  });

  if (eventResult.duplicate) {
    return {
      duplicate: true,
      ignored: false,
      eventId: eventResult.event.id,
      ticketId: eventResult.ticketId,
      jobId: eventResult.event.jobId,
      status: eventResult.event.status
    };
  }

  const job = await enqueueTriggerJob(db, {
    workspaceId: trigger.workspaceId,
    triggerId: trigger.id,
    eventId: eventResult.event.id,
    type: 'trigger.webhook',
    dedupeKey: triggerJobDedupeKey(trigger, eventResult.event.id),
    source,
    reference: idempotencyKey
  });
  attachJobToEvent(db, eventResult.event.id, job.id);

  return {
    duplicate: false,
    ignored: false,
    eventId: eventResult.event.id,
    ticketId: null,
    jobId: job.id,
    status: 'received'
  };
}
