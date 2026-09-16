/**
 * Process-wide registry of secret plaintexts.
 *
 * Secrets are only decrypted at the moment of use, so any code path that could
 * persist or log a value must be able to ask "is this string a secret?". The
 * registry answers that question for the redactor used by the logger, the audit
 * ledger, run snapshots and HTTP request logs.
 *
 * Values are held in memory only, are never serialized, and are dropped on
 * rotation. Registration is idempotent and cheap.
 */

const values = new Set<string>();

/** Below this length, masking would corrupt unrelated text. */
const MIN_LENGTH = 6;

export function registerSecretValue(plaintext: string | null | undefined): void {
  if (typeof plaintext === 'string' && plaintext.length >= MIN_LENGTH) {
    values.add(plaintext);
  }
}

export function registerSecretValues(list: Iterable<string | null | undefined>): void {
  for (const value of list) registerSecretValue(value);
}

export function registeredSecretValues(): string[] {
  return [...values];
}

export function forgetSecretValue(plaintext: string): void {
  values.delete(plaintext);
}

/** Test/rotation helper. Never call this in request handling. */
export function clearSecretRegistry(): void {
  values.clear();
}
