/**
 * HTML processor.
 *
 * Only the visible text is useful to retrieval and extraction; script, style and
 * comment content is actively harmful (it pollutes search results and can smuggle
 * prompt-injection text from a page). Block-level tags become newlines so the
 * output keeps paragraph structure without a heavyweight DOM dependency.
 */
import {
  extracted,
  type ProcessingContext,
  type Processor,
  type ProcessorResult
} from '../contracts';
import { countWords } from './plain-text';

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class HtmlProcessor implements Processor {
  readonly type = 'html';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const html = utf8.decode(context.bytes);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const text = stripHtml(html);
    const genericMetadata: Record<string, unknown> = {
      wordCount: countWords(text),
      charCount: text.length
    };
    if (titleMatch?.[1]) genericMetadata.title = decodeEntities(titleMatch[1]).trim();
    return extracted({ text, contentKind: 'text', genericMetadata });
  }
}

export function stripHtml(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(
    /<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)>/gi,
    '\n'
  );
  out = out.replace(/<[^>]*>/g, ' ');
  out = decodeEntities(out);
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export const htmlProcessor = new HtmlProcessor();
