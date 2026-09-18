/**
 * The filter bar's state and its serialisation to the shared filter AST.
 *
 * Board and list must agree on what the user filtered, and a saved view stores
 * exactly the same AST the board posts, so this module is the single translation
 * between the five controls and the JSON that travels in `?filter=`.
 */
import { PRIORITIES, type Priority } from '$ui/work/format';
import type { FilterAst, FilterCondition, FilterGroup, FilterNode } from '$ui/work/types';

export { PRIORITIES };
export type WorkItemPriority = Priority;

export interface FilterState {
  stateIds: string[];
  priorities: WorkItemPriority[];
  ownerUserId: string;
  labelIds: string[];
  search: string;
}

export function emptyFilterState(): FilterState {
  return { stateIds: [], priorities: [], ownerUserId: '', labelIds: [], search: '' };
}

export function isFilterActive(filter: FilterState): boolean {
  return (
    filter.stateIds.length > 0 ||
    filter.priorities.length > 0 ||
    filter.ownerUserId !== '' ||
    filter.labelIds.length > 0 ||
    filter.search.trim() !== ''
  );
}

export function countFilterConditions(filter: FilterState): number {
  let count = 0;
  if (filter.stateIds.length > 0) count += 1;
  if (filter.priorities.length > 0) count += 1;
  if (filter.ownerUserId !== '') count += 1;
  if (filter.labelIds.length > 0) count += 1;
  if (filter.search.trim() !== '') count += 1;
  return count;
}

function condition(
  kind: FilterCondition['kind'],
  key: string,
  operator: FilterCondition['operator'],
  value?: unknown
): FilterCondition {
  return value === undefined
    ? { type: 'condition', kind, key, operator }
    : { type: 'condition', kind, key, operator, value };
}

/** Translate the five controls into one AND group; null when nothing is set. */
export function filterStateToAst(filter: FilterState): FilterAst | null {
  const children: FilterNode[] = [];
  const search = filter.search.trim();
  if (search !== '') {
    // Text search matches title, key or description, so it is an OR group of its own.
    children.push({
      type: 'group',
      op: 'or',
      children: [
        condition('system', 'title', 'contains', search),
        condition('system', 'key', 'contains', search),
        condition('system', 'description', 'contains', search)
      ]
    });
  }
  if (filter.stateIds.length > 0) {
    children.push(condition('state', 'stateId', 'in', filter.stateIds));
  }
  if (filter.priorities.length > 0) {
    children.push(condition('system', 'priority', 'in', filter.priorities));
  }
  if (filter.ownerUserId !== '') {
    children.push(
      filter.ownerUserId === 'unassigned'
        ? condition('system', 'isUnassigned', 'is_true')
        : condition('owner', 'ownerUserId', 'eq', filter.ownerUserId)
    );
  }
  if (filter.labelIds.length > 0) {
    children.push(condition('label', 'label', 'in', filter.labelIds));
  }
  if (children.length === 0) return null;
  return { type: 'group', op: 'and', children };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string' && value !== '') return [value];
  return [];
}

function flatten(node: FilterNode, out: FilterCondition[]): void {
  if (node.type === 'group') {
    for (const child of node.children) flatten(child, out);
    return;
  }
  out.push(node);
}

/**
 * Recover the controls from a stored AST. Unknown conditions are ignored rather
 * than rejected: a saved view created elsewhere may carry more than this bar shows.
 */
export function filterAstToState(ast: FilterAst | null): FilterState {
  const state = emptyFilterState();
  if (!ast) return state;
  const conditions: FilterCondition[] = [];
  flatten(ast, conditions);
  for (const entry of conditions) {
    if (entry.kind === 'state' && entry.key === 'stateId') {
      state.stateIds = asStringList(entry.value);
    } else if (entry.kind === 'system' && entry.key === 'priority') {
      state.priorities = asStringList(entry.value).filter((value): value is WorkItemPriority =>
        (PRIORITIES as readonly string[]).includes(value)
      );
    } else if (entry.kind === 'owner' && entry.key === 'ownerUserId') {
      state.ownerUserId = asStringList(entry.value)[0] ?? '';
    } else if (entry.kind === 'system' && entry.key === 'isUnassigned') {
      state.ownerUserId = 'unassigned';
    } else if (entry.kind === 'label') {
      state.labelIds = asStringList(entry.value);
    } else if (
      entry.kind === 'system' &&
      entry.key === 'title' &&
      typeof entry.value === 'string' &&
      state.search === ''
    ) {
      state.search = entry.value;
    }
  }
  return state;
}

/** Validate an untrusted AST from the query string or a saved view. */
export function parseFilterAst(raw: unknown): FilterAst | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type === 'condition') {
    return typeof parsed.key === 'string' && typeof parsed.operator === 'string'
      ? (parsed as unknown as FilterCondition)
      : null;
  }
  if (parsed.type === 'group' && (parsed.op === 'and' || parsed.op === 'or')) {
    const children = Array.isArray(parsed.children)
      ? parsed.children
          .map((child) => parseFilterAst(child))
          .filter((child): child is FilterNode => child !== null)
      : [];
    const group: FilterGroup = { type: 'group', op: parsed.op, children };
    return group;
  }
  return null;
}

/** The value the board and list put in `?filter=`; null when unfiltered. */
export function filterStateToQuery(filter: FilterState): string | null {
  const ast = filterStateToAst(filter);
  return ast ? JSON.stringify(ast) : null;
}

export function filterStateFromQuery(raw: string | null): FilterState {
  return filterAstToState(parseFilterAst(raw));
}
