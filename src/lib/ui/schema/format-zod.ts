/**
 * Conservative Zod-source formatter.
 *
 * The schema box reformats on blur so a pasted one-liner becomes something a human
 * can read. This is deliberately not a full pretty-printer: it rewrites whitespace
 * and bracket indentation while copying strings, template literals, regular
 * expressions and comments verbatim, so it can never change what the code means.
 * If anything unexpected happens the original source is returned untouched.
 */
export function formatZodSource(source: string): string {
  try {
    return new ZodSourceFormatter(source).format();
  } catch {
    return source;
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
/** Characters after which a `/` begins a regular expression, not a division. */
const REGEX_PREFIX = /[([{,=:!&|?;+\-*%<>~^]/;

class ZodSourceFormatter {
  private readonly source: string;
  private readonly out: string[] = [];
  private index = 0;
  /** Brace/bracket nesting; drives whether a comma starts a new line. */
  private containers = 0;
  private indent = 0;
  private pendingSpace = false;
  /** Last emitted non-whitespace character, used for spacing and regex detection. */
  private previous = '';

  constructor(source: string) {
    this.source = source;
  }

  format(): string {
    while (this.index < this.source.length) {
      this.step();
    }
    const text = this.out
      .join('')
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text.length > 0 ? `${text}\n` : text;
  }

  private step(): void {
    const char = this.source[this.index] as string;

    if (/\s/.test(char)) {
      this.pendingSpace = true;
      this.index += 1;
      return;
    }
    if (char === '/' && this.source[this.index + 1] === '/') {
      this.copyLineComment();
      return;
    }
    if (char === '/' && this.source[this.index + 1] === '*') {
      this.copyBlockComment();
      return;
    }
    if (char === '/' && this.regexAllowed()) {
      this.copyRegex();
      return;
    }
    if (char === '"' || char === "'" || char === '`') {
      this.copyString(char);
      return;
    }
    if (IDENT_START.test(char)) {
      this.copyIdentifier();
      return;
    }
    if (/[0-9]/.test(char)) {
      this.copyNumber();
      return;
    }
    this.copyPunctuation(char);
  }

  private copyLineComment(): void {
    const end = this.source.indexOf('\n', this.index);
    const text = this.source.slice(this.index, end === -1 ? undefined : end);
    this.push(text);
    this.previous = text.slice(-1);
    this.index = end === -1 ? this.source.length : end;
    this.newline();
  }

  private copyBlockComment(): void {
    const end = this.source.indexOf('*/', this.index + 2);
    const text = this.source.slice(this.index, end === -1 ? undefined : end + 2);
    this.push(text);
    this.previous = '/';
    this.index = end === -1 ? this.source.length : end + 2;
    this.pendingSpace = true;
  }

  private copyRegex(): void {
    let cursor = this.index + 1;
    let inClass = false;
    while (cursor < this.source.length) {
      const char = this.source[cursor] as string;
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      else if (char === '\n') break;
      cursor += 1;
    }
    cursor += 1;
    while (cursor < this.source.length && /[a-z]/i.test(this.source[cursor] as string)) cursor += 1;
    const text = this.source.slice(this.index, cursor);
    this.push(text);
    this.previous = text.slice(-1);
    this.index = cursor;
  }

  private copyString(quote: string): void {
    let cursor = this.index + 1;
    while (cursor < this.source.length) {
      const char = this.source[cursor] as string;
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === quote) {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    const text = this.source.slice(this.index, cursor);
    this.push(text);
    this.previous = text.slice(-1);
    this.index = cursor;
  }

  private copyIdentifier(): void {
    let cursor = this.index;
    while (cursor < this.source.length && IDENT_PART.test(this.source[cursor] as string))
      cursor += 1;
    const text = this.source.slice(this.index, cursor);
    this.push(text);
    this.previous = text.slice(-1);
    this.index = cursor;
  }

  private copyNumber(): void {
    let cursor = this.index;
    while (
      cursor < this.source.length &&
      /[0-9a-fA-FxX._eE+-]/.test(this.source[cursor] as string)
    ) {
      cursor += 1;
    }
    const text = this.source.slice(this.index, cursor);
    this.push(text);
    this.previous = text.slice(-1);
    this.index = cursor;
  }

  private copyPunctuation(char: string): void {
    switch (char) {
      case '{':
      case '[': {
        const empty = this.nextSignificant() === (char === '{' ? '}' : ']');
        this.push(char);
        this.previous = char;
        this.index += 1;
        this.containers += 1;
        if (!empty) {
          this.indent += 1;
          this.newline();
        }
        return;
      }
      case '}':
      case ']': {
        const wasEmpty = this.previous === (char === '}' ? '{' : '[');
        if (!wasEmpty) {
          this.indent = Math.max(0, this.indent - 1);
          this.newline();
        }
        this.push(char);
        this.previous = char;
        this.index += 1;
        this.containers = Math.max(0, this.containers - 1);
        return;
      }
      case ',':
        this.push(',');
        if (this.containers > 0) this.newline();
        else this.pendingSpace = true;
        this.previous = ',';
        this.index += 1;
        return;
      case ':':
        this.push(': ');
        this.previous = ':';
        this.index += 1;
        return;
      case '?':
        if (this.source[this.index + 1] === '.') {
          this.push('?.');
          this.previous = '.';
          this.index += 2;
          return;
        }
        if (this.source[this.index + 1] === '?') {
          this.push('??');
          this.previous = '?';
          this.index += 2;
          this.pendingSpace = true;
          return;
        }
        this.push('? ');
        this.previous = '?';
        this.index += 1;
        return;
      case '=':
        if (this.source[this.index + 1] === '>') {
          this.push('=>');
          this.previous = '>';
          this.index += 2;
          this.pendingSpace = true;
          return;
        }
        this.push(' = ');
        this.previous = '=';
        this.index += 1;
        return;
      case '.':
        this.push('.');
        this.previous = '.';
        this.index += 1;
        this.pendingSpace = false;
        return;
      default:
        this.push(char);
        this.previous = char;
        this.index += 1;
        return;
    }
  }

  private nextSignificant(): string {
    let cursor = this.index + 1;
    while (cursor < this.source.length && /\s/.test(this.source[cursor] as string)) cursor += 1;
    return this.source[cursor] ?? '';
  }

  private regexAllowed(): boolean {
    if (this.previous === '') return true;
    if (REGEX_PREFIX.test(this.previous)) return true;
    return false;
  }

  /** Emit text, restoring exactly one space where dropping it would merge tokens. */
  private push(text: string): void {
    if (text.length === 0) return;
    if (this.pendingSpace && this.needsSpace(this.out[this.out.length - 1] ?? '', text)) {
      this.out.push(' ');
    }
    this.pendingSpace = false;
    this.out.push(text);
  }

  private needsSpace(previous: string, next: string): boolean {
    const left = previous.slice(-1);
    const right = next.slice(0, 1);
    return IDENT_PART.test(left) && IDENT_PART.test(right);
  }

  private newline(): void {
    this.pendingSpace = false;
    const joined = this.out.join('');
    if (joined.length === 0) return;
    if (joined.endsWith('\n')) return;
    this.out.push(`\n${'  '.repeat(this.indent)}`);
  }
}
