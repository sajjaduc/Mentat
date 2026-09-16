/**
 * PDF processor.
 *
 * PDFs are the dominant "evidence" format in the workflows Mentat targets, so
 * text extraction returns per-page segments: downstream field extraction needs to
 * cite the page a value came from, and content search needs a page count. `unpdf`
 * is imported lazily so a deployment that never ingests a PDF pays nothing for
 * the PDF.js payload.
 */
import {
  extracted,
  type ProcessingContext,
  type Processor,
  type ProcessorResult
} from '../contracts';
import { countWords } from './plain-text';

export class PdfProcessor implements Processor {
  readonly type = 'pdf';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const { extractText } = await import('unpdf');
    const result = await extractText(context.bytes, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    const text = pages.join('\n\n');
    return extracted({
      text,
      contentKind: 'text',
      pageCount: result.totalPages,
      segments: pages.map((pageText, index) => ({ page: index + 1, text: pageText })),
      genericMetadata: {
        wordCount: countWords(text),
        charCount: text.length
      }
    });
  }
}

export const pdfProcessor = new PdfProcessor();
