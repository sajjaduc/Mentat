/**
 * File retrieval: structured listing and content search.
 *
 * ADR-0018 keeps retrieval behind an interface with a portable default. Structured
 * listing compiles the frozen filter AST (see `./filter-compile`); content search
 * uses SQLite FTS5 when the build exposes it and falls back to a `LIKE` scan
 * otherwise. Both implementations satisfy `FileSearchIndex`, so swapping in
 * PostgreSQL FTS or a vector index later does not change any caller.
 */
import { and, asc, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { hasFullTextSearch } from '../db/migrate';
import type { FileRecord } from '../db/schema';
import { files } from '../db/schema';
import type { FilterAst } from '../filters/ast';
import type { FileSummaryView } from './contracts';
import { compileFileFilter } from './filter-compile';
import { fileSummaryView } from './views';

export interface FileListSort {
  key: 'createdAt' | 'updatedAt' | 'filename' | 'size';
  direction: 'asc' | 'desc';
}

export interface FileListQuery {
  filter?: FilterAst | null;
  sort?: FileListSort;
  limit?: number;
  cursor?: string | null;
}

export interface FileListPage {
  items: FileSummaryView[];
  nextCursor: string | null;
}

export interface FileContentSearchInput {
  workspaceId: string;
  query: string;
  workflowId?: string | null;
  limit?: number;
}

export interface FileContentSearchHit {
  fileId: string;
  filename: string;
  snippet: string;
  pageCount: number | null;
}

export interface FileSearchIndex {
  readonly kind: string;
  /** Insert or replace the searchable body for a file. Synchronous: it runs inside a transaction. */
  index(executor: Executor, input: { fileId: string; workspaceId: string; text: string }): void;
  remove(executor: Executor, fileId: string): void;
  search(executor: Executor, input: FileContentSearchInput): FileContentSearchHit[];
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const SORT_COLUMNS = {
  createdAt: files.createdAt,
  updatedAt: files.updatedAt,
  filename: files.originalFilename,
  size: files.size
} as const;

export async function findFiles(
  actor: ActorContext,
  query: FileListQuery = {},
  db?: Executor
): Promise<FileListPage> {
  const executor = requireExecutor(db);
  assertPermission(actor, Permissions.fileRead, 'Not permitted to list files');

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const sort = query.sort ?? { key: 'createdAt', direction: 'desc' };
  const column = SORT_COLUMNS[sort.key];
  const conditions: SQL[] = [eq(files.workspaceId, actor.workspaceId), isNull(files.deletedAt)];

  const compiled = compileFileFilter(executor, actor.workspaceId, query.filter ?? null);
  if (compiled) conditions.push(compiled);

  if (query.cursor) {
    const [rawValue, id] = query.cursor.split('|');
    if (rawValue === undefined || !id) throw errors.validation('Invalid file cursor');
    const value = cursorValue(rawValue, sort.key);
    conditions.push(
      sort.direction === 'desc'
        ? sql`(${column} < ${value} OR (${column} = ${value} AND ${files.id} < ${id}))`
        : sql`(${column} > ${value} OR (${column} = ${value} AND ${files.id} > ${id}))`
    );
  }

  const rows = executor
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(
      sort.direction === 'desc' ? desc(column) : asc(column),
      sort.direction === 'desc' ? desc(files.id) : asc(files.id)
    )
    .limit(limit)
    .all();

  const items = rows.map((row) => fileSummaryView(executor, row));
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit && last ? encodeCursor(last, sort.key) : null;
  return { items, nextCursor };
}

export async function searchFileContent(
  actor: ActorContext,
  input: { query: string; workflowId?: string | null; limit?: number },
  db?: Executor
): Promise<FileContentSearchHit[]> {
  const executor = requireExecutor(db);
  assertPermission(actor, Permissions.fileRead, 'Not permitted to search file content');
  const query = input.query.trim();
  if (query.length === 0) return [];
  return resolveFileSearchIndex(executor).search(executor, {
    workspaceId: actor.workspaceId,
    query,
    workflowId: input.workflowId ?? null,
    limit: Math.min(Math.max(input.limit ?? 25, 1), MAX_LIMIT)
  });
}

/** Update the content index for a file (called whenever extracted content changes). */
export function writeFileContentIndex(
  executor: Executor,
  input: { fileId: string; workspaceId: string; text: string }
): void {
  resolveFileSearchIndex(executor).index(executor, input);
}

/** Remove a file's content index entry (called on delete). */
export function removeFileContentIndex(executor: Executor, fileId: string): void {
  resolveFileSearchIndex(executor).remove(executor, fileId);
}

let installed: FileSearchIndex | null = null;

/** Replace the process-wide search index (used by tests and future backends). */
export function setFileSearchIndex(index: FileSearchIndex | null): void {
  installed = index;
}

export function resolveFileSearchIndex(executor: Executor): FileSearchIndex {
  if (installed) return installed;
  return hasFileContentFts(executor) ? ftsFileSearchIndex : likeFileSearchIndex;
}

/** True when the SQLite build has the optional FTS5 index available. */
export function hasFileContentFts(executor: Executor): boolean {
  const client = (executor as { $client?: unknown }).$client;
  if (client && typeof (client as { query?: unknown }).query === 'function') {
    try {
      return hasFullTextSearch(client as Parameters<typeof hasFullTextSearch>[0]);
    } catch {
      return false;
    }
  }
  try {
    const rows = executor.all<{ name?: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_content_fts' LIMIT 1`
    );
    return Boolean(rows[0]?.name);
  } catch {
    return false;
  }
}

/** FTS5-backed index. One row per file, replaced on every content write. */
export class FtsFileSearchIndex implements FileSearchIndex {
  readonly kind = 'fts';

  index(executor: Executor, input: { fileId: string; workspaceId: string; text: string }): void {
    executor.run(sql`DELETE FROM file_content_fts WHERE file_id = ${input.fileId}`);
    executor.run(
      sql`INSERT INTO file_content_fts (file_id, workspace_id, body) VALUES (${input.fileId}, ${input.workspaceId}, ${input.text})`
    );
  }

  remove(executor: Executor, fileId: string): void {
    executor.run(sql`DELETE FROM file_content_fts WHERE file_id = ${fileId}`);
  }

  search(executor: Executor, input: FileContentSearchInput): FileContentSearchHit[] {
    const match = toFtsMatch(input.query);
    if (!match) return [];
    const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_LIMIT);
    const workflowClause = input.workflowId
      ? sql`AND EXISTS (SELECT 1 FROM workflow_files wf WHERE wf.file_id = f.id AND wf.workflow_id = ${input.workflowId} AND wf.removed_at IS NULL)`
      : sql``;
    return executor.all<FileContentSearchHit>(sql`
      SELECT f.id AS fileId,
             f.original_filename AS filename,
             snippet(file_content_fts, 2, '[', ']', '…', 12) AS snippet,
             fec.page_count AS pageCount
      FROM file_content_fts
      JOIN files f ON f.id = file_content_fts.file_id
      JOIN file_extracted_content fec ON fec.id = (
        SELECT x.id FROM file_extracted_content x
        WHERE x.file_id = f.id ORDER BY x.created_at DESC LIMIT 1
      )
      WHERE file_content_fts.workspace_id = ${input.workspaceId}
        AND f.workspace_id = ${input.workspaceId}
        AND f.deleted_at IS NULL
        AND file_content_fts MATCH ${match}
        ${workflowClause}
      ORDER BY rank
      LIMIT ${limit}
    `);
  }
}

/**
 * Portable `LIKE` fallback. It reads extracted content directly, so it needs no
 * index maintenance and stays correct even if the FTS table is unavailable.
 */
export class LikeFileSearchIndex implements FileSearchIndex {
  readonly kind = 'like';

  index(): void {
    // No index to maintain; search reads `file_extracted_content` directly.
  }

  remove(): void {
    // See above.
  }

  search(executor: Executor, input: FileContentSearchInput): FileContentSearchHit[] {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_LIMIT);
    const pattern = `%${escapeLike(input.query.toLowerCase())}%`;
    const workflowClause = input.workflowId
      ? sql`AND EXISTS (SELECT 1 FROM workflow_files wf WHERE wf.file_id = f.id AND wf.workflow_id = ${input.workflowId} AND wf.removed_at IS NULL)`
      : sql``;
    const rows = executor.all<{
      fileId: string;
      filename: string;
      body: string;
      pageCount: number | null;
    }>(sql`
      SELECT f.id AS fileId,
             f.original_filename AS filename,
             fec.text AS body,
             fec.page_count AS pageCount
      FROM file_extracted_content fec
      JOIN files f ON f.id = fec.file_id
      WHERE f.workspace_id = ${input.workspaceId}
        AND f.deleted_at IS NULL
        AND fec.id = (
          SELECT x.id FROM file_extracted_content x
          WHERE x.file_id = f.id ORDER BY x.created_at DESC LIMIT 1
        )
        AND lower(fec.text) LIKE ${pattern} ESCAPE '\\'
        ${workflowClause}
      ORDER BY f.created_at DESC
      LIMIT ${limit}
    `);
    return rows.map((row) => ({
      fileId: row.fileId,
      filename: row.filename,
      snippet: buildSnippet(row.body, input.query),
      pageCount: row.pageCount
    }));
  }
}

export const ftsFileSearchIndex = new FtsFileSearchIndex();
export const likeFileSearchIndex = new LikeFileSearchIndex();

function requireExecutor(db?: Executor): Executor {
  if (!db) throw errors.internal('File retrieval requires a database executor');
  return db;
}

function encodeCursor(row: FileRecord, key: FileListSort['key']): string {
  const value = key === 'filename' ? row.originalFilename : row[key];
  return `${String(value)}|${row.id}`;
}

function cursorValue(raw: string, key: FileListSort['key']): string | number {
  if (key === 'size') return Number(raw);
  if (key === 'createdAt' || key === 'updatedAt') return Number(raw);
  return raw;
}

/** FTS5 match expression: quoted prefix tokens, never raw user syntax. */
function toFtsMatch(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu);
  if (!tokens || tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' ');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function buildSnippet(body: string, query: string): string {
  const index = body.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return body.slice(0, 240);
  const start = Math.max(0, index - 80);
  const end = Math.min(body.length, index + query.length + 160);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${body.slice(start, end)}${suffix}`;
}
