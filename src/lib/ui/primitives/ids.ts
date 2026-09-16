/**
 * Monotonic ids for form controls.
 *
 * Labels need a stable `for`/`id` pair. A counter is deterministic and avoids the
 * hydration mismatch that `Math.random()` in a derived would risk.
 */
let counter = 0;

export function nextControlId(): number {
  counter += 1;
  return counter;
}
