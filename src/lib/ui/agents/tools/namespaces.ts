/**
 * Tool namespacing for the catalogue.
 *
 * Tool keys are dotted paths. Native tools are prefixed `mentat.` (`mentat.workflowItems.setFields`),
 * while stored HTTP tools carry the operation key verbatim (`hubspot.get_contact`). The
 * first *meaningful* segment is what an operator recognises as the owner, so a native key
 * drops the `mentat.` prefix before taking its head — `mentat.workflowItems.setFields` groups
 * under `workflowItems`, and `hubspot.get_contact` groups under `hubspot`.
 */

/** The product-owned prefix stripped before deriving a namespace. */
const PRODUCT_PREFIX = 'mentat.';

/** The owner segment of a tool key, e.g. `work item` or `hubspot`. */
export function namespaceForKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return 'other';
  const withoutProductPrefix = trimmed.startsWith(PRODUCT_PREFIX)
    ? trimmed.slice(PRODUCT_PREFIX.length)
    : trimmed;
  const head = withoutProductPrefix.split('.')[0];
  return head && head.length > 0 ? head : 'other';
}

/**
 * Group entries by {@link namespaceForKey}, preserving the incoming order within each
 * group and naming the empty-string bucket `other` so it always sorts predictably.
 */
export function groupByNamespace<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string
): Array<[string, T[]]> {
  const buckets = new Map<string, T[]>();
  for (const entry of entries) {
    const namespace = namespaceForKey(keyOf(entry));
    const bucket = buckets.get(namespace);
    if (bucket) bucket.push(entry);
    else buckets.set(namespace, [entry]);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
}
