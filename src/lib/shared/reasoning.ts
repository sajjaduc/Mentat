/**
 * Portable reasoning-effort vocabulary.
 *
 * This is the one definition shared by the server (which maps a level onto each
 * provider's native knob) and the UI (which offers the levels a selected model
 * declares). Keep it free of server imports so the schema layer and client bundles
 * can both use it.
 */

/** Portable levels, ordered weakest to strongest. */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && EFFORT_SET.has(value);
}

/** Keep only recognised levels, preserving the canonical weakest-to-strongest order. */
export function normalizeReasoningEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<ReasoningEffort>();
  for (const entry of value) {
    if (isReasoningEffort(entry)) seen.add(entry);
  }
  if (seen.size === 0) return undefined;
  return REASONING_EFFORTS.filter((effort) => seen.has(effort));
}

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max'
};

/** Ready-made options for a select, weakest to strongest. */
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: ReasoningEffort;
  label: string;
}> = REASONING_EFFORTS.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] }));
