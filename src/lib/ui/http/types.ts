/**
 * HTTP platform types, mirroring the server contract.
 *
 * The UI is a client of `/api`, not of the database, so these interfaces describe
 * exactly what the API returns. Keeping them in one place means the editor, the test
 * console and the logs panel agree on the shape of a policy object, and a server
 * change surfaces as a type error instead of a runtime surprise.
 *
 * A deliberate rule runs through every type here: there is no field for a secret
 * *value*. A service references a secret by id, and the API returns only metadata
 * (`SecretView`), so the plaintext cannot reach a component even by accident
 * (ADR-0020).
 */

export type HttpAuthType =
  | 'none'
  | 'bearer'
  | 'api_key_header'
  | 'api_key_query'
  | 'basic'
  | 'custom_header';

export interface HttpAuthConfig {
  /** Secret reference; the value is resolved only inside execution. */
  secretId?: string;
  username?: string;
  passwordSecretId?: string;
  headerName?: string;
  queryName?: string;
  /** Custom header template containing `{{secret}}`. */
  template?: string;
}

export interface RateLimitConfig {
  requests?: number;
  windowSeconds?: number;
  concurrency?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: number[];
  honorRetryAfter?: boolean;
}

export interface ApprovalPolicy {
  mode: 'never' | 'always' | 'conditional';
  condition?: string;
  reason?: string;
}

export interface CachePolicy {
  enabled: boolean;
  ttlSeconds?: number;
  read?: boolean;
  varyOn?: string[];
}

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type HttpParameterLocation = 'path' | 'query' | 'header' | 'body';

export interface HttpParameterMapping {
  name: string;
  location: HttpParameterLocation;
  wireName?: string;
  required?: boolean;
  description?: string;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  default?: unknown;
  constant?: unknown;
}

export interface HttpBodyMapping {
  mode: 'none' | 'json' | 'form' | 'raw';
  contentType?: string;
  /** Template with `{{param}}` placeholders, used for `raw`. */
  template?: string;
  passthrough?: boolean;
  fields?: HttpParameterMapping[];
}

export interface HttpResponseMapping {
  bodyPath?: string;
  headers?: Record<string, string>;
  outputTemplate?: Record<string, string>;
}

export interface HttpSuccessRules {
  statusCodes?: number[];
  failWhenPath?: string;
  failWhenBodyContains?: string;
}

export interface HttpService {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  bindingMode: 'use_asis' | 'override' | 'fork';
  name: string;
  description: string | null;
  baseUrl: string;
  authType: HttpAuthType;
  authConfig: HttpAuthConfig | null;
  defaultHeaders: Record<string, string> | null;
  timeoutMs: number;
  retryPolicy: RetryPolicy | null;
  cachePolicy: CachePolicy | null;
  rateLimit: RateLimitConfig | null;
  defaultApprovalPolicy: ApprovalPolicy | null;
  allowedHosts: string[] | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface HttpOperation {
  id: string;
  workspaceId: string;
  serviceId: string;
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  parameters: HttpParameterMapping[] | null;
  headers: Record<string, string> | null;
  body: HttpBodyMapping | null;
  inputSchema: unknown;
  outputSchema: unknown;
  successRules: HttpSuccessRules | null;
  responseMapping: HttpResponseMapping | null;
  timeoutMs: number | null;
  retryPolicy: RetryPolicy | null;
  cachePolicy: CachePolicy | null;
  approvalPolicy: ApprovalPolicy | null;
  rateLimitOverride: RateLimitConfig | null;
  exposeAsTool: boolean;
  toolId: string | null;
  enabled: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface HttpRequestLog {
  id: string;
  workspaceId: string;
  serviceId: string;
  operationId: string | null;
  runId: string | null;
  stepId: string | null;
  method: string;
  url: string;
  requestHeaders: Record<string, string> | null;
  requestBody: string | null;
  attempt: number;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBodyPreview: string | null;
  responseBytes: number | null;
  latencyMs: number | null;
  cacheStatus: 'hit' | 'miss' | 'bypass' | 'stored' | null;
  fromTestConsole: boolean;
  error: string | null;
  errorCode: string | null;
  createdAt: number;
}

export interface HttpRetryTraceEntry {
  attempt: number;
  status?: number | null;
  error?: string | null;
  delayMs?: number;
}

/** The request the runtime was about to make, already redacted by the server. */
export interface RedactedRequestSummary {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  query: Record<string, unknown>;
}

export interface TestRequestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  attempts: number;
  cacheStatus: string;
  logId: string | null;
  body: unknown;
  formattedBody: string;
  headers: Record<string, string>;
  requestHeaders: Record<string, string>;
  request: RedactedRequestSummary;
  retryTrace: HttpRetryTraceEntry[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  /** Present only when `inferSchemaFromResponse` was requested and the call succeeded. */
  inferredOutputSchema?: unknown;
}

/** Secret metadata only — deliberately no plaintext accessor exists. */
export interface SecretView {
  id: string;
  workspaceId: string;
  scope: 'workspace' | 'workflow';
  workflowId: string | null;
  key: string;
  name: string;
  description: string | null;
  lastFour: string | null;
  valueLength: number | null;
  version: number;
  bindingMode: string;
  sourceSecretId: string | null;
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
  hasWorkflowOverride: boolean;
}

export const AUTH_TYPE_LABELS: Record<HttpAuthType, string> = {
  none: 'None',
  bearer: 'Bearer token',
  api_key_header: 'API key (header)',
  api_key_query: 'API key (query)',
  basic: 'Basic auth',
  custom_header: 'Custom header'
};

/** Auth types that reference exactly one secret via `authConfig.secretId`. */
export const SINGLE_SECRET_AUTH_TYPES: readonly HttpAuthType[] = [
  'bearer',
  'api_key_header',
  'api_key_query',
  'custom_header'
];

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
];

export const HTTP_METHOD_TONES: Record<
  HttpMethod,
  'neutral' | 'accent' | 'positive' | 'caution' | 'danger' | 'muted'
> = {
  GET: 'positive',
  HEAD: 'positive',
  POST: 'accent',
  PUT: 'caution',
  PATCH: 'caution',
  DELETE: 'danger',
  OPTIONS: 'muted'
};
