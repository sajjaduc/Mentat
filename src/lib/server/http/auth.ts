/**
 * Authentication application.
 *
 * Credentials are *never* part of the operation definition a model can read: they
 * are secret references on the service. Resolution happens in the runtime, immediately
 * before the request, and this module is a pure function over already-resolved values.
 *
 * Splitting it this way matters for two reasons:
 *  1. it keeps decryption on exactly one path (the execution runtime), so no editor,
 *     tool listing or repository read can accidentally surface plaintext;
 *  2. it lets the runtime produce a safe, *redacted* mirror of every header and query
 *     parameter at the same moment it builds the real one — there is no code path that
 *     builds a request without also building its redacted twin, which is what the
 *     `http_request_logs` and audit rows persist.
 */

import { errors } from '../core/errors';
import { createRedactor, isSensitiveKey, REDACTED } from '../core/redaction';
import type { HttpAuthConfig, HttpAuthType } from '../db/schema';

export interface AuthServiceRef {
  authType: HttpAuthType;
  authConfig?: HttpAuthConfig | null;
  defaultHeaders?: Record<string, string> | null;
}

/** Already-decrypted values. The runtime is the only producer. */
export interface ResolvedAuthSecrets {
  /** `authConfig.secretId` (bearer, api key, custom header). */
  secret?: string | null;
  /** `authConfig.passwordSecretId` (basic). */
  password?: string | null;
}

export interface AppliedAuth {
  /** Real headers to send. Never persist these. */
  headers: Record<string, string>;
  /** Real query parameters to send. Never persist these. */
  query: Record<string, string>;
  /** Safe to persist in request logs and audit rows. */
  redactedHeaders: Record<string, string>;
  /** Safe to persist; a secret in a query string is still a secret. */
  redactedQuery: Record<string, string>;
}

const DEFAULT_API_KEY_HEADER = 'X-API-Key';
const DEFAULT_API_KEY_QUERY = 'api_key';
const DEFAULT_CUSTOM_HEADER = 'X-Auth';
const SECRET_PLACEHOLDER = '{{secret}}';

export function applyAuth(input: {
  service: AuthServiceRef;
  resolvedSecrets: ResolvedAuthSecrets;
}): AppliedAuth {
  const { service, resolvedSecrets } = input;
  const config = service.authConfig ?? {};
  const redactor = createRedactor([resolvedSecrets.secret, resolvedSecrets.password]);

  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  const redactedHeaders: Record<string, string> = {};
  const redactedQuery: Record<string, string> = {};

  for (const [key, value] of Object.entries(service.defaultHeaders ?? {})) {
    headers[key] = value;
    redactedHeaders[key] = isSensitiveKey(key) ? REDACTED : redactor.string(value);
  }

  switch (service.authType) {
    case 'none':
      break;
    case 'bearer': {
      const secret = requireSecret(service.authType, resolvedSecrets);
      headers.Authorization = `Bearer ${secret}`;
      redactedHeaders.Authorization = `Bearer ${REDACTED}`;
      break;
    }
    case 'api_key_header': {
      const secret = requireSecret(service.authType, resolvedSecrets);
      const name = config.headerName ?? DEFAULT_API_KEY_HEADER;
      headers[name] = secret;
      redactedHeaders[name] = REDACTED;
      break;
    }
    case 'api_key_query': {
      const secret = requireSecret(service.authType, resolvedSecrets);
      const name = config.queryName ?? DEFAULT_API_KEY_QUERY;
      query[name] = secret;
      redactedQuery[name] = REDACTED;
      break;
    }
    case 'basic': {
      if (!config.username) {
        throw errors.validation('Basic auth requires a username');
      }
      if (!config.passwordSecretId) {
        throw errors.validation('Basic auth requires a password secret reference');
      }
      const password = resolvedSecrets.password;
      if (!password) {
        throw errors.validation(
          `Basic auth secret "${config.passwordSecretId}" could not be resolved`
        );
      }
      const encoded = Buffer.from(`${config.username}:${password}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${encoded}`;
      redactedHeaders.Authorization = `Basic ${REDACTED}`;
      break;
    }
    case 'custom_header': {
      const secret = requireSecret(service.authType, resolvedSecrets);
      const name = config.headerName ?? DEFAULT_CUSTOM_HEADER;
      const template = config.template ?? SECRET_PLACEHOLDER;
      if (!template.includes(SECRET_PLACEHOLDER)) {
        throw errors.validation(
          `custom_header template must contain ${SECRET_PLACEHOLDER} for the secret`
        );
      }
      headers[name] = template.split(SECRET_PLACEHOLDER).join(secret);
      redactedHeaders[name] = template.split(SECRET_PLACEHOLDER).join(REDACTED);
      break;
    }
    default: {
      // Exhaustiveness: a new HttpAuthType must be handled explicitly rather than
      // silently sending an unauthenticated request.
      const exhaustive: never = service.authType;
      throw errors.unsupported(`Unsupported auth type: ${String(exhaustive)}`);
    }
  }

  return { headers, query, redactedHeaders, redactedQuery };
}

function requireSecret(authType: HttpAuthType, resolved: ResolvedAuthSecrets): string {
  if (!resolved.secret) {
    throw errors.validation(`Auth type "${authType}" requires a resolved secret`);
  }
  return resolved.secret;
}

/**
 * A redacted placeholder used when previewing a request before approval.
 *
 * Approval previews must not force decryption: showing the approver `Bearer [redacted]`
 * communicates exactly which auth mechanism is used without the runtime opening a
 * secret it may never need, and without writing a `secret.accessed` audit row for a
 * request that is still waiting for a human.
 */
export const PREVIEW_SECRET_PLACEHOLDER = REDACTED;
