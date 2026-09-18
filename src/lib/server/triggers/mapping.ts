/**
 * Declarative payload → Record + WorkflowItem mapping.
 *
 * Why this exists: an incoming webhook or email must be turned into work without
 * bespoke code per integration. `TriggerMapping` is *data*: dot-paths select
 * values, `{{...}}` templates compose them, and typed fields are populated by
 * key. One templating language is used across the product — the helpers come from
 * the shared `format` module rather than a trigger-specific mini-language.
 *
 * Mapping deliberately routes creation through the records + workflow-items
 * services: triggers decide *what* the work should contain, those domains decide
 * how to create it (object-type schema, key allocation, state entry, history and
 * execution, ADR-0021).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { interpolateTemplate, readPath } from '../../shared/format';
import type { ActorContext } from '../core/context';
import { systemActor } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/client';
import type { Trigger, TriggerMapping } from '../db/schema';
import { recordExternalIds, records, workflowItems } from '../db/schema';
import { listWorkflowFields } from '../fields/service';
import type { FileService, FileSourceType } from '../files/contracts';
import { fileService as installedFileService } from '../files/contracts';
import { listBaseFieldsSync, objectTypeForWorkflow } from '../records/object-types';
import { createRecordSync } from '../records/service';
import { PRIORITY_CHOICES } from '../records/types';
import {
  addWorkflowItemLabelsSync,
  createWorkflowItemSync,
  linkWorkItemsSync,
  updateWorkflowItemSync
} from '../workflow-items/service';

/** External-id system under which a trigger's dedupe key is recorded. */
export const TRIGGER_EXTERNAL_SYSTEM = 'trigger';

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
  parentRecordPath: z.string().min(1).optional()
});

export interface ApplyTriggerMappingInput {
  trigger: Trigger;
  /** The redacted payload snapshot persisted on the trigger event. */
  payload: unknown;
  /** Overridable so tests can record ingest calls without the global locator. */
  fileService?: FileService;
  actor?: ActorContext;
  /** Provenance for attachment ingest; defaults from the trigger type. */
  sourceType?: FileSourceType;
  /** Stable external reference (delivery id, event id) recorded on the work. */
  reference?: string | null;
  triggerEventId?: string | null;
  runId?: string | null;
}

export interface TriggerMappingResult {
  recordId: string;
  workflowItemId: string;
  workflowId: string;
  stateId: string;
  fieldKeysSet: string[];
  filesIngested: number;
  dedupeKey: string | null;
  /** True when existing work was refreshed instead of created. */
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
 * rather than an empty string — silent empty values are how bad records get made.
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

function resolvePriority(payload: unknown, mapping: TriggerMapping): string | undefined {
  if (!mapping.priorityPath) return undefined;
  const value = readPath(payload, mapping.priorityPath);
  if (!isPresent(value)) return undefined;
  const candidate = String(value).toLowerCase();
  if (!PRIORITY_CHOICES.some((choice) => choice.value === candidate)) {
    throw errors.validation(
      `Priority "${String(value)}" is not one of ${PRIORITY_CHOICES.map((choice) => choice.value).join(', ')}`,
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

function resolveParentRecordId(payload: unknown, mapping: TriggerMapping): string | null {
  if (!mapping.parentRecordPath) return null;
  const value = readPath(payload, mapping.parentRecordPath);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errors.validation(
      `parentRecordPath "${mapping.parentRecordPath}" did not resolve to a record id`,
      { path: mapping.parentRecordPath }
    );
  }
  return value.trim();
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

/** Ingest every declared attachment and link it to the work item and record. */
async function ingestMappingAttachments(options: {
  /** Resolved lazily: a trigger with no attachments does not need the files module. */
  files?: FileService;
  actor: ActorContext;
  trigger: Trigger;
  mapping: TriggerMapping;
  payload: unknown;
  workflowItemId: string;
  recordId: string;
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
        // Linking in the ingest call keeps the work/evidence links in the same
        // transaction as the file row (ADR-0009).
        workflowItemId: options.workflowItemId,
        recordId: options.recordId,
        relationship: 'attachment',
        process: true
      });
      ingested += 1;
    }
  }
  return ingested;
}

/**
 * Apply a mapping to a payload and return the created (or refreshed) Record and
 * WorkflowItem.
 *
 * Field values are routed by the workflow-items field engine: keys bound to the
 * Object Type land on the Record, keys bound to the workflow become overlay
 * values on the participation. Attachments are ingested after commit and linked
 * to both the work item (context) and the Record (evidence).
 */
export async function applyTriggerMapping(
  db: Executor,
  input: ApplyTriggerMappingInput
): Promise<TriggerMappingResult> {
  const trigger = input.trigger;
  const mapping = (trigger.config?.mapping ?? {}) as TriggerMapping;
  const payload = input.payload;
  const payloadRecord = toRecord(payload);
  const actor =
    input.actor ?? systemActor(trigger.workspaceId, `trigger:${trigger.type}:${trigger.id}`);

  const title = resolveTitle(trigger, mapping, payload, payloadRecord);
  const description = resolveDescription(mapping, payload, payloadRecord);
  const workflowId = mapping.targetWorkflowId ?? trigger.workflowId;
  const stateId = mapping.targetStateId ?? trigger.targetStateId ?? null;
  const priority = resolvePriority(payload, mapping);
  const fields = resolveFieldValues(payload, payloadRecord, mapping);
  const parentRecordId = resolveParentRecordId(payload, mapping);
  const dedupeKey = resolveDedupeKey(mapping, payloadRecord);

  const objectType = objectTypeForWorkflow(db, workflowId);
  if (!objectType) {
    throw errors.precondition('This workflow has no Object Type configured', { workflowId });
  }

  const routed = routeMappedFields(db, actor, {
    workflowId,
    objectTypeId: objectType.id,
    title,
    description,
    priority,
    fields
  });

  const provenance = {
    sourceType: trigger.type,
    triggerId: trigger.id,
    triggerEventId: input.triggerEventId ?? undefined,
    sourceReference: input.reference ?? undefined,
    externalRef: dedupeKey ?? undefined
  };

  const outcome = await withTransaction(db, (tx) =>
    runMappedWorkTransaction(tx, actor, {
      trigger,
      mapping,
      objectTypeId: objectType.id,
      workflowId,
      stateId,
      title,
      fields: routed.fields,
      recordFields: routed.recordFields,
      structured: routed.structured,
      provenance,
      dedupeKey,
      parentRecordId,
      runId: input.runId ?? null
    })
  );

  const filesIngested = await ingestMappingAttachments({
    files: input.fileService,
    actor,
    trigger,
    mapping,
    payload,
    workflowItemId: outcome.workflowItemId,
    recordId: outcome.recordId,
    workflowId,
    reference: input.reference,
    triggerEventId: input.triggerEventId,
    sourceType: input.sourceType ?? attachmentSourceType(trigger, input.reference)
  });

  return {
    recordId: outcome.recordId,
    workflowItemId: outcome.workflowItemId,
    workflowId,
    stateId: outcome.stateId,
    fieldKeysSet: Object.keys(fields),
    filesIngested,
    dedupeKey,
    upserted: outcome.upserted
  };
}

interface RoutedMappedFields {
  fields: Record<string, unknown>;
  recordFields: Record<string, unknown>;
  structured: Record<string, unknown> | undefined;
}

/**
 * Route every mapped key before writing: an unknown key must fail the delivery,
 * not silently disappear into JSON. Base keys land on the Record, overlay keys on
 * the participation, and unbound description/priority go to structured data.
 */
function routeMappedFields(
  db: Executor,
  actor: ActorContext,
  input: {
    workflowId: string;
    objectTypeId: string;
    title: string;
    description: string | null;
    priority: string | undefined;
    fields: Record<string, unknown>;
  }
): RoutedMappedFields {
  const fields = { ...input.fields };
  const baseFieldList = listBaseFieldsSync(db, actor.workspaceId, input.objectTypeId);
  const baseKeys = new Set(baseFieldList.map((field) => field.key));
  const overlayKeys = new Set(
    listWorkflowFields(db, actor, input.workflowId).map((view) => view.definition.key)
  );
  const unknown = Object.keys(fields).filter((key) => !baseKeys.has(key) && !overlayKeys.has(key));
  if (unknown.length > 0) {
    throw errors.validation(`Unknown field key(s): ${unknown.join(', ')}`, { missing: unknown });
  }

  const recordFields: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (baseKeys.has(key)) recordFields[key] = fields[key];
  }

  // The Record's display name is the mapped title. When the Object Type has a
  // primary display field, seed it too so required-field validation passes and
  // later field edits keep the display name consistent.
  const primaryDisplay = baseFieldList.find((field) => field.isPrimaryDisplay);
  if (primaryDisplay && fields[primaryDisplay.key] === undefined) {
    fields[primaryDisplay.key] = input.title;
    recordFields[primaryDisplay.key] = input.title;
  }

  const structuredData: Record<string, unknown> = {};
  if (input.description && !('description' in fields)) {
    if (baseKeys.has('description') || overlayKeys.has('description')) {
      fields.description = input.description;
      if (baseKeys.has('description')) recordFields.description = input.description;
    } else {
      structuredData.description = input.description;
    }
  }
  if (input.priority !== undefined && !('priority' in fields)) {
    if (baseKeys.has('priority') || overlayKeys.has('priority')) {
      fields.priority = input.priority;
      if (baseKeys.has('priority')) recordFields.priority = input.priority;
    } else {
      structuredData.priority = input.priority;
    }
  }

  return {
    fields,
    recordFields,
    structured: Object.keys(structuredData).length > 0 ? structuredData : undefined
  };
}

interface MappedWorkContext {
  trigger: Trigger;
  mapping: TriggerMapping;
  objectTypeId: string;
  workflowId: string;
  stateId: string | null;
  title: string;
  fields: Record<string, unknown>;
  recordFields: Record<string, unknown>;
  structured: Record<string, unknown> | undefined;
  provenance: {
    sourceType: string;
    triggerId: string;
    triggerEventId?: string;
    sourceReference?: string;
    externalRef?: string;
  };
  dedupeKey: string | null;
  parentRecordId: string | null;
  runId: string | null;
}

interface MappedWorkOutcome {
  recordId: string;
  workflowItemId: string;
  stateId: string;
  upserted: boolean;
}

/**
 * Resolve dedupe, then create (or refresh) the Record + WorkflowItem. Kept out of
 * the mapping function so the payload→data translation and the write decision stay
 * independently readable.
 */
function runMappedWorkTransaction(
  tx: Executor,
  actor: ActorContext,
  context: MappedWorkContext
): MappedWorkOutcome {
  const { trigger, mapping, dedupeKey } = context;
  const existing = dedupeKey
    ? tx
        .select({ recordId: recordExternalIds.recordId })
        .from(recordExternalIds)
        .where(
          and(
            eq(recordExternalIds.workspaceId, actor.workspaceId),
            eq(recordExternalIds.system, TRIGGER_EXTERNAL_SYSTEM),
            eq(recordExternalIds.externalId, dedupeKey)
          )
        )
        .limit(1)
        .all()[0]
    : undefined;

  if (existing) {
    const active = tx
      .select()
      .from(workflowItems)
      .where(
        and(
          eq(workflowItems.workspaceId, actor.workspaceId),
          eq(workflowItems.workflowId, context.workflowId),
          eq(workflowItems.recordId, existing.recordId),
          isNull(workflowItems.completedAt),
          isNull(workflowItems.archivedAt)
        )
      )
      .limit(1)
      .all()[0];

    if (active && trigger.upsertOnDedupe) {
      updateWorkflowItemSync(tx, actor, {
        workflowItemId: active.id,
        fields: context.fields,
        structuredData: context.structured,
        displayName: context.title,
        runId: context.runId,
        reason: `Trigger "${trigger.name}" re-delivered`
      });
    }
    if (active) {
      // A redelivery without upsert must not create a second unit of work.
      return {
        recordId: existing.recordId,
        workflowItemId: active.id,
        stateId: active.stateId,
        upserted: true
      };
    }
    // The record exists but has no active work in this workflow: start it.
    const item = createWorkflowItemSync(tx, actor, {
      workflowId: context.workflowId,
      recordId: existing.recordId,
      stateId: context.stateId,
      ownerUserId: mapping.ownerUserId ?? null,
      ownerTeamId: mapping.ownerTeamId ?? null,
      fields: context.fields,
      structuredData: context.structured,
      provenance: context.provenance,
      reason: `Trigger "${trigger.name}"`
    });
    return {
      recordId: existing.recordId,
      workflowItemId: item.id,
      stateId: item.stateId,
      upserted: true
    };
  }

  const record = createRecordSync(tx, actor, {
    objectTypeId: context.objectTypeId,
    displayName: context.title,
    fields: context.recordFields,
    structuredData: context.structured,
    externalIds: dedupeKey
      ? [{ system: TRIGGER_EXTERNAL_SYSTEM, externalId: dedupeKey, label: trigger.name }]
      : [],
    provenance: context.provenance
  });
  const item = createWorkflowItemSync(tx, actor, {
    workflowId: context.workflowId,
    recordId: record.id,
    stateId: context.stateId,
    ownerUserId: mapping.ownerUserId ?? null,
    ownerTeamId: mapping.ownerTeamId ?? null,
    fields: context.fields,
    structuredData: context.structured,
    provenance: context.provenance,
    reason: `Trigger "${trigger.name}"`
  });
  if (mapping.labels && mapping.labels.length > 0) {
    addWorkflowItemLabelsSync(tx, actor, {
      workflowItemId: item.id,
      labelNames: mapping.labels
    });
  }
  if (context.parentRecordId) {
    linkParentWork(tx, actor, context.workflowId, item.id, context.parentRecordId);
  }
  return { recordId: record.id, workflowItemId: item.id, stateId: item.stateId, upserted: false };
}

/**
 * Link created work to the work item of the Record named by `parentRecordPath`.
 * A parent Record with no active work in the destination workflow has nothing to
 * parent under, so the link is skipped rather than guessed.
 */
function linkParentWork(
  tx: Executor,
  actor: ActorContext,
  workflowId: string,
  childWorkflowItemId: string,
  parentRecordId: string
): void {
  const parentRecord = tx
    .select({ id: records.id })
    .from(records)
    .where(and(eq(records.workspaceId, actor.workspaceId), eq(records.id, parentRecordId)))
    .limit(1)
    .all()[0];
  if (!parentRecord) {
    throw errors.validation('parentRecordPath did not resolve to a known record', {
      recordId: parentRecordId
    });
  }
  const parentItem = tx
    .select({ id: workflowItems.id })
    .from(workflowItems)
    .where(
      and(
        eq(workflowItems.workspaceId, actor.workspaceId),
        eq(workflowItems.workflowId, workflowId),
        eq(workflowItems.recordId, parentRecordId),
        isNull(workflowItems.completedAt),
        isNull(workflowItems.archivedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!parentItem) return;
  linkWorkItemsSync(tx, actor, {
    fromWorkflowItemId: childWorkflowItemId,
    toWorkflowItemId: parentItem.id,
    type: 'parent',
    note: 'Mapped from parentRecordPath'
  });
}
