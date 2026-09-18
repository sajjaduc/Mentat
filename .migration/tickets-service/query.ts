/**
 * Ticket querying: filters, sorting and pagination for boards and lists.
 *
 * The filter AST from `$server/filters/ast.ts` is the single filtering language in
 * Mentat (ADR-0012). This module compiles it for tickets using a self-contained
 * implementation, and exposes an injectable seam so a richer compiler (for example
 * the analytics workstream's) can replace it at bootstrap without touching any
 * caller. The seam matters because the board must never depend on a module that
 * may not be deployed.
 *
 * Everything here is workspace-scoped and fully parameterized: no user input is
 * ever interpolated into SQL.
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql
} from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import {
  agentRuns,
  approvalRequests,
  fieldDefinitions,
  files,
  labels,
  type Ticket,
  ticketFieldValues,
  ticketFiles,
  ticketLabels,
  tickets,
  users as usersTable,
  workflowStates
} from '../db/schema';
import { type FilterAst, type FilterCondition, filterAstSchema, isGroup } from '../filters/ast';

export interface CompiledFilter {
  sql: SQL | undefined;
  /** Field keys that could not be resolved; the UI explains rather than 500s. */
  unresolved: string[];
}

export interface TicketFilterCompiler {
  /**
   * Compile a filter AST into a Drizzle condition. May be asynchronous: the
   * canonical implementation resolves field definitions before building conditions.
   */
  compile(
    db: Executor,
    options: { workspaceId: string; filter: FilterAst | null }
  ): CompiledFilter | Promise<CompiledFilter>;
}

export interface TicketSort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface ListTicketsOptions {
  workspaceId: string;
  workflowId?: string | null;
  filter?: FilterAst | null;
  sort?: TicketSort[];
  limit?: number;
  cursor?: string | null;
  /** Include archived/closed tickets; closed tickets remain visible by default. */
  stateIds?: string[];
  search?: string | null;
}

export interface TicketListRow {
  ticket: Ticket;
  stateName: string;
  stateKind: string;
  stateCategory: string;
  ownerName: string | null;
  labels: Array<{ id: string; name: string; color: string | null }>;
  fields: Record<string, unknown>;
}

export interface TicketPage {
  rows: TicketListRow[];
  nextCursor: string | null;
  total: number;
}

const SYSTEM_COLUMNS: Record<string, SQL> = {
  title: sql`${tickets.title}`,
  description: sql`coalesce(${tickets.description}, '')`,
  priority: sql`${tickets.priority}`,
  stateId: sql`${tickets.stateId}`,
  workflowId: sql`${tickets.workflowId}`,
  ownerUserId: sql`coalesce(${tickets.ownerUserId}, '')`,
  ownerTeamId: sql`coalesce(${tickets.ownerTeamId}, '')`,
  key: sql`${tickets.key}`,
  createdAt: sql`${tickets.createdAt}`,
  updatedAt: sql`${tickets.updatedAt}`,
  enteredStateAt: sql`${tickets.enteredStateAt}`,
  lastActivityAt: sql`${tickets.lastActivityAt}`,
  dueAt: sql`${tickets.dueAt}`,
  closedAt: sql`${tickets.closedAt}`,
  waitingOn: sql`coalesce(${tickets.waitingOn}, '')`,
  originTicketId: sql`coalesce(${tickets.originTicketId}, '')`,
  stateRunCount: sql`${tickets.stateRunCount}`,
  sourceType: sql`coalesce(json_extract(${tickets.provenance}, '$.sourceType'), '')`
};

const NUMERIC_SYSTEM_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'enteredStateAt',
  'lastActivityAt',
  'dueAt',
  'closedAt'
]);

const PRIORITY_RANK_SQL = sql`case ${tickets.priority}
  when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`;

/** The default compiler; replaceable through {@link setTicketFilterCompiler}. */
export const defaultTicketFilterCompiler: TicketFilterCompiler = {
  compile(db, options) {
    const unresolved: string[] = [];
    if (!options.filter) return { sql: undefined, unresolved };
    const condition = compileNode(db, options.workspaceId, options.filter, unresolved);
    return { sql: condition, unresolved };
  }
};

let activeCompiler: TicketFilterCompiler = defaultTicketFilterCompiler;

export function setTicketFilterCompiler(compiler: TicketFilterCompiler | null): void {
  activeCompiler = compiler ?? defaultTicketFilterCompiler;
}

export function getTicketFilterCompiler(): TicketFilterCompiler {
  return activeCompiler;
}

function compileNode(
  db: Executor,
  workspaceId: string,
  node: FilterAst,
  unresolved: string[]
): SQL | undefined {
  if (isGroup(node)) {
    const children = node.children
      .map((child) => compileNode(db, workspaceId, child, unresolved))
      .filter((child): child is SQL => child !== undefined);
    if (children.length === 0) return undefined;
    if (children.length === 1) return children[0];
    return node.op === 'and' ? and(...children) : or(...children);
  }
  return compileCondition(db, workspaceId, node, unresolved);
}

function compileCondition(
  db: Executor,
  workspaceId: string,
  condition: FilterCondition,
  unresolved: string[]
): SQL | undefined {
  switch (condition.kind) {
    case 'system':
      return compileSystemCondition(condition, unresolved);
    case 'state':
      return compileStateCondition(db, workspaceId, condition, unresolved);
    case 'label':
      return compileLabelCondition(db, workspaceId, condition, unresolved);
    case 'workflow':
      return compare(sql`${tickets.workflowId}`, condition, 'text');
    case 'owner': {
      const owner = sql`coalesce(${tickets.ownerUserId}, '')`;
      return compileOwnerCondition(owner, condition);
    }
    case 'team': {
      const team = sql`coalesce(${tickets.ownerTeamId}, '')`;
      return compare(team, condition, 'text');
    }
    case 'field':
    case 'file_field':
      return compileFieldCondition(db, workspaceId, condition, unresolved);
    case 'run':
      return compileRunCondition(condition, workspaceId);
    case 'approval':
      return compileApprovalCondition(condition, workspaceId);
    case 'file':
      return compileFileCondition(db, workspaceId, condition, unresolved);
    case 'collection':
      unresolved.push(condition.key);
      return sql`0 = 1`;
    default:
      unresolved.push(condition.key);
      return undefined;
  }
}

function compileSystemCondition(condition: FilterCondition, unresolved: string[]): SQL | undefined {
  const { key, operator } = condition;

  if (key === 'isUnassigned') {
    const wantUnassigned = operator === 'is_true';
    const clause = and(isNull(tickets.ownerUserId), isNull(tickets.ownerTeamId));
    return wantUnassigned ? clause : sql`not (${clause})`;
  }
  if (key === 'timeInStateSeconds') {
    const seconds = sql`(cast(strftime('%s','now') as integer) - cast(${tickets.enteredStateAt} / 1000 as integer))`;
    return compare(seconds, condition, 'number');
  }
  if (key === 'stateName' || key === 'stateKind' || key === 'stateCategory') {
    // Handled by `state` kind, but tolerate the system alias for convenience.
    const column =
      key === 'stateName'
        ? sql`${workflowStates.name}`
        : key === 'stateKind'
          ? sql`${workflowStates.kind}`
          : sql`${workflowStates.category}`;
    return and(
      exists(
        sql`(select 1 from ${workflowStates} where ${workflowStates.id} = ${tickets.stateId})`
      ),
      compare(column, condition, 'text')
    );
  }
  if (key === 'runStatus') {
    return compileRunCondition({ ...condition, key: 'status' }, 'system');
  }
  if (key === 'approvalStatus') {
    return compileApprovalCondition({ ...condition, key: 'status' }, 'system');
  }

  const column = SYSTEM_COLUMNS[key];
  if (!column) {
    unresolved.push(key);
    return undefined;
  }
  return compare(column, condition, NUMERIC_SYSTEM_FIELDS.has(key) ? 'number' : 'text');
}

function compileStateCondition(
  db: Executor,
  workspaceId: string,
  condition: FilterCondition,
  unresolved: string[]
): SQL | undefined {
  const key = condition.key;
  const supported = new Set([
    'stateId',
    'id',
    'name',
    'stateName',
    'kind',
    'stateKind',
    'category',
    'stateCategory'
  ]);
  if (!supported.has(key)) {
    unresolved.push(key);
    return undefined;
  }

  // Resolve the matching states first, then constrain the ticket's own state column:
  // that keeps the outer query index-friendly on `tickets(state_id)` rather than
  // joining `workflow_states` for every row.
  const matching = db
    .select({
      id: workflowStates.id,
      name: workflowStates.name,
      kind: workflowStates.kind,
      category: workflowStates.category
    })
    .from(workflowStates)
    .where(eq(workflowStates.workspaceId, workspaceId))
    .all()
    .filter((state) => matchesValue(condition, stateValue(state, key)))
    .map((state) => state.id);

  if (matching.length === 0) return sql`0 = 1`;
  return inArray(tickets.stateId, matching);
}

function stateValue(
  state: { id: string; name: string; kind: string; category: string },
  key: string
): string {
  if (key === 'kind' || key === 'stateKind') return state.kind;
  if (key === 'category' || key === 'stateCategory') return state.category;
  if (key === 'name' || key === 'stateName') return state.name;
  return state.id;
}

function compileLabelCondition(
  db: Executor,
  workspaceId: string,
  condition: FilterCondition,
  unresolved: string[]
): SQL | undefined {
  const allLabels = db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(eq(labels.workspaceId, workspaceId))
    .all();

  const resolveId = (value: unknown): string | null => {
    const text = String(value);
    const byId = allLabels.find((label) => label.id === text);
    if (byId) return byId.id;
    const byName = allLabels.find((label) => label.name.toLowerCase() === text.toLowerCase());
    return byName?.id ?? null;
  };

  if (
    condition.key !== 'label' &&
    condition.key !== 'labels' &&
    condition.key !== 'id' &&
    condition.key !== 'name'
  ) {
    unresolved.push(condition.key);
  }

  const isEmpty = condition.operator === 'is_empty';
  const isNotEmpty = condition.operator === 'is_not_empty';
  const hasLabels = exists(
    sql`(select 1 from ${ticketLabels} where ${ticketLabels.ticketId} = ${tickets.id})`
  );
  if (isEmpty) return sql`not (${hasLabels})`;
  if (isNotEmpty) return hasLabels;

  const raw = Array.isArray(condition.value) ? condition.value : [condition.value];
  const ids = raw.map(resolveId).filter((id): id is string => id !== null);
  if (ids.length === 0) return sql`0 = 1`;

  const clause = exists(
    sql`(select 1 from ${ticketLabels} where ${ticketLabels.ticketId} = ${tickets.id} and ${ticketLabels.labelId} in ${ids})`
  );
  return condition.operator === 'not_in' || condition.operator === 'neq'
    ? sql`not (${clause})`
    : clause;
}

function compileOwnerCondition(column: SQL, condition: FilterCondition): SQL | undefined {
  if (condition.operator === 'is_empty') {
    return and(isNull(tickets.ownerUserId), isNull(tickets.ownerTeamId));
  }
  if (condition.operator === 'is_not_empty') {
    return or(sql`${tickets.ownerUserId} is not null`, sql`${tickets.ownerTeamId} is not null`);
  }
  return compare(column, condition, 'text');
}

function compileRunCondition(condition: FilterCondition, workspaceId: string): SQL | undefined {
  const status = condition.value === undefined ? null : String(condition.value);
  const subquery = sql`(select ${agentRuns.status} from ${agentRuns} where ${agentRuns.ticketId} = ${tickets.id} and ${agentRuns.workspaceId} = ${workspaceId} order by ${agentRuns.createdAt} desc limit 1)`;

  if (condition.operator === 'is_empty') return sql`${subquery} is null`;
  if (condition.operator === 'is_not_empty') return sql`${subquery} is not null`;

  const values = Array.isArray(condition.value)
    ? condition.value.map(String)
    : [String(condition.value)];
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    const clause = inArray(subquery, values);
    return condition.operator === 'not_in' ? sql`not (${clause})` : clause;
  }
  if (status === null) return undefined;
  const clause = eq(subquery, status);
  return condition.operator === 'neq' ? sql`not (${clause})` : clause;
}

function compileApprovalCondition(
  condition: FilterCondition,
  workspaceId: string
): SQL | undefined {
  const subquery = sql`(select ${approvalRequests.status} from ${approvalRequests} where ${approvalRequests.ticketId} = ${tickets.id} and ${approvalRequests.workspaceId} = ${workspaceId} order by ${approvalRequests.createdAt} desc limit 1)`;
  if (condition.operator === 'is_empty') return sql`${subquery} is null`;
  if (condition.operator === 'is_not_empty') return sql`${subquery} is not null`;

  const values = Array.isArray(condition.value)
    ? condition.value.map(String)
    : [String(condition.value)];
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    const clause = inArray(subquery, values);
    return condition.operator === 'not_in' ? sql`not (${clause})` : clause;
  }
  const clause = eq(subquery, String(condition.value));
  return condition.operator === 'neq' ? sql`not (${clause})` : clause;
}

function compileFieldCondition(
  db: Executor,
  workspaceId: string,
  condition: FilterCondition,
  unresolved: string[]
): SQL | undefined {
  const scope = condition.kind === 'file_field' ? 'file' : 'ticket';
  const rows = db
    .select()
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, scope),
        eq(fieldDefinitions.key, condition.key)
      )
    )
    .limit(1)
    .all();
  const definition = rows[0];
  if (!definition) {
    // Allow addressing by id as well as by key.
    const byId = db
      .select()
      .from(fieldDefinitions)
      .where(
        and(eq(fieldDefinitions.workspaceId, workspaceId), eq(fieldDefinitions.id, condition.key))
      )
      .limit(1)
      .all();
    if (!byId[0]) {
      unresolved.push(condition.key);
      return undefined;
    }
    return buildFieldValueCondition(byId[0].id, byId[0].type, condition);
  }
  return buildFieldValueCondition(definition.id, definition.type, condition);
}

function buildFieldValueCondition(
  fieldDefinitionId: string,
  type: string,
  condition: FilterCondition
): SQL | undefined {
  const numeric = type === 'number' || type === 'currency';
  const date = type === 'date' || type === 'datetime';
  const boolean = type === 'boolean';
  const multi = type === 'multi_select';

  const column = numeric
    ? sql`${ticketFieldValues.valueNumber}`
    : date
      ? sql`${ticketFieldValues.valueDate}`
      : boolean
        ? sql`${ticketFieldValues.valueText}`
        : multi
          ? sql`${ticketFieldValues.searchText}`
          : sql`${ticketFieldValues.valueText}`;

  const base: SQL =
    and(
      eq(ticketFieldValues.ticketId, tickets.id),
      eq(ticketFieldValues.fieldDefinitionId, fieldDefinitionId)
    ) ?? sql`1 = 0`;

  if (condition.operator === 'is_empty') {
    return sql`not exists (select 1 from ${ticketFieldValues} where ${base})`;
  }
  if (condition.operator === 'is_not_empty') {
    return exists(sql`(select 1 from ${ticketFieldValues} where ${base})`);
  }

  const clause = compareInSubquery(
    base,
    column,
    condition,
    numeric ? 'number' : date ? 'number' : 'text'
  );
  if (!clause) return undefined;
  return clause;
}

function compileFileCondition(
  db: Executor,
  workspaceId: string,
  condition: FilterCondition,
  unresolved: string[]
): SQL | undefined {
  const base: SQL =
    and(
      eq(ticketFiles.ticketId, tickets.id),
      eq(ticketFiles.workspaceId, workspaceId),
      isNull(ticketFiles.removedAt)
    ) ?? sql`1 = 0`;

  if (condition.key === 'file' || condition.key === 'files' || condition.key === 'id') {
    if (condition.operator === 'is_empty') {
      return sql`not exists (select 1 from ${ticketFiles} where ${base})`;
    }
    if (condition.operator === 'is_not_empty') {
      return exists(sql`(select 1 from ${ticketFiles} where ${base})`);
    }
    const values = Array.isArray(condition.value)
      ? condition.value.map(String)
      : [String(condition.value)];
    const clause = exists(
      sql`(select 1 from ${ticketFiles} where ${base} and ${ticketFiles.fileId} in ${values})`
    );
    return condition.operator === 'not_in' ? sql`not (${clause})` : clause;
  }

  const columnByKey: Record<string, SQL> = {
    filename: sql`${files.originalFilename}`,
    mimeType: sql`${files.mimeType}`,
    status: sql`${files.status}`,
    summary: sql`coalesce(${files.summary}, '')`,
    contentHash: sql`${files.blobId}`,
    size: sql`${files.size}`
  };

  if (
    condition.kind === 'file_field' ||
    (condition.kind === 'file' && !columnByKey[condition.key])
  ) {
    return compileFieldCondition(db, workspaceId, { ...condition, kind: 'file_field' }, unresolved);
  }

  const column = columnByKey[condition.key];
  if (!column) {
    unresolved.push(condition.key);
    return undefined;
  }
  const subSelect = sql`(select ${column} from ${ticketFiles} inner join ${files} on ${files.id} = ${ticketFiles.fileId} where ${base} limit 1)`;
  if (condition.operator === 'is_empty') return sql`${subSelect} is null`;
  if (condition.operator === 'is_not_empty') return sql`${subSelect} is not null`;
  const clause = compare(subSelect, condition, condition.key === 'size' ? 'number' : 'text');
  return clause;
}

type ValueKind = 'text' | 'number';

/** Compare a scalar expression against a filter condition. */
function compare(column: SQL, condition: FilterCondition, kind: ValueKind): SQL | undefined {
  const { operator } = condition;
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  const coerce = (value: unknown): string | number =>
    kind === 'number' ? Number(value) : String(value);

  switch (operator) {
    case 'eq':
      return eq(column, coerce(condition.value) as never);
    case 'neq':
      return ne(column, coerce(condition.value) as never);
    case 'in':
      return inArray(column, values.map((value) => coerce(value)) as never[]);
    case 'not_in':
      return sql`not (${inArray(column, values.map((value) => coerce(value)) as never[])})`;
    case 'contains':
      return sql`${column} like ${`%${escapeLike(String(condition.value))}%`} escape '\\'`;
    case 'not_contains':
      return sql`${column} not like ${`%${escapeLike(String(condition.value))}%`} escape '\\'`;
    case 'starts_with':
      return sql`${column} like ${`${escapeLike(String(condition.value))}%`} escape '\\'`;
    case 'ends_with':
      return sql`${column} like ${`%${escapeLike(String(condition.value))}`} escape '\\'`;
    case 'gt':
      return gt(column, coerce(condition.value) as never);
    case 'gte':
      return sql`${column} >= ${coerce(condition.value)}`;
    case 'lt':
      return lt(column, coerce(condition.value) as never);
    case 'lte':
      return lte(column, coerce(condition.value) as never);
    case 'before':
      return lt(column, coerce(condition.value) as never);
    case 'after':
      return gt(column, coerce(condition.value) as never);
    case 'between': {
      const [from, to] = Array.isArray(condition.value) ? condition.value : [];
      if (from === undefined || to === undefined) return undefined;
      return and(sql`${column} >= ${coerce(from)}`, sql`${column} <= ${coerce(to)}`);
    }
    case 'is_true':
      return eq(column, 1 as never);
    case 'is_false':
      return eq(column, 0 as never);
    case 'within_last_days':
    case 'not_within_last_days': {
      const days = Number(condition.value);
      if (!Number.isFinite(days)) return undefined;
      const cutoff = Date.now() - days * 86_400_000;
      const clause = sql`${column} >= ${cutoff}`;
      return operator === 'not_within_last_days' ? sql`not (${clause})` : clause;
    }
    default:
      return undefined;
  }
}

/** Same as {@link compare} but expressed as an EXISTS over a correlated subquery. */
function compareInSubquery(
  base: SQL,
  column: SQL,
  condition: FilterCondition,
  kind: ValueKind
): SQL | undefined {
  const inner = compare(column, condition, kind);
  if (!inner) return undefined;
  if (
    condition.operator === 'not_contains' ||
    condition.operator === 'neq' ||
    condition.operator === 'not_in'
  ) {
    // Negation about a value that may not exist is true when the row is absent, so
    // express it as "there is a value and it does not match".
    return exists(sql`(select 1 from ${ticketFieldValues} where ${base} and ${inner})`);
  }
  return exists(sql`(select 1 from ${ticketFieldValues} where ${base} and ${inner})`);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function matchesValue(condition: FilterCondition, actual: string): boolean {
  const expected = condition.value;
  switch (condition.operator) {
    case 'eq':
      return actual === String(expected);
    case 'neq':
      return actual !== String(expected);
    case 'in':
      return (Array.isArray(expected) ? expected : [expected]).map(String).includes(actual);
    case 'not_in':
      return !(Array.isArray(expected) ? expected : [expected]).map(String).includes(actual);
    case 'contains':
      return actual.toLowerCase().includes(String(expected).toLowerCase());
    case 'starts_with':
      return actual.toLowerCase().startsWith(String(expected).toLowerCase());
    case 'ends_with':
      return actual.toLowerCase().endsWith(String(expected).toLowerCase());
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Sorting and pagination
// ---------------------------------------------------------------------------

function sortExpression(db: Executor, workspaceId: string, sort: TicketSort): SQL {
  const field = sort.field;
  const direction = sort.direction === 'asc' ? asc : desc;

  if (field === 'priority') {
    return (sort.direction === 'asc' ? asc(PRIORITY_RANK_SQL) : desc(PRIORITY_RANK_SQL)) as SQL;
  }
  if (field === 'state') {
    return direction(sql`${tickets.stateId}`) as SQL;
  }
  const column = SYSTEM_COLUMNS[field];
  if (column) return direction(column) as SQL;

  // Custom field sort: correlated subquery on the typed value column.
  const definitions = db
    .select({ id: fieldDefinitions.id, type: fieldDefinitions.type })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.workspaceId, workspaceId),
        eq(fieldDefinitions.scope, 'ticket'),
        eq(fieldDefinitions.key, field)
      )
    )
    .limit(1)
    .all();
  const definition = definitions[0];
  if (!definition) return desc(sql`${tickets.updatedAt}`) as SQL;

  const numeric = definition.type === 'number' || definition.type === 'currency';
  const columnName = numeric ? ticketFieldValues.valueNumber : ticketFieldValues.valueText;
  const subquery = sql`(select ${columnName} from ${ticketFieldValues} where ${ticketFieldValues.ticketId} = ${tickets.id} and ${ticketFieldValues.fieldDefinitionId} = ${definition.id} limit 1)`;
  return direction(subquery) as SQL;
}

function encodeCursor(ticket: Ticket): string {
  return `${ticket.updatedAt}:${ticket.id}`;
}

function decodeCursor(cursor: string | null | undefined): { updatedAt: number; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.indexOf(':');
  if (separator < 0) return null;
  const updatedAt = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(updatedAt) || id.length === 0) return null;
  return { updatedAt, id };
}

/**
 * List tickets with filter, sort and keyset pagination.
 *
 * Keyset pagination is used instead of OFFSET so the board and list stay stable
 * while agents are actively mutating tickets.
 */
export async function listTickets(db: Executor, options: ListTicketsOptions): Promise<TicketPage> {
  const conditions: SQL[] = [eq(tickets.workspaceId, options.workspaceId)];
  if (options.workflowId) conditions.push(eq(tickets.workflowId, options.workflowId));
  if (options.stateIds && options.stateIds.length > 0) {
    conditions.push(inArray(tickets.stateId, options.stateIds));
  }

  const compiled = await activeCompiler.compile(db, {
    workspaceId: options.workspaceId,
    filter: options.filter ?? null
  });
  if (compiled.sql) conditions.push(compiled.sql);

  if (options.search && options.search.trim().length > 0) {
    const term = `%${escapeLike(options.search.trim().toLowerCase())}%`;
    conditions.push(
      or(
        sql`lower(${tickets.title}) like ${term} escape '\\'`,
        sql`lower(coalesce(${tickets.description}, '')) like ${term} escape '\\'`,
        sql`lower(${tickets.key}) like ${term} escape '\\'`
      ) as SQL
    );
  }

  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    conditions.push(
      or(
        lt(tickets.updatedAt, cursor.updatedAt),
        and(eq(tickets.updatedAt, cursor.updatedAt), lt(tickets.id, cursor.id))
      ) as SQL
    );
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const sorts =
    options.sort && options.sort.length > 0
      ? options.sort
      : [{ field: 'updatedAt', direction: 'desc' as const }];

  // Always finish with a deterministic tiebreaker so pagination cannot skip rows.
  const orderBy: SQL[] = sorts.map((sort) => sortExpression(db, options.workspaceId, sort));
  orderBy.push(desc(sql`${tickets.updatedAt}`) as SQL, desc(sql`${tickets.id}`) as SQL);

  const total = await countTickets(db, {
    workspaceId: options.workspaceId,
    workflowId: options.workflowId,
    filter: options.filter ?? null,
    search: options.search ?? null,
    stateIds: options.stateIds
  });

  const rows = await db
    .select({ ticket: tickets, state: workflowStates })
    .from(tickets)
    .leftJoin(workflowStates, eq(workflowStates.id, tickets.stateId))
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ticketIds = page.map((row) => row.ticket.id);

  const labelRows = ticketIds.length
    ? await db
        .select({
          ticketId: ticketLabels.ticketId,
          id: labels.id,
          name: labels.name,
          color: labels.color
        })
        .from(ticketLabels)
        .innerJoin(labels, eq(labels.id, ticketLabels.labelId))
        .where(inArray(ticketLabels.ticketId, ticketIds))
        .all()
    : [];
  const labelsByTicket = new Map<
    string,
    Array<{ id: string; name: string; color: string | null }>
  >();
  for (const row of labelRows) {
    const list = labelsByTicket.get(row.ticketId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    labelsByTicket.set(row.ticketId, list);
  }

  const fieldRows = ticketIds.length
    ? await db
        .select({ value: ticketFieldValues, definition: fieldDefinitions })
        .from(ticketFieldValues)
        .innerJoin(fieldDefinitions, eq(fieldDefinitions.id, ticketFieldValues.fieldDefinitionId))
        .where(inArray(ticketFieldValues.ticketId, ticketIds))
        .all()
    : [];
  const fieldsByTicket = new Map<string, Record<string, unknown>>();
  for (const row of fieldRows) {
    const bag = fieldsByTicket.get(row.value.ticketId) ?? {};
    bag[row.definition.key] =
      row.value.valueText ??
      row.value.valueNumber ??
      row.value.valueBool ??
      row.value.valueDate ??
      row.value.valueJson ??
      null;
    fieldsByTicket.set(row.value.ticketId, bag);
  }

  const ownerIds = [
    ...new Set(page.map((row) => row.ticket.ownerUserId).filter((id): id is string => Boolean(id)))
  ];
  const ownerRows = ownerIds.length
    ? await db
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
        .where(inArray(usersTable.id, ownerIds))
        .all()
    : [];
  const ownerNames = new Map(ownerRows.map((row) => [row.id, row.name]));

  return {
    rows: page.map((row) => ({
      ticket: row.ticket,
      stateName: row.state?.name ?? 'Unknown',
      stateKind: row.state?.kind ?? 'manual',
      stateCategory: row.state?.category ?? 'active',
      ownerName: row.ticket.ownerUserId ? (ownerNames.get(row.ticket.ownerUserId) ?? null) : null,
      labels: labelsByTicket.get(row.ticket.id) ?? [],
      fields: fieldsByTicket.get(row.ticket.id) ?? {}
    })),
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.ticket) : null,
    total
  };
}

export async function countTickets(
  db: Executor,
  options: {
    workspaceId: string;
    workflowId?: string | null;
    filter?: FilterAst | null;
    search?: string | null;
    stateIds?: string[];
  }
): Promise<number> {
  const conditions: SQL[] = [eq(tickets.workspaceId, options.workspaceId)];
  if (options.workflowId) conditions.push(eq(tickets.workflowId, options.workflowId));
  if (options.stateIds && options.stateIds.length > 0) {
    conditions.push(inArray(tickets.stateId, options.stateIds));
  }
  const compiled = await activeCompiler.compile(db, {
    workspaceId: options.workspaceId,
    filter: options.filter ?? null
  });
  if (compiled.sql) conditions.push(compiled.sql);
  if (options.search && options.search.trim().length > 0) {
    const term = `%${escapeLike(options.search.trim().toLowerCase())}%`;
    conditions.push(
      or(
        sql`lower(${tickets.title}) like ${term} escape '\\'`,
        sql`lower(coalesce(${tickets.description}, '')) like ${term} escape '\\'`
      ) as SQL
    );
  }

  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(tickets)
    .where(and(...conditions))
    .all();
  return rows[0]?.count ?? 0;
}

/** Board view: tickets grouped by state in configured order. */
export async function getBoard(
  db: Executor,
  options: {
    workspaceId: string;
    workflowId: string;
    filter?: FilterAst | null;
    search?: string | null;
    perColumnLimit?: number;
  }
): Promise<{
  columns: Array<{
    state: typeof workflowStates.$inferSelect;
    tickets: TicketListRow[];
    total: number;
  }>;
}> {
  const states = await db
    .select()
    .from(workflowStates)
    .where(eq(workflowStates.workflowId, options.workflowId))
    .orderBy(asc(workflowStates.position))
    .all();

  const columns = [];
  for (const state of states) {
    const page = await listTickets(db, {
      workspaceId: options.workspaceId,
      workflowId: options.workflowId,
      filter: options.filter ?? null,
      search: options.search ?? null,
      stateIds: [state.id],
      limit: options.perColumnLimit ?? 50,
      sort: [{ field: 'priority', direction: 'desc' }]
    });
    columns.push({ state, tickets: page.rows, total: page.total });
  }
  return { columns };
}

/** Parse an untrusted filter payload from a query string or stored view. */
export function parseFilterInput(input: unknown): FilterAst | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    if (input.trim().length === 0) return null;
    try {
      return filterAstSchema.parse(JSON.parse(input));
    } catch (error) {
      throw errors.validation('Invalid filter expression', {
        reason: error instanceof Error ? error.message : 'unparseable'
      });
    }
  }
  return filterAstSchema.parse(input);
}
