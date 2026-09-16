/**
 * MIME → processor registry.
 *
 * Registration is explicit so the set of formats Mentat can process is auditable
 * in one place and a missing processor fails as an explicit `unsupported`
 * resolution instead of an empty extraction. The registry is cheap to construct,
 * which keeps it trivially replaceable in tests.
 */
import type { Processor, ProcessorRegistry, ProcessorResolution } from './contracts';
import { csvProcessor } from './processors/csv';
import { htmlProcessor } from './processors/html';
import { imageProcessor } from './processors/image';
import { jsonProcessor } from './processors/json';
import { markdownProcessor } from './processors/markdown';
import { pdfProcessor } from './processors/pdf';
import { plainTextProcessor } from './processors/plain-text';

export class InMemoryProcessorRegistry implements ProcessorRegistry {
  private readonly processors = new Map<string, Processor>();

  register(processor: Processor): void {
    if (this.processors.has(processor.type)) {
      throw new Error(`Duplicate processor registration for type "${processor.type}"`);
    }
    this.processors.set(processor.type, processor);
  }

  resolve(mimeType: string): ProcessorResolution {
    const normalized = (mimeType ?? '').toLowerCase();
    for (const processor of this.processors.values()) {
      if (processor.supports(normalized)) {
        return { outcome: 'resolved', processor };
      }
    }
    return {
      outcome: 'unsupported',
      reason: `No processor supports MIME type "${mimeType}"`
    };
  }

  list(): Processor[] {
    return [...this.processors.values()];
  }
}

export function createProcessorRegistry(initial: Processor[] = []): ProcessorRegistry {
  const registry = new InMemoryProcessorRegistry();
  for (const processor of initial) registry.register(processor);
  return registry;
}

/** The processors shipped with Mentat, in resolution order. */
export function defaultProcessors(): Processor[] {
  return [
    plainTextProcessor,
    markdownProcessor,
    csvProcessor,
    jsonProcessor,
    htmlProcessor,
    pdfProcessor,
    imageProcessor
  ];
}

export function defaultProcessorRegistry(): ProcessorRegistry {
  return createProcessorRegistry(defaultProcessors());
}
