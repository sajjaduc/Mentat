/**
 * Execution-time resolution of environment variables.
 *
 * Why this is a separate module from `config/environment.ts`: configuration must
 * be readable and renderable without ever producing plaintext (ADR-0020). Only
 * execution needs the value, and only this function may decrypt — it delegates to
 * `resolveSecretValue`, which registers the plaintext with the process redactor
 * and audits the access by secret id.
 */

import { resolveEnvironmentValue } from '../config/environment';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { resolveSecretValue } from './service';

export interface ResolvedEnvironmentSecret {
  key: string;
  value: string;
  source: 'workspace' | 'workflow' | 'default';
  secretId: string | null;
  isSecret: boolean;
  /** True when the value came from the redactor-registering secret path. */
  fromSecret: boolean;
}

/**
 * Resolve a variable for use inside a run. Returns `null` when nothing (not even
 * a default) is configured, so callers can raise a precise error rather than
 * acting on an empty string.
 */
export function resolveEnvironmentVariableWithSecret(
  db: Executor,
  options: {
    workspaceId: string;
    workflowId?: string | null;
    key: string;
    defaultValue?: string | null;
    runId?: string | null;
    purpose?: string;
  }
): ResolvedEnvironmentSecret | null {
  const resolved = resolveEnvironmentValue(db, {
    workspaceId: options.workspaceId,
    workflowId: options.workflowId,
    key: options.key,
    defaultValue: options.defaultValue
  });

  if (resolved.isSecret) {
    if (!resolved.secretId) {
      throw errors.validation(
        `Environment variable "${resolved.key}" is marked as a secret but references no secret`,
        { key: resolved.key }
      );
    }
    const value = resolveSecretValue(db, {
      workspaceId: options.workspaceId,
      secretId: resolved.secretId,
      runId: options.runId ?? null,
      purpose: options.purpose ?? 'environment'
    });
    return {
      key: resolved.key,
      value,
      source: resolved.source,
      secretId: resolved.secretId,
      isSecret: true,
      fromSecret: true
    };
  }

  if (resolved.value === null) return null;
  return {
    key: resolved.key,
    value: resolved.value,
    source: resolved.source,
    secretId: resolved.secretId,
    isSecret: false,
    fromSecret: false
  };
}
