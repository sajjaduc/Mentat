import { describe, expect, test } from 'bun:test';
import {
  bucketKey,
  bucketLabel,
  enumerateBuckets,
  fillMissingBuckets
} from '../../../src/lib/server/analytics/series';

/** 2024-03-06T12:00:00Z — a Wednesday. */
const WEDNESDAY = Date.UTC(2024, 2, 6, 12, 0, 0);
/** 2024-03-04T00:00:00Z — the Monday of that ISO week. */
const MONDAY = Date.UTC(2024, 2, 4, 0, 0, 0);

describe('bucketKey', () => {
  test('day buckets are UTC calendar days, not affected by time-of-day', () => {
    expect(bucketKey(WEDNESDAY, 'day')).toBe('2024-03-06');
    expect(bucketKey(Date.UTC(2024, 2, 6, 23, 59, 59), 'day')).toBe('2024-03-06');
    expect(bucketKey(Date.UTC(2024, 2, 7, 0, 0, 0), 'day')).toBe('2024-03-07');
  });

  test('week buckets start on Monday and are stable through the week', () => {
    expect(bucketKey(WEDNESDAY, 'week')).toBe('2024-03-04');
    expect(bucketKey(MONDAY, 'week')).toBe('2024-03-04');
    // Sunday belongs to the week that started the preceding Monday.
    expect(bucketKey(Date.UTC(2024, 2, 10, 23, 0, 0), 'week')).toBe('2024-03-04');
    expect(bucketKey(Date.UTC(2024, 2, 11, 0, 0, 0), 'week')).toBe('2024-03-11');
  });

  test('month buckets are UTC calendar months', () => {
    expect(bucketKey(WEDNESDAY, 'month')).toBe('2024-03');
    expect(bucketKey(Date.UTC(2024, 11, 31, 23, 0, 0), 'month')).toBe('2024-12');
  });

  test('bucketLabel mirrors bucketKey for display keys', () => {
    expect(bucketLabel(WEDNESDAY, 'day')).toBe('2024-03-06');
    expect(bucketLabel(new Date(WEDNESDAY), 'week')).toBe('2024-03-04');
  });
});

describe('enumerateBuckets', () => {
  test('produces every day boundary inclusively', () => {
    expect(enumerateBuckets(Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 7), 'day')).toEqual([
      '2024-03-04',
      '2024-03-05',
      '2024-03-06',
      '2024-03-07'
    ]);
  });

  test('steps weeks by seven days from the first Monday', () => {
    expect(enumerateBuckets(Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 20), 'week')).toEqual([
      '2024-03-04',
      '2024-03-11',
      '2024-03-18'
    ]);
  });

  test('steps months across a year boundary', () => {
    expect(enumerateBuckets(Date.UTC(2023, 10, 15), Date.UTC(2024, 1, 2), 'month')).toEqual([
      '2023-11',
      '2023-12',
      '2024-01',
      '2024-02'
    ]);
  });

  test('returns nothing when the range is inverted', () => {
    expect(enumerateBuckets(Date.UTC(2024, 2, 7), Date.UTC(2024, 2, 4), 'day')).toEqual([]);
  });
});

describe('fillMissingBuckets', () => {
  test('inserts explicit zero buckets across the whole axis', () => {
    const filled = fillMissingBuckets(
      [
        { bucket: '2024-03-05', value: 3 },
        { bucket: '2024-03-07', value: 5 }
      ],
      Date.UTC(2024, 2, 4),
      Date.UTC(2024, 2, 8),
      'day'
    );
    expect(filled).toEqual([
      { bucket: '2024-03-04', value: 0 },
      { bucket: '2024-03-05', value: 3 },
      { bucket: '2024-03-06', value: 0 },
      { bucket: '2024-03-07', value: 5 },
      { bucket: '2024-03-08', value: 0 }
    ]);
  });

  test('keeps an existing zero and never duplicates a bucket', () => {
    const filled = fillMissingBuckets(
      [
        { bucket: '2024-03-06', value: 0 },
        { bucket: '2024-03-06', value: 4 }
      ],
      Date.UTC(2024, 2, 6),
      Date.UTC(2024, 2, 6),
      'day'
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]?.value).toBe(4);
  });

  test('an empty result still yields a continuous zero axis', () => {
    const filled = fillMissingBuckets([], Date.UTC(2024, 2, 4), Date.UTC(2024, 2, 5), 'day');
    expect(filled.map((row) => row.value)).toEqual([0, 0]);
  });
});
