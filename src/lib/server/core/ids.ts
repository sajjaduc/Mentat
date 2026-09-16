/**
 * Application-generated identifiers.
 *
 * Mentat never relies on database autoincrement values for entity identity
 * (see ADR-0003). All entity ids are UUIDv7 generated in the application so that
 * they are (a) globally unique, (b) roughly time-ordered, which keeps B-tree
 * inserts local and makes keyset pagination cheap, and (c) portable between
 * SQLite and PostgreSQL without sequence migration work.
 */

const HEX = '0123456789abcdef';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX[b >> 4];
    out += HEX[b & 0x0f];
  }
  return out;
}

/**
 * Generate a UUIDv7 (RFC 9562) string: 48-bit unix-ms timestamp, 12 bits of
 * randomness/version, 62 bits of randomness/variant.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Math.floor(nowMs));

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // version 7
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  // RFC 4122 variant
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Extract the embedded millisecond timestamp from a UUIDv7 (0 when not a v7). */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  if (hex.length < 12) return 0;
  const value = Number.parseInt(hex, 16);
  return Number.isFinite(value) ? value : 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertUuid(value: unknown, label = 'id'): string {
  if (!isUuid(value)) {
    throw new Error(`Invalid ${label}: expected a UUID, received ${JSON.stringify(value)}`);
  }
  return value;
}

/** Random, URL-safe opaque token (used for sessions, webhooks, api tokens). */
export function randomToken(bytes = 32): string {
  return toHex(randomBytes(bytes));
}

export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}

/** Deterministic short key fragment for workflow keys (CLAIM, SUP, ...). */
export function keyPrefix(input: string, fallback = 'WF'): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .filter(Boolean)
    .join('')
    .toUpperCase();
  const base = cleaned.length >= 2 ? cleaned : input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return (base.slice(0, 6) || fallback).padEnd(2, 'X');
}
