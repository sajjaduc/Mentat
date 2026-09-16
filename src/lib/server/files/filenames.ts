/**
 * Filename sanitisation.
 *
 * An uploaded filename is attacker-controlled input that ends up in storage keys,
 * audit rows, download headers and logs. Stripping path separators and control
 * characters at the boundary means every downstream consumer can treat the value
 * as an opaque, display-safe label (see the security requirements in the files
 * brief). This intentionally does not try to preserve a directory structure:
 * Mentat stores logical files, not a mounted filesystem.
 */

const WHITESPACE = /\s+/g;
const MAX_FILENAME_LENGTH = 200;
const MAX_EXTENSION_LENGTH = 12;

export function sanitizeFilename(input: string, fallback = 'file'): string {
  const raw = typeof input === 'string' ? input : '';
  const withoutControls = stripControlCharacters(raw);
  const normalisedSeparators = withoutControls.replace(/[\\/]+/g, '/');

  const segments = normalisedSeparators
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  const basename = segments.length > 0 ? (segments[segments.length - 1] as string) : '';

  const collapsed = basename.replace(WHITESPACE, ' ').trim().replace(/^\.+/, '');
  if (collapsed.length === 0) return fallback;
  if (collapsed.length <= MAX_FILENAME_LENGTH) return collapsed;

  // Preserve the extension when truncating so MIME fallbacks stay useful.
  const dot = collapsed.lastIndexOf('.');
  if (dot > 0 && collapsed.length - dot <= MAX_EXTENSION_LENGTH) {
    const extension = collapsed.slice(dot);
    return `${collapsed.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`;
  }
  return collapsed.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Drop C0/C1 control characters without a regex literal: a literal range would
 * trip `noControlCharactersInRegex`, and a filename is exactly the kind of input
 * where that rule's warning is easy to silence by accident.
 */
function stripControlCharacters(input: string): string {
  let out = '';
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code !== 0x7f) || code > 0xff) out += character;
  }
  return out;
}
