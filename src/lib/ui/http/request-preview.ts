/**
 * Copy-as-cURL / copy-as-fetch for the Test Request console.
 *
 * Both builders take the runtime's *redacted* request summary, never the live
 * request: the summary already has every resolved credential replaced with the
 * redaction placeholder, so a pasted command cannot leak a secret. The builders
 * only quote and format — they never resolve or reconstruct a value.
 */

import type { RedactedRequestSummary } from './types';

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function singleLine(value: string): string {
  return value.replace(/\r?\n/g, '');
}

/** A runnable cURL command built from an already-redacted request summary. */
export function toCurl(request: RedactedRequestSummary): string {
  const lines = [`curl -X ${request.method} ${shellQuote(request.url)}`];
  for (const [name, value] of Object.entries(request.headers)) {
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (request.body !== undefined && request.body.length > 0) {
    lines.push(`  --data-raw ${shellQuote(request.body)}`);
  }
  return lines.join(' \\\n');
}

/** The equivalent `fetch` call, again built from redacted material only. */
export function toFetch(request: RedactedRequestSummary): string {
  const headerEntries = Object.entries(request.headers);
  const headerObject =
    headerEntries.length === 0
      ? '{}'
      : `{\n${headerEntries
          .map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
          .join(',\n')}\n  }`;
  const lines = [
    `const response = await fetch(${JSON.stringify(request.url)}, {`,
    `  method: ${JSON.stringify(request.method)},`,
    `  headers: ${headerObject}${request.body !== undefined ? ',' : ''}`
  ];
  if (request.body !== undefined && request.body.length > 0) {
    lines.push(`  body: ${JSON.stringify(request.body)}`);
  }
  lines.push('});', 'const data = await response.json();');
  return lines.join('\n');
}

/** One-line label for a request summary, used in the console header. */
export function requestLabel(request: RedactedRequestSummary | null | undefined): string {
  if (!request) return 'No request yet';
  return `${request.method} ${singleLine(request.url)}`;
}
