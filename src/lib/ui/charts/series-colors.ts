/**
 * Deterministic series colours for hand-built charts.
 *
 * A chart must not choose a colour per render: the same series name has to look
 * the same on every reload and in every export. This hashes a name into a fixed
 * palette built from design tokens, so theme changes (including dark mode) flow
 * through automatically and no hex value is ever hard-coded.
 */

const PALETTE = [
  'var(--color-accent)',
  'var(--color-positive)',
  'var(--color-caution)',
  'var(--color-danger)',
  'color-mix(in oklch, var(--color-accent) 60%, var(--color-positive))',
  'color-mix(in oklch, var(--color-accent) 55%, var(--color-danger))',
  'color-mix(in oklch, var(--color-positive) 60%, var(--color-caution))',
  'color-mix(in oklch, var(--color-ink-muted) 65%, var(--color-accent))'
] as const;

export function colorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length] as string;
}

/** Colour for a series by its ordinal position, used where order is meaningful. */
export function colorAt(index: number): string {
  return PALETTE[index % PALETTE.length] as string;
}
