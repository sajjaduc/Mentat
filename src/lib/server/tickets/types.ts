/**
 * Shared ticket domain types.
 *
 * Kept separate from the Drizzle schema so that consumers (triggers, analytics,
 * tools) can depend on vocabulary without depending on table shapes.
 */

export type TicketPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export type TicketStatusWait = 'human' | 'agent' | 'approval' | 'trigger' | 'none';

export type TicketRelationshipType =
  | 'parent'
  | 'child'
  | 'related'
  | 'duplicate'
  | 'blocks'
  | 'blocked_by';

export const TICKET_PRIORITIES: TicketPriority[] = ['none', 'low', 'medium', 'high', 'urgent'];

export const PRIORITY_RANK: Record<TicketPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
};

/**
 * The inverse of a relationship type. Storing `child` implies `parent` when read
 * from the other side, so decomposition is queryable in both directions.
 */
export const INVERSE_RELATIONSHIP: Record<TicketRelationshipType, TicketRelationshipType> = {
  parent: 'child',
  child: 'parent',
  related: 'related',
  duplicate: 'duplicate',
  blocks: 'blocked_by',
  blocked_by: 'blocks'
};

/** Field keys on a ticket that are native system fields, not custom fields. */
export const NATIVE_TICKET_MUTABLE_KEYS = [
  'title',
  'description',
  'priority',
  'ownerUserId',
  'ownerTeamId',
  'dueAt'
] as const;
export type NativeTicketMutableKey = (typeof NATIVE_TICKET_MUTABLE_KEYS)[number];

export function isNativeTicketKey(key: string): key is NativeTicketMutableKey {
  return (NATIVE_TICKET_MUTABLE_KEYS as readonly string[]).includes(key);
}
