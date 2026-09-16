/**
 * First-class HTTP platform.
 *
 * An `http_services` row is a reusable connection (base URL, auth, defaults,
 * rate limits) and an `http_operations` row is a semantic, agent-facing capability
 * layered on top of it. Models only ever see the operation's `key` and schemas —
 * never credentials, never the raw transport (ADR-0014).
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  bool,
  createdAt,
  epochMs,
  json,
  primaryId,
  type ResourceBindingMode,
  updatedAt
} from './_helpers';
import type { ApprovalPolicy, CachePolicy, RetryPolicy } from './agents';
import { users, workspaces } from './tenancy';

export type HttpAuthType =
  | 'none'
  | 'bearer'
  | 'api_key_header'
  | 'api_key_query'
  | 'basic'
  | 'custom_header';

export interface HttpAuthConfig {
  /** Secret reference; resolved only inside execution, never serialized outward. */
  secretId?: string;
  /** Basic auth additionally needs a username (non-secret) plus a secret password. */
  username?: string;
  passwordSecretId?: string;
  /** api_key_header / api_key_query / custom_header */
  headerName?: string;
  queryName?: string;
  /** Template for custom headers, e.g. `Bearer {{secret}}`. */
  template?: string;
}

export interface RateLimitConfig {
  /** Max requests inside `windowSeconds`. */
  requests?: number;
  windowSeconds?: number;
  /** Max in-flight requests per service. */
  concurrency?: number;
}

export const httpServices = sqliteTable(
  'http_services',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id'),
    sourceServiceId: text('source_service_id'),
    bindingMode: text('binding_mode').$type<ResourceBindingMode>().notNull().default('use_asis'),
    name: text('name').notNull(),
    description: text('description'),
    baseUrl: text('base_url').notNull(),
    authType: text('auth_type').$type<HttpAuthType>().notNull().default('none'),
    authConfig: json<HttpAuthConfig>('auth_config'),
    defaultHeaders: json<Record<string, string>>('default_headers'),
    timeoutMs: integer('timeout_ms').notNull().default(15000),
    retryPolicy: json<RetryPolicy>('retry_policy'),
    cachePolicy: json<CachePolicy>('cache_policy'),
    rateLimit: json<RateLimitConfig>('rate_limit'),
    defaultApprovalPolicy: json<ApprovalPolicy>('default_approval_policy'),
    allowedHosts: json<string[]>('allowed_hosts'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('http_services_name_unique').on(table.workspaceId, table.workflowId, table.name),
    index('http_services_workspace_idx').on(table.workspaceId, table.archivedAt)
  ]
);

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type HttpParameterLocation = 'path' | 'query' | 'header' | 'body';

export interface HttpParameterMapping {
  /** Parameter name as it appears in the operation's input schema. */
  name: string;
  location: HttpParameterLocation;
  /** Name used on the wire; defaults to `name`. */
  wireName?: string;
  required?: boolean;
  description?: string;
  /** JSON-schema-ish type descriptor shown to the model. */
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  default?: unknown;
  /** Static value, useful for constant API versions. */
  constant?: unknown;
}

export interface HttpBodyMapping {
  mode: 'none' | 'json' | 'form' | 'raw';
  contentType?: string;
  /** Template with `{{param}}` placeholders, used for `raw`. */
  template?: string;
  /** When true, the whole `body` input object is sent as-is. */
  passthrough?: boolean;
  /** Field-level mapping for json/form bodies. */
  fields?: HttpParameterMapping[];
}

export interface HttpResponseMapping {
  /** JSONPath-ish selector into the response body, e.g. `data.contact`. */
  bodyPath?: string;
  headers?: Record<string, string>;
  /** Map into a stable shape the agent sees. */
  outputTemplate?: Record<string, string>;
}

export interface HttpSuccessRules {
  statusCodes?: number[];
  /** Fail the operation when this JSON path is truthy. */
  failWhenPath?: string;
  /** Fail when the response body contains this substring. */
  failWhenBodyContains?: string;
}

export const httpOperations = sqliteTable(
  'http_operations',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => httpServices.id, { onDelete: 'cascade' }),
    /** Semantic, model-facing tool name, e.g. `hubspot.get_contact`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    method: text('method').$type<HttpMethod>().notNull().default('GET'),
    /** Path template relative to the service base URL, e.g. `/contacts/{{id}}`. */
    path: text('path').notNull().default('/'),
    parameters: json<HttpParameterMapping[]>('parameters'),
    headers: json<Record<string, string>>('headers'),
    body: json<HttpBodyMapping>('body'),
    inputSchema: json<unknown>('input_schema'),
    outputSchema: json<unknown>('output_schema'),
    successRules: json<HttpSuccessRules>('success_rules'),
    responseMapping: json<HttpResponseMapping>('response_mapping'),
    timeoutMs: integer('timeout_ms'),
    retryPolicy: json<RetryPolicy>('retry_policy'),
    cachePolicy: json<CachePolicy>('cache_policy'),
    approvalPolicy: json<ApprovalPolicy>('approval_policy'),
    rateLimitOverride: json<RateLimitConfig>('rate_limit_override'),
    /** When true the operation is exposed to agents as a tool automatically. */
    exposeAsTool: bool('expose_as_tool', true),
    toolId: text('tool_id'),
    enabled: bool('enabled', true),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [
    uniqueIndex('http_operations_key_unique').on(table.workspaceId, table.key),
    index('http_operations_service_idx').on(table.serviceId, table.position)
  ]
);

export const httpRequestLogs = sqliteTable(
  'http_request_logs',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    serviceId: text('service_id').notNull(),
    operationId: text('operation_id'),
    runId: text('run_id'),
    stepId: text('step_id'),
    /** Redacted at write time. */
    method: text('method').notNull(),
    url: text('url').notNull(),
    requestHeaders: json<Record<string, string>>('request_headers'),
    requestBody: text('request_body'),
    attempt: integer('attempt').notNull().default(1),
    responseStatus: integer('response_status'),
    responseHeaders: json<Record<string, string>>('response_headers'),
    responseBodyPreview: text('response_body_preview'),
    responseBytes: integer('response_bytes'),
    latencyMs: integer('latency_ms'),
    cacheStatus: text('cache_status').$type<'hit' | 'miss' | 'bypass' | 'stored'>(),
    fromTestConsole: bool('from_test_console'),
    error: text('error'),
    errorCode: text('error_code'),
    createdAt: createdAt()
  },
  (table) => [
    index('http_request_logs_service_idx').on(table.workspaceId, table.serviceId, table.createdAt),
    index('http_request_logs_run_idx').on(table.runId)
  ]
);

export type HttpService = typeof httpServices.$inferSelect;
export type NewHttpService = typeof httpServices.$inferInsert;
export type HttpOperation = typeof httpOperations.$inferSelect;
export type NewHttpOperation = typeof httpOperations.$inferInsert;
export type HttpRequestLog = typeof httpRequestLogs.$inferSelect;
