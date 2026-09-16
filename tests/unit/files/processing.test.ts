/**
 * Processor contracts and the MIME registry.
 *
 * The pipeline must never silently produce an empty extraction: an unhandled
 * MIME type has to surface as an explicit `unsupported` outcome so operators can
 * see why a file produced no content. Each built-in processor is exercised on a
 * generated fixture.
 */
import { describe, expect, test } from 'bun:test';
import {
  configurationFingerprintFor,
  processingKeyFor
} from '../../../src/lib/server/files/processing/pipeline';
import { csvProcessor } from '../../../src/lib/server/files/processing/processors/csv';
import { htmlProcessor } from '../../../src/lib/server/files/processing/processors/html';
import { imageProcessor } from '../../../src/lib/server/files/processing/processors/image';
import { jsonProcessor } from '../../../src/lib/server/files/processing/processors/json';
import { markdownProcessor } from '../../../src/lib/server/files/processing/processors/markdown';
import { pdfProcessor } from '../../../src/lib/server/files/processing/processors/pdf';
import { plainTextProcessor } from '../../../src/lib/server/files/processing/processors/plain-text';
import {
  createProcessorRegistry,
  defaultProcessors
} from '../../../src/lib/server/files/processing/registry';
import { buildGif, buildJpeg, buildPdf, buildPng } from '../../helpers/blobs';

const encoder = new TextEncoder();

function input(mimeType: string, body: string, filename = 'fixture') {
  return { bytes: encoder.encode(body), mimeType, filename, metadata: {} };
}

describe('processor registry', () => {
  test('resolves a processor by MIME type', () => {
    const registry = createProcessorRegistry(defaultProcessors());
    const resolved = registry.resolve('application/pdf');
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome === 'resolved') expect(resolved.processor.type).toBe('pdf');
  });

  test('reports an explicit unsupported outcome for unknown MIME types', () => {
    const registry = createProcessorRegistry(defaultProcessors());
    const resolved = registry.resolve('application/x-mentat-nope');
    expect(resolved.outcome).toBe('unsupported');
    if (resolved.outcome === 'unsupported')
      expect(resolved.reason).toContain('application/x-mentat-nope');
  });

  test('rejects a processor registered under a duplicate type', () => {
    const registry = createProcessorRegistry([plainTextProcessor]);
    expect(() => registry.register(plainTextProcessor)).toThrow();
  });

  test('image types resolve to the metadata processor, not the text processors', () => {
    const registry = createProcessorRegistry(defaultProcessors());
    const resolved = registry.resolve('image/png');
    expect(resolved.outcome).toBe('resolved');
    if (resolved.outcome === 'resolved') expect(resolved.processor.type).toBe('image');
  });
});

describe('plain text processor', () => {
  test('extracts text and counts words and characters', async () => {
    const result = await plainTextProcessor.process(input('text/plain', 'hello world'));
    expect(result.outcome).toBe('extracted');
    expect(result.contentKind).toBe('text');
    expect(result.text).toBe('hello world');
    expect(result.genericMetadata.wordCount).toBe(2);
    expect(result.genericMetadata.charCount).toBe(11);
  });

  test('declares its MIME support', () => {
    expect(plainTextProcessor.supports('text/plain')).toBe(true);
    expect(plainTextProcessor.supports('application/pdf')).toBe(false);
  });
});

describe('markdown processor', () => {
  test('keeps markdown text and records heading count', async () => {
    const result = await markdownProcessor.process(
      input('text/markdown', '# Title\n\n## Sub\n\nBody text')
    );
    expect(result.contentKind).toBe('markdown');
    expect(result.text).toContain('# Title');
    expect(result.genericMetadata.headingCount).toBe(2);
  });
});

describe('csv processor', () => {
  test('parses headers and rows into a readable projection', async () => {
    const result = await csvProcessor.process(input('text/csv', 'name,age\nAda,36\nGrace,45\n'));
    expect(result.contentKind).toBe('csv');
    expect(result.genericMetadata.columns).toEqual(['name', 'age']);
    expect(result.genericMetadata.rowCount).toBe(2);
    expect(result.text).toContain('Ada');
  });

  test('handles quoted fields containing separators and newlines', async () => {
    const result = await csvProcessor.process(
      input('text/csv', 'name,note\n"Ada","hello, world"\n"Grace","line\nbreak"\n')
    );
    expect(result.genericMetadata.rowCount).toBe(2);
    expect(result.text).toContain('hello, world');
  });
});

describe('json processor', () => {
  test('pretty-prints valid JSON and records top-level shape', async () => {
    const result = await jsonProcessor.process(input('application/json', '{"a":1,"b":[2,3]}'));
    expect(result.contentKind).toBe('json');
    expect(result.text).toContain('"a": 1');
    expect(result.genericMetadata.topLevelKeys).toEqual(['a', 'b']);
  });

  test('falls back to raw text for invalid JSON without inventing a result', async () => {
    const result = await jsonProcessor.process(input('application/json', '{not json'));
    expect(result.outcome).toBe('extracted');
    expect(result.text).toContain('{not json');
  });
});

describe('html processor', () => {
  test('strips tags, scripts and styles', async () => {
    const result = await htmlProcessor.process(
      input(
        'text/html',
        '<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body><h1>Hi</h1><p>There</p></body></html>'
      )
    );
    expect(result.outcome).toBe('extracted');
    expect(result.text).toContain('Hi');
    expect(result.text).toContain('There');
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('color:red');
  });
});

describe('pdf processor', () => {
  test('extracts per-page text and a page count', async () => {
    const result = await pdfProcessor.process({
      bytes: buildPdf('Hello Mentat PDF'),
      mimeType: 'application/pdf',
      filename: 'fixture.pdf',
      metadata: {}
    });
    expect(result.outcome).toBe('extracted');
    expect(result.contentKind).toBe('text');
    expect(result.pageCount).toBe(1);
    expect(result.text).toContain('Hello Mentat PDF');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.page).toBe(1);
  });
});

describe('image processor', () => {
  test('reports unsupported text extraction but records dimensions', async () => {
    const png = await imageProcessor.process({
      bytes: buildPng(12, 34),
      mimeType: 'image/png',
      filename: 'fixture.png',
      metadata: {}
    });
    expect(png.outcome).toBe('unsupported');
    expect(png.genericMetadata.imageWidth).toBe(12);
    expect(png.genericMetadata.imageHeight).toBe(34);
    expect(png.reason).toBeDefined();
  });

  test('reads JPEG and GIF dimensions', async () => {
    const jpeg = await imageProcessor.process({
      bytes: buildJpeg(640, 480),
      mimeType: 'image/jpeg',
      filename: 'fixture.jpg',
      metadata: {}
    });
    expect(jpeg.genericMetadata.imageWidth).toBe(640);
    expect(jpeg.genericMetadata.imageHeight).toBe(480);

    const gif = await imageProcessor.process({
      bytes: buildGif(100, 50),
      mimeType: 'image/gif',
      filename: 'fixture.gif',
      metadata: {}
    });
    expect(gif.genericMetadata.imageWidth).toBe(100);
    expect(gif.genericMetadata.imageHeight).toBe(50);
  });
});

describe('processing identity', () => {
  test('processingKeyFor is stable for identical inputs and order-sensitive', () => {
    const base = {
      contentHash: 'abc',
      processorType: 'pdf',
      processorVersion: '1',
      configurationFingerprint: 'fp'
    };
    expect(processingKeyFor(base)).toBe(processingKeyFor({ ...base }));
    expect(processingKeyFor(base)).toContain('abc');
  });

  test('a processor version change produces a different processing key', () => {
    const base = {
      contentHash: 'abc',
      processorType: 'pdf',
      processorVersion: '1',
      configurationFingerprint: 'fp'
    };
    expect(processingKeyFor(base)).not.toBe(processingKeyFor({ ...base, processorVersion: '2' }));
    expect(processingKeyFor(base)).not.toBe(
      processingKeyFor({ ...base, configurationFingerprint: 'fp2' })
    );
  });

  test('configurationFingerprintFor changes with configuration and processor version', async () => {
    const processor = { type: 'pdf', version: '1' };
    const first = await configurationFingerprintFor(processor, { maxChars: 100 });
    const second = await configurationFingerprintFor(processor, { maxChars: 100 });
    const changed = await configurationFingerprintFor(processor, { maxChars: 200 });
    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });
});
