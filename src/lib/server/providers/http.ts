/**
 * Shared HTTP plumbing for provider implementations.
 *
 * Three concerns are easy to get subtly wrong and dangerous to duplicate, so they
 * live here once:
 *
 *  1. **Cancellation.** A caller's abort signal must be combined with a request
 *     timeout. `AbortSignal.any` exists in Bun 1.3, but combining manually keeps
 *     the "was this a timeout or a user cancel?" distinction explicit, which the
 *     health and streaming paths depend on.
 *  2. **Readable failures.** Every transport and status failure becomes a
 *     `ProviderUnavailableError`. Bodies are truncated and passed through the
 *     process-wide redactor so an upstream that echoes a credential cannot leak
 *     it into logs or run records.
 *  3. **Line framing.** Ollama NDJSON and provider SSE both need "yield complete
 *     lines, flush a trailing partial line, cancel the reader on exit".
 */
import { createRedactor } from '../core/redaction';
import { registeredSecretValues } from '../core/secret-registry';
import { ProviderUnavailableError } from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const SNIPPET_LIMIT = 400;

export interface CombinedSignal {
  signal: AbortSignal;
  /** True when the signal fired because the timeout elapsed. */
  timedOut(): boolean;
  /**
   * Drop the timeout while still forwarding the caller's abort. Used once a
   * streaming response's headers arrive so a long generation is not cut off.
   */
  stopTimeout(): void;
  cleanup(): void;
}

/**
 * Combine a caller signal with an optional timeout into one signal.
 * The caller must invoke `cleanup()` when the request settles to release the
 * timer and listener.
 */
export function combineAbortSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined
): CombinedSignal {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => controller.abort();
  const listeners: Array<[AbortSignal, () => void]> = [];
  if (caller) {
    if (caller.aborted) {
      controller.abort();
    } else {
      caller.addEventListener('abort', onAbort, { once: true });
      listeners.push([caller, onAbort]);
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const stopTimeout = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    stopTimeout,
    cleanup() {
      stopTimeout();
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
      listeners.length = 0;
    }
  };
}

/** Strip inline credentials the redactor knows about, including registered values. */
export function sanitizeProviderMessage(text: string): string {
  return createRedactor(registeredSecretValues()).string(text);
}

/** Trim and bound an upstream body so error messages stay readable. */
export function truncateSnippet(text: string, limit = SNIPPET_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

/** Remove userinfo from a URL before it is ever put in a message or detail. */
export function sanitizeProviderUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function safeUrl(url: string): string {
  return sanitizeProviderMessage(sanitizeProviderUrl(url));
}

export function httpErrorMessage(status: number, body: string, url: string): string {
  const snippet = truncateSnippet(sanitizeProviderMessage(body));
  const detail = snippet.length > 0 ? `: ${snippet}` : '';
  return `Provider request to ${safeUrl(url)} failed with HTTP ${status}${detail}`;
}

/** Extract the HTTP status recorded on a non-2xx `ProviderUnavailableError`. */
export function providerHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof ProviderUnavailableError)) return undefined;
  const detail = error.detail;
  if (
    detail &&
    typeof detail === 'object' &&
    typeof (detail as { status?: unknown }).status === 'number'
  ) {
    return (detail as { status: number }).status;
  }
  return undefined;
}

export interface ProviderHttpOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Resolved API key; attached as `apiKeyHeader` with `apiKeyPrefix`. */
  apiKey?: string | null;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
}

function buildHeaders(options: ProviderHttpOptions): Record<string, string> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.apiKey) {
    const header = (options.apiKeyHeader ?? 'authorization').toLowerCase();
    headers[header] = `${options.apiKeyPrefix ?? 'Bearer '}${options.apiKey}`;
  }
  if (options.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

function requestFailure(
  error: unknown,
  combined: CombinedSignal,
  timeoutMs: number | undefined,
  url: string
): ProviderUnavailableError {
  if (combined.timedOut()) {
    return new ProviderUnavailableError(
      `Provider request to ${safeUrl(url)} timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      { url: safeUrl(url), reason: 'timeout' }
    );
  }
  const message = error instanceof Error ? error.message : 'unknown transport error';
  return new ProviderUnavailableError(
    sanitizeProviderMessage(`Provider request to ${safeUrl(url)} failed: ${message}`),
    { url: safeUrl(url), reason: 'transport' }
  );
}

export interface ProviderHttpResponse {
  status: number;
  ok: boolean;
  text: string;
  headers: Headers;
}

/**
 * Perform a non-streaming request and return the raw body.
 * Transport failures and timeouts throw `ProviderUnavailableError`; HTTP error
 * statuses are returned so the caller can decide whether they mean degraded.
 */
export async function providerFetch(
  url: string,
  options: ProviderHttpOptions = {}
): Promise<ProviderHttpResponse> {
  const combined = combineAbortSignals(options.signal, options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: combined.signal
    });
  } catch (error) {
    combined.cleanup();
    throw requestFailure(error, combined, options.timeoutMs, url);
  }
  try {
    const text = await response.text();
    return { status: response.status, ok: response.ok, text, headers: response.headers };
  } catch (error) {
    throw requestFailure(error, combined, options.timeoutMs, url);
  } finally {
    combined.cleanup();
  }
}

/** `providerFetch` plus JSON parsing and non-2xx/parse failures as errors. */
export async function providerFetchJson<T>(
  url: string,
  options: ProviderHttpOptions = {}
): Promise<T> {
  const response = await providerFetch(url, options);
  if (!response.ok) {
    throw new ProviderUnavailableError(httpErrorMessage(response.status, response.text, url), {
      status: response.status
    });
  }
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ProviderUnavailableError(
      `Provider returned malformed JSON from ${safeUrl(url)} (HTTP ${response.status}): ${truncateSnippet(
        sanitizeProviderMessage(response.text)
      )}`,
      { status: response.status, reason: 'malformed_json' }
    );
  }
}

export interface ProviderStreamHandle {
  response: Response;
  cleanup(): void;
  abortedByCaller(): boolean;
}

/**
 * Open a streaming response. Non-2xx responses throw with a readable body snippet
 * before any bytes are consumed. The caller owns `cleanup()`.
 *
 * The timeout is a *connection* deadline: once headers arrive it is dropped so a
 * long generation is not cut off. Cancellation remains governed by the caller's
 * signal, and the job/run layer owns higher-level deadlines.
 */
export async function openProviderStream(
  url: string,
  options: ProviderHttpOptions = {}
): Promise<ProviderStreamHandle> {
  const combined = combineAbortSignals(options.signal, options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: buildHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: combined.signal
    });
  } catch (error) {
    combined.cleanup();
    throw requestFailure(error, combined, options.timeoutMs, url);
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // The body may already be gone; the status is still enough to report.
    }
    combined.cleanup();
    throw new ProviderUnavailableError(httpErrorMessage(response.status, body, url), {
      status: response.status
    });
  }

  combined.stopTimeout();
  return {
    response,
    cleanup: () => combined.cleanup(),
    abortedByCaller: () => Boolean(options.signal?.aborted)
  };
}

/**
 * Yield newline-delimited lines from a response body.
 *
 * A trailing line without a newline is still yielded, which is how providers
 * tolerate a final chunk that the server forgot to terminate. The reader is
 * cancelled on exit so an aborted consumer tears the socket down promptly.
 */
export async function* readLineStream(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderUnavailableError('Provider returned an empty response body');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        yield line;
        index = buffer.indexOf('\n');
      }
    }
    const tail = buffer.replace(/\r$/, '');
    if (tail.trim().length > 0) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be errored or closed; nothing left to release.
    }
  }
}
