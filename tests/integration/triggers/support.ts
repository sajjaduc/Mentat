/**
 * Shared helpers for trigger integration tests.
 *
 * Not a `.test.ts` file, so bun test does not collect it; it exists so the
 * webhook/manual/handler suites drive jobs through the same registered handler
 * path instead of re-implementing it three times.
 */
import type { Executor } from '../../../src/lib/server/db/client';
import { requireJobHandler } from '../../../src/lib/server/jobs/handlers';
import { SqliteJobQueue } from '../../../src/lib/server/jobs/queue';

/**
 * Lease and run every pending job once through the registered handler.
 * Returns how many jobs were processed.
 */
export async function runPendingJobs(db: Executor, workerId = 'test-worker'): Promise<number> {
  const queue = new SqliteJobQueue(db);
  let processed = 0;
  for (;;) {
    const job = await queue.lease({ workerId });
    if (!job) break;
    const handler = requireJobHandler(job.type);
    await handler({
      job,
      db,
      workerId,
      heartbeat: async () => {},
      signal: new AbortController().signal
    });
    processed += 1;
  }
  return processed;
}
