/**
 * Error taxonomy.
 *
 * Every failure that can reach an HTTP boundary or be persisted on a job/run is
 * expressed as an `AppError` with a stable machine-readable `code`. Domain code
 * throws these; the API layer converts them into responses with the right status
 * and never leaks internals for unexpected errors.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'precondition_failed'
  | 'rate_limited'
  | 'timeout'
  | 'dependency_failed'
  | 'provider_error'
  | 'policy_denied'
  | 'human_gate_required'
  | 'approval_required'
  | 'invalid_state_transition'
  | 'quota_exceeded'
  | 'unsupported'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  timeout: 504,
  dependency_failed: 502,
  provider_error: 502,
  policy_denied: 403,
  human_gate_required: 409,
  approval_required: 409,
  invalid_state_transition: 409,
  quota_exceeded: 402,
  unsupported: 501,
  internal: 500
};

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Whether a retry of the same logical operation could plausibly succeed. */
  retryable?: boolean;
  /** Stable, non-sensitive message safe to persist in audit/job records. */
  publicMessage?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly publicMessage: string;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? isRetryableCode(code);
    this.publicMessage = options.publicMessage ?? message;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      status: this.status,
      message: this.publicMessage,
      details: this.details,
      retryable: this.retryable
    };
  }
}

function isRetryableCode(code: ErrorCode): boolean {
  return (
    code === 'timeout' ||
    code === 'dependency_failed' ||
    code === 'provider_error' ||
    code === 'rate_limited' ||
    code === 'internal'
  );
}

export const errors = {
  badRequest: (message: string, details?: Record<string, unknown>) =>
    new AppError('bad_request', message, { details }),
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError('validation_failed', message, { details }),
  unauthorized: (message = 'Authentication required') => new AppError('unauthorized', message),
  forbidden: (message = 'Not permitted', details?: Record<string, unknown>) =>
    new AppError('forbidden', message, { details }),
  notFound: (entity: string, id?: string) =>
    new AppError('not_found', id ? `${entity} ${id} not found` : `${entity} not found`, {
      details: { entity, id }
    }),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError('conflict', message, { details }),
  versionConflict: (entity: string, expected: number, actual: number) =>
    new AppError('version_conflict', `${entity} was modified by another writer`, {
      details: { expected, actual },
      retryable: true
    }),
  precondition: (message: string, details?: Record<string, unknown>) =>
    new AppError('precondition_failed', message, { details }),
  policyDenied: (message: string, details?: Record<string, unknown>) =>
    new AppError('policy_denied', message, { details }),
  humanGate: (message: string, details?: Record<string, unknown>) =>
    new AppError('human_gate_required', message, { details }),
  approvalRequired: (message: string, details?: Record<string, unknown>) =>
    new AppError('approval_required', message, { details }),
  invalidTransition: (message: string, details?: Record<string, unknown>) =>
    new AppError('invalid_state_transition', message, { details }),
  timeout: (message: string, details?: Record<string, unknown>) =>
    new AppError('timeout', message, { details }),
  dependency: (message: string, details?: Record<string, unknown>) =>
    new AppError('dependency_failed', message, { details }),
  provider: (message: string, details?: Record<string, unknown>) =>
    new AppError('provider_error', message, { details }),
  unsupported: (message: string, details?: Record<string, unknown>) =>
    new AppError('unsupported', message, { details }),
  internal: (message: string, details?: Record<string, unknown>) =>
    new AppError('internal', message, { details })
};

/** Normalize any thrown value into an AppError without leaking internals. */
export function toAppError(value: unknown): AppError {
  if (value instanceof AppError) return value;
  if (value instanceof Error) {
    return new AppError('internal', value.message, {
      cause: value,
      publicMessage: 'An unexpected error occurred'
    });
  }
  return new AppError('internal', typeof value === 'string' ? value : 'Unknown error', {
    publicMessage: 'An unexpected error occurred'
  });
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
