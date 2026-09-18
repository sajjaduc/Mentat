import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  cycleTimeReport,
  throughputSeries,
  timeInStateReport
} from '../../../src/lib/server/analytics/aging';
import type { Executor } from '../../../src/lib/server/db/client';
import { workflowItemStateHistory } from '../../../src/lib/server/db/schema';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createWorkflow,
  createWorkflowItem,
  createWorkflowItemStateInterval,
  createWorkspace,
  updateWorkflowItemRow,
  type WorkflowFixture
} from '../../helpers/factories';

const DAY = 86_400_000;
const BASE = Date.UTC(2024, 2, 4);
const NOW = BASE + 400_000;

let handle: TestDatabase;
let db: Executor;
let workspaceId: string;
let workflow: WorkflowFixture;
const ids: Record<string, string> = {};

async function ticket(key: string): Promise<string> {
  const created = await createWorkflowItem(db, { workspaceId, workflow, title: key });
  ids[key] = created.id;
  await updateWorkflowItemRow(db, created.id, {
    createdAt: BASE,
    updatedAt: BASE,
    enteredStateAt: BASE,
    lastActivityAt: BASE
  });
  // The factory records the item's initial state entry; this suite seeds the exact
  // interval history it asserts on, so drop the automatic one.
  await db
    .delete(workflowItemStateHistory)
    .where(eq(workflowItemStateHistory.workflowItemId, created.id))
    .run();
  return created.id;
}

async function interval(
  key: string,
  state: string,
  enteredAt: number,
  exitedAt: number | null
): Promise<void> {
  await createWorkflowItemStateInterval(db, {
    workspaceId,
    workflowItemId: ids[key]!,
    workflowId: workflow.id,
    stateId: workflow.stateIds[state]!,
    stateName: state,
    enteredAt,
    exitedAt
  });
}

async function seed(): Promise<void> {
  handle = createTestDatabase();
  db = handle.db;
  const workspace = await createWorkspace(db, 'Aging WS');
  workspaceId = workspace.id;
  workflow = await createWorkflow(db, workspaceId, {
    states: [
      { name: 'Backlog', kind: 'manual', category: 'backlog', isStart: true },
      { name: 'Review', kind: 'manual', category: 'review' },
      { name: 'Done', kind: 'manual', category: 'done', isTerminal: true }
    ]
  });
  await ticket('t1');
  await ticket('t2');
  await ticket('t3');

  // Backlog: three closed intervals (100s, 200s, 300s) and one still open.
  await interval('t1', 'Backlog', BASE, BASE + 100_000);
  await interval('t2', 'Backlog', BASE, BASE + 200_000);
  await interval('t3', 'Backlog', BASE, BASE + 300_000);
  await interval('t1', 'Backlog', BASE, null);
  // Review: a single 50s interval.
  await interval('t1', 'Review', BASE + 100_000, BASE + 150_000);
  // A second-day interval for throughput.
  await interval('t2', 'Review', BASE + DAY, BASE + DAY + 100_000);
  // Terminal entries for cycle time.
  await interval('t1', 'Done', BASE + 500_000, null);
  await interval('t2', 'Done', BASE + 900_000, null);
}

beforeEach(seed);
afterEach(() => handle.cleanup());

describe('time in state', () => {
  test('reports entered, exited and currently-in counts per state', async () => {
    const report = await timeInStateReport(db, {
      workspaceId,
      stateIds: [workflow.stateIds.Backlog!, workflow.stateIds.Review!],
      now: NOW
    });
    const backlog = report.find((entry) => entry.stateName === 'Backlog');
    const review = report.find((entry) => entry.stateName === 'Review');
    expect(backlog).toMatchObject({ entered: 4, exited: 3, currentlyIn: 1 });
    // Review has two closed intervals (50s for t1, 100s for t2).
    expect(review).toMatchObject({ entered: 2, exited: 2, currentlyIn: 0 });
  });

  test('computes median, p90, average and max dwell time including open intervals', async () => {
    const report = await timeInStateReport(db, {
      workspaceId,
      stateIds: [workflow.stateIds.Backlog!],
      now: NOW
    });
    const backlog = report[0]!;
    // Durations: 100, 200, 300 and an open interval of 400s at `now`.
    expect(backlog.medianSeconds).toBe(250);
    expect(backlog.p90Seconds).toBeCloseTo(370, 6);
    expect(backlog.avgSeconds).toBe(250);
    expect(backlog.maxSeconds).toBe(400);

    const review = (
      await timeInStateReport(db, {
        workspaceId,
        stateIds: [workflow.stateIds.Review!],
        now: NOW
      })
    )[0]!;
    // [50, 100] -> median/avg 75, p90 95, max 100.
    expect(review.medianSeconds).toBe(75);
    expect(review.maxSeconds).toBe(100);
  });

  test('restricts intervals by the time window on entry', async () => {
    const report = await timeInStateReport(db, {
      workspaceId,
      stateIds: [workflow.stateIds.Review!],
      timeRange: {
        kind: 'absolute',
        from: BASE + DAY,
        to: BASE + DAY + 200_000,
        basis: 'entered_state'
      },
      now: NOW
    });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ entered: 1, exited: 1 });
    expect(report[0]?.medianSeconds).toBe(100);
  });
});

describe('cycle time', () => {
  test('measures creation to the first terminal entry', async () => {
    const report = await cycleTimeReport(db, { workspaceId });
    // t1 500s, t2 900s, t3 has no terminal entry.
    expect(report.count).toBe(2);
    expect(report.medianSeconds).toBe(700);
    expect(report.avgSeconds).toBe(700);
    expect(report.p90Seconds).toBeCloseTo(860, 6);
    expect(report.maxSeconds).toBe(900);
  });

  test('returns an empty summary when nothing reached a terminal state', async () => {
    const report = await cycleTimeReport(db, {
      workspaceId,
      timeRange: { kind: 'absolute', from: BASE + 10 * DAY, to: BASE + 20 * DAY }
    });
    expect(report.count).toBe(0);
    expect(report.medianSeconds).toBeNull();
  });
});

describe('throughput', () => {
  test('counts entries and exits per UTC bucket with explicit zeros', async () => {
    const series = await throughputSeries(db, { workspaceId, by: 'day' });
    const byBucket = new Map(series.map((point) => [point.bucket, point]));
    // Five non-terminal intervals enter on day one, plus two terminal entries;
    // four intervals exit that day (the open Backlog interval does not).
    expect(byBucket.get('2024-03-04')).toEqual({
      bucket: '2024-03-04',
      entered: 7,
      exited: 4
    });
    expect(byBucket.get('2024-03-05')).toEqual({
      bucket: '2024-03-05',
      entered: 1,
      exited: 1
    });
  });

  test('fills a zero bucket between activity days', async () => {
    const series = await throughputSeries(db, {
      workspaceId,
      by: 'day',
      timeRange: { kind: 'absolute', from: BASE, to: BASE + 3 * DAY }
    });
    const buckets = series.map((point) => point.bucket);
    expect(buckets).toEqual(['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07']);
    expect(series.find((point) => point.bucket === '2024-03-06')).toEqual({
      bucket: '2024-03-06',
      entered: 0,
      exited: 0
    });
  });
});
