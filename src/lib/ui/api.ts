/**
 * Typed API client.
 *
 * One place knows how to talk to the router: JSON in/out, error shaping, request
 * ids. Browser code calls `api.get('/tickets')` and gets either data or a thrown
 * `ApiError` with a stable code, which is what lets every screen render the same
 * quality of error state.
 *
 * `mutate` wraps a write in an optimistic update: apply locally, call the server,
 * and roll back on failure while surfacing the reason. That is the mechanism
 * behind "the board should feel like a live workbench rather than CRUD forms".
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? {};
    this.requestId = body.requestId ?? null;
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.code === 'version_conflict';
  }

  /** True when the failure is the user's to fix (validation, permission, conflict). */
  get actionable(): boolean {
    return this.status < 500;
  }
}

type QueryValue = string | number | boolean | null | undefined;

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path, globalThis.location?.origin ?? 'http://localhost');
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

async function request<T>(
  method: string,
  path: string,
  options: {
    query?: Record<string, QueryValue>;
    body?: unknown;
    signal?: AbortSignal;
    formData?: FormData;
  } = {}
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    signal: options.signal
  };
  if (options.formData) {
    init.body = options.formData;
  } else if (options.body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(0, {
      code: 'network_error',
      message: 'Mentat could not be reached. Is the server still running?'
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed = text.length > 0 ? safeJson(text) : null;

  if (!response.ok) {
    const body = (parsed as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      body ?? {
        code: 'unexpected_error',
        message: `Request failed with status ${response.status}`
      }
    );
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'invalid_response', message: text.slice(0, 500) } };
  }
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string, query?: Record<string, QueryValue>) =>
    request<T>('DELETE', path, { query }),
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, { formData })
};

export interface OptimisticOptions<T> {
  /** Apply the change locally; the returned value is used as the rollback snapshot. */
  optimistic?: () => undefined | (() => void);
  /** Called with the server's response when it succeeds. */
  onSuccess?: (result: T) => void;
  /** Called with the error body when it fails, after the rollback ran. */
  onError?: (error: ApiError) => void;
}

/**
 * Run a write with an optimistic update and automatic rollback.
 *
 * The rollback is a callback returned by `optimistic`, which keeps the caller in
 * charge of restoring exactly the state it changed — no shadow copies of the whole
 * store, and no chance of the library "helpfully" restoring the wrong thing.
 */
export async function mutateOptimistic<T>(
  run: () => Promise<T>,
  options: OptimisticOptions<T> = {}
): Promise<T | null> {
  const rollback = options.optimistic?.();
  try {
    const result = await run();
    options.onSuccess?.(result);
    return result;
  } catch (error) {
    if (typeof rollback === 'function') rollback();
    if (error instanceof ApiError) {
      options.onError?.(error);
      return null;
    }
    throw error;
  }
}

/** Human-readable summary of an API failure, used by toasts and inline errors. */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'validation_failed' && error.details.issues) {
      const issues = error.details.issues as Array<{ path?: string; message?: string }>;
      const first = issues[0];
      if (first?.message) {
        return first.path ? `${first.path}: ${first.message}` : first.message;
      }
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
