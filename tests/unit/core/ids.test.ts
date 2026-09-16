import { describe, expect, test } from 'bun:test';
import {
  isUuid,
  keyPrefix,
  slugify,
  uuidv7,
  uuidv7Timestamp
} from '../../../src/lib/server/core/ids';

describe('uuidv7', () => {
  test('produces an RFC-shaped, valid UUID', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id).toHaveLength(36);
    // version nibble
    expect(id[14]).toBe('7');
    // variant nibble
    expect(['8', '9', 'a', 'b']).toContain(id[19] as string);
  });

  test('is unique across many generations', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7()));
    expect(ids.size).toBe(5000);
  });

  test('embeds a recoverable timestamp', () => {
    const now = Date.now();
    const id = uuidv7(now);
    expect(Math.abs(uuidv7Timestamp(id) - now)).toBeLessThan(5);
  });

  test('sorts lexicographically by generation time', () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    expect(earlier < later).toBe(true);
  });

  test('rejects lookalike values', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid('123e4567-e89b-42d3-a456-42661417400')).toBe(false);
  });
});

describe('slugify', () => {
  test('normalizes punctuation, case and accents', () => {
    expect(slugify('Claims — Intake & Triage')).toBe('claims-intake-triage');
    expect(slugify('Café Ünïcode')).toBe('cafe-unicode');
  });

  test('falls back when nothing usable remains', () => {
    expect(slugify('***', 'workflow')).toBe('workflow');
  });
});

describe('keyPrefix', () => {
  test('derives a short uppercase key from initials', () => {
    expect(keyPrefix('Claims Intake')).toBe('CI');
    expect(keyPrefix('Underwriting')).toBe('UNDERW');
  });

  test('never returns a one-character or empty key', () => {
    expect(keyPrefix('A').length).toBeGreaterThanOrEqual(2);
    expect(keyPrefix('', 'WF')).toBe('WF');
  });
});
