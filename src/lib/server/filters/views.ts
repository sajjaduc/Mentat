/**
 * Saved views.
 *
 * A saved view is a *named, permissioned reference to a filter AST* — not a
 * second query language. Storing the AST (rather than a rendered SQL string)
 * means a view can be re-applied to a ticket list and reused verbatim by a
 * dashboard widget, and that the same validation runs in both places.
 *
 * Privacy is two-dimensional and intentionally simple: a view is either shared
 * with the workspace or private to `createdByUserId`. Private views are hidden
 * from everyone else, and a hidden view is reported as `not_found` rather than
 * `forbidden` so probing cannot confirm that a colleague's view exists
 * (workspace-isolation convention). Mutating a *shared* view additionally
 * requires being its creator or a workspace admin.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditActions, writeAudit } from '../audit/ledger';
import {
  type ActorContext,
  assertAnyPermission,
  assertPermission,
  Permissions
} from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import { type SavedView, type SavedViewScope, type SavedViewSort, savedViews } from '../db/schema';
import { type FilterAst, parseFilterAst } from './ast';

const sortSchema = z.array(
  z.object({
    field: z.string().min(1),
    direction: z.enum(['asc', 'desc'])
  })
);

const draftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  scope: z.enum(['tickets', 'files']).optional(),
  workflowId: z.string().nullable().optional(),
  filter: z.unknown().optional(),
  sort: sortSchema.nullable().optional(),
  columns: z.array(z.string()).nullable().optional(),
  isShared: z.boolean().optional(),
  isPinned: z.boolean().optional()
});

const patchSchema = draftSchema.partial();

export interface SavedViewDraft {
  name: string;
  description?: string | null;
  scope?: SavedViewScope;
  workflowId?: string | null;
  filter?: unknown;
  sort?: SavedViewSort[] | null;
  columns?: string[] | null;
  isShared?: boolean;
  isPinned?: boolean;
}

export type SavedViewPatch = Partial<SavedViewDraft>;

/** A view plus its parsed AST, which is what list and widget callers consume. */
export interface SavedViewDetail extends SavedView {
  filter: FilterAst | null;
}

export interface SavedViewListOptions {
  scope?: SavedViewScope;
  pinnedOnly?: boolean;
}

export interface AppliedSavedView {
  id: string;
  name: string;
  scope: SavedViewScope;
  workflowId: string | null;
  filter: FilterAst | null;
  sort: SavedViewSort[];
  columns: string[];
}

function permissionForScope(scope: SavedViewScope): string {
  return scope === 'files' ? Permissions.fileRead : Permissions.ticketRead;
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.validation(message, { issues: result.error.issues });
  }
  return result.data;
}

/** Validate an untrusted filter payload, converting Zod failures to a 422. */
function parseFilter(input: unknown): FilterAst | null {
  try {
    return parseFilterAst(input);
  } catch (cause) {
    throw errors.validation('Invalid filter', { cause: String(cause) });
  }
}

/** Read path: a stored AST should already be valid; never fail a list over it. */
function safeParseFilter(input: unknown): FilterAst | null {
  try {
    return parseFilterAst(input);
  } catch {
    return null;
  }
}

function toDetail(view: SavedView): SavedViewDetail {
  return { ...view, filter: safeParseFilter(view.filterAst) };
}

function assertVisible(view: SavedView, actor: ActorContext): void {
  if (view.isShared) return;
  if (view.createdByUserId !== null && view.createdByUserId === actor.actorId) return;
  throw errors.notFound('Saved view', view.id);
}

function assertCanMutate(view: SavedView, actor: ActorContext): void {
  if (view.createdByUserId !== null && view.createdByUserId === actor.actorId) return;
  if (actor.permissions.has(Permissions.workspaceAdmin)) return;
  throw errors.forbidden('Only the creator or a workspace admin may change this view', {
    viewId: view.id
  });
}

async function loadView(db: Executor, actor: ActorContext, viewId: string): Promise<SavedView> {
  const rows = await db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.workspaceId, actor.workspaceId), eq(savedViews.id, viewId)))
    .all();
  const view = rows[0];
  if (!view) throw errors.notFound('Saved view', viewId);
  return view;
}

async function assertNameAvailable(
  db: Executor,
  actor: ActorContext,
  scope: SavedViewScope,
  name: string,
  excludeId?: string
): Promise<void> {
  const rows = await db
    .select({ id: savedViews.id })
    .from(savedViews)
    .where(
      and(
        eq(savedViews.workspaceId, actor.workspaceId),
        eq(savedViews.scope, scope),
        eq(savedViews.name, name)
      )
    )
    .all();
  if (rows.some((row) => row.id !== excludeId)) {
    throw errors.conflict(`A ${scope} view named "${name}" already exists`, { name, scope });
  }
}

export async function createSavedView(
  db: Executor,
  actor: ActorContext,
  draft: SavedViewDraft
): Promise<SavedView> {
  const parsed = parseOrThrow(draftSchema, draft, 'Invalid saved view');
  const scope = parsed.scope ?? 'tickets';
  assertPermission(actor, permissionForScope(scope));
  const filter = parseFilter(parsed.filter);
  await assertNameAvailable(db, actor, scope, parsed.name);

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const inserted = tx
      .insert(savedViews)
      .values({
        id: uuidv7(now),
        workspaceId: actor.workspaceId,
        name: parsed.name,
        description: parsed.description ?? null,
        scope,
        workflowId: parsed.workflowId ?? null,
        filterAst: (filter ?? null) as never,
        sort: (parsed.sort ?? null) as never,
        columns: (parsed.columns ?? null) as never,
        isShared: parsed.isShared ?? true,
        isPinned: parsed.isPinned ?? false,
        createdByUserId: actor.actorId,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .all();
    const view = inserted[0];
    if (!view) throw errors.internal('Failed to create saved view');
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.savedViewCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'saved_view',
      entityId: view.id,
      summary: `Saved view "${view.name}" created`,
      data: { scope, shared: view.isShared }
    });
    return view;
  });
}

export async function updateSavedView(
  db: Executor,
  actor: ActorContext,
  viewId: string,
  patch: SavedViewPatch
): Promise<SavedView> {
  const current = await loadView(db, actor, viewId);
  assertVisible(current, actor);
  assertPermission(actor, permissionForScope(current.scope));
  assertCanMutate(current, actor);

  const parsed = parseOrThrow(patchSchema, patch, 'Invalid saved view');
  const scope = parsed.scope ?? current.scope;
  const name = parsed.name ?? current.name;
  if (name !== current.name || scope !== current.scope) {
    await assertNameAvailable(db, actor, scope, name, current.id);
  }
  const filter = parsed.filter === undefined ? undefined : parseFilter(parsed.filter);
  const now = Date.now();

  return withTransaction(db, (tx) => {
    const updated = tx
      .update(savedViews)
      .set({
        name,
        scope,
        description: parsed.description === undefined ? current.description : parsed.description,
        workflowId: parsed.workflowId === undefined ? current.workflowId : parsed.workflowId,
        filterAst: (filter === undefined ? current.filterAst : filter) as never,
        sort: (parsed.sort === undefined ? current.sort : parsed.sort) as never,
        columns: (parsed.columns === undefined ? current.columns : parsed.columns) as never,
        isShared: parsed.isShared ?? current.isShared,
        isPinned: parsed.isPinned ?? current.isPinned,
        updatedAt: now
      })
      .where(and(eq(savedViews.workspaceId, actor.workspaceId), eq(savedViews.id, viewId)))
      .returning()
      .all();
    const view = updated[0];
    if (!view) throw errors.notFound('Saved view', viewId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'saved_view.updated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'saved_view',
      entityId: view.id,
      summary: `Saved view "${view.name}" updated`
    });
    return view;
  });
}

export async function deleteSavedView(
  db: Executor,
  actor: ActorContext,
  viewId: string
): Promise<void> {
  const current = await loadView(db, actor, viewId);
  assertVisible(current, actor);
  assertPermission(actor, permissionForScope(current.scope));
  assertCanMutate(current, actor);

  await withTransaction(db, (tx) => {
    tx.delete(savedViews)
      .where(and(eq(savedViews.workspaceId, actor.workspaceId), eq(savedViews.id, viewId)))
      .run();
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: 'saved_view.deleted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'saved_view',
      entityId: viewId,
      summary: `Saved view "${current.name}" deleted`
    });
  });
}

export async function getSavedView(
  db: Executor,
  actor: ActorContext,
  viewId: string
): Promise<SavedViewDetail> {
  const view = await loadView(db, actor, viewId);
  assertVisible(view, actor);
  assertPermission(actor, permissionForScope(view.scope));
  return toDetail(view);
}

/**
 * Views visible to the actor: shared ones plus the actor's own private ones,
 * pinned first so the list endpoint can render a stable quick bar.
 */
export async function listSavedViews(
  db: Executor,
  actor: ActorContext,
  options: SavedViewListOptions = {}
): Promise<SavedViewDetail[]> {
  assertAnyPermission(actor, [Permissions.ticketRead, Permissions.fileRead]);
  const visibility = actor.actorId
    ? sql`(${savedViews.isShared} = 1 OR ${savedViews.createdByUserId} = ${actor.actorId})`
    : sql`${savedViews.isShared} = 1`;
  const conditions = [eq(savedViews.workspaceId, actor.workspaceId), visibility];
  if (options.scope) conditions.push(eq(savedViews.scope, options.scope));
  if (options.pinnedOnly) conditions.push(eq(savedViews.isPinned, true));
  const rows = await db
    .select()
    .from(savedViews)
    .where(and(...conditions))
    .orderBy(desc(savedViews.isPinned), savedViews.name)
    .all();
  return rows.map(toDetail);
}

/**
 * Resolve a view into the filter/sort/columns a list endpoint should apply.
 * The filter is parsed (and therefore validated) here, so a list can pass it
 * straight to `compileTicketFilter` or to a widget.
 */
export async function applySavedView(
  db: Executor,
  actor: ActorContext,
  viewId: string
): Promise<AppliedSavedView> {
  const view = await loadView(db, actor, viewId);
  assertVisible(view, actor);
  assertPermission(actor, permissionForScope(view.scope));
  return {
    id: view.id,
    name: view.name,
    scope: view.scope,
    workflowId: view.workflowId,
    filter: safeParseFilter(view.filterAst),
    sort: view.sort ?? [],
    columns: view.columns ?? []
  };
}
