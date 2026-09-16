/**
 * Application bootstrap.
 *
 * One function wires the whole system together, in dependency order, exactly once
 * per process:
 *
 *  1. migrations (so a fresh clone only ever needs one command);
 *  2. cross-module locators (ticket/file services, filter compiler, provider
 *     lookup, HTTP tool invoker, file extraction provider);
 *  3. durable job handlers (execution, files, triggers, maintenance);
 *  4. native tool registration on the shared registry;
 *  5. the in-process worker.
 *
 * Everything here is idempotent. SvelteKit calls `ensureBootstrapped()` from
 * `hooks.server.ts`, so a request that arrives before startup finishes waits for
 * the same promise rather than racing it.
 *
 * Why locators rather than direct imports: several modules legitimately need to
 * call each other in both directions (tickets ↔ files ↔ triggers, execution ↔
 * http). Injecting the implementations here keeps every module's imports
 * one-directional and makes the full dependency graph readable in one file.
 */
import { eq, sql } from 'drizzle-orm';
import { env, workerEnabled } from './config/env';
import { systemActor } from './core/context';
import { errors } from './core/errors';
import { moduleLogger, rootLogger } from './core/logger';
import { type Executor, getDatabaseHandle, getDb, withTransaction } from './db/client';
import { runMigrations } from './db/migrate';
import { models } from './db/schema';
import { registerExecutionJobHandlers } from './execution/engine';
import { setProviderLookup } from './execution/provider-lookup';
import { setFileExtractionProvider } from './files/fields';
import { registerFileJobHandlers } from './files/handlers';
import { installFileService } from './files/service';
import { compileTicketFilterDetailed } from './filters/compile';
import { executeOperation } from './http/runtime';
import { getProviderForModel } from './providers/registry';
import { setTicketFilterCompiler } from './tickets/query';
import { installTicketService } from './tickets/service';
import { setHttpToolInvoker } from './tools/http-locator';
import { registerNativeTools } from './tools/native';
import { registerCoreNativeTools } from './tools/native/register';
import { getDefaultToolRegistry, resetToolRegistry } from './tools/registry';
import { scheduleDueTriggers } from './triggers/cron';
import { registerTriggerJobHandlers } from './triggers/handlers';

const log = moduleLogger('bootstrap');

let bootstrapPromise: Promise<BootstrapResult> | null = null;

export interface BootstrapResult {
  workerId: string | null;
  registeredJobTypes: string[];
  nativeToolCount: number;
}

export function isBootstrapped(): boolean {
  return bootstrapPromise !== null;
}

/** Test/reset helper: forget the bootstrap so the next call re-runs it. */
export function resetBootstrap(): void {
  bootstrapPromise = null;
}

/**
 * Run bootstrap once. Concurrent callers share the same promise, so a request that
 * races startup cannot observe a half-wired system.
 */
export function ensureBootstrapped(): Promise<BootstrapResult> {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((error) => {
      // A failed bootstrap must not be cached: the next request should retry
      // rather than serve a permanently broken process.
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

export interface RunBootstrapOptions {
  db?: Executor;
  sqlite?: import('bun:sqlite').Database;
  /** Force-enable/disable the in-process worker regardless of the environment. */
  startWorker?: boolean;
  /** Skip migrations (tests apply their own). */
  skipMigrations?: boolean;
}

export async function runBootstrap(options: RunBootstrapOptions = {}): Promise<BootstrapResult> {
  const startedAt = Date.now();
  const handle = options.db ? null : getDatabaseHandle();
  const db = options.db ?? handle!.db;
  const sqlite = options.sqlite ?? handle!.sqlite;

  if (!options.skipMigrations) {
    runMigrations(db, sqlite);
  }

  installLocators(db);
  registerHandlers();
  const nativeToolCount = registerTools();

  const shouldStartWorker = options.startWorker ?? workerEnabled();
  let workerId: string | null = null;
  if (shouldStartWorker) {
    workerId = await startBackgroundWorker(db);
  }

  const registeredJobTypes = (await import('./jobs/handlers')).registeredJobTypes();

  log.info('bootstrap complete', {
    workerId,
    jobTypes: registeredJobTypes.length,
    nativeTools: nativeToolCount,
    ms: Date.now() - startedAt
  });

  return { workerId, registeredJobTypes, nativeToolCount };
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * Install the cross-module implementations.
 *
 * Order matters only in that each installer must not *call* another module during
 * installation; they only record a reference.
 */
export function installLocators(db: Executor): void {
  const dbFactory = (): Executor => db;

  // Tickets
  installTicketService(dbFactory);

  // The analytics filter compiler becomes the single implementation used by the
  // board, the list, saved views and dashboard widgets, so they cannot drift
  // (ADR-0012). It is async because it resolves field definitions first.
  setTicketFilterCompiler({
    compile(executor, { workspaceId, filter }) {
      return compileTicketFilterDetailed(executor, { workspaceId, filter });
    }
  });

  // Files
  installFileService({ db });

  // Providers
  setProviderLookup((executor, input) => Promise.resolve(getProviderForModel(executor, input)));

  // File extraction uses the same provider registry as agent runs. The extraction
  // seam carries only the model identifier, so it is resolved back to a workspace
  // here rather than duplicating provider selection in the files module.
  setFileExtractionProvider({
    type: 'registry',
    name: 'Mentat provider registry',
    async generate(request) {
      const modelRow =
        db
          .select({ id: models.id, workspaceId: models.workspaceId })
          .from(models)
          .where(eq(models.id, request.model))
          .limit(1)
          .all()[0] ??
        db
          .select({ id: models.id, workspaceId: models.workspaceId })
          .from(models)
          .where(eq(models.modelKey, request.model))
          .limit(1)
          .all()[0];
      if (!modelRow) {
        throw errors.precondition(
          'No model is configured for file extraction. Register a model on a provider first.',
          { requested: request.model }
        );
      }
      const resolved = getProviderForModel(db, {
        workspaceId: modelRow.workspaceId,
        modelId: modelRow.id
      });
      return resolved.provider.generate(request);
    }
  });

  // HTTP operations are reachable from agent tools.
  setHttpToolInvoker(async (executor, invocation) => {
    const result = await executeOperation({
      db: executor,
      actor: invocation.actor,
      operationId: invocation.operationId,
      serviceId: invocation.serviceId ?? undefined,
      input: invocation.input,
      runId: invocation.runId ?? null,
      stepId: invocation.stepId ?? null,
      overrides: { approval: 'bypass' }
    });
    if (result.approvalRequired) {
      return {
        ok: false,
        error: {
          code: 'approval_required',
          message: result.approvalRequired.reason,
          details: { operationKey: result.approvalRequired.operationKey }
        },
        durationMs: result.latencyMs,
        metadata: { logId: result.logId }
      };
    }
    return {
      ok: result.ok,
      output: result.output,
      status: result.status ?? undefined,
      error: result.error,
      cacheStatus: result.cacheStatus,
      durationMs: result.latencyMs,
      attempts: result.attempts,
      metadata: { logId: result.logId, retryTrace: result.retryTrace }
    };
  });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

export function registerHandlers(): void {
  // `maintenance.reap` is registered by the execution engine because it crosses
  // job, approval and session boundaries.
  registerExecutionJobHandlers();
  registerFileJobHandlers();
  registerTriggerJobHandlers();
}

// ---------------------------------------------------------------------------
// Native tools
// ---------------------------------------------------------------------------

export function registerTools(): number {
  // A fresh registry at bootstrap keeps a restart deterministic and makes a
  // duplicate registration fatal (which is what we want to hear about).
  resetToolRegistry();
  const registry = getDefaultToolRegistry();
  registerNativeTools(registry);
  registerCoreNativeTools(registry);
  return registry.list().length;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function startBackgroundWorker(db: Executor): Promise<string> {
  const { runWorker } = await import('./jobs/worker');
  const handle = await runWorker({ db });
  // Start the cron scheduler alongside the worker: it only enqueues durable jobs,
  // so it is safe for it to run in the same process.
  startScheduler(db);
  log.info('worker started', { workerId: handle.workerId });
  return handle.workerId;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The scheduler ticks every 30 seconds and claims due cron slots with a
 * compare-and-swap, so running two processes never double-fires a schedule.
 */
export function startScheduler(db: Executor, intervalMs = 30_000): void {
  if (schedulerTimer) return;
  const tick = async () => {
    try {
      await scheduleDueTriggers(db);
    } catch (error) {
      rootLogger.error('cron scheduler tick failed', { error });
    }
  };
  schedulerTimer = setInterval(() => void tick(), intervalMs);
  // Do not hold the event loop open on shutdown.
  schedulerTimer.unref?.();
  void tick();
}

export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/** Enqueue the recurring maintenance job (called by the scheduler or an operator). */
export async function enqueueMaintenance(db: Executor = getDb()): Promise<void> {
  const workspaces = await db.select({ id: sql<string>`id` }).from(sql`workspaces`).all();
  const { enqueueJobSync } = await import('./jobs/queue');
  for (const workspace of workspaces) {
    await withTransaction(db, (tx) =>
      enqueueJobSync(tx as Executor, {
        workspaceId: workspace.id,
        type: 'maintenance.reap',
        payload: {},
        delayMs: 1_000,
        dedupeKey: `maintenance.reap:${workspace.id}`,
        actorType: 'system'
      })
    );
  }
  log.debug('maintenance jobs enqueued', { workspaces: workspaces.length });
}

/** Fail fast in production when a required secret master key is missing. */
export function assertProductionConfig(): void {
  if (env().NODE_ENV !== 'production') return;
  if (!env().MENTAT_MASTER_KEY) {
    throw errors.precondition(
      'MENTAT_MASTER_KEY must be set in production: secrets cannot be stored under a generated local key'
    );
  }
}
