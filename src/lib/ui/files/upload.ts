/**
 * File upload with real progress.
 *
 * The shared `api.upload` helper uses `fetch`, which reports no upload progress.
 * The Files screen owes the user a progress indicator, so this module uses
 * `XMLHttpRequest` — the one browser API that still emits upload progress — while
 * keeping the error contract identical: failures are thrown as `ApiError` with the
 * server's code, so `describeApiError` and toast handling are unchanged.
 *
 * The response is the server's `IngestFileResult`, including the honest
 * `deduplicated` flag. This module reports it verbatim; it never infers dedupe
 * from a hash it computed itself, because only the server knows whether the bytes
 * already existed for this workspace.
 */
import { ApiError } from '$ui/api';
import type { UploadResult } from '$ui/types';

export interface UploadOptions {
  file: File;
  workflowItemId?: string | null;
  recordId?: string | null;
  workflowId?: string | null;
  sourceType?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export function uploadFile(options: UploadOptions): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/files');
    request.withCredentials = true;
    request.setRequestHeader('accept', 'application/json');

    const form = new FormData();
    form.append('file', options.file, options.file.name);
    if (options.workflowItemId) form.append('workflowItemId', options.workflowItemId);
    if (options.recordId) form.append('recordId', options.recordId);
    if (options.workflowId) form.append('workflowId', options.workflowId);
    form.append('sourceType', options.sourceType ?? 'human_upload');

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });

    request.addEventListener('load', () => {
      const parsed = parseJson(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        resolve(parsed as UploadResult);
        return;
      }
      reject(apiErrorFrom(request.status, parsed));
    });

    request.addEventListener('error', () => {
      reject(
        new ApiError(0, {
          code: 'network_error',
          message: 'Mentat could not be reached. Is the server still running?'
        })
      );
    });

    request.addEventListener('abort', () => {
      reject(
        new ApiError(0, {
          code: 'upload_aborted',
          message: 'Upload was cancelled before it finished.'
        })
      );
    });

    const onExternalAbort = () => request.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    request.addEventListener('loadend', () =>
      options.signal?.removeEventListener('abort', onExternalAbort)
    );

    request.send(form);
  });
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiErrorFrom(status: number, parsed: unknown): ApiError {
  const body = (parsed as { error?: { code: string; message: string } } | null)?.error;
  return new ApiError(
    status,
    body ?? { code: 'unexpected_error', message: `Upload failed with status ${status}` }
  );
}
