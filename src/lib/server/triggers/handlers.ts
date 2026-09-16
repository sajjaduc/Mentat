/**
 * Durable trigger job handlers.
 *
 * Why: receiving a webhook or claiming a cron slot only persists an event; this
 * module is where the event becomes work. Registering both trigger job types here
 * means the worker has exactly one implementation of "process a trigger event",
 * and a missing registration fails loudly at bootstrap rather than silently
 * retrying.
 */
import { errors } from '../core/errors';
import { getJobHandler, type JobHandler, payloadOf, registerJobHandler } from '../jobs/handlers';
import { processTriggerEvent } from './events';

/** Job types that route into {@link processTriggerEvent}. */
export const TRIGGER_JOB_TYPES = ['trigger.webhook', 'trigger.cron'] as const;
export type TriggerJobType = (typeof TRIGGER_JOB_TYPES)[number];

const handler: JobHandler = async ({ job, db }) => {
  const payload = payloadOf<{ eventId?: unknown }>(job);
  if (typeof payload.eventId !== 'string' || payload.eventId.length === 0) {
    throw errors.validation(`Trigger job ${job.id} (${job.type}) is missing its eventId`, {
      jobId: job.id,
      type: job.type
    });
  }
  const result = await processTriggerEvent(db, payload.eventId);
  return {
    result,
    // A duplicate delivery is a success, not a failure worth retrying.
    skipRetry: result.status === 'duplicate'
  };
};

/**
 * Register the trigger handlers. Idempotent: bootstrap may call it once, and
 * tests may call it after installing fakes, without a duplicate-registration
 * crash.
 */
export function registerTriggerJobHandlers(): void {
  for (const type of TRIGGER_JOB_TYPES) {
    if (getJobHandler(type)) continue;
    registerJobHandler(type, handler);
  }
}
