/**
 * MIME detection.
 *
 * The declared content type on an upload is a hint, not proof. Processing is
 * MIME-driven, so a wrong type means a file silently yields no content. Detection
 * therefore prefers magic bytes, falls back to the filename extension, then to a
 * cheap text heuristic, and only then to `application/octet-stream` — which the
 * processor registry reports as an explicit `unsupported` outcome rather than an
 * empty result.
 */

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  eml: 'message/rfc822',
  rtf: 'application/rtf'
};

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const utf8 = new TextDecoder('utf-8', { fatal: false });

/** Normalize a declared MIME type, dropping parameters and casing. */
export function normalizeMimeType(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const base = (value.split(';')[0] ?? '').trim().toLowerCase();
  return MIME_RE.test(base) ? base : null;
}

/** Detect the content type of a file from its bytes and name. */
export function detectMimeType(filename: string, bytes: Uint8Array): string {
  const sniffed = sniffMagic(bytes);
  if (sniffed) return sniffed;

  const extension = extensionOf(filename);
  const fromExtension = extension ? EXTENSION_MIME[extension] : undefined;
  if (fromExtension) return fromExtension;

  return looksLikeText(bytes) ? 'text/plain' : 'application/octet-stream';
}

export function isTextMimeType(mimeType: string): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  return (
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('yaml') ||
    mime.includes('csv') ||
    mime.includes('markdown') ||
    mime.includes('javascript') ||
    mime.includes('x-sh') ||
    mime.includes('rfc822')
  );
}

function extensionOf(filename: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename ?? '');
  return match?.[1] ? match[1].toLowerCase() : null;
}

function sniffMagic(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(bytes, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';

  const text = utf8.decode(bytes.subarray(0, 512)).trimStart();
  if (text.startsWith('<!DOCTYPE html') || text.startsWith('<!doctype html')) return 'text/html';
  if (/^<html[\s>]/i.test(text)) return 'text/html';
  if (text.startsWith('{') || text.startsWith('[')) return 'application/json';
  if (text.startsWith('<?xml')) return 'application/xml';
  return null;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 512);
  if (sample.length === 0) return true;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e)) printable += 1;
    else if (byte >= 0xc2) printable += 1; // UTF-8 lead/continuation bytes
  }
  return printable / sample.length > 0.9;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  return asciiAt(bytes, 0, value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}
