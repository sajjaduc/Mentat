/**
 * Plain-text processor.
 *
 * The baseline format: decode UTF-8 and project word/character counts. It also
 * absorbs the `text/plain` fallback assigned by MIME detection, which is what
 * keeps unknown-but-textual uploads from silently producing nothing.
 */
import {
  extracted,
  type ProcessingContext,
  type Processor,
  type ProcessorResult
} from '../contracts';

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class PlainTextProcessor implements Processor {
  readonly type = 'text';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return mimeType === 'text/plain';
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const text = utf8.decode(context.bytes);
    return extracted({
      text,
      contentKind: 'text',
      genericMetadata: {
        wordCount: countWords(text),
        charCount: text.length
      }
    });
  }
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

export const plainTextProcessor = new PlainTextProcessor();
