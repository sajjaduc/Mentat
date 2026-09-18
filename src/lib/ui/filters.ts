/**
 * Client-side view of the one filter language (ADR-0012).
 *
 * The AST is the server's, not a UI invention: `?filter=` carries exactly the JSON
 * that `parseFilterAst` accepts, so a filter built here is the same object a saved
 * view stores and a dashboard widget runs. There is deliberately no second
 * "simplified" query syntax.
 *
 * Two responsibilities live here:
 *
 *  - **Build and edit** an AST (conditions, groups, operator/value pairing).
 *  - **Serialize** it into a URL-safe query parameter and back, so a filtered list
 *    is a shareable link and a saved view is just persisted AST + columns.
 *
 * Unknown operators and field kinds are preserved rather than dropped: opening a
 * saved view authored elsewhere and re-saving it must not silently delete a
 * condition this build does not understand.
 */

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_true'
  | 'is_false'
  | 'before'
  | 'after'
  | 'within_last_days'
  | 'not_within_last_days';

export type FilterFieldKind =
  | 'system'
  | 'field'
  | 'file_field'
  | 'state'
  | 'workflow'
  | 'label'
  | 'owner'
  | 'team'
  | 'run'
  | 'approval'
  | 'file'
  | 'collection';

export interface FilterCondition {
  type: 'condition';
  kind: FilterFieldKind;
  key: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface FilterGroup {
  type: 'group';
  op: 'and' | 'or';
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterCondition;
export type FilterAst = FilterNode;

export function isGroup(node: FilterNode): node is FilterGroup {
  return node.type === 'group';
}

export function isCondition(node: FilterNode): node is FilterCondition {
  return node.type === 'condition';
}

export function emptyGroup(op: 'and' | 'or' = 'and'): FilterGroup {
  return { type: 'group', op, children: [] };
}

export function andOf(children: FilterNode[]): FilterGroup {
  return { type: 'group', op: 'and', children };
}

export function orOf(children: FilterNode[]): FilterGroup {
  return { type: 'group', op: 'or', children };
}

/** A filter with no conditions matches everything and serializes to nothing. */
export function isEmptyFilter(node: FilterNode | null | undefined): boolean {
  if (!node) return true;
  if (isGroup(node)) {
    return node.children.length === 0 || node.children.every((child) => isEmptyFilter(child));
  }
  return false;
}

export function countConditions(node: FilterNode | null | undefined): number {
  if (!node) return 0;
  if (isGroup(node)) return node.children.reduce((sum, child) => sum + countConditions(child), 0);
  return 1;
}

export function cloneFilter<T extends FilterNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}

/** Operators that carry no value; the editor hides the value control for these. */
export const VALUELESS_OPERATORS: readonly FilterOperator[] = [
  'is_empty',
  'is_not_empty',
  'is_true',
  'is_false'
];

export function operatorTakesValue(operator: FilterOperator): boolean {
  return !VALUELESS_OPERATORS.includes(operator);
}

/** Operators that expect a list of values rather than one. */
export function operatorTakesList(operator: FilterOperator): boolean {
  return operator === 'in' || operator === 'not_in';
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  gt: 'greater than',
  gte: 'greater than or equal',
  lt: 'less than',
  lte: 'less than or equal',
  between: 'between',
  is_empty: 'is empty',
  is_not_empty: 'is set',
  is_true: 'is true',
  is_false: 'is false',
  before: 'before',
  after: 'after',
  within_last_days: 'within the last N days',
  not_within_last_days: 'not within the last N days'
};

export const FIELD_KIND_LABELS: Record<FilterFieldKind, string> = {
  system: 'Built-in',
  field: 'Record field',
  file_field: 'File field',
  state: 'State',
  workflow: 'Workflow',
  label: 'Label',
  owner: 'Owner',
  team: 'Team',
  run: 'Run',
  approval: 'Approval',
  file: 'File',
  collection: 'Collection'
};

/** Built-in file columns, matching `FileSystemFields` on the server. */
export const FILE_SYSTEM_FIELDS: ReadonlyArray<{ key: string; label: string; type: string }> = [
  { key: 'filename', label: 'Filename', type: 'text' },
  { key: 'mimeType', label: 'MIME type', type: 'text' },
  { key: 'size', label: 'Size (bytes)', type: 'number' },
  { key: 'status', label: 'Processing status', type: 'text' },
  { key: 'summary', label: 'Summary', type: 'text' },
  { key: 'contentText', label: 'Extracted content', type: 'text' },
  { key: 'createdAt', label: 'Created', type: 'datetime' },
  { key: 'updatedAt', label: 'Updated', type: 'datetime' },
  { key: 'sourceType', label: 'Source type', type: 'text' },
  { key: 'workflowId', label: 'Workflow context', type: 'text' },
  { key: 'workflowItemId', label: 'Linked work item', type: 'text' },
  { key: 'recordId', label: 'Linked Record', type: 'text' },
  { key: 'contentHash', label: 'Content hash', type: 'text' },
  { key: 'contextLabel', label: 'Context label', type: 'text' },
  { key: 'pageCount', label: 'Page count', type: 'number' },
  { key: 'language', label: 'Language', type: 'text' }
];

/**
 * Record-level and work-level built-ins, matching `WorkflowItemSystemFields` on
 * the server. Record fields (key, title, priority, object type) and process fields
 * (state, owner, due date) live in one namespace because a work item is the union.
 */
export const RECORD_SYSTEM_FIELDS: ReadonlyArray<{ key: string; label: string; type: string }> = [
  { key: 'key', label: 'Key', type: 'text' },
  { key: 'number', label: 'Number', type: 'number' },
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'displayName', label: 'Display name', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'priority', label: 'Priority', type: 'text' },
  { key: 'objectTypeId', label: 'Object Type', type: 'text' },
  { key: 'recordId', label: 'Record', type: 'text' },
  { key: 'recordCreatedAt', label: 'Record created', type: 'datetime' },
  { key: 'recordUpdatedAt', label: 'Record updated', type: 'datetime' },
  { key: 'stateId', label: 'State id', type: 'text' },
  { key: 'stateName', label: 'State', type: 'text' },
  { key: 'stateKind', label: 'State kind', type: 'text' },
  { key: 'stateCategory', label: 'State category', type: 'text' },
  { key: 'workflowId', label: 'Workflow', type: 'text' },
  { key: 'ownerUserId', label: 'Owner', type: 'text' },
  { key: 'ownerTeamId', label: 'Team', type: 'text' },
  { key: 'isUnassigned', label: 'Unassigned', type: 'boolean' },
  { key: 'createdAt', label: 'Created', type: 'datetime' },
  { key: 'updatedAt', label: 'Updated', type: 'datetime' },
  { key: 'enteredStateAt', label: 'Entered state at', type: 'datetime' },
  { key: 'lastActivityAt', label: 'Last activity', type: 'datetime' },
  { key: 'dueAt', label: 'Due', type: 'datetime' },
  { key: 'closedAt', label: 'Closed', type: 'datetime' },
  { key: 'completedAt', label: 'Completed', type: 'datetime' },
  { key: 'waitingOn', label: 'Waiting on', type: 'text' },
  { key: 'participation', label: 'Participation', type: 'text' },
  { key: 'runStatus', label: 'Run status', type: 'text' },
  { key: 'approvalStatus', label: 'Approval status', type: 'text' },
  { key: 'sourceType', label: 'Source type', type: 'text' }
];

// ------------------------------------------------------------- serialization

/**
 * Encode an AST as a compact, URL-safe parameter.
 *
 * `JSON.stringify` round-trips through `encodeURIComponent`; the AST is already a
 * JSON document on the server, so there is nothing to translate. An empty filter
 * encodes to `null` so callers can omit the parameter entirely.
 */
export function serializeFilter(node: FilterNode | null | undefined): string | null {
  if (!node || isEmptyFilter(node)) return null;
  return JSON.stringify(node);
}

/**
 * Decode a `?filter=` parameter. Malformed input is reported rather than thrown:
 * a broken link should show an error the user can clear, not a blank screen.
 */
export function parseFilter(value: string | null | undefined): FilterNode | null {
  if (!value || value.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isFilterNode(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Structural validation that never throws and tolerates unknown enum members. */
export function isFilterNode(value: unknown): value is FilterNode {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'group') {
    return (
      (record.op === 'and' || record.op === 'or') &&
      Array.isArray(record.children) &&
      record.children.every((child) => isFilterNode(child))
    );
  }
  if (record.type === 'condition') {
    return typeof record.key === 'string' && typeof record.operator === 'string';
  }
  return false;
}

/** Read the filter out of a URLSearchParams or a URL, tolerating absence. */
export function filterFromParams(params: URLSearchParams): FilterNode | null {
  return parseFilter(params.get('filter'));
}

// --------------------------------------------------------------- description

/**
 * Human-readable summary, mirroring the server's `describeFilter` so a chip
 * rendered before a save says the same thing after a reload.
 */
export function describeFilter(node: FilterNode | null | undefined): string {
  if (!node || isEmptyFilter(node)) return 'All items';
  if (isGroup(node)) {
    const joiner = node.op === 'and' ? ' and ' : ' or ';
    return node.children
      .map((child) => (isGroup(child) ? `(${describeFilter(child)})` : describeCondition(child)))
      .join(joiner);
  }
  return describeCondition(node);
}

function describeCondition(condition: FilterCondition): string {
  const label = condition.key;
  switch (condition.operator) {
    case 'is_empty':
      return `${label} is empty`;
    case 'is_not_empty':
      return `${label} is set`;
    case 'is_true':
      return `${label} is true`;
    case 'is_false':
      return `${label} is false`;
    case 'within_last_days':
      return `${label} within the last ${formatValue(condition.value)} day(s)`;
    case 'not_within_last_days':
      return `${label} not within the last ${formatValue(condition.value)} day(s)`;
    default: {
      const symbol = OPERATOR_LABELS[condition.operator] ?? condition.operator;
      return `${label} ${symbol} ${formatValue(condition.value)}`;
    }
  }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Remove one condition by structural path (`0.2` = first child's second child). */
export function removeAtPath(root: FilterGroup, path: string): FilterGroup {
  const segments = path
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
  const clone = cloneFilter(root);
  if (segments.length === 0) return clone;
  let cursor: FilterGroup = clone;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = cursor.children[segments[index] as number];
    if (!next || !isGroup(next)) return clone;
    cursor = next;
  }
  cursor.children.splice(segments[segments.length - 1] as number, 1);
  return clone;
}

/** Replace one condition by structural path, preserving everything else. */
export function replaceAtPath(root: FilterGroup, path: string, node: FilterNode): FilterGroup {
  const segments = path
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
  const clone = cloneFilter(root);
  if (segments.length === 0) return clone;
  let cursor: FilterGroup = clone;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = cursor.children[segments[index] as number];
    if (!next || !isGroup(next)) return clone;
    cursor = next;
  }
  cursor.children[segments[segments.length - 1] as number] = node;
  return clone;
}

/** Flatten a filter into `path → condition` pairs for rendering editors. */
export function flattenConditions(
  node: FilterNode,
  path = ''
): Array<{ path: string; condition: FilterCondition }> {
  if (isCondition(node)) return [{ path, condition: node }];
  return node.children.flatMap((child, index) =>
    flattenConditions(child, path ? `${path}.${index}` : String(index))
  );
}

/**
 * The canonical example from the files requirements:
 * `Document Type = Invoice AND Customer = ACME AND Document Date > 2026-01-01`.
 * Shipping it as a one-click starter keeps the structured filter discoverable
 * without inventing a tutorial screen.
 */
export function structuredFilterExample(): FilterGroup {
  return andOf([
    {
      type: 'condition',
      kind: 'file_field',
      key: 'document_type',
      operator: 'eq',
      value: 'Invoice'
    },
    { type: 'condition', kind: 'file_field', key: 'customer', operator: 'eq', value: 'ACME' },
    {
      type: 'condition',
      kind: 'file_field',
      key: 'document_date',
      operator: 'gt',
      value: '2026-01-01'
    }
  ]);
}
