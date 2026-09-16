/**
 * Server hooks.
 *
 * Bootstrapping happens on the first request, so `bun run dev` needs no separate
 * initialization step. Session resolution populates `locals` for page loaders; API
 * routes resolve their own context through the same module.
 *
 * Errors are converted into redacted JSON/HTML responses here so an unexpected
 * failure never leaks a stack trace or a secret to the browser.
 */
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { assertProductionConfig, ensureBootstrapped } from '$server/bootstrap';
import { isAppError, toAppError } from '$server/core/errors';
import { moduleLogger } from '$server/core/logger';
import { resolveRequestContext } from '$server/request-context';

const log = moduleLogger('hooks');

export const handle: Handle = async ({ event, resolve }) => {
  try {
    assertProductionConfig();
    const context = await resolveRequestContext(event);
    event.locals.actor = context.actor;
    event.locals.userId = context.userId;
    event.locals.sessionId = context.sessionId;
    event.locals.workspaceId = context.workspaceId;
    event.locals.requestId = context.requestId;

    const response = await resolve(event);
    response.headers.set('x-request-id', context.requestId);
    // Local-first deployment: no third-party assets, so a strict policy is cheap.
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'same-origin');
    return response;
  } catch (error) {
    const appError = toAppError(error);
    log.error('request failed', { url: event.url.pathname, error });
    if (event.url.pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({
          error: {
            code: appError.code,
            message: appError.message,
            details: appError.details
          }
        }),
        {
          status: appError.status,
          headers: { 'content-type': 'application/json; charset=utf-8' }
        }
      );
    }
    throw error;
  }
};

export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const appError = isAppError(error) ? error : toAppError(error);
  log.error('unhandled error', { url: event.url.pathname, status, error });
  return {
    // A safe, non-leaking message for the error page; the real error is logged.
    message: status >= 500 ? 'Something went wrong. The failure was recorded.' : appError.message,
    code: appError.code,
    requestId: event.locals.requestId,
    details: status >= 500 ? undefined : appError.details
  };
};

/** Warm the system up before the first request in production. */
export function init(): void {
  void ensureBootstrapped().catch((error) => {
    log.error('bootstrap failed during init', { error });
  });
}
