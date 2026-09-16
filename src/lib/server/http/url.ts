/**
 * URL construction for HTTP operations.
 *
 * A model never sees a URL; it sees an operation key plus semantic parameters. This
 * module turns `(service.baseUrl, operation.path, params)` into one concrete URL and
 * is the *only* place a request URL is assembled, so the SSRF guard lives here in one
 * place instead of being duplicated by every caller.
 *
 * The guard is deliberately strict:
 *  - only `http:`/`https:` service bases are accepted;
 *  - the operation path may not be an absolute URL or protocol-relative;
 *  - `..` segments (authored or supplied through a placeholder) are rejected rather
 *    than normalised away, because "normalise then send" is how traversal bugs hide;
 *  - placeholder values are percent-encoded, so a value can never introduce a new
 *    path segment, query delimiter or header;
 *  - `allowedHosts`, when configured, is enforced against the final host.
 *
 * The function is pure and synchronous: it performs no I/O and depends only on its
 * arguments, which keeps it exhaustively testable.
 */
import { errors } from '../core/errors';
import type { HttpBodyMapping, HttpParameterMapping } from '../db/schema';

export interface UrlServiceRef {
  baseUrl: string;
  /** Optional egress allow-list. Empty/absent means "no additional restriction". */
  allowedHosts?: readonly string[] | null;
}

export interface UrlOperationRef {
  /** Path template relative to the service base, e.g. `/contacts/{{id}}`. */
  path: string;
  parameters?: readonly HttpParameterMapping[] | null;
  /** Body mapping, consulted only so body-field names are accepted as known inputs. */
  body?: HttpBodyMapping | null;
}

export interface BuildUrlInput {
  service: UrlServiceRef;
  operation: UrlOperationRef;
  params?: Record<string, unknown>;
  /** Static query parameters merged last (used by the runtime for auth keys). */
  extraQuery?: Record<string, string | string[]>;
}

export interface BuiltUrl {
  /** Fully-qualified URL, safe to hand to `fetch`. */
  url: string;
  pathname: string;
  /** Query values as they will be sent, before auth query parameters are added. */
  query: Record<string, string | string[]>;
  /** Parameter names consumed while building the URL. */
  consumed: string[];
}

const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** Control characters are rejected by scanning char codes rather than a regex. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function buildUrl(input: BuildUrlInput): BuiltUrl {
  const base = parseBaseUrl(input.service.baseUrl);
  assertHostAllowed(base.hostname, input.service.allowedHosts);

  const parameters = input.operation.parameters ?? [];
  const params = input.params ?? {};
  assertNoUnknownParameters(params, parameters, input.operation.body);

  const consumed: string[] = [];
  const values = resolveParameterValues(parameters, params);

  const path = resolvePath(input.operation.path, parameters, params, values, consumed);
  const { query, queryNames } = buildQuery(parameters, values, input.extraQuery);
  consumed.push(...queryNames);

  const basePath = base.pathname.replace(/\/+$/, '');
  const fullPath = `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
  const normalized = normalizePath(fullPath);

  const url = new URL(base.toString());
  url.pathname = normalized;
  url.search = '';
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, entry);
    } else {
      url.searchParams.set(key, value);
    }
  }

  return {
    url: url.toString(),
    pathname: url.pathname,
    query,
    consumed
  };
}

/** Resolve the effective value for one parameter mapping. */
export function resolveParameterValue(
  mapping: HttpParameterMapping,
  params: Record<string, unknown>
): unknown {
  if (mapping.constant !== undefined) return mapping.constant;
  const supplied = params[mapping.name];
  if (supplied !== undefined && supplied !== null) return supplied;
  if (mapping.default !== undefined) return mapping.default;
  return undefined;
}

function parseBaseUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw errors.validation('HTTP service base URL is required');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw errors.validation(`HTTP service base URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw errors.validation(
      `HTTP service base URL must use http or https (received "${url.protocol}")`
    );
  }
  if (!url.hostname) throw errors.validation('HTTP service base URL must include a host');
  return url;
}

/** True when `host` matches the allow-list. An empty list imposes no restriction. */
export function isHostAllowed(host: string, allowedHosts?: readonly string[] | null): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const normalized = host.toLowerCase().replace(/:\d+$/, '');
  return allowedHosts.some((pattern) => {
    const candidate = pattern.trim().toLowerCase();
    if (candidate.length === 0) return false;
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return candidate === normalized || candidate === host.toLowerCase();
  });
}

function assertHostAllowed(host: string, allowedHosts?: readonly string[] | null): void {
  if (!isHostAllowed(host, allowedHosts)) {
    throw errors.policyDenied(`Host "${host}" is not in the service allowedHosts list`, {
      host,
      allowedHosts: allowedHosts ?? []
    });
  }
}

function assertNoUnknownParameters(
  params: Record<string, unknown>,
  parameters: readonly HttpParameterMapping[],
  body?: HttpBodyMapping | null
): void {
  const known = new Set(parameters.map((parameter) => parameter.name));
  // `body` is always permitted: a passthrough operation sends the whole object as-is.
  known.add('body');
  for (const name of bodyInputNames(body)) known.add(name);
  for (const key of Object.keys(params)) {
    if (!known.has(key)) {
      throw errors.validation(`Unknown parameter "${key}"`, { parameter: key });
    }
  }
}

/**
 * Input names implied by the body mapping, mirroring `inferInputSchema`: raw templates
 * declare placeholders, passthrough sends a single `body` object, and json/form use the
 * field list. Without this, a valid body-field input would be rejected as unknown.
 */
function bodyInputNames(body?: HttpBodyMapping | null): Set<string> {
  const names = new Set<string>();
  if (!body) return names;
  if (body.mode === 'raw') {
    for (const match of (body.template ?? '').matchAll(PLACEHOLDER_RE)) {
      if (match[1]) names.add(match[1]);
    }
  } else if (body.passthrough) {
    names.add('body');
  } else {
    for (const field of body.fields ?? []) names.add(field.name);
  }
  return names;
}

function resolveParameterValues(
  parameters: readonly HttpParameterMapping[],
  params: Record<string, unknown>
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const mapping of parameters) {
    const value = resolveParameterValue(mapping, params);
    if (value !== undefined) {
      values.set(mapping.name, value);
    } else if (isRequired(mapping)) {
      throw errors.validation(`Missing required parameter "${mapping.name}"`, {
        parameter: mapping.name,
        location: mapping.location
      });
    }
  }
  return values;
}

function isRequired(mapping: HttpParameterMapping): boolean {
  // Path parameters are required by construction; everything else defaults to optional.
  return mapping.required ?? mapping.location === 'path';
}

function resolvePath(
  template: string,
  parameters: readonly HttpParameterMapping[],
  params: Record<string, unknown>,
  values: Map<string, unknown>,
  consumed: string[]
): string {
  if (typeof template !== 'string' || template.length === 0) {
    throw errors.validation('Operation path is required');
  }
  if (hasControlCharacters(template)) {
    throw errors.validation('Operation path contains control characters');
  }
  if (template.includes('\\')) {
    throw errors.validation('Operation path must not contain backslashes');
  }

  const byName = new Map(parameters.map((mapping) => [mapping.name, mapping]));
  const path = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const mapping = byName.get(name);
    const raw = mapping ? values.get(name) : params[name];
    if (raw === undefined || raw === null) {
      const fallback = mapping?.default ?? mapping?.constant;
      if (fallback !== undefined && fallback !== null)
        return encodePathValue(String(fallback), name);
      throw errors.validation(`Missing required parameter "${name}"`, { parameter: name });
    }
    consumed.push(name);
    return encodePathValue(String(raw), name);
  });

  assertRelativePath(path);
  return path;
}

function encodePathValue(value: string, name: string): string {
  if (hasControlCharacters(value)) {
    throw errors.validation(`Parameter "${name}" contains control characters`, { parameter: name });
  }
  if (value === '.' || value === '..') {
    throw errors.policyDenied(`Parameter "${name}" would cause path traversal outside the base`, {
      parameter: name
    });
  }
  return encodeURIComponent(value);
}

function assertRelativePath(path: string): void {
  if (ABSOLUTE_URL_RE.test(path)) {
    throw errors.policyDenied('Operation path must not be an absolute URL', { path });
  }
  if (path.startsWith('//')) {
    throw errors.policyDenied('Operation path must not be protocol-relative', { path });
  }
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw errors.policyDenied('Operation path would escape the service base via traversal', {
        path
      });
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function buildQuery(
  parameters: readonly HttpParameterMapping[],
  values: Map<string, unknown>,
  extraQuery?: Record<string, string | string[]>
): { query: Record<string, string | string[]>; queryNames: string[] } {
  const query: Record<string, string | string[]> = {};
  const queryNames: string[] = [];
  for (const mapping of parameters) {
    if (mapping.location !== 'query') continue;
    const value = values.get(mapping.name);
    if (value === undefined) continue;
    const wireName = mapping.wireName ?? mapping.name;
    query[wireName] = serializeQueryValue(value);
    queryNames.push(mapping.name);
  }
  if (extraQuery) {
    for (const [key, value] of Object.entries(extraQuery)) {
      query[key] = value;
    }
  }
  return { query, queryNames };
}

function serializeQueryValue(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map((entry) => scalarToString(entry));
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return scalarToString(value);
}

function scalarToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}
