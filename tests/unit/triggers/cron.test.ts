/**
 * Cron next-run determinism.
 *
 * The scheduler must be reproducible and timezone-aware: the same expression and
 * reference instant always produce the same instant, and an IANA timezone follows
 * daylight-saving transitions instead of drifting by an hour.
 */
import { describe, expect, test } from 'bun:test';
import { isAppError } from '../../../src/lib/server/core/errors';
import { computeNextRun } from '../../../src/lib/server/triggers/cron';

describe('triggers/cron computeNextRun', () => {
  test('is deterministic for a fixed reference instant', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0);
    const first = computeNextRun('0 9 * * *', 'UTC', from);
    const second = computeNextRun('0 9 * * *', 'UTC', from);
    expect(first).toBe(Date.UTC(2024, 0, 1, 9, 0, 0));
    expect(second).toBe(first);
  });

  test('defaults to UTC when no timezone is given', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(computeNextRun('0 9 * * *', null, from)).toBe(computeNextRun('0 9 * * *', 'UTC', from));
  });

  test('follows IANA DST transitions rather than a fixed offset', () => {
    const winter = computeNextRun('0 12 * * *', 'America/New_York', Date.UTC(2024, 0, 15));
    const summer = computeNextRun('0 12 * * *', 'America/New_York', Date.UTC(2024, 2, 15));
    // Noon is 17:00Z in EST and 16:00Z in EDT.
    expect(winter).toBe(Date.UTC(2024, 0, 15, 17, 0));
    expect(summer).toBe(Date.UTC(2024, 2, 15, 16, 0));
  });

  test('handles the spring-forward gap without drifting', () => {
    // 02:30 local does not exist on 2024-03-10 in New York; the next occurrence
    // is the same wall-clock slot on the following day.
    const skipped = computeNextRun('30 2 * * *', 'America/New_York', Date.UTC(2024, 2, 10, 8));
    expect(skipped).toBe(Date.UTC(2024, 2, 11, 6, 30));
  });

  test('honours a non-US timezone offset', () => {
    expect(computeNextRun('0 9 * * *', 'Europe/London', Date.UTC(2024, 5, 1))).toBe(
      Date.UTC(2024, 5, 1, 8, 0)
    );
  });

  test('rejects an invalid expression with a validation error', () => {
    try {
      computeNextRun('not a cron', 'UTC', Date.now());
      throw new Error('expected computeNextRun to throw');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('validation_failed');
        expect(error.details).toMatchObject({ expression: 'not a cron' });
      }
    }
  });

  test('rejects an invalid timezone', () => {
    expect(() => computeNextRun('0 9 * * *', 'Mars/Olympus', Date.now())).toThrow();
  });

  test('supports step and range expressions', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(computeNextRun('*/15 * * * *', 'UTC', from)).toBe(Date.UTC(2024, 0, 1, 0, 15));
    expect(computeNextRun('0 9 * * 1-5', 'UTC', Date.UTC(2024, 0, 6))).toBe(
      Date.UTC(2024, 0, 8, 9)
    );
  });
});
