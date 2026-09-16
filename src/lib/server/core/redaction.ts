/**
 * Secret redaction.
 *
 * Mentat has one hard invariant: secret plaintext must never reach model context,
 * logs, audit payloads, HTTP request logs, run snapshots or the browser. All
 * persistence paths that could capture arbitrary structures pass through these
 * helpers first.
 *
 * Redaction works on two axes:
 *  1. structural — known sensitive key names anywhere in a nested structure;
 *  2. value-based — registered secret values are masked wherever they appear,
 *     even embedded inside strings (headers, URLs, templates).
 */

export const REDACTED = '[redacted]';

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /apikey/i,
  /authorization/i,
  /auth[_-]?header/i,
  /credential/i,
  /private[_-]?key/i,
  /client[_-]?secret/i,
  /access[_-]?key/i,
  /refresh[_-]?token/i,
  /session/i,
  /cookie/i,
  /ciphertext/i,
  /master[_-]?key/i,
  /^key$/i,
  /bearer/i,
  /signature/i,
  /webhook[_-]?secret/i
];

/** Keys that look sensitive but are structural ids we intentionally keep visible. */
const KEY_ALLOWLIST = new Set([
  'secretId',
  'secret_id',
  'credentialSecretId',
  'apiKeySecretId',
  'keyVersion',
  'idempotencyKey',
  'dedupeKey',
  'cacheKey',
  'keyPrefix',
  'namespace',
  'key',
  'sortKey',
  'partitionKey',
  'storageKey',
  'actionKey',
  'operationKey',
  'fieldKey',
  'modelKey',
  'providerKey',
  'publicKey',
  'keyId',
  'webhookToken',
  'tokenPrefix',
  'sessionId',
  'cookiesRequired'
]);

export function isSensitiveKey(key: string): boolean {
  if (KEY_ALLOWLIST.has(key)) return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export interface Redactor {
  /** Mask registered plaintext values inside arbitrary strings. */
  string(value: string): string;
  /** Deep-clone a structure, masking sensitive keys and registered values. */
  value<T>(input: T, depth?: number): T;
  /** Register a plaintext value to be masked wherever it appears. */
  register(plaintext: string | null | undefined): void;
  hasRegistered(): boolean;
}

const MAX_DEPTH = 12;
const MIN_SECRET_LENGTH = 4;

export function createRedactor(initial: Iterable<string | null | undefined> = []): Redactor {
  const secrets = new Set<string>();
  const register = (plaintext: string | null | undefined) => {
    if (typeof plaintext === 'string' && plaintext.length >= MIN_SECRET_LENGTH) {
      secrets.add(plaintext);
    }
  };
  for (const value of initial) register(value);

  const string = (value: string): string => {
    let out = value;
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return maskInlineCredentials(out);
  };

  const value = <T>(input: T, depth = 0): T => {
    if (depth > MAX_DEPTH) return REDACTED as unknown as T;
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return string(input) as unknown as T;
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
      return input;
    }
    if (input instanceof Date) return input.toISOString() as unknown as T;
    if (input instanceof Error) {
      return {
        name: input.name,
        message: string(input.message),
        code: (input as { code?: string }).code
      } as unknown as T;
    }
    if (Array.isArray(input)) {
      return input.map((entry) => value(entry, depth + 1)) as unknown as T;
    }
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
        out[key] = isSensitiveKey(key) ? REDACTED : value(entry, depth + 1);
      }
      return out as unknown as T;
    }
    return input;
  };

  return {
    string,
    value,
    register,
    hasRegistered: () => secrets.size > 0
  };
}

const INLINE_PATTERNS: Array<[RegExp, string]> = [
  [/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`],
  [/(basic\s+)[A-Za-z0-9+/=]{8,}/gi, `$1${REDACTED}`],
  [
    /((?:api[_-]?key|apikey|token|secret|password|access[_-]?key)["'\s:=]+)[A-Za-z0-9._~+/=-]{6,}/gi,
    `$1${REDACTED}`
  ],
  [/(:\/\/[^/\s:@]+:)[^@/\s]+(@)/g, `$1${REDACTED}$2`]
];

/** Mask credentials that appear inline in free text (URLs, header dumps, logs). */
export function maskInlineCredentials(input: string): string {
  let out = input;
  for (const [pattern, replacement] of INLINE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Convenience helper for the common "redact this structure with no registry" case. */
export function redact<T>(input: T): T {
  return createRedactor().value(input);
}

/**
 * Produce a stable, safe summary of a secret for display: never the value, only
 * a hint that lets a human recognise which credential is configured.
 */
export function secretHint(plaintext: string): { lastFour: string; length: number } {
  const trimmed = plaintext.trim();
  return {
    lastFour: trimmed.slice(-4),
    length: trimmed.length
  };
}

/**
 * Assert a structure contains no registered secret plaintext. Used by tests and
 * by the run-snapshot writer as a defence-in-depth guard.
 */
export function containsSecret(
  input: unknown,
  secrets: Iterable<string>,
  depth = 0
): string | null {
  if (depth > MAX_DEPTH) return null;
  const candidates = [...secrets].filter((s) => s && s.length >= MIN_SECRET_LENGTH);
  if (candidates.length === 0) return null;
  const walk = (node: unknown): string | null => {
    if (typeof node === 'string') {
      for (const secret of candidates) {
        if (node.includes(secret)) return secret;
      }
      return null;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        const hit = walk(entry);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      for (const entry of Object.values(node as Record<string, unknown>)) {
        const hit = walk(entry);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(input);
}
