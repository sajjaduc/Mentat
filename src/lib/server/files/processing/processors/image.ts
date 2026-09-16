/**
 * Image metadata processor.
 *
 * Mentat deliberately ships no OCR in this milestone, so text extraction is an
 * explicit `unsupported` result rather than an empty string — the processing run
 * records why. Dimensions are cheap to read from common headers, so they are still
 * captured as generic metadata for the Files UI and for vision-capable providers.
 */
import {
  type ProcessingContext,
  type Processor,
  type ProcessorResult,
  unsupported
} from '../contracts';

export class ImageProcessor implements Processor {
  readonly type = 'image';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return (
      mimeType === 'image/png' ||
      mimeType === 'image/jpeg' ||
      mimeType === 'image/gif' ||
      mimeType === 'image/webp' ||
      mimeType === 'image/bmp'
    );
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const dimensions = readImageDimensions(context.bytes, context.mimeType);
    const metadata: Record<string, unknown> = {};
    if (dimensions) {
      metadata.imageWidth = dimensions.width;
      metadata.imageHeight = dimensions.height;
    }
    return unsupported(
      'Text extraction is not available for images (OCR is not enabled)',
      metadata
    );
  }
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Best-effort header parsing; returns null when the format is not recognised. */
export function readImageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | null {
  switch (mimeType) {
    case 'image/png':
      return readPngDimensions(bytes);
    case 'image/gif':
      return readGifDimensions(bytes);
    case 'image/jpeg':
      return readJpegDimensions(bytes);
    case 'image/bmp':
      return readBmpDimensions(bytes);
    case 'image/webp':
      return readWebpDimensions(bytes);
    default:
      return null;
  }
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

function readGifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
}

function readBmpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26) return null;
  return { width: readInt32LE(bytes, 18), height: Math.abs(readInt32LE(bytes, 22)) };
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  // VP8X extended header: 24-bit little-endian (width - 1, height - 1).
  if (bytes.length < 30) return null;
  const width =
    1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16);
  const height =
    1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16);
  return { width, height };
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2; // skip SOI
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry frame dimensions.
    const isFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (isFrame) {
      if (offset + 9 >= bytes.length) return null;
      return {
        height: readUint16BE(bytes, offset + 5),
        width: readUint16BE(bytes, offset + 7)
      };
    }
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) |
    ((bytes[offset + 1] as number) << 8) |
    ((bytes[offset + 2] as number) << 16) |
    ((bytes[offset + 3] as number) << 24)
  );
}

export const imageProcessor = new ImageProcessor();
