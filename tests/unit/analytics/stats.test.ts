import { describe, expect, test } from 'bun:test';
import {
  maxOf,
  meanOf,
  medianOf,
  minOf,
  p90Of,
  percentileOf,
  sumOf
} from '../../../src/lib/server/analytics/stats';

describe('medianOf', () => {
  test('returns null for an empty sample', () => {
    expect(medianOf([])).toBeNull();
  });

  test('is exact for an odd count without sorting the caller array', () => {
    const input = [7, 1, 3];
    expect(medianOf(input)).toBe(3);
    expect(input).toEqual([7, 1, 3]);
  });

  test('averages the middle two for an even count', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([10, 2, 8, 4])).toBe(6);
  });

  test('handles a single sample and duplicates', () => {
    expect(medianOf([42])).toBe(42);
    expect(medianOf([5, 5, 5, 9])).toBe(5);
  });
});

describe('percentileOf', () => {
  test('uses linear interpolation between ranks', () => {
    // n = 4: p90 index 2.7 -> 3 + 0.7 * (4 - 3)
    expect(percentileOf([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
    expect(p90Of([1, 2, 3, 4])).toBeCloseTo(3.7, 10);
  });

  test('p100 is the maximum and p0 the minimum', () => {
    expect(percentileOf([4, 8, 15, 16, 23, 42], 1)).toBe(42);
    expect(percentileOf([4, 8, 15, 16, 23, 42], 0)).toBe(4);
  });

  test('rejects an out-of-range percentile', () => {
    expect(() => percentileOf([1, 2], 1.5)).toThrow();
    expect(() => percentileOf([1, 2], -0.1)).toThrow();
  });
});

describe('summary helpers', () => {
  test('mean, sum, min and max over an empty sample', () => {
    expect(meanOf([])).toBeNull();
    expect(sumOf([])).toBe(0);
    expect(minOf([])).toBeNull();
    expect(maxOf([])).toBeNull();
  });

  test('mean, sum, min and max over a sample', () => {
    expect(meanOf([2, 4, 6])).toBe(4);
    expect(sumOf([2, 4, 6])).toBe(12);
    expect(minOf([2, 4, 6])).toBe(2);
    expect(maxOf([2, 4, 6])).toBe(6);
  });
});
