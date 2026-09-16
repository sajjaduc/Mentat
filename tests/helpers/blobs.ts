/**
 * Test helpers for the files/blob workstream.
 *
 * Real blob storage is exercised against `handle.tempDir`, and binary fixtures
 * (PDF, PNG, GIF, JPEG) are *generated* here rather than committed, so the repo
 * stays free of large opaque binaries while processors still run on real bytes.
 *
 * This file deliberately lives outside `factories.ts`: the factories module is
 * shared across workstreams, while these helpers are owned by the files suite.
 */
import { eq } from 'drizzle-orm';
import { uuidv7 } from '../../src/lib/server/core/ids';
import type { Executor } from '../../src/lib/server/db/client';
import { workspaceStorageConfig } from '../../src/lib/server/db/schema';
import type { FileExtractionProvider } from '../../src/lib/server/files/fields';
import type { GenerateRequest, GenerateResult } from '../../src/lib/server/providers/types';
import { LocalBlobStore } from '../../src/lib/server/storage/local-blob-store';

/** Insert a workspace storage config row pointing a workspace at a temp root. */
export async function configureLocalStorage(
  db: Executor,
  workspaceId: string,
  localRoot: string,
  overrides: { maxFileBytes?: number; prefix?: string | null } = {}
): Promise<void> {
  await db
    .insert(workspaceStorageConfig)
    .values({
      id: uuidv7(),
      workspaceId,
      provider: 'local',
      localRoot,
      prefix: overrides.prefix ?? null,
      maxFileBytes: overrides.maxFileBytes ?? 52_428_800,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
}

/** Insert a GCS storage config row. No network calls are made by this helper. */
export async function configureGcsStorage(
  db: Executor,
  workspaceId: string,
  input: {
    bucket: string;
    prefix?: string | null;
    credentialsSecretId?: string | null;
    maxFileBytes?: number;
  }
): Promise<void> {
  await db
    .insert(workspaceStorageConfig)
    .values({
      id: uuidv7(),
      workspaceId,
      provider: 'gcs',
      bucket: input.bucket,
      prefix: input.prefix ?? null,
      credentialsSecretId: input.credentialsSecretId ?? null,
      maxFileBytes: input.maxFileBytes ?? 52_428_800,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    .run();
}

export async function readStorageConfig(
  db: Executor,
  workspaceId: string
): Promise<typeof workspaceStorageConfig.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(workspaceStorageConfig)
    .where(eq(workspaceStorageConfig.workspaceId, workspaceId))
    .all();
  return rows[0];
}

/** Convenience: a local store rooted at the handle's temp directory. */
export function createLocalStore(root: string): LocalBlobStore {
  return new LocalBlobStore({ root });
}

/**
 * Build a valid single-page PDF whose content stream draws `text`.
 *
 * Hand-rolled so tests never depend on a binary fixture. Byte offsets in the
 * cross-reference table are computed from the assembled body, which is what makes
 * `unpdf`/PDF.js accept the file.
 */
export function buildPdf(text: string): Uint8Array {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const content = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

/** A minimal PNG header with the given dimensions (IHDR only, no pixel data). */
export function buildPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ]);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  return bytes;
}

/** A minimal GIF header with the given logical screen dimensions. */
export function buildGif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3b
  ]);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

/** A minimal JPEG with a valid SOF0 marker carrying the given dimensions. */
export function buildJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x00,
    0x00,
    0x00,
    0x00,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // SOF0
    0xff,
    0xd9 // EOI
  ]);
  bytes[25] = (height >> 8) & 0xff;
  bytes[26] = height & 0xff;
  bytes[27] = (width >> 8) & 0xff;
  bytes[28] = width & 0xff;
  return bytes;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

export interface FakeFileExtractionProvider extends FileExtractionProvider {
  /** Number of `generate` calls, so tests can assert cache reuse. */
  calls: number;
  lastRequest: GenerateRequest | null;
}

/**
 * Deterministic provider double: tests control the reply and count calls, which
 * is how summary reuse and field extraction are asserted without a model.
 */
export function createFakeProvider(
  reply: (request: GenerateRequest, call: number) => string
): FakeFileExtractionProvider {
  const provider: FakeFileExtractionProvider = {
    type: 'fake',
    name: 'fake-model',
    calls: 0,
    lastRequest: null,
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      provider.calls += 1;
      provider.lastRequest = request;
      return {
        content: reply(request, provider.calls),
        toolCalls: [],
        finishReason: 'stop',
        model: request.model
      };
    }
  };
  return provider;
}
