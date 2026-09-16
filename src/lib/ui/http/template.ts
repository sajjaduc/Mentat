/**
 * `{{param}}` template helpers.
 *
 * Paths, raw bodies and output templates all use the same placeholder syntax, so the
 * editor highlights placeholders the same way everywhere. Keeping the split in one
 * function means the highlighted view and the "which parameters are missing" check
 * can never disagree.
 */

export interface TemplateSegment {
  text: string;
  param: boolean;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]*)\s*\}\}/g;

/** Split a template into literal and placeholder segments for highlighted rendering. */
export function templateSegments(value: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: value.slice(cursor, index), param: false });
    segments.push({ text: match[0], param: true });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), param: false });
  return segments;
}

/** Every non-empty placeholder name referenced by a template, de-duplicated in order. */
export function templateParams(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER)) {
    const name = match[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Path parameters declared in a path template, e.g. `/contacts/{{id}}` → `['id']`. */
export function pathTemplateParams(path: string): string[] {
  return templateParams(path);
}
