#!/usr/bin/env bun
/**
 * Standalone worker.
 *
 * The web server runs an in-process worker by default, which is all a local
 * installation needs. This entry point exists for the case where you want the
 * server to stay responsive while a separate process chews through the queue — for
 * example while debugging a slow provider, or when running with
 * `MENTAT_WORKER_ENABLED=false`.
 *
 *   bun run worker                 # run until interrupted
 *   bun run worker --once          # drain the queue, then exit
 *   bun run worker --concurrency 8
 *   bun run worker --queue default --workspace <id>
 */
import { ensureBootstrapped } from '../lib/server/bootstrap';
import { env } from '../lib/server/config/env';
import { moduleLogger } from '../lib/server/core/logger';
import { getDb } from '../lib/server/db/client';
import { drainQueue, runWorker } from '../lib/server/jobs/worker';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const log = moduleLogger('worker.cli');

// Bootstrap installs the job handlers and tool registry. `startWorker: false` is
// deliberate: this process *is* the worker, so the in-process one would only compete
// with it for leases.
const boot = await ensureBootstrapped({ startWorker: false });
const db = getDb();

const concurrency = Number(flag('concurrency') ?? env().MENTAT_WORKER_CONCURRENCY);
const queue = flag('queue') ?? 'default';
const workspaceId = flag('workspace');

process.stdout.write(
  [
    '',
    'Mentat worker',
    `  workerId    : ${boot.workerId ?? '(none started by bootstrap)'}`,
    `  concurrency : ${concurrency}`,
    `  queue       : ${queue}`,
    `  workspace   : ${workspaceId ?? 'all'}`,
    `  job types   : ${boot.registeredJobTypes.length}`,
    '',
    ''
  ].join('\n')
);

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  process.stdout.write('\nStopping after the current jobs finish…\n');
});
process.on('SIGTERM', () => {
  stopping = true;
});

if (has('once')) {
  const processed = await drainQueue({
    db,
    concurrency,
    queue,
    workspaceId,
    maxJobs: Number(flag('max') ?? 10_000)
  });
  process.stdout.write(`Drained ${processed} job(s).\n`);
  process.exit(0);
}

const handle = await runWorker({
  db,
  concurrency,
  queue,
  workspaceId,
  idleTimeoutMs: has('idle') ? Number(flag('idle') ?? 5_000) : undefined,
  onJobFinished: ({ job, ok, error }) => {
    if (ok) {
      log.debug('job finished', { jobId: job.id, type: job.type });
    } else {
      log.warn('job failed', { jobId: job.id, type: job.type, error });
    }
  }
});

while (!stopping) {
  await Bun.sleep(500);
}

await handle.stop();
await handle.done;
process.stdout.write(`Stopped. Processed ${handle.processed()} job(s).\n`);
process.exit(0);
