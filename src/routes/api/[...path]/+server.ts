/**
 * SvelteKit API adapter.
 *
 * A single catch-all route delegates to the router. Everything that makes a
 * request trustworthy — bootstrapping, session resolution, workspace scoping — is
 * established once in `server/request-context.ts`, so an API handler can never see
 * a partially-initialized system.
 */
import type { RequestHandler } from '@sveltejs/kit';
import { apiIndex, dispatchApi } from '$server/api/router';
import { resolveRequestContext, toResponse } from '$server/request-context';

function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    out[key] = value;
  }
  return out;
}

export const fallback: RequestHandler = async () => {
  return new Response(
    JSON.stringify({
      error: {
        code: 'not_found',
        message: 'No API route matches this request'
      }
    }),
    { status: 404, headers: { 'content-type': 'application/json' } }
  );
};

export const GET: RequestHandler = handle;
export const POST: RequestHandler = handle;
export const PUT: RequestHandler = handle;
export const PATCH: RequestHandler = handle;
export const DELETE: RequestHandler = handle;

async function handle(event: Parameters<RequestHandler>[0]): Promise<Response> {
  const context = await resolveRequestContext(event);

  // The API index is public and useful for debugging a local instance.
  if (event.url.pathname === '/api' || event.url.pathname === '/api/') {
    return new Response(JSON.stringify({ routes: apiIndex() }), {
      headers: { 'content-type': 'application/json' }
    });
  }

  const rawBody =
    event.request.method === 'GET' || event.request.method === 'HEAD'
      ? undefined
      : await event.request
          .clone()
          .text()
          .catch(() => undefined);

  const result = await dispatchApi({
    db: context.db,
    method: event.request.method,
    pathname: event.url.pathname,
    actor: context.actor,
    query: queryObject(event.url),
    rawBody,
    request: event.request
  });

  return toResponse(result);
}
