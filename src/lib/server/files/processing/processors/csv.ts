/**
 * CSV/TSV processor.
 *
 * A real RFC 4180 parser (quotes, escaped quotes, embedded separators and
 * newlines) rather than `split(',')`: spreadsheets are a primary evidence format
 * and a naive split silently corrupts values that contain separators. The
 * extracted text is a readable `a | b` projection so field extraction and content
 * search can work over the same value.
 */
import {
  extracted,
  type ProcessingContext,
  type Processor,
  type ProcessorResult
} from '../contracts';

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class CsvProcessor implements Processor {
  readonly type = 'csv';
  readonly version = '1';

  supports(mimeType: string): boolean {
    return (
      mimeType === 'text/csv' ||
      mimeType === 'text/tab-separated-values' ||
      mimeType === 'application/csv'
    );
  }

  async process(context: ProcessingContext): Promise<ProcessorResult> {
    const text = utf8.decode(context.bytes);
    const delimiter = context.mimeType === 'text/tab-separated-values' ? '\t' : ',';
    const rows = parseDelimited(text, delimiter);
    const columns = rows[0] ?? [];
    const dataRows = rows.slice(1);
    return extracted({
      text: rows.map((row) => row.join(' | ')).join('\n'),
      contentKind: 'csv',
      genericMetadata: {
        columns,
        columnCount: columns.length,
        rowCount: dataRows.length
      }
    });
  }
}

/** RFC 4180 parser: handles quoted fields and preserved newlines inside quotes. */
export function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ''));
}

export const csvProcessor = new CsvProcessor();
