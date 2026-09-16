/**
 * UI primitives.
 *
 * A small, deliberately opinionated set. Every primitive carries the design
 * decisions once so screens stay consistent: restrained colour, generous spacing,
 * focus-visible rings, reduced-motion respect and accessible semantics.
 *
 * Svelte 5 runes only. No global store: state belongs to the screen that owns it.
 */
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes, HTMLInputAttributes } from 'svelte/elements';

export type Tone = 'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted';

export interface BaseProps {
  class?: string;
  children?: Snippet;
}

/** A choice in a native select. */
export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}
