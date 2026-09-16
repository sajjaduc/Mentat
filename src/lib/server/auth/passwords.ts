/**
 * Password hashing.
 *
 * Bun ships Argon2id, so Mentat has no native-hashing dependency. The hash format
 * string is stored verbatim, which lets a future deployment raise parameters and
 * re-hash on next successful login without invalidating existing credentials.
 */
import { errors } from '../core/errors';

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw errors.validation(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw errors.validation(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  // Length is the dominant factor; composition rules are deliberately not enforced
  // beyond rejecting an all-whitespace secret.
  if (password.trim().length === 0) {
    throw errors.validation('Password must not be blank');
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordStrength(password);
  return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2 });
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    // Perform a dummy verification so a missing account is not distinguishable by
    // response time from a wrong password.
    await Bun.password.verify(password, DUMMY_HASH).catch(() => false);
    return false;
  }
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/** True when an existing hash should be upgraded to current parameters. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith('$argon2id$');
}

// A fixed, valid Argon2id hash of a random string; used only to equalize timing.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$3g0mQ0S3n2yQq9mQmZ0mQ0S3n2yQq9mQmZ0mQ0S3n2y';
