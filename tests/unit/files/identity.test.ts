/**
 * Content identity, filename safety and MIME detection.
 *
 * These are the first gates of ingestion: a wrong hash breaks dedupe, an unsafe
 * filename breaks storage and logs, and a missed MIME type makes processing
 * silently do nothing. Each is tested in isolation before the pipeline exists.
 */
import { describe, expect, test } from 'bun:test';
import { fingerprint, sha256Hex, stableStringify } from '../../../src/lib/server/core/hash';
import { sanitizeFilename } from '../../../src/lib/server/files/filenames';
import {
  detectMimeType,
  isTextMimeType,
  normalizeMimeType
} from '../../../src/lib/server/files/mime';
import { buildPng } from '../../helpers/blobs';

const encoder = new TextEncoder();

describe('deterministic hashing', () => {
  test('sha256Hex yields the known digest for the same bytes', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(await sha256Hex(encoder.encode('abc'))).toBe(await sha256Hex('abc'));
  });

  test('different bytes produce different hashes', async () => {
    expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'));
  });

  test('fingerprint is stable for reordered object keys but changes with content', async () => {
    const a = await fingerprint({ a: 1, b: { c: [1, 2] } });
    const b = await fingerprint({ b: { c: [1, 2] }, a: 1 });
    const c = await fingerprint({ a: 1, b: { c: [1, 3] } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('stableStringify ignores undefined members', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('filename sanitisation', () => {
  test('strips POSIX path separators and keeps the basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/var/tmp/report.pdf')).toBe('report.pdf');
  });

  test('strips Windows path separators', () => {
    expect(sanitizeFilename('C:\\Users\\me\\policy.docx')).toBe('policy.docx');
  });

  test('removes control characters', () => {
    expect(sanitizeFilename('in\u0000voice\u001f.csv')).toBe('invoice.csv');
  });

  test('collapses whitespace and trims dots', () => {
    expect(sanitizeFilename('  my   file.pdf  ')).toBe('my file.pdf');
    expect(sanitizeFilename('...')).toBe('file');
  });

  test('falls back for empty or separator-only input', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('///')).toBe('file');
    expect(sanitizeFilename('', 'attachment')).toBe('attachment');
  });

  test('truncates very long names while preserving the extension', () => {
    const long = `${'a'.repeat(400)}.pdf`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('MIME detection', () => {
  test('uses magic bytes before the extension', () => {
    expect(detectMimeType('mystery.bin', encoder.encode('%PDF-1.7\n...'))).toBe('application/pdf');
    expect(detectMimeType('photo.bin', buildPng(1, 1))).toBe('image/png');
  });

  test('falls back to the extension when bytes are inconclusive', () => {
    expect(detectMimeType('notes.txt', encoder.encode('hello'))).toBe('text/plain');
    expect(detectMimeType('rows.csv', encoder.encode('a,b\n1,2\n'))).toBe('text/csv');
    expect(detectMimeType('doc.md', encoder.encode('# title'))).toBe('text/markdown');
    expect(detectMimeType('page.html', encoder.encode('<html></html>'))).toBe('text/html');
  });

  test('sniffs JSON and HTML without an extension', () => {
    expect(detectMimeType('payload', encoder.encode('{"a":1}'))).toBe('application/json');
    expect(detectMimeType('payload', encoder.encode('<!DOCTYPE html><html>'))).toBe('text/html');
  });

  test('defaults to octet-stream for unknown binary content', () => {
    expect(detectMimeType('blob', new Uint8Array([0x00, 0x01, 0x02, 0xff]))).toBe(
      'application/octet-stream'
    );
  });

  test('normalizes declared MIME types and rejects invalid ones', () => {
    expect(normalizeMimeType('TEXT/PLAIN; charset=utf-8')).toBe('text/plain');
    expect(normalizeMimeType('application/pdf')).toBe('application/pdf');
    expect(normalizeMimeType('not-a-mime')).toBeNull();
    expect(normalizeMimeType('')).toBeNull();
    expect(normalizeMimeType(undefined)).toBeNull();
  });

  test('classifies text-like MIME types', () => {
    expect(isTextMimeType('text/plain')).toBe(true);
    expect(isTextMimeType('application/json')).toBe(true);
    expect(isTextMimeType('application/pdf')).toBe(false);
    expect(isTextMimeType('image/png')).toBe(false);
  });
});
