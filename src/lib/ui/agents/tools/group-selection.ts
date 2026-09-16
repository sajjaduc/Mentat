/**
 * Group selection helpers.
 *
 * The catalogue and the agent pickers all present tools grouped by namespace and offer
 * a single control that selects or clears a whole group. Working out whether a group
 * is fully, partly or not selected is the same arithmetic everywhere, so it lives
 * here once and is covered by unit tests.
 */

export type GroupSelectionState = 'all' | 'some' | 'none';

/** How much of `keys` the current `selected` set covers. */
export function groupSelectionState(
  selected: readonly string[],
  keys: readonly string[]
): GroupSelectionState {
  if (keys.length === 0) return 'none';
  const chosen = new Set(selected);
  let covered = 0;
  for (const key of keys) {
    if (chosen.has(key)) covered += 1;
  }
  if (covered === 0) return 'none';
  return covered === keys.length ? 'all' : 'some';
}

/**
 * Toggle a whole group. When every key is already selected the group is cleared;
 * otherwise every missing key is added. Existing selections outside the group are
 * preserved, and the order of the original selection is kept so a save produces a
 * stable payload.
 */
export function toggleGroupSelection(
  selected: readonly string[],
  keys: readonly string[]
): string[] {
  if (keys.length === 0) return [...selected];
  const state = groupSelectionState(selected, keys);
  if (state === 'all') {
    const drop = new Set(keys);
    return selected.filter((entry) => !drop.has(entry));
  }
  const next = [...selected];
  const chosen = new Set(selected);
  for (const key of keys) {
    if (!chosen.has(key)) {
      next.push(key);
      chosen.add(key);
    }
  }
  return next;
}
