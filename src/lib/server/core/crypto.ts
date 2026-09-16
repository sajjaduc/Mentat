/**
 * Authenticated encryption for secrets at rest.
 *
 * AES-256-GCM with a deployment-provided master key. The master key never enters
 * the database. Every secret row stores its own random IV and authentication tag,
 * so a single compromised row does not weaken the others and tampering is
 * detectable at read time.
 *
 * The implementation is synchronous on purpose: secret resolution happens inside
 * execution and secret writes happen inside repository transactions, and both
 * paths must not be forced to `await` a cryptographic primitive.
 *
 * Key rotation: each ciphertext records the `keyVersion` that produced it. The
 * keyring accepts `MENTAT_MASTER_KEY` (current, version 1) plus optional
 * `MENTAT_MASTER_KEY_PREVIOUS` (version 0) so old ciphertexts remain readable
 * while new writes use the current key.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Version assigned to the first master key a deployment uses. */
export const DEFAULT_KEY_VERSION = 1;

export interface Ciphertext {
  ciphertext: string;
  iv: string;
  authTag: string;
  algorithm: typeof ALGORITHM;
  keyVersion: number;
}

export interface SecretBox {
  encrypt(plaintext: string): Ciphertext;
  decrypt(payload: Ciphertext): string;
  /** True when a payload was produced by a key other than the current one. */
  needsRotation(payload: Ciphertext): boolean;
  readonly keyVersion: number;
}

function decodeMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  let bytes: Buffer;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    bytes = Buffer.from(trimmed, 'hex');
  } else {
    try {
      bytes = Buffer.from(trimmed, 'base64');
    } catch {
      bytes = Buffer.from(trimmed, 'utf8');
    }
    if (bytes.length !== KEY_BYTES) bytes = Buffer.from(trimmed, 'utf8');
  }
  if (bytes.length !== KEY_BYTES) {
    throw new Error(
      `MENTAT_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${bytes.length}). ` +
        'Generate one with: openssl rand -base64 32'
    );
  }
  return bytes;
}

class AesGcmSecretBox implements SecretBox {
  readonly keyVersion: number;

  /** version → key. Holds the current key plus at most one rotation predecessor. */
  private readonly keyring: Map<number, Buffer>;

  constructor(
    current: Buffer,
    currentVersion: number,
    previous: { material: Buffer; version: number } | null
  ) {
    this.keyVersion = currentVersion;
    this.keyring = new Map([[currentVersion, current]]);
    if (previous) this.keyring.set(previous.version, previous.material);
  }

  encrypt(plaintext: string): Ciphertext {
    const key = this.keyring.get(this.keyVersion);
    if (!key) throw new Error('No active master key available for encryption');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      algorithm: ALGORITHM,
      keyVersion: this.keyVersion
    };
  }

  decrypt(payload: Ciphertext): string {
    if (payload.algorithm !== ALGORITHM) {
      throw new Error(`Unsupported secret algorithm: ${payload.algorithm}`);
    }
    const key = this.keyring.get(payload.keyVersion);
    if (!key) {
      throw new Error(
        `No master key available for ciphertext keyVersion ${payload.keyVersion}. ` +
          'Set MENTAT_MASTER_KEY_PREVIOUS to read it.'
      );
    }
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  needsRotation(payload: Ciphertext): boolean {
    return payload.keyVersion !== this.keyVersion;
  }
}

export interface KeyringEntry {
  /** Base64/hex master key material. */
  key: string;
  /** Version number recorded on ciphertexts produced by this key. */
  version: number;
}

export interface SecretBoxOptions {
  /** Version to stamp on new ciphertexts. Defaults to {@link DEFAULT_KEY_VERSION}. */
  version?: number;
  /** A previously used key that must remain readable. */
  previous?: KeyringEntry | null;
}

export function createSecretBox(masterKey: string, options: SecretBoxOptions = {}): SecretBox {
  const previous = options.previous;
  return new AesGcmSecretBox(
    decodeMasterKey(masterKey),
    options.version ?? DEFAULT_KEY_VERSION,
    previous ? { version: previous.version, material: decodeMasterKey(previous.key) } : null
  );
}

/**
 * A deterministic development key is intentionally rejected. Callers must supply
 * a real master key so that a fresh clone cannot accidentally persist production
 * secrets under a publicly known key.
 */
export function assertMasterKeyPresent(value: string | undefined, envName: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(
      `${envName} is required to store secrets. Generate one with: openssl rand -base64 32`
    );
  }
  return value;
}

const encoder = new TextEncoder();

/**
 * Constant-time comparison for tokens and signatures.
 *
 * Length is folded into the accumulator rather than short-circuiting so the
 * timing profile does not reveal the expected token's length.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** HMAC-SHA256 signature used for inbound webhook verification. */
export function hmacSha256Hex(secret: string, payload: string, encoding: 'hex' | 'base64' = 'hex') {
  return createHmac('sha256', secret).update(payload).digest(encoding);
}
