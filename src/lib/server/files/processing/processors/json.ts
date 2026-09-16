/**
 * JSON processor.
 *
 * Pretty-printing makes the extracted text readable for prompts and search while
 * preserving every key. Invalid JSON is *not* an error: the raw text is returned
 * so a human can still see (and extract from) what arrived, with `valid: false`
 * recorded so the failure is observable instead of silent.
 */
import {
  extracted,
  type ProcessingContext,
  type Processor,
  type ProcessorResult
} from '../contracts';

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class JsonProcessor implements Processor {
  readonly type = 'json';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return mimeType === 'application/json' || mimeType.endsWith('+json');
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const raw = utf8.decode(context.bytes);
    try {
      const parsed: unknown = JSON.parse(raw);
      const genericMetadata: Record<string, unknown> = { valid: true };
      if (Array.isArray(parsed)) {
        genericMetadata.arrayLength = parsed.length;
      } else if (parsed && typeof parsed === 'object') {
        genericMetadata.topLevelKeys = Object.keys(parsed as Record<string, unknown>);
      }
      return extracted({
        text: JSON.stringify(parsed, null, 2),
        contentKind: 'json',
        genericMetadata
      });
    } catch {
      return extracted({
        text: raw,
        contentKind: 'json',
        genericMetadata: { valid: false }
      });
    }
  }
}

export const jsonProcessor = new JsonProcessor();
