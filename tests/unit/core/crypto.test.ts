import { describe, expect, test } from 'bun:test';
import {
  ALGORITHM,
  createSecretBox,
  hmacSha256Hex,
  timingSafeEqualString
} from '../../../src/lib/server/core/crypto';

const KEY = '3ojl1YOUasRS3hPbFNEv+sWZIU9e3+BM/zw+mj6xczQ=';
const OTHER_KEY = '8QZ66d3bNwNdKUCBgKbZ5RuUUTNneZwEipfheN9zqJY=';

describe('secret box', () => {
  test('round-trips a value through AES-256-GCM', () => {
    const box = createSecretBox(KEY);
    const payload = box.encrypt('correct horse battery staple');
    expect(payload.algorithm).toBe(ALGORITHM);
    expect(payload.iv).not.toHaveLength(0);
    expect(payload.authTag).not.toHaveLength(0);
    expect(payload.ciphertext).not.toContain('horse');
    expect(box.decrypt(payload)).toBe('correct horse battery staple');
  });

  test('uses a fresh IV per encryption', () => {
    const box = createSecretBox(KEY);
    const a = box.encrypt('same input');
    const b = box.encrypt('same input');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('detects tampering through the authentication tag', () => {
    const box = createSecretBox(KEY);
    const payload = box.encrypt('sensitive');
    const tampered = { ...payload, ciphertext: Buffer.from('tampered value').toString('base64') };
    expect(() => box.decrypt(tampered)).toThrow();
  });

  test('rejects a key that is the wrong size', () => {
    expect(() => createSecretBox('too-short')).toThrow(/32 bytes/);
  });

  test('keeps previous-key ciphertext readable and flags rotation', () => {
    // The deployment originally used OTHER_KEY at version 1...
    const original = createSecretBox(OTHER_KEY, { version: 1 });
    const legacy = original.encrypt('legacy value');
    expect(legacy.keyVersion).toBe(1);

    // ...then rotated to KEY at version 2, keeping the old key readable.
    const rotated = createSecretBox(KEY, {
      version: 2,
      previous: { key: OTHER_KEY, version: 1 }
    });
    expect(rotated.decrypt(legacy)).toBe('legacy value');
    expect(rotated.needsRotation(legacy)).toBe(true);

    const fresh = rotated.encrypt('new value');
    expect(fresh.keyVersion).toBe(2);
    expect(rotated.needsRotation(fresh)).toBe(false);
    expect(rotated.decrypt(fresh)).toBe('new value');
  });

  test('refuses to read a ciphertext whose key is not in the keyring', () => {
    const legacy = createSecretBox(OTHER_KEY, { version: 7 }).encrypt('orphan');
    const box = createSecretBox(KEY, { version: 2, previous: { key: OTHER_KEY, version: 1 } });
    expect(() => box.decrypt(legacy)).toThrow(/keyVersion 7/);
  });

  test('different keys cannot decrypt each other', () => {
    const a = createSecretBox(KEY);
    const b = createSecretBox(OTHER_KEY);
    expect(() => b.decrypt(a.encrypt('x'))).toThrow();
  });
});

describe('token comparison and signing', () => {
  test('compares tokens without early exit on length mismatch', () => {
    expect(timingSafeEqualString('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqualString('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqualString('abcdef', 'abcde')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
  });

  test('produces a stable HMAC for webhook verification', () => {
    const signature = hmacSha256Hex('shhh', '{"a":1}');
    expect(signature).toBe(hmacSha256Hex('shhh', '{"a":1}'));
    expect(signature).not.toBe(hmacSha256Hex('other', '{"a":1}'));
    expect(signature).toHaveLength(64);
  });
});
