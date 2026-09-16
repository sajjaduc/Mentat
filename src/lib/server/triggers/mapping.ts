/**
 * Declarative payload → ticket mapping.
 *
 * Why this exists: an incoming webhook or email must be turned into work without
 * bespoke code per integration. `TriggerMapping` is *data*: dot-paths select
 * values, `{{...}}` templates compose them, and typed fields are populated by
 * key. One templating language is used across the product — the helpers come from
 * the shared `format` module rather than a trigger-specific mini-language.
 *
 * Mapping deliberately delegates ticket creation to the `TicketService` locator:
 * triggers decide *what* the ticket should contain, the tickets domain decides
 * how to create it (states, key allocation, history, execution).
 */
import { z } from 'zod';
import { interpolateTemplate, readPath } from '../../shared/format';
import type { ActorContext } from '../core/context';
import { systemActor } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import type { Trigger, TriggerMapping } from '../db/schema';
import type { FileService, FileSourceType } from '../files/contracts';
import { fileService as installedFileService } from '../files/contracts';
import type { TicketService } from '../tickets/contracts';
import { TICKET_PRIORITIES, type TicketPriority } from '../tickets/types';

/** Runtime validation for the declarative mapping stored on a trigger. */
export const triggerMappingSchema = z.object({
  titlePath: z.string().min(1).optional(),
  titleTemplate: z.string().min(1).optional(),
  descriptionPath: z.string().min(1).optional(),
  descriptionTemplate: z.string().min(1).optional(),
  targetWorkflowId: z.string().min(1).optional(),
  targetStateId: z.string().min(1).optional(),
  priorityPath: z.string().min(1).optional(),
  ownerUserId: z.string().min(1).optional(),
  ownerTeamId: z.string().min(1).optional(),
  fieldPaths: z.record(z.string(), z.string()).optional(),
  fieldTemplates: z.record(z.string(), z.string()).optional(),
  labels: z.array(z.string().min(1)).optional(),
  attachmentPaths: z.array(z.string().min(1)).optional(),
  dedupeTemplate: z.string().min(1).optional(),
  parentTicketPath: z.string().min(1).optional()
});

export interface ApplyTriggerMappingInput {
  trigger: Trigger;
  /** The redacted payload snapshot persisted on the trigger event. */
  payload: unknown;
  ticketService: TicketService;
  /** Overridable so tests can record ingest calls without the global locator. */
  fileService?: FileService;
  actor?: ActorContext;
  /** Provenance for attachment ingest; defaults from the trigger type. */
  sourceType?: FileSourceType;
  /** Stable external reference (delivery id, event id) recorded on the ticket. */
  reference?: string | null;
  triggerEventId?: string | null;
}

export interface TriggerMappingResult {
  ticketId: string;
  workflowId: string;
  stateId: string;
  fieldKeysSet: string[];
  filesIngested: number;
  dedupeKey: string | null;
  /** True when an existing ticket was refreshed instead of created. */
  upserted: boolean;
}

const TEMPLATE_REFERENCE = /\{\{\s*([^}]+?)\s*\}\}/g;

function toRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : { value: payload };
}

function templateReferences(template: string): string[] {
  const refs: string[] = [];
  for (const match of template.matchAll(TEMPLATE_REFERENCE)) {
    const path = match[1]?.trim();
    if (path) refs.push(path);
  }
  return refs;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Render a template. When `strict`, a referenced path that is absent is an error
 * rather than an empty string — silent empty values are how bad tickets get made.
 */
function evaluateTemplate(
  template: string,
  payload: Record<string, unknown>,
  label: string,
  strict: boolean
): string {
  if (strict) {
    const missing = templateReferences(template).filter(
      (path) => !isPresent(readPath(payload, path))
    );
    if (missing.length > 0) {
      throw errors.validation(
        `Missing value for ${missing.map((path) => `"${path}"`).join(', ')} in ${label}`,
        { template, missing }
      );
    }
  }
  return interpolateTemplate(template, payload);
}

function readPathText(
  payload: unknown,
  path: string,
  label: string,
  required: boolean
): string | null {
  const value = readPath(payload, path);
  if (!isPresent(value)) {
    if (required) {
      throw errors.validation(`Missing value at path "${path}" for ${label}`, { path });
    }
    return null;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function resolvePriority(payload: unknown, mapping: TriggerMapping): TicketPriority | undefined {
  if (!mapping.priorityPath) return undefined;
  const value = readPath(payload, mapping.priorityPath);
  if (!isPresent(value)) return undefined;
  const candidate = String(value).toLowerCase() as TicketPriority;
  if (!TICKET_PRIORITIES.includes(candidate)) {
    throw errors.validation(
      `Priority "${String(value)}" is not one of ${TICKET_PRIORITIES.join(', ')}`,
      { path: mapping.priorityPath, value }
    );
  }
  return candidate;
}

function resolveFieldValues(
  payload: unknown,
  payloadRecord: Record<string, unknown>,
  mapping: TriggerMapping
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(mapping.fieldPaths ?? {})) {
    const value = readPath(payload, path);
    // A path that is absent leaves the field unset; overwriting with null would
    // destroy data a later delivery might legitimately omit.
    if (!isPresent(value)) continue;
    fields[key] = value;
  }
  for (const [key, template] of Object.entries(mapping.fieldTemplates ?? {})) {
    fields[key] = evaluateTemplate(template, payloadRecord, `field "${key}" template`, true);
  }
  return fields;
}

function resolveParentTicketId(payload: unknown, mapping: TriggerMapping): string | null {
  if (!mapping.parentTicketPath) return null;
  const value = readPath(payload, mapping.parentTicketPath);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errors.validation(
      `parentTicketPath "${mapping.parentTicketPath}" did not resolve to a ticket id`,
      { path: mapping.parentTicketPath }
    );
  }
  return value;
}

export interface DecodedAttachment {
  filename: string;
  bytes: Uint8Array;
  mimeType: string | undefined;
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function decodeDataUrl(value: string): { bytes: Uint8Array; mimeType: string | undefined } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  const mimeType = match[1] && match[1].length > 0 ? match[1] : undefined;
  const payload = match[3] ?? '';
  return {
    bytes: match[2] ? base64Bytes(payload) : textBytes(decodeURIComponent(payload)),
    mimeType
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function decodeStringAttachment(entry: string, index: number): DecodedAttachment {
  const dataUrl = decodeDataUrl(entry);
  if (dataUrl) {
    return {
      filename: `attachment-${index + 1}`,
      bytes: dataUrl.bytes,
      mimeType: dataUrl.mimeType
    };
  }
  return {
    filename: `attachment-${index + 1}`,
    bytes: base64Bytes(entry),
    mimeType: undefined
  };
}

function decodeObjectAttachment(
  record: Record<string, unknown>,
  label: string,
  index: number
): DecodedAttachment {
  const filename =
    optionalString(record.filename) ??
    optionalString(record.fileName) ??
    optionalString(record.name) ??
    `attachment-${index + 1}`;
  const mimeType = optionalString(record.mimeType) ?? optionalString(record.contentType);

  if (record.bytes instanceof Uint8Array) {
    return { filename, bytes: record.bytes, mimeType };
  }

  const raw = record.contentBase64 ?? record.base64 ?? record.data ?? record.content ?? record.text;
  if (!isPresent(raw)) {
    throw errors.validation(`Attachment at ${label} has no content`, { filename });
  }
  if (typeof raw !== 'string') {
    return { filename, bytes: textBytes(JSON.stringify(raw)), mimeType };
  }
  const dataUrl = decodeDataUrl(raw);
  if (dataUrl) return { filename, bytes: dataUrl.bytes, mimeType: mimeType ?? dataUrl.mimeType };
  const explicitBase64 =
    typeof record.encoding === 'string' && record.encoding.toLowerCase() === 'base64';
  const forceBase64 =
    explicitBase64 || record.contentBase64 !== undefined || record.base64 !== undefined;
  return { filename, bytes: forceBase64 ? base64Bytes(raw) : textBytes(raw), mimeType };
}

/**
 * Turn one attachment entry into bytes. Accepts a base64/data-URL string or an
 * object with `filename`, `mimeType` and one of `bytes` / `contentBase64` /
 * `base64` / `data` / `content` / `text`.
 */
export function decodeAttachment(entry: unknown, label: string, index: number): DecodedAttachment {
  if (typeof entry === 'string') return decodeStringAttachment(entry, index);
  if (entry === null || typeof entry !== 'object') {
    throw errors.validation(`Attachment at ${label} is neither a string nor an object`);
  }
  return decodeObjectAttachment(entry as Record<string, unknown>, label, index);
}

/** Each `attachmentPaths` entry may point at an array or at a single object. */
function collectAttachmentEntries(value: unknown, path: string): unknown[] {
  if (!isPresent(value)) {
    throw errors.validation(`Attachment path "${path}" resolved to no value`, { path });
  }
  return Array.isArray(value) ? value : [value];
}

/** Default file provenance for a trigger type / source hint. */
export function attachmentSourceType(trigger: Trigger, sourceHint?: string | null): FileSourceType {
  const hint = (sourceHint ?? '').toLowerCase();
  if (hint.includes('email')) return 'incoming_email';
  if (hint.includes('webhook')) return 'webhook';
  switch (trigger.type) {
    case 'webhook':
      return 'webhook';
    case 'manual':
    case 'api':
      return 'api';
    default:
      return 'system';
  }
}

function resolveTitle(
  trigger: Trigger,
  mapping: TriggerMapping,
  payload: unknown,
  payloadRecord: Record<string, unknown>
): string {
  if (mapping.titleTemplate) {
    const title = evaluateTemplate(
      mapping.titleTemplate,
      payloadRecord,
      'title template',
      true
    ).trim();
    if (title.length === 0) {
      throw errors.validation('Title template produced an empty title', {
        template: mapping.titleTemplate
      });
    }
    return title;
  }
  if (mapping.titlePath) {
    const title = (readPathText(payload, mapping.titlePath, 'title', true) ?? '').trim();
    if (title.length === 0) {
      throw errors.validation(`Title path "${mapping.titlePath}" produced an empty title`, {
        path: mapping.titlePath
      });
    }
    return title;
  }
  // No title configured: the trigger name is a stable, meaningful fallback.
  return trigger.name;
}

function resolveDescription(
  mapping: TriggerMapping,
  payload: unknown,
  payloadRecord: Record<string, unknown>
): string | null {
  if (mapping.descriptionTemplate) {
    // Descriptions are informational; a missing optional input becomes no
    // description rather than failing the whole delivery.
    return (
      evaluateTemplate(mapping.descriptionTemplate, payloadRecord, 'description template', false) ||
      null
    );
  }
  if (mapping.descriptionPath) {
    return readPathText(payload, mapping.descriptionPath, 'description', false);
  }
  return null;
}

function resolveDedupeKey(
  mapping: TriggerMapping,
  payloadRecord: Record<string, unknown>
): string | null {
  if (!mapping.dedupeTemplate) return null;
  const key = evaluateTemplate(
    mapping.dedupeTemplate,
    payloadRecord,
    'dedupe template',
    true
  ).trim();
  if (key.length === 0) {
    throw errors.validation('Dedupe template produced an empty key', {
      template: mapping.dedupeTemplate
    });
  }
  return key;
}

/** Ingest every declared attachment and link each one to the ticket. */
async function ingestMappingAttachments(options: {
  /** Resolved lazily: a trigger with no attachments does not need the files module. */
  files?: FileService;
  actor: ActorContext;
  trigger: Trigger;
  mapping: TriggerMapping;
  payload: unknown;
  ticketId: string;
  workflowId: string;
  reference?: string | null;
  triggerEventId?: string | null;
  sourceType: FileSourceType;
}): Promise<number> {
  const paths = options.mapping.attachmentPaths ?? [];
  if (paths.length === 0) return 0;
  const files = options.files ?? installedFileService();
  const { actor, trigger, payload } = options;
  let ingested = 0;
  for (const path of paths) {
    const entries = collectAttachmentEntries(readPath(payload, path), path);
    for (const [index, entry] of entries.entries()) {
      const decoded = decodeAttachment(entry, path, index);
      await files.ingest(actor, {
        filename: decoded.filename,
        bytes: decoded.bytes,
        mimeType: decoded.mimeType,
        source: {
          type: options.sourceType,
          reference: options.reference ?? trigger.id,
          label: trigger.name,
          occurredAt: Date.now(),
          triggerEventId: options.triggerEventId ?? null
        },
        kind: 'external',
        workflowId: options.workflowId,
        // Linking in the ingest call keeps the file↔ticket link in the same
        // transaction as the file row.
        ticketId: options.ticketId,
        relationship: 'attachment',
        process: true
      });
      ingested += 1;
    }
  }
  return ingested;
}

/**
 * Apply a mapping to a payload and return the created (or refreshed) ticket.
 *
 * Attachment bytes are ingested *after* ticket creation and linked in the same
 * ingest call (`ticketId` + `relationship`), which is what makes the link atomic
 * and the provenance durable (ADR-0009).
 */
export async function applyTriggerMapping(
  _db: Executor,
  input: ApplyTriggerMappingInput
): Promise<TriggerMappingResult> {
  const trigger = input.trigger;
  const mapping = (trigger.config?.mapping ?? {}) as TriggerMapping;
  const payload = input.payload;
  const payloadRecord = toRecord(payload);
  const actor =
    input.actor ?? systemActor(trigger.workspaceId, `trigger:${trigger.type}:${trigger.id}`);
  const ticketService = input.ticketService;

  const title = resolveTitle(trigger, mapping, payload, payloadRecord);
  const description = resolveDescription(mapping, payload, payloadRecord);
  const workflowId = mapping.targetWorkflowId ?? trigger.workflowId;
  const stateId = mapping.targetStateId ?? trigger.targetStateId ?? null;
  const priority = resolvePriority(payload, mapping);
  const fields = resolveFieldValues(payload, payloadRecord, mapping);
  const parentTicketId = resolveParentTicketId(payload, mapping);
  const dedupeKey = resolveDedupeKey(mapping, payloadRecord);

  const created = await ticketService.create(actor, {
    workflowId,
    stateId,
    title,
    description,
    priority,
    ownerUserId: mapping.ownerUserId ?? null,
    ownerTeamId: mapping.ownerTeamId ?? null,
    fields,
    labelNames: mapping.labels ?? [],
    parentTicketId,
    dedupeKey,
    provenance: {
      sourceType: trigger.type,
      triggerId: trigger.id,
      triggerEventId: input.triggerEventId ?? undefined,
      sourceReference: input.reference ?? undefined,
      externalRef: dedupeKey ?? undefined
    }
  });

  // `create` is idempotent on `dedupeKey`; when upserting we re-apply the mapped
  // fields so a later delivery with changed content refreshes the same ticket.
  const upserted = Boolean(dedupeKey && trigger.upsertOnDedupe);
  if (upserted) {
    await ticketService.setFields(actor, {
      ticketId: created.id,
      values: fields,
      source: 'system',
      force: true
    });
  }

  const filesIngested = await ingestMappingAttachments({
    files: input.fileService,
    actor,
    trigger,
    mapping,
    payload,
    ticketId: created.id,
    workflowId: created.workflowId,
    reference: input.reference,
    triggerEventId: input.triggerEventId,
    sourceType: input.sourceType ?? attachmentSourceType(trigger, input.reference)
  });

  return {
    ticketId: created.id,
    workflowId: created.workflowId,
    stateId: created.stateId,
    fieldKeysSet: Object.keys(fields),
    filesIngested,
    dedupeKey,
    upserted
  };
}
