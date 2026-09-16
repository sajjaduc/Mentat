/**
 * Structural editing of the filter AST.
 *
 * The recursive editor component in `$ui/common/FilterGroupEditor.svelte` needs to
 * mutate one node deep inside a tree without re-implementing tree walking, and it
 * must never drop a node it does not understand (a saved view authored elsewhere
 * can contain anything the schema allows). These helpers are that tree walk: they
 * return new trees, address nodes by a positional path such as `0.2`, and leave
 * every sibling untouched.
 */

import {
  cloneFilter,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  isGroup
} from '$ui/filters';

/** A selectable field in the filter builder: a key, a label and its type. */
export interface BuilderFieldOption {
  key: string;
  label: string;
  type: string;
}

/** Positional path for a child, e.g. `'' + 0 -> '0'`, `'1' + 2 -> '1.2'`. */
export function childPath(parentPath: string, index: number): string {
  return parentPath === '' ? String(index) : `${parentPath}.${index}`;
}

export function parsePath(path: string): number[] {
  if (path === '') return [];
  return path
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment) && segment >= 0);
}

/** Resolve a positional path to its group, or `null` if it is not a group. */
export function groupAt(root: FilterGroup, path: string): FilterGroup | null {
  let cursor: FilterGroup = root;
  for (const index of parsePath(path)) {
    const next = cursor.children[index];
    if (!next || !isGroup(next)) return null;
    cursor = next;
  }
  return cursor;
}

/** Append a node to the group at `path`. Returns a new tree. */
export function appendNode(root: FilterGroup, path: string, node: FilterNode): FilterGroup {
  const clone = cloneFilter(root);
  const target = groupAt(clone, path);
  if (target) target.children.push(node);
  return clone;
}

/** Remove the node at `path`. Returns a new tree. */
export function removeNode(root: FilterGroup, path: string): FilterGroup {
  const segments = parsePath(path);
  if (segments.length === 0) return cloneFilter(root);
  const clone = cloneFilter(root);
  const parent = groupAt(clone, segments.slice(0, -1).map(String).join('.'));
  if (parent) parent.children.splice(segments[segments.length - 1] as number, 1);
  return clone;
}

/** Replace the node at `path` with `updater(node)`. Returns a new tree. */
export function replaceNode(
  root: FilterGroup,
  path: string,
  updater: (node: FilterNode) => FilterNode
): FilterGroup {
  const segments = parsePath(path);
  if (segments.length === 0) return cloneFilter(root);
  const clone = cloneFilter(root);
  const parent = groupAt(clone, segments.slice(0, -1).map(String).join('.'));
  if (!parent) return clone;
  const index = segments[segments.length - 1] as number;
  const current = parent.children[index];
  if (!current) return clone;
  parent.children[index] = updater(current);
  return clone;
}

/** Toggle a group between `and` and `or`. Returns a new tree. */
export function toggleGroupOperator(root: FilterGroup, path: string): FilterGroup {
  const clone = cloneFilter(root);
  const target = groupAt(clone, path);
  if (target) target.op = target.op === 'and' ? 'or' : 'and';
  return clone;
}

/** Render a condition value back into the single-line text input it came from. */
export function conditionValueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  return String(value);
}

/** Parse the text input back into an AST value (`in`/`not_in` become arrays). */
export function conditionTextToValue(raw: string, list: boolean): unknown {
  if (!list) return raw;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Drop a condition whose value is empty but whose operator requires one. */
export function conditionIsIncomplete(condition: FilterCondition): boolean {
  if (!operatorNeedsValue(condition.operator)) return false;
  const value = condition.value;
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** A condition with no field selected cannot mean anything yet. */
export function conditionHasNoField(condition: FilterCondition): boolean {
  return condition.key.trim().length === 0;
}

/**
 * Prune rows the user is still filling in.
 *
 * The server rejects a condition with an empty key or a missing value rather than
 * silently broadening the result, which is the right behaviour for the *API* — but
 * a builder always has a half-completed row in it the moment a user clicks "add
 * condition". Sending that would turn ordinary editing into a 422 error page.
 *
 * So the query is sent without incomplete rows while the builder keeps showing them.
 * This is form semantics, not silent filtering: nothing that could match is dropped,
 * and the UI states that incomplete rows are not applied until they are filled in.
 */
export function pruneIncompleteFilter(node: FilterNode): FilterNode | null {
  if (!isGroup(node)) {
    return conditionHasNoField(node) || conditionIsIncomplete(node) ? null : node;
  }
  const children = node.children
    .map((child) => pruneIncompleteFilter(child))
    .filter((child): child is FilterNode => child !== null);
  if (children.length === 0) return null;
  return { ...node, children };
}

function operatorNeedsValue(operator: string): boolean {
  return !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(operator);
}
