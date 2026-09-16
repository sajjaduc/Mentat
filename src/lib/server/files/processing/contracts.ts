/**
 * Processor contracts.
 *
 * Content extraction is MIME-driven and versioned. A processor declares which
 * MIME types it supports and returns either extracted content or an *explicit*
 * `unsupported` outcome: a silent empty string would be indistinguishable from a
 * genuinely empty document and would hide broken parsers from operators
 * (ADR-0010). The pipeline depends on these interfaces only, so a new format is a
 * registration rather than a change to processing.
 */

export type ContentKind = 'text' | 'markdown' | 'html' | 'json' | 'csv';

export interface ProcessingSegment {
  page?: number;
  span?: string;
  text: string;
}

/** Everything a processor may inspect. Raw bytes never reach the database. */
export interface ProcessingContext {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** Generic metadata already known about the file (size, detected MIME, ...). */
  metadata: Record<string, unknown>;
}

export type ProcessorOutcome = 'extracted' | 'unsupported';

export interface ProcessorResult {
  outcome: ProcessorOutcome;
  /** Empty string for `unsupported`; never a misleading partial value. */
  text: string;
  contentKind: ContentKind;
  pageCount: number | null;
  language: string | null;
  segments: ProcessingSegment[];
  /** Generic (non-workflow) metadata discovered by the processor. */
  genericMetadata: Record<string, unknown>;
  truncated: boolean;
  /** Present when `outcome` is `unsupported`, so the reason is observable. */
  reason?: string;
}

export interface Processor {
  readonly type: string;
  readonly version: string;
  supports(mimeType: string): boolean;
  process(context: ProcessingContext): Promise<ProcessorResult>;
}

export type ProcessorResolution =
  | { outcome: 'resolved'; processor: Processor }
  | { outcome: 'unsupported'; reason: string };

export interface ProcessorRegistry {
  register(processor: Processor): void;
  resolve(mimeType: string): ProcessorResolution;
  list(): Processor[];
}

export function extracted(
  input: Pick<ProcessorResult, 'text' | 'contentKind'> & Partial<ProcessorResult>
): ProcessorResult {
  return {
    outcome: 'extracted',
    text: input.text,
    contentKind: input.contentKind,
    pageCount: input.pageCount ?? null,
    language: input.language ?? null,
    segments: input.segments ?? [],
    genericMetadata: input.genericMetadata ?? {},
    truncated: input.truncated ?? false
  };
}

export function unsupported(
  reason: string,
  genericMetadata: Record<string, unknown> = {}
): ProcessorResult {
  return {
    outcome: 'unsupported',
    text: '',
    contentKind: 'text',
    pageCount: null,
    language: null,
    segments: [],
    genericMetadata,
    truncated: false,
    reason
  };
}
