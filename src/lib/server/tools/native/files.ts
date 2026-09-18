/**
 * Native file tools.
 *
 * Agents never receive storage credentials and never address a blob directly. They
 * work with *files*: read a summary, read extracted content on demand, query file
 * fields, correct a field, or link a file to a Record or WorkflowItem. Content is
 * fetched only when the agent asks for it, which is the token-efficiency rule from
 * the follow-up brief (§18) expressed as an API shape.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertNativeCapability } from '../../agents/permissions';
import { errors } from '../../core/errors';
import { uuidv7 } from '../../core/ids';
import {
  blobs,
  fieldDefinitions,
  fileExtractedContent,
  fileFieldValues,
  fileRecords,
  fileSources,
  files,
  fileWorkflowItems
} from '../../db/schema';
import { displayFieldValue, normalizeFieldValue } from '../../fields/values';
import { defineNativeTool, type NativeToolHandler, toolFailure, toolSuccess } from '../types';

const FILES_GET = 'files.get';
const FILES_LIST = 'files.list';
const FILES_FIND = 'files.find';
const FILES_SEARCH = 'files.search';
const FILES_READ = 'files.read';
const FILES_SUMMARY = 'files.getSummary';
const FILES_FIELDS_GET = 'files.getFields';
const FILES_FIELDS_SET = 'files.setFields';
const FILES_LINK = 'files.linkToWorkItem';

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

/**
 * Resolve the file a call refers to. When a run has exactly one linked file, a
 * call may omit the id — but ambiguity is an error rather than a guess, because
 * guessing here would mean writing fields onto the wrong document.
 */
function resolveFileId(
  context: Parameters<NativeToolHandler['execute']>[1],
  explicitId?: string | null
): string {
  if (explicitId) return explicitId;
  if (context.fileIds && context.fileIds.length === 1) return context.fileIds[0] as string;
  if (!context.workflowItemId && !context.recordId) {
    throw errors.validation('Provide a fileId: no file is in scope for this call');
  }
  const linked = context.workflowItemId
    ? context.db
        .select({ fileId: fileWorkflowItems.fileId })
        .from(fileWorkflowItems)
        .where(
          and(
            eq(fileWorkflowItems.workspaceId, context.actor.workspaceId),
            eq(fileWorkflowItems.workflowItemId, context.workflowItemId),
            isNull(fileWorkflowItems.removedAt)
          )
        )
        .all()
    : context.db
        .select({ fileId: fileRecords.fileId })
        .from(fileRecords)
        .where(
          and(
            eq(fileRecords.workspaceId, context.actor.workspaceId),
            eq(fileRecords.recordId, context.recordId as string),
            isNull(fileRecords.removedAt)
          )
        )
        .all();
  if (linked.length === 1) return linked[0]!.fileId;
  if (linked.length === 0) {
    throw errors.validation('This work item has no linked files; provide a fileId explicitly');
  }
  throw errors.validation('This work item has several linked files; provide a fileId explicitly', {
    fileIds: linked.map((row) => row.fileId)
  });
}

function requireFile(context: Parameters<NativeToolHandler['execute']>[1], fileId: string) {
  const row = context.db
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.workspaceId, context.actor.workspaceId),
        isNull(files.deletedAt)
      )
    )
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('File', fileId);
  return row;
}

export const filesGetTool = defineNativeTool({
  key: FILES_GET,
  name: 'Get a file',
  description:
    'Read a file’s identity, metadata, provenance and processing status. Does not return content; use files.read for extracted text.',
  inputSchema: objectSchema({ fileId: { type: 'string', description: 'File id.' } }),
  permission: 'file:read',
  async execute(input: { fileId?: string } | undefined, context) {
    const fileId = resolveFileId(context, input?.fileId);
    const file = requireFile(context, fileId);
    const provenance = context.db
      .select()
      .from(fileSources)
      .where(
        and(eq(fileSources.fileId, fileId), eq(fileSources.workspaceId, context.actor.workspaceId))
      )
      .orderBy(desc(fileSources.occurredAt))
      .all();
    const blob = context.db.select().from(blobs).where(eq(blobs.id, file.blobId)).limit(1).all()[0];
    const linkedRecords = context.db
      .select({ recordId: fileRecords.recordId, relationship: fileRecords.relationship })
      .from(fileRecords)
      .where(and(eq(fileRecords.fileId, fileId), isNull(fileRecords.removedAt)))
      .all();
    const linkedWorkItems = context.db
      .select({
        workflowItemId: fileWorkflowItems.workflowItemId,
        relationship: fileWorkflowItems.relationship
      })
      .from(fileWorkflowItems)
      .where(and(eq(fileWorkflowItems.fileId, fileId), isNull(fileWorkflowItems.removedAt)))
      .all();

    return toolSuccess({
      file: {
        id: file.id,
        filename: file.originalFilename,
        mimeType: file.mimeType,
        size: file.size,
        status: file.status,
        kind: file.kind,
        summary: file.summary,
        metadata: file.metadata,
        contentHash: blob?.contentHash ?? null,
        createdAt: file.createdAt
      },
      provenance: provenance.map((source) => ({
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        sourceLabel: source.sourceLabel,
        occurredAt: source.occurredAt,
        deduplicated: source.deduplicated
      })),
      linkedRecords,
      linkedWorkItems
    });
  }
});

export const filesListTool = defineNativeTool({
  key: FILES_LIST,
  name: 'List files for a record or work item',
  description:
    'List the files linked to a Record or WorkflowItem with their summaries and processing status.',
  inputSchema: objectSchema({
    recordId: { type: 'string', description: 'Record id. Defaults to the record in scope.' },
    workflowItemId: {
      type: 'string',
      description: 'Workflow item id. Defaults to the work item in scope.'
    }
  }),
  permission: 'file:read',
  async execute(input: { recordId?: string; workflowItemId?: string } | undefined, context) {
    const workflowItemId = input?.workflowItemId ?? context.workflowItemId;
    const recordId = input?.recordId ?? context.recordId;
    if (workflowItemId) {
      const rows = context.db
        .select({
          id: files.id,
          filename: files.originalFilename,
          mimeType: files.mimeType,
          size: files.size,
          status: files.status,
          summary: files.summary,
          relationship: fileWorkflowItems.relationship,
          addedAt: fileWorkflowItems.createdAt
        })
        .from(fileWorkflowItems)
        .innerJoin(files, eq(files.id, fileWorkflowItems.fileId))
        .where(
          and(
            eq(fileWorkflowItems.workspaceId, context.actor.workspaceId),
            eq(fileWorkflowItems.workflowItemId, workflowItemId),
            isNull(fileWorkflowItems.removedAt),
            isNull(files.deletedAt)
          )
        )
        .all();
      return toolSuccess({ files: rows });
    }
    if (recordId) {
      const rows = context.db
        .select({
          id: files.id,
          filename: files.originalFilename,
          mimeType: files.mimeType,
          size: files.size,
          status: files.status,
          summary: files.summary,
          relationship: fileRecords.relationship,
          addedAt: fileRecords.createdAt
        })
        .from(fileRecords)
        .innerJoin(files, eq(files.id, fileRecords.fileId))
        .where(
          and(
            eq(fileRecords.workspaceId, context.actor.workspaceId),
            eq(fileRecords.recordId, recordId),
            isNull(fileRecords.removedAt),
            isNull(files.deletedAt)
          )
        )
        .all();
      return toolSuccess({ files: rows });
    }
    return toolFailure({
      code: 'validation_failed',
      message: 'Provide a recordId or workflowItemId, or call this from a scoped run'
    });
  }
});

export const filesFindTool = defineNativeTool({
  key: FILES_FIND,
  name: 'Find files',
  description:
    'Search files by structured criteria: filename substring, MIME type, processing status, workflow context, and file field values (for example Document Type = Invoice).',
  inputSchema: objectSchema({
    filenameContains: { type: 'string', description: 'Case-insensitive filename substring.' },
    mimeType: { type: 'string', description: 'Exact MIME type, e.g. application/pdf.' },
    status: { type: 'string', description: 'pending | processing | ready | failed' },
    workflowId: { type: 'string', description: 'Only files contextualised to this workflow.' },
    recordId: { type: 'string', description: 'Only files linked to this Record.' },
    workflowItemId: { type: 'string', description: 'Only files linked to this WorkflowItem.' },
    fields: {
      type: 'object',
      description: 'Field key to expected value. Values are matched exactly after normalisation.'
    },
    limit: { type: 'number', description: 'Maximum results (default 20, max 100).' }
  }),
  permission: 'file:read',
  async execute(
    input:
      | {
          filenameContains?: string;
          mimeType?: string;
          status?: string;
          workflowId?: string;
          recordId?: string;
          workflowItemId?: string;
          fields?: Record<string, unknown>;
          limit?: number;
        }
      | undefined,
    context
  ) {
    const workspaceId = context.actor.workspaceId;
    const conditions = [eq(files.workspaceId, workspaceId), isNull(files.deletedAt)];
    if (input?.filenameContains) {
      conditions.push(
        sql`lower(${files.originalFilename}) like ${`%${input.filenameContains.toLowerCase()}%`}`
      );
    }
    if (input?.mimeType) conditions.push(eq(files.mimeType, input.mimeType));
    if (input?.status) conditions.push(eq(files.status, input.status as never));
    if (input?.workflowId) conditions.push(eq(files.primaryWorkflowId, input.workflowId));
    if (input?.workflowItemId) {
      conditions.push(
        sql`exists (select 1 from ${fileWorkflowItems} where ${fileWorkflowItems.fileId} = ${files.id} and ${fileWorkflowItems.workflowItemId} = ${input.workflowItemId} and ${fileWorkflowItems.removedAt} is null)`
      );
    } else if (input?.recordId) {
      conditions.push(
        sql`exists (select 1 from ${fileRecords} where ${fileRecords.fileId} = ${files.id} and ${fileRecords.recordId} = ${input.recordId} and ${fileRecords.removedAt} is null)`
      );
    }

    const limit = Math.min(Math.max(input?.limit ?? 20, 1), 100);
    let rows = context.db
      .select({
        id: files.id,
        filename: files.originalFilename,
        mimeType: files.mimeType,
        size: files.size,
        status: files.status,
        summary: files.summary,
        metadata: files.metadata,
        createdAt: files.createdAt
      })
      .from(files)
      .where(and(...conditions))
      .orderBy(desc(files.createdAt))
      .limit(limit * 4)
      .all();

    const fieldFilters = Object.entries(input?.fields ?? {});
    if (fieldFilters.length > 0) {
      const definitions = context.db
        .select()
        .from(fieldDefinitions)
        .where(
          and(
            eq(fieldDefinitions.workspaceId, workspaceId),
            eq(fieldDefinitions.scope, 'file'),
            inArray(
              fieldDefinitions.key,
              fieldFilters.map(([key]) => key)
            )
          )
        )
        .all();
      const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
      const fileIds = rows.map((row) => row.id);
      const values = fileIds.length
        ? context.db
            .select()
            .from(fileFieldValues)
            .where(
              and(
                eq(fileFieldValues.workspaceId, workspaceId),
                inArray(fileFieldValues.fileId, fileIds)
              )
            )
            .all()
        : [];

      const matches = (fileId: string, key: string, expected: unknown): boolean => {
        const definition = byKey.get(key);
        if (!definition) return false;
        const normalisedExpected = normalizeFieldValue(definition, expected);
        const row = values.find(
          (value) => value.fileId === fileId && value.fieldDefinitionId === definition.id
        );
        if (!row)
          return normalisedExpected.valueText === null && normalisedExpected.valueNumber === null;
        return (
          row.valueText === normalisedExpected.valueText &&
          row.valueNumber === normalisedExpected.valueNumber &&
          row.valueBool === normalisedExpected.valueBool &&
          row.valueDate === normalisedExpected.valueDate
        );
      };

      rows = rows.filter((row) =>
        fieldFilters.every(([key, expected]) => matches(row.id, key, expected))
      );
      const unknownKeys = fieldFilters.map(([key]) => key).filter((key) => !byKey.has(key));
      if (unknownKeys.length > 0) {
        return toolFailure({
          code: 'validation_failed',
          message: `Unknown file field key(s): ${unknownKeys.join(', ')}`
        });
      }
    }

    return toolSuccess({ files: rows.slice(0, limit), count: rows.length });
  }
});

export const filesSearchTool = defineNativeTool({
  key: FILES_SEARCH,
  name: 'Search file content',
  description:
    'Text search across extracted document content. Returns matching files with a short excerpt around the first match.',
  inputSchema: objectSchema(
    {
      query: { type: 'string', description: 'Text to find in extracted content.' },
      workflowId: { type: 'string', description: 'Restrict to one workflow context.' },
      limit: { type: 'number', description: 'Maximum results (default 10, max 50).' }
    },
    ['query']
  ),
  permission: 'file:read',
  async execute(input: { query: string; workflowId?: string; limit?: number }, context) {
    const workspaceId = context.actor.workspaceId;
    const query = input.query.trim();
    if (query.length < 2) {
      return toolFailure({
        code: 'validation_failed',
        message: 'Search text must be at least 2 characters'
      });
    }
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);

    // Prefer the FTS index when the SQLite build provides one; fall back to a
    // portable LIKE scan so retrieval works everywhere (ADR-0018).
    const ftsAvailable = hasFtsTable(context);
    const rows = ftsAvailable
      ? context.db.all<{ file_id: string; workspace_id: string; body: string; rank: number }>(
          sql`select file_id, workspace_id, body, rank from file_content_fts where file_content_fts match ${query} and workspace_id = ${workspaceId} order by rank limit ${limit}`
        )
      : [];

    if (rows.length > 0) {
      const fileIds = rows.map((row) => row.file_id).filter((id) => typeof id === 'string');
      const meta = fileIds.length
        ? context.db
            .select({ id: files.id, filename: files.originalFilename, status: files.status })
            .from(files)
            .where(and(eq(files.workspaceId, workspaceId), inArray(files.id, fileIds)))
            .all()
        : [];
      const byId = new Map(meta.map((row) => [row.id, row]));
      return toolSuccess({
        results: rows.map((row) => ({
          fileId: row.file_id,
          filename: byId.get(row.file_id)?.filename ?? null,
          excerpt: excerpt(row.body, query)
        }))
      });
    }

    const likes = `%${query.toLowerCase()}%`;
    const fallback = context.db
      .select({
        fileId: fileExtractedContent.fileId,
        text: fileExtractedContent.text,
        filename: files.originalFilename
      })
      .from(fileExtractedContent)
      .innerJoin(files, eq(files.id, fileExtractedContent.fileId))
      .where(
        and(
          eq(fileExtractedContent.workspaceId, workspaceId),
          isNull(files.deletedAt),
          sql`lower(${fileExtractedContent.text}) like ${likes}`
        )
      )
      .limit(limit)
      .all();

    return toolSuccess({
      results: fallback.map((row) => ({
        fileId: row.fileId,
        filename: row.filename,
        excerpt: excerpt(row.text, query)
      }))
    });
  }
});

function hasFtsTable(context: Parameters<NativeToolHandler['execute']>[1]): boolean {
  try {
    const row = context.db.get<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'file_content_fts' limit 1`
    );
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function excerpt(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, 240);
  const start = Math.max(0, index - 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 240)}${start + 240 < text.length ? '…' : ''}`;
}

export const filesReadTool = defineNativeTool({
  key: FILES_READ,
  name: 'Read extracted file content',
  description:
    'Read the extracted text of a file. Use this only when the summary is not enough: full content is long and should be requested deliberately.',
  inputSchema: objectSchema(
    {
      fileId: { type: 'string', description: 'File id.' },
      maxChars: {
        type: 'number',
        description: 'Maximum characters to return (default 4000, max 20000).'
      }
    },
    ['fileId']
  ),
  permission: 'file:read',
  async execute(input: { fileId: string; maxChars?: number }, context) {
    const fileId = resolveFileId(context, input.fileId);
    const maxChars = Math.min(Math.max(input.maxChars ?? 4000, 200), 20_000);
    const row = context.db
      .select()
      .from(fileExtractedContent)
      .where(
        and(
          eq(fileExtractedContent.workspaceId, context.actor.workspaceId),
          eq(fileExtractedContent.fileId, fileId)
        )
      )
      .orderBy(desc(fileExtractedContent.createdAt))
      .limit(1)
      .all()[0];
    if (!row) {
      return toolFailure({
        code: 'not_found',
        message: 'No extracted content is available yet. The file may still be processing.'
      });
    }
    const truncated = row.text.length > maxChars;
    return toolSuccess({
      fileId,
      contentKind: row.contentKind,
      pageCount: row.pageCount,
      charCount: row.charCount,
      text: truncated ? row.text.slice(0, maxChars) : row.text,
      truncated
    });
  }
});

export const filesSummaryTool = defineNativeTool({
  key: FILES_SUMMARY,
  name: 'Get a file summary',
  description:
    'Read the current summary of a file, with the model and prompt version that produced it.',
  inputSchema: objectSchema({ fileId: { type: 'string', description: 'File id.' } }, ['fileId']),
  permission: 'file:read',
  async execute(input: { fileId: string }, context) {
    const fileId = resolveFileId(context, input.fileId);
    const file = requireFile(context, fileId);
    return toolSuccess({
      fileId,
      filename: file.originalFilename,
      summary: file.summary,
      status: file.status,
      metadata: file.metadata
    });
  }
});

export const filesFieldsGetTool = defineNativeTool({
  key: FILES_FIELDS_GET,
  name: 'Get file fields',
  description:
    'Read the typed fields extracted for a file, optionally scoped to one workflow context.',
  inputSchema: objectSchema({
    fileId: { type: 'string', description: 'File id.' },
    workflowId: { type: 'string', description: 'Workflow context to read.' }
  }),
  permission: 'file:read',
  async execute(input: { fileId?: string; workflowId?: string } | undefined, context) {
    const fileId = resolveFileId(context, input?.fileId);
    const conditions = [
      eq(fileFieldValues.workspaceId, context.actor.workspaceId),
      eq(fileFieldValues.fileId, fileId)
    ];
    if (input?.workflowId) conditions.push(eq(fileFieldValues.workflowId, input.workflowId));

    const rows = context.db
      .select({ value: fileFieldValues, definition: fieldDefinitions })
      .from(fileFieldValues)
      .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, fileFieldValues.fieldDefinitionId))
      .where(and(...conditions))
      .all();

    return toolSuccess({
      fields: rows.map((row) => ({
        key: row.definition.key,
        name: row.definition.name,
        type: row.definition.type,
        value:
          row.value.valueText ??
          row.value.valueNumber ??
          row.value.valueBool ??
          row.value.valueDate ??
          row.value.valueJson,
        display: displayFieldValue(row.definition, {
          valueText: row.value.valueText,
          valueNumber: row.value.valueNumber,
          valueBool: row.value.valueBool,
          valueDate: row.value.valueDate,
          valueJson: row.value.valueJson,
          searchText: row.value.searchText,
          display: null
        }),
        confidence: row.value.confidence,
        sourcePage: row.value.sourcePage,
        workflowId: row.value.workflowId
      }))
    });
  }
});

export const filesFieldsSetTool = defineNativeTool({
  key: FILES_FIELDS_SET,
  name: 'Correct file fields',
  description:
    'Write or correct typed file fields. Mentat validates the type, records the previous value in history and audits who changed it.',
  inputSchema: objectSchema(
    {
      fileId: { type: 'string', description: 'File id.' },
      workflowId: { type: 'string', description: 'Workflow context these fields belong to.' },
      values: { type: 'object', description: 'Map of field key to new value.' }
    },
    ['values']
  ),
  permission: 'file:write',
  async execute(
    input: { fileId?: string; workflowId?: string; values: Record<string, unknown> },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [FILES_FIELDS_SET, 'files.setFields'],
      'correct file fields'
    );
    const fileId = resolveFileId(context, input.fileId);
    const workspaceId = context.actor.workspaceId;

    const definitions = context.db
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.workspaceId, workspaceId),
          eq(fieldDefinitions.scope, 'file'),
          inArray(fieldDefinitions.key, Object.keys(input.values))
        )
      )
      .all();
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
    const unknown = Object.keys(input.values).filter((key) => !byKey.has(key));
    if (unknown.length > 0) {
      return toolFailure({
        code: 'validation_failed',
        message: `Unknown file field key(s): ${unknown.join(', ')}`
      });
    }

    const now = Date.now();
    const changed: Array<{ key: string; previous: unknown; next: unknown }> = [];
    for (const [key, raw] of Object.entries(input.values)) {
      const definition = byKey.get(key)!;
      const normalized = normalizeFieldValue(definition, raw);
      const existing = context.db
        .select()
        .from(fileFieldValues)
        .where(
          and(
            eq(fileFieldValues.workspaceId, workspaceId),
            eq(fileFieldValues.fileId, fileId),
            eq(fileFieldValues.fieldDefinitionId, definition.id),
            input.workflowId
              ? eq(fileFieldValues.workflowId, input.workflowId)
              : isNull(fileFieldValues.workflowId)
          )
        )
        .limit(1)
        .all()[0];

      const previous = existing
        ? (existing.valueText ??
          existing.valueNumber ??
          existing.valueBool ??
          existing.valueDate ??
          existing.valueJson)
        : null;

      if (existing) {
        context.db
          .update(fileFieldValues)
          .set({
            valueText: normalized.valueText,
            valueNumber: normalized.valueNumber,
            valueBool: normalized.valueBool,
            valueDate: normalized.valueDate,
            valueJson: normalized.valueJson as never,
            searchText: normalized.searchText,
            confidence: null,
            updatedByType: context.actor.actorType,
            updatedById: context.actor.actorId,
            updatedAt: now
          })
          .where(eq(fileFieldValues.id, existing.id))
          .run();
      } else {
        const { uuidv7 } = await import('../../core/ids');
        context.db
          .insert(fileFieldValues)
          .values({
            id: uuidv7(now),
            workspaceId,
            fileId,
            workflowId: input.workflowId ?? null,
            fieldDefinitionId: definition.id,
            valueText: normalized.valueText,
            valueNumber: normalized.valueNumber,
            valueBool: normalized.valueBool,
            valueDate: normalized.valueDate,
            valueJson: normalized.valueJson as never,
            searchText: normalized.searchText,
            updatedByType: context.actor.actorType,
            updatedById: context.actor.actorId,
            updatedAt: now
          })
          .run();
      }
      changed.push({ key, previous, next: normalized.display });
    }

    return toolSuccess({ fileId, changed });
  }
});

export const filesLinkToWorkItemTool = defineNativeTool({
  key: FILES_LINK,
  name: 'Link a file to work',
  description:
    'Attach an existing file to a Record or WorkflowItem. Files are shared objects: linking never copies bytes and never removes other links.',
  inputSchema: objectSchema(
    {
      fileId: { type: 'string', description: 'File id.' },
      recordId: { type: 'string', description: 'Record id. Defaults to the record in scope.' },
      workflowItemId: {
        type: 'string',
        description: 'Workflow item id. Defaults to the work item in scope.'
      },
      relationship: { type: 'string', description: 'attachment | reference | output | evidence' },
      caption: { type: 'string', description: 'Optional caption.' }
    },
    ['fileId']
  ),
  permission: 'file:write',
  async execute(
    input: {
      fileId: string;
      recordId?: string;
      workflowItemId?: string;
      relationship?: string;
      caption?: string;
    },
    context
  ) {
    assertNativeCapability(
      context.actor.permissions,
      [FILES_LINK, 'files.linkToWorkItem'],
      'link files to work'
    );
    const fileId = resolveFileId(context, input.fileId);
    const workflowItemId = input.workflowItemId ?? context.workflowItemId;
    const recordId = input.recordId ?? context.recordId;
    if (!workflowItemId && !recordId) {
      return toolFailure({
        code: 'validation_failed',
        message: 'Provide a recordId or workflowItemId, or call this from a scoped run'
      });
    }
    const allowed = ['attachment', 'reference', 'output', 'evidence'] as const;
    const relationship = allowed.find((entry) => entry === input.relationship) ?? 'attachment';
    const now = Date.now();

    if (workflowItemId) {
      const existing = context.db
        .select({ id: fileWorkflowItems.id })
        .from(fileWorkflowItems)
        .where(
          and(
            eq(fileWorkflowItems.workspaceId, context.actor.workspaceId),
            eq(fileWorkflowItems.fileId, fileId),
            eq(fileWorkflowItems.workflowItemId, workflowItemId),
            eq(fileWorkflowItems.relationship, relationship)
          )
        )
        .all()[0];
      if (existing) {
        context.db
          .update(fileWorkflowItems)
          .set({ removedAt: null })
          .where(eq(fileWorkflowItems.id, existing.id))
          .run();
      } else {
        context.db
          .insert(fileWorkflowItems)
          .values({
            id: uuidv7(now),
            workspaceId: context.actor.workspaceId,
            fileId,
            workflowItemId,
            relationship,
            caption: input.caption ?? null,
            addedByType: context.actor.actorType,
            addedById: context.actor.actorId,
            addedByLabel: context.actor.actorLabel,
            runId: context.runId ?? null,
            createdAt: now
          })
          .run();
      }
      return toolSuccess({ fileId, workflowItemId, relationship });
    }

    const existing = context.db
      .select({ id: fileRecords.id })
      .from(fileRecords)
      .where(
        and(
          eq(fileRecords.workspaceId, context.actor.workspaceId),
          eq(fileRecords.fileId, fileId),
          eq(fileRecords.recordId, recordId as string),
          eq(fileRecords.relationship, relationship)
        )
      )
      .all()[0];
    if (existing) {
      context.db
        .update(fileRecords)
        .set({ removedAt: null })
        .where(eq(fileRecords.id, existing.id))
        .run();
    } else {
      context.db
        .insert(fileRecords)
        .values({
          id: uuidv7(now),
          workspaceId: context.actor.workspaceId,
          fileId,
          recordId: recordId as string,
          relationship,
          caption: input.caption ?? null,
          addedByType: context.actor.actorType,
          addedById: context.actor.actorId,
          addedByLabel: context.actor.actorLabel,
          runId: context.runId ?? null,
          createdAt: now
        })
        .run();
    }
    return toolSuccess({ fileId, recordId, relationship });
  }
});

export const fileTools: NativeToolHandler[] = [
  filesGetTool,
  filesListTool,
  filesFindTool,
  filesSearchTool,
  filesReadTool,
  filesSummaryTool,
  filesFieldsGetTool,
  filesFieldsSetTool,
  filesLinkToWorkItemTool
];

export const fileToolKeys = fileTools.map((tool) => tool.key);

export const fileApiSchemas = {
  find: z.object({
    filenameContains: z.string().max(200).optional(),
    mimeType: z.string().max(120).optional(),
    status: z.string().max(40).optional(),
    workflowId: z.string().optional(),
    recordId: z.string().optional(),
    workflowItemId: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }),
  link: z.object({
    fileId: z.string(),
    recordId: z.string().optional(),
    workflowItemId: z.string().optional(),
    relationship: z.enum(['attachment', 'reference', 'output', 'evidence']).optional(),
    caption: z.string().max(500).optional()
  })
};
