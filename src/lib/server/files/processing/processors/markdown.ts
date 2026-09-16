/**
 * Markdown processor.
 *
 * Markdown is stored as-is (not rendered): agents and humans both read the source,
 * and stripping syntax would destroy structure that downstream prompts rely on.
 * The heading count is recorded as cheap generic metadata for search facets.
 */
import {
  extracted,
  type ProcessingContext,
  type Processor,
  type ProcessorResult
} from '../contracts';
import { countWords } from './plain-text';

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class MarkdownProcessor implements Processor {
  readonly type = 'markdown';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return mimeType === 'text/markdown' || mimeType === 'text/x-markdown';
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const text = utf8.decode(context.bytes);
    const headingCount = text.split('\n').filter((line) => /^#{1,6}\s+\S/.test(line)).length;
    return extracted({
      text,
      contentKind: 'markdown',
      genericMetadata: {
        headingCount,
        wordCount: countWords(text),
        charCount: text.length
      }
    });
  }
}

export const markdownProcessor = new MarkdownProcessor();
