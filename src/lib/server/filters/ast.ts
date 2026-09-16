/**
 * Structured filter AST.
 *
 * There is exactly one filtering language in Mentat: the serializable AST defined
 * here. Ticket lists, file lists, saved views and dashboard widgets all compile
 * through the same evaluator, so a saved view and a widget can never disagree
 * about what "Open claims" means (ADR-0012).
 *
 * The AST is also the seam for a future textual query language: a parser can emit
 * this structure without touching storage code.
 */
import { z } from 'zod';

export const filterOperatorSchema = z.enum([
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
  'is_true',
  'is_false',
  'before',
  'after',
  'within_last_days',
  'not_within_last_days'
]);
export type FilterOperator = z.infer<typeof filterOperatorSchema>;

/**
 * What a condition refers to. `system` covers native columns (title, priority,
 * state, owner, dates); `field` covers typed custom fields; the remaining kinds
 * cover relations that require a join.
 */
export const filterFieldKindSchema = z.enum([
  'system',
  'field',
  'file_field',
  'state',
  'workflow',
  'label',
  'owner',
  'team',
  'run',
  'approval',
  'file',
  'collection'
]);
export type FilterFieldKind = z.infer<typeof filterFieldKindSchema>;

export const filterConditionSchema = z.object({
  type: z.literal('condition'),
  kind: filterFieldKindSchema.default('system'),
  /** Field key: a system field name, a field definition key, or an id. */
  key: z.string().min(1),
  operator: filterOperatorSchema,
  /** Operators like `is_empty` take no value. */
  value: z.unknown().optional()
});

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    type: z.literal('group'),
    op: z.enum(['and', 'or']),
    children: z.array(z.union([filterGroupSchema, filterConditionSchema])).min(1)
  })
);

export type FilterCondition = z.infer<typeof filterConditionSchema>;
export interface FilterGroup {
  type: 'group';
  op: 'and' | 'or';
  children: FilterNode[];
}
export type FilterNode = FilterGroup | FilterCondition;

export const filterAstSchema = z.union([filterGroupSchema, filterConditionSchema]);
export type FilterAst = FilterNode;

/** System field keys that are valid in a `system` condition. */
export const TicketSystemFields = {
  key: 'key',
  number: 'number',
  title: 'title',
  description: 'description',
  priority: 'priority',
  stateId: 'stateId',
  stateName: 'stateName',
  stateKind: 'stateKind',
  stateCategory: 'stateCategory',
  workflowId: 'workflowId',
  ownerUserId: 'ownerUserId',
  ownerTeamId: 'ownerTeamId',
  isUnassigned: 'isUnassigned',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  enteredStateAt: 'enteredStateAt',
  lastActivityAt: 'lastActivityAt',
  dueAt: 'dueAt',
  closedAt: 'closedAt',
  waitingOn: 'waitingOn',
  timeInStateSeconds: 'timeInStateSeconds',
  runStatus: 'runStatus',
  approvalStatus: 'approvalStatus',
  sourceType: 'sourceType',
  originTicketId: 'originTicketId',
  stateRunCount: 'stateRunCount'
} as const;
export type TicketSystemField = (typeof TicketSystemFields)[keyof typeof TicketSystemFields];

export const FileSystemFields = {
  filename: 'filename',
  mimeType: 'mimeType',
  size: 'size',
  status: 'status',
  summary: 'summary',
  contentText: 'contentText',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  sourceType: 'sourceType',
  workflowId: 'workflowId',
  ticketId: 'ticketId',
  contentHash: 'contentHash',
  contextLabel: 'contextLabel',
  pageCount: 'pageCount',
  language: 'language'
} as const;

export function isGroup(node: FilterNode): node is FilterGroup {
  return node.type === 'group';
}

export function isCondition(node: FilterNode): node is FilterCondition {
  return node.type === 'condition';
}

/** An empty filter that matches everything. */
export function emptyFilter(): FilterGroup {
  return { type: 'group', op: 'and', children: [] };
}

export function andOf(children: FilterNode[]): FilterGroup {
  return { type: 'group', op: 'and', children };
}

export function orOf(children: FilterNode[]): FilterGroup {
  return { type: 'group', op: 'or', children };
}

/**
 * Merge a base filter with an additional constraint. Used to combine a dashboard's
 * global filter with a widget's local filter without mutating either.
 */
export function combineFilters(
  base: FilterNode | null,
  extra: FilterNode | null
): FilterAst | null {
  if (!base && !extra) return null;
  if (!base) return extra;
  if (!extra) return base;
  return andOf([base, extra]);
}

/**
 * Validate an untrusted filter payload (query string, saved view, widget) and
 * normalize it. Throws a Zod error which boundaries convert into a 422.
 */
export function parseFilterAst(input: unknown): FilterAst | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    if (input.trim() === '') return null;
    return filterAstSchema.parse(JSON.parse(input));
  }
  return filterAstSchema.parse(input);
}

/** Collect every referenced field key, used to pre-load field definitions. */
export function collectFieldKeys(node: FilterNode | null, out = new Set<string>()): Set<string> {
  if (!node) return out;
  if (isGroup(node)) {
    for (const child of node.children) collectFieldKeys(child, out);
    return out;
  }
  if (node.kind === 'field' || node.kind === 'file_field') out.add(node.key);
  return out;
}

/** Count leaf conditions — used to warn about expensive filters before running. */
export function countConditions(node: FilterNode | null): number {
  if (!node) return 0;
  if (isGroup(node)) return node.children.reduce((sum, child) => sum + countConditions(child), 0);
  return 1;
}

/** Human-readable summary for saved-view chips and widget subtitles. */
export function describeFilter(node: FilterNode | null): string {
  if (!node) return 'All items';
  if (isGroup(node)) {
    if (node.children.length === 0) return 'All items';
    const joiner = node.op === 'and' ? ' and ' : ' or ';
    const parts = node.children.map((child) =>
      isGroup(child) ? `(${describeFilter(child)})` : describeCondition(child)
    );
    return parts.join(joiner);
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
    case 'in':
    case 'not_in':
      return `${label} ${condition.operator === 'in' ? 'is one of' : 'is not'} ${formatValue(condition.value)}`;
    case 'between':
      return `${label} between ${formatValue(condition.value)}`;
    case 'within_last_days':
      return `${label} in the last ${String(condition.value)} day(s)`;
    case 'not_within_last_days':
      return `${label} not in the last ${String(condition.value)} day(s)`;
    default:
      return `${label} ${operatorSymbol(condition.operator)} ${formatValue(condition.value)}`;
  }
}

function operatorSymbol(operator: FilterOperator): string {
  const symbols: Partial<Record<FilterOperator, string>> = {
    eq: '=',
    neq: '≠',
    contains: 'contains',
    not_contains: 'does not contain',
    starts_with: 'starts with',
    ends_with: 'ends with',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    before: 'before',
    after: 'after'
  };
  return symbols[operator] ?? operator;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}
