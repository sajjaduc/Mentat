/**
 * Workflow-interpreted file fields.
 *
 * The same document can be a `Policy Schedule` in Underwriting and `Evidence` in
 * Compliance. Field values are therefore keyed by `(fileId, workflowId,
 * fieldDefinitionId)` and never by file alone (ADR-0010). Definitions reuse the
 * generalized `field_definitions`/`workflow_fields` tables with scope `file`, and
 * values reuse `file_field_values` plus the immutable `field_value_history`, so
 * correction history and filtering behave exactly like ticket fields.
 *
 * Extraction goes through a provider seam (`FileExtractionProvider`) rather than
 * importing provider internals: this workstream must not depend on how models are
 * called, only on the `ModelProvider` shape, and tests inject a deterministic fake.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import {
  type ActorType,
  type FieldDefinition,
  type FieldDisplay,
  type FieldOptions,
  type FieldType,
  type FieldValidation,
  fieldDefinitions,
  fieldValueHistory,
  fileFieldValues,
  files,
  workflowFields
} from '../db/schema';
import type { GenerateRequest, GenerateResult } from '../providers/types';
import { normalizeFieldValue, readFieldValue, type TypedFieldValueColumns } from './field-values';
import * as repo from './repository';

/**
 * Narrow provider contract used for file-field extraction and summarisation.
 * Structurally compatible with `ModelProvider`, so the real registry can satisfy
 * it once it exists, while tests inject a fake that returns fixed JSON.
 */
export interface FileExtractionProvider {
  readonly type: string;
  readonly name: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

let extractionProvider: FileExtractionProvider | null = null;

/** Install the provider used for extraction/summarisation. */
export function setFileExtractionProvider(provider: FileExtractionProvider | null): void {
  extractionProvider = provider;
}

export function getFileExtractionProvider(): FileExtractionProvider | null {
  return extractionProvider;
}

function requireProvider(): FileExtractionProvider {
  if (!extractionProvider) {
    throw errors.unsupported(
      'No file extraction provider is installed. Register one with setFileExtractionProvider().'
    );
  }
  return extractionProvider;
}

export interface CreateFileFieldInput {
  key: string;
  name?: string;
  description?: string | null;
  type: FieldType;
  options?: FieldOptions | null;
  validation?: FieldValidation | null;
  display?: FieldDisplay | null;
  defaultValue?: unknown;
  isSystem?: boolean;
}

/** Define a workspace file field. Keys are unique per `(workspace, scope, key)`. */
export async function createFileFieldDefinition(
  actor: ActorContext,
  input: CreateFileFieldInput,
  db?: Executor
): Promise<string> {
  assertPermission(actor, Permissions.configWrite, 'Not permitted to define file fields');
  const executor = requireExecutor(db);
  const key = normalizeFieldKey(input.key);
  return withTransaction(executor, (tx) => {
    const existing = tx
      .select({ id: fieldDefinitions.id })
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, actor.workspaceId),
          eq(fieldDefinitions.scope, 'file'),
          eq(fieldDefinitions.key, key)
        )
      )
      .limit(1)
      .all()[0];
    if (existing) throw errors.conflict(`A file field with key "${key}" already exists`, { key });

    const row = tx
      .insert(fieldDefinitions)
      .values({
        id: uuidv7(),
        workspaceId: actor.workspaceId,
        key,
        name: input.name ?? input.key,
        description: input.description ?? null,
        type: input.type,
        scope: 'file',
        options: input.options ?? null,
        validation: input.validation ?? null,
        display: input.display ?? null,
        defaultValue: input.defaultValue ?? null,
        isSystem: input.isSystem ?? false,
        createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
      .returning({ id: fieldDefinitions.id })
      .all()[0];
    if (!row) throw errors.internal('Failed to create file field definition');
    return row.id;
  });
}

/** Apply file fields to a workflow so extraction and the UI know what to offer. */
export async function applyFileFieldsToWorkflow(
  actor: ActorContext,
  input: { workflowId: string; fieldKeys: string[] },
  db?: Executor
): Promise<void> {
  assertPermission(actor, Permissions.configWrite, 'Not permitted to configure file fields');
  const executor = requireExecutor(db);
  await withTransaction(executor, (tx) => {
    repo.assertWorkflowInWorkspace(tx, actor.workspaceId, input.workflowId);
    const keys = input.fieldKeys.map(normalizeFieldKey);
    if (keys.length === 0) return;
    const definitions = tx
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, actor.workspaceId),
          eq(fieldDefinitions.scope, 'file'),
          inArray(fieldDefinitions.key, keys)
        )
      )
      .all();
    if (definitions.length !== keys.length) {
      const found = new Set(definitions.map((definition) => definition.key));
      throw errors.validation('Unknown file field keys', {
        missing: keys.filter((key) => !found.has(key))
      });
    }
    for (const [position, definition] of definitions.entries()) {
      const existing = tx
        .select({ id: workflowFields.id })
        .from(workflowFields)
        .where(
          and(
            eq(workflowFields.workflowId, input.workflowId),
            eq(workflowFields.fieldDefinitionId, definition.id)
          )
        )
        .limit(1)
        .all()[0];
      if (existing) {
        tx.update(workflowFields)
          .set({ position, updatedAt: Date.now() })
          .where(eq(workflowFields.id, existing.id))
          .run();
      } else {
        tx.insert(workflowFields)
          .values({
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            workflowId: input.workflowId,
            fieldDefinitionId: definition.id,
            position,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
          .run();
      }
    }
  });
}

export interface SetFileFieldValuesInput {
  fileId: string;
  workflowId?: string | null;
  values: Record<string, unknown>;
  source?: 'human' | 'agent' | 'system' | 'extraction';
  runId?: string | null;
  /** Extraction metadata keyed by field key. */
  confidence?: Record<string, number>;
  sourcePages?: Record<string, number | null>;
  sourceSpans?: Record<string, string | null>;
  /** Skip the permission check — reserved for system actors. */
  force?: boolean;
}

export interface FileFieldChange {
  key: string;
  previous: unknown;
  next: unknown;
}

/**
 * Write typed file-field values, append history and audit in one transaction.
 * Every value passes through `normalizeFieldValue` first, so a bad value can
 * never reach the typed columns.
 */
export async function setFileFieldValues(
  actor: ActorContext,
  input: SetFileFieldValuesInput,
  db?: Executor
): Promise<{ changed: FileFieldChange[] }> {
  if (!input.force) {
    assertPermission(actor, Permissions.fileWrite, 'Not permitted to set file fields');
  }
  const executor = requireExecutor(db);
  const workflowId = input.workflowId ?? null;
  const source = input.source ?? (actor.actorType === 'extraction' ? 'extraction' : 'human');

  return withTransaction(executor, (tx) => {
    const file = repo.findFile(tx, actor.workspaceId, input.fileId);
    if (!file) throw errors.notFound('File', input.fileId);
    if (workflowId) repo.assertWorkflowInWorkspace(tx, actor.workspaceId, workflowId);

    const definitions = resolveDefinitions(tx, actor.workspaceId, Object.keys(input.values));
    const changed: FileFieldChange[] = [];
    const now = Date.now();

    for (const [key, definition] of definitions) {
      const raw = input.values[key];
      const normalized = normalizeFieldValue(definition, raw);
      const existing = findValueRow(tx, input.fileId, workflowId, definition.id);
      const previous = existing
        ? readFieldValue(existing as TypedFieldValueColumns, definition)
        : null;

      const columns = {
        valueText: normalized.valueText,
        valueNumber: normalized.valueNumber,
        valueBool: normalized.valueBool,
        valueDate: normalized.valueDate,
        valueJson: normalized.valueJson as never,
        searchText: normalized.searchText,
        confidence: input.confidence?.[key] ?? existing?.confidence ?? null,
        sourcePage: input.sourcePages?.[key] ?? existing?.sourcePage ?? null,
        sourceSpan: input.sourceSpans?.[key] ?? existing?.sourceSpan ?? null,
        updatedByType: actor.actorType as ActorType,
        updatedById: actor.actorId,
        updatedAt: now
      };

      if (existing) {
        tx.update(fileFieldValues).set(columns).where(eq(fileFieldValues.id, existing.id)).run();
      } else {
        tx.insert(fileFieldValues)
          .values({
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            fileId: input.fileId,
            workflowId,
            fieldDefinitionId: definition.id,
            ...columns
          })
          .run();
      }

      const isChange = !sameValue(previous, normalized.display);
      tx.insert(fieldValueHistory)
        .values({
          id: uuidv7(),
          workspaceId: actor.workspaceId,
          ownerType: 'file',
          ownerId: input.fileId,
          fieldDefinitionId: definition.id,
          workflowId,
          previousValue: previous as never,
          newValue: normalized.display as never,
          actorType: actor.actorType as ActorType,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          runId: input.runId ?? actor.runId ?? null,
          source,
          createdAt: now
        })
        .run();

      if (isChange) {
        changed.push({ key, previous, next: normalized.display });
        writeAudit(tx, {
          workspaceId: actor.workspaceId,
          action:
            source === 'extraction'
              ? AuditActions.fileFieldExtracted
              : AuditActions.fileFieldCorrected,
          actorType: source === 'extraction' ? 'extraction' : actor.actorType,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          entityType: 'file',
          entityId: input.fileId,
          fileId: input.fileId,
          workflowId,
          runId: input.runId ?? actor.runId ?? null,
          summary: `${source === 'extraction' ? 'Extracted' : 'Corrected'} file field "${key}"`,
          data: {
            fieldKey: key,
            previous: previous as never,
            next: normalized.display as never,
            source,
            confidence: input.confidence?.[key] ?? null
          }
        });
      }
    }

    tx.update(files)
      .set({ version: sql`${files.version} + 1`, updatedAt: now })
      .where(and(eq(files.id, input.fileId), eq(files.workspaceId, actor.workspaceId)))
      .run();

    return { changed };
  });
}

export interface FileFieldValueView {
  key: string;
  name: string;
  type: FieldType;
  workflowId: string | null;
  value: unknown;
  confidence: number | null;
  sourcePage: number | null;
  sourceSpan: string | null;
  updatedAt: number;
}

export async function listFileFieldValues(
  actor: ActorContext,
  input: { fileId: string; workflowId?: string | null },
  db?: Executor
): Promise<FileFieldValueView[]> {
  assertPermission(actor, Permissions.fileRead, 'Not permitted to read file fields');
  const executor = requireExecutor(db);
  const file = repo.findFile(executor, actor.workspaceId, input.fileId);
  if (!file) throw errors.notFound('File', input.fileId);

  const conditions = [
    eq(fileFieldValues.workspaceId, actor.workspaceId),
    eq(fileFieldValues.fileId, input.fileId)
  ];
  if (input.workflowId !== undefined) {
    conditions.push(
      input.workflowId === null
        ? isNull(fileFieldValues.workflowId)
        : eq(fileFieldValues.workflowId, input.workflowId)
    );
  }

  const rows = executor
    .select({ value: fileFieldValues, definition: fieldDefinitions })
    .from(fileFieldValues)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fileFieldValues.fieldDefinitionId))
    .where(and(...conditions))
    .all();

  return rows.map(({ value, definition }) => ({
    key: definition.key,
    name: definition.name,
    type: definition.type,
    workflowId: value.workflowId,
    value: readFieldValue(value as TypedFieldValueColumns, definition),
    confidence: value.confidence,
    sourcePage: value.sourcePage,
    sourceSpan: value.sourceSpan,
    updatedAt: value.updatedAt
  }));
}

export interface FileFieldExtractionResult {
  fileId: string;
  provider: string;
  extracted: number;
  fields: Array<{ key: string; value: unknown; confidence: number | null }>;
}

/**
 * Extract the workflow's configured file fields from the file's latest extracted
 * content. Model I/O happens outside the transaction; persistence reuses
 * `setFileFieldValues`, so validation and history are identical to a human edit.
 */
export async function extractFileFields(
  actor: ActorContext,
  input: {
    fileId: string;
    workflowId: string;
    providerId?: string | null;
    modelId?: string | null;
  },
  db?: Executor
): Promise<FileFieldExtractionResult> {
  assertPermission(actor, Permissions.fileWrite, 'Not permitted to extract file fields');
  const executor = requireExecutor(db);
  const file = repo.findFile(executor, actor.workspaceId, input.fileId);
  if (!file) throw errors.notFound('File', input.fileId);
  const content = repo.findLatestExtractedContent(executor, actor.workspaceId, input.fileId);
  if (!content) {
    throw errors.precondition('File has no extracted content to extract fields from', {
      fileId: input.fileId
    });
  }

  const definitions = loadWorkflowFieldDefinitions(executor, actor.workspaceId, input.workflowId);
  if (definitions.length === 0) {
    throw errors.validation('This workflow has no file fields configured', {
      workflowId: input.workflowId
    });
  }

  const provider = requireProvider();
  const prompt = buildExtractionPrompt(definitions, content.text);
  const result = await provider.generate({
    model: input.modelId ?? input.providerId ?? provider.name,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    jsonSchema: prompt.jsonSchema,
    temperature: 0
  });

  const parsed = parseJsonObject(result.content);
  const values: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const sourcePages: Record<string, number | null> = {};
  const sourceSpans: Record<string, string | null> = {};

  for (const definition of definitions) {
    const entry = parsed[definition.key];
    if (entry === undefined || entry === null) continue;
    const extracted = isExtractionEnvelope(entry)
      ? entry
      : { value: entry, confidence: undefined, page: undefined, span: undefined };
    if (extracted.value === undefined || extracted.value === null) continue;
    values[definition.key] = extracted.value;
    if (typeof extracted.confidence === 'number') confidence[definition.key] = extracted.confidence;
    if (typeof extracted.page === 'number') sourcePages[definition.key] = extracted.page;
    if (typeof extracted.span === 'string') sourceSpans[definition.key] = extracted.span;
  }

  if (Object.keys(values).length === 0) {
    return { fileId: input.fileId, provider: provider.type, extracted: 0, fields: [] };
  }

  await setFileFieldValues(
    actor,
    {
      fileId: input.fileId,
      workflowId: input.workflowId,
      values,
      source: 'extraction',
      runId: actor.runId ?? null,
      confidence,
      sourcePages,
      sourceSpans
    },
    executor
  );

  return {
    fileId: input.fileId,
    provider: provider.type,
    extracted: Object.keys(values).length,
    fields: definitions
      .filter((definition) => definition.key in values)
      .map((definition) => ({
        key: definition.key,
        value: values[definition.key],
        confidence: confidence[definition.key] ?? null
      }))
  };
}

function loadWorkflowFieldDefinitions(
  executor: Executor,
  workspaceId: string,
  workflowId: string
): FieldDefinition[] {
  return executor
    .select({ definition: fieldDefinitions })
    .from(workflowFields)
    .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, workflowFields.fieldDefinitionId))
    .where(
      and(
        eq(workflowFields.workspaceId, workspaceId),
        eq(workflowFields.workflowId, workflowId),
        eq(fieldDefinitions.scope, 'file')
      )
    )
    .orderBy(workflowFields.position)
    .all()
    .map((row) => row.definition);
}

function resolveDefinitions(
  executor: Executor,
  workspaceId: string,
  keys: string[]
): Map<string, FieldDefinition> {
  if (keys.length === 0) return new Map();
  const normalised = keys.map((key) => ({
    original: key,
    lookup: normalizeFieldKey(key)
  }));
  const rows = executor
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, 'file'),
        inArray(
          fieldDefinitions.key,
          normalised.map((entry) => entry.lookup)
        )
      )
    )
    .all();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const result = new Map<string, FieldDefinition>();
  const missing: string[] = [];
  for (const entry of normalised) {
    const definition = byKey.get(entry.lookup);
    if (!definition) {
      missing.push(entry.original);
      continue;
    }
    result.set(entry.original, definition);
  }
  if (missing.length > 0) {
    throw errors.validation('Unknown file field(s)', { fields: missing });
  }
  return result;
}

function findValueRow(
  executor: Executor,
  fileId: string,
  workflowId: string | null,
  fieldDefinitionId: string
) {
  return executor
    .select()
    .from(fileFieldValues)
    .where(
      and(
        eq(fileFieldValues.fileId, fileId),
        workflowId === null
          ? isNull(fileFieldValues.workflowId)
          : eq(fileFieldValues.workflowId, workflowId),
        eq(fileFieldValues.fieldDefinitionId, fieldDefinitionId)
      )
    )
    .limit(1)
    .all()[0];
}

function normalizeFieldKey(key: string): string {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized.length === 0) throw errors.validation('File field key must not be empty');
  return normalized;
}

function sameValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (previous === null || previous === undefined) return next === null || next === undefined;
  return JSON.stringify(previous) === JSON.stringify(next);
}

interface ExtractionEnvelope {
  value: unknown;
  confidence?: number;
  page?: number;
  span?: string;
}

function isExtractionEnvelope(entry: unknown): entry is ExtractionEnvelope {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    'value' in (entry as Record<string, unknown>)
  );
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

const MAX_EXTRACTION_CHARS = 12_000;

function buildExtractionPrompt(
  definitions: FieldDefinition[],
  text: string
): { system: string; user: string; jsonSchema: Record<string, unknown> } {
  const lines = definitions.map((definition) => {
    const choices = definition.options?.choices
      ?.map((choice) => `${choice.value} (${choice.label})`)
      .join(', ');
    return `- ${definition.key} (${definition.type}): ${definition.name}${choices ? `; allowed: ${choices}` : ''}`;
  });
  const properties: Record<string, unknown> = {};
  for (const definition of definitions) {
    properties[definition.key] = {
      type: 'object',
      properties: {
        value: { description: `Extracted value for ${definition.name}` },
        confidence: { type: 'number' },
        page: { type: 'number' },
        span: { type: 'string' }
      },
      required: ['value'],
      additionalProperties: false
    };
  }
  return {
    system:
      'You extract structured fields from a document. Return ONLY a JSON object keyed by the ' +
      'requested field keys. For each field return an object with "value", and when known ' +
      '"confidence" (0..1), "page" and "span". Omit fields you cannot determine.\n\nFields:\n' +
      lines.join('\n'),
    user: text.slice(0, MAX_EXTRACTION_CHARS),
    jsonSchema: { type: 'object', properties, additionalProperties: false }
  };
}

function requireExecutor(db?: Executor): Executor {
  if (!db) throw errors.internal('File field operations require a database executor');
  return db;
}
