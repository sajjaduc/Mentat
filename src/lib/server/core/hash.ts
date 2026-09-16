/**
 * Content hashing helpers.
 *
 * SHA-256 over actual bytes is the identity of stored content (ADR-0009). The
 * helpers here are deliberately boring and deterministic: the same bytes always
 * produce the same lowercase hex digest, and hashes are scoped by workspace before
 * they are used in queries so hash equality can never reveal cross-tenant
 * possession of a file.
 */

const encoder = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer | string): Promise<string> {
  const data =
    typeof bytes === 'string'
      ? encoder.encode(bytes)
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : bytes;
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

export function sha256HexSync(bytes: Uint8Array): string {
  // Bun ships a fast sync hasher; fall back to a small pure implementation when
  // running under Node for tooling.
  const hasher = (Bun as unknown as { CryptoHasher?: new (alg: string) => BunLikeHasher })
    .CryptoHasher;
  if (hasher) {
    const h = new hasher('sha256');
    h.update(bytes);
    return h.digest('hex');
  }
  throw new Error('sha256HexSync requires Bun.CryptoHasher; use sha256Hex instead');
}

interface BunLikeHasher {
  update(data: Uint8Array): void;
  digest(encoding: 'hex'): string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable JSON serialization used for fingerprints and cache identities. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) out[key] = normalize(entry);
    return out;
  }
  return value;
}

/** Short stable fingerprint of any structure (8 bytes of hex). */
export async function fingerprint(value: unknown): Promise<string> {
  return (await sha256Hex(stableStringify(value))).slice(0, 16);
}
