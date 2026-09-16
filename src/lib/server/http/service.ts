/**
 * HTTP service and operation services.
 *
 * This is the policy layer: it checks `http:write`/`http:read`, validates connection
 * and operation definitions, keeps the automatically-exposed `tools` row for an
 * operation in sync, and writes an audit row in the *same transaction* as every
 * mutation. Repositories below it never check permission; runtimes above it never
 * mutate configuration.
 *
 * Two decisions are worth calling out:
 *
 *  - **Secrets are referenced, never embedded.** Validation checks that a referenced
 *    secret exists *in this workspace*, but the value is never read here; only the
 *    execution runtime resolves plaintext (ADR-0020).
 *  - **Tool exposure is derived.** `exposeAsTool` produces a `tools` row whose
 *    implementation points back at `{operationId, serviceId}`; disabling it disables the
 *    row rather than deleting it, so agent configuration that references the tool id
 *    stays valid and the id remains stable across edits.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { AuditActions, writeAudit } from '../audit/ledger';
import { type ActorContext, assertPermission, Permissions } from '../core/context';
import { errors } from '../core/errors';
import { uuidv7 } from '../core/ids';
import { type Executor, withTransaction } from '../db/client';
import type {
  ApprovalPolicy,
  CachePolicy,
  HttpAuthConfig,
  HttpAuthType,
  HttpBodyMapping,
  HttpMethod,
  HttpOperation,
  HttpParameterMapping,
  HttpResponseMapping,
  HttpService,
  HttpSuccessRules,
  RateLimitConfig,
  RetryPolicy,
  ToolImplementation
} from '../db/schema';
import { secrets, tools, workflows } from '../db/schema';
import type { JsonSchema } from '../tools/types';
import { inferInputSchema } from './mapping';
import {
  findOperationRow,
  findOperationRowByKey,
  findServiceRow,
  findServiceRowByName,
  findToolRow,
  findToolRowByKey,
  insertOperationRow,
  insertServiceRow,
  type ListOperationOptions,
  type ListServiceOptions,
  listOperationRows,
  listServiceRows,
  updateOperationRow,
  updateServiceRow
} from './repository';

const DEFAULT_TIMEOUT_MS = 15_000;
const OPERATION_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SECRET_PLACEHOLDER = '{{secret}}';

export interface CreateHttpServiceInput {
  workflowId?: string | null;
  name: string;
  description?: string | null;
  baseUrl: string;
  authType?: HttpAuthType;
  authConfig?: HttpAuthConfig | null;
  defaultHeaders?: Record<string, string> | null;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy | null;
  cachePolicy?: CachePolicy | null;
  rateLimit?: RateLimitConfig | null;
  defaultApprovalPolicy?: ApprovalPolicy | null;
  allowedHosts?: string[] | null;
}

export type UpdateHttpServiceInput = Partial<Omit<CreateHttpServiceInput, 'workflowId'>>;

export async function createHttpService(
  db: Executor,
  actor: ActorContext,
  input: CreateHttpServiceInput
): Promise<HttpService> {
  assertPermission(actor, Permissions.httpWrite, 'Not permitted to create HTTP services');
  const name = input.name?.trim();
  if (!name) throw errors.validation('HTTP service name is required');
  const baseUrl = assertHttpBaseUrl(input.baseUrl);
  const workflowId = input.workflowId ?? null;
  if (workflowId) assertWorkflow(db, actor.workspaceId, workflowId);
  const authType = input.authType ?? 'none';
  validateAuthConfig(db, actor.workspaceId, authType, input.authConfig ?? null);

  const duplicate = findServiceRowByName(db, actor.workspaceId, name, workflowId);
  if (duplicate) {
    throw errors.conflict(`An HTTP service named "${name}" already exists in this scope`, { name });
  }

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const row = insertServiceRow(tx, {
      id: uuidv7(),
      workspaceId: actor.workspaceId,
      workflowId,
      name,
      description: input.description ?? null,
      baseUrl,
      authType,
      authConfig: input.authConfig ?? null,
      defaultHeaders: input.defaultHeaders ?? null,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retryPolicy: input.retryPolicy ?? null,
      cachePolicy: input.cachePolicy ?? null,
      rateLimit: input.rateLimit ?? null,
      defaultApprovalPolicy: input.defaultApprovalPolicy ?? null,
      allowedHosts: input.allowedHosts ?? null,
      createdByUserId: actor.actorType === 'user' ? actor.actorId : null,
      createdAt: now,
      updatedAt: now
    });
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.serviceCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'http_service',
      entityId: row.id,
      workflowId,
      summary: `HTTP service "${row.name}" created`,
      // Never the auth config value: only the mechanism and reference ids.
      data: { name: row.name, baseUrl: row.baseUrl, authType: row.authType }
    });
    return row;
  });
}

export async function updateHttpService(
  db: Executor,
  actor: ActorContext,
  serviceId: string,
  patch: UpdateHttpServiceInput
): Promise<HttpService> {
  assertPermission(actor, Permissions.httpWrite, 'Not permitted to update HTTP services');
  const current = findServiceRow(db, actor.workspaceId, serviceId);
  if (!current) throw errors.notFound('HTTP service', serviceId);

  const updates: Partial<CreateHttpServiceInput> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw errors.validation('HTTP service name is required');
    updates.name = name;
  }
  const baseUrl = patch.baseUrl !== undefined ? assertHttpBaseUrl(patch.baseUrl) : undefined;
  if (baseUrl !== undefined) updates.baseUrl = baseUrl;
  const authType = patch.authType ?? current.authType;
  const authConfig = patch.authConfig !== undefined ? patch.authConfig : current.authConfig;
  validateAuthConfig(db, actor.workspaceId, authType, authConfig ?? null);
  updates.authType = authType;
  updates.authConfig = authConfig ?? null;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.defaultHeaders !== undefined) updates.defaultHeaders = patch.defaultHeaders;
  if (patch.timeoutMs !== undefined) updates.timeoutMs = patch.timeoutMs;
  if (patch.retryPolicy !== undefined) updates.retryPolicy = patch.retryPolicy;
  if (patch.cachePolicy !== undefined) updates.cachePolicy = patch.cachePolicy;
  if (patch.rateLimit !== undefined) updates.rateLimit = patch.rateLimit;
  if (patch.defaultApprovalPolicy !== undefined) {
    updates.defaultApprovalPolicy = patch.defaultApprovalPolicy;
  }
  if (patch.allowedHosts !== undefined) updates.allowedHosts = patch.allowedHosts;

  if (updates.name && updates.name !== current.name) {
    const duplicate = findServiceRowByName(db, actor.workspaceId, updates.name, current.workflowId);
    if (duplicate && duplicate.id !== current.id) {
      throw errors.conflict(`An HTTP service named "${updates.name}" already exists in this scope`);
    }
  }

  const now = Date.now();
  const changedFields = Object.keys(updates).filter(
    (field) =>
      !isSameValue(
        (updates as unknown as Record<string, unknown>)[field],
        (current as unknown as Record<string, unknown>)[field]
      )
  );
  if (changedFields.length === 0) return current;

  return withTransaction(db, (tx) => {
    const row = updateServiceRow(tx, actor.workspaceId, serviceId, { ...updates, updatedAt: now });
    if (!row) throw errors.notFound('HTTP service', serviceId);

    // Service-level defaults feed every derived tool row; re-sync so agents see the
    // same retry/approval/cache policy the runtime will actually enforce.
    for (const operation of listOperationRows(tx, actor.workspaceId, {
      serviceId,
      includeArchived: true
    })) {
      syncToolForOperation(tx, operation, row);
    }

    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.serviceUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'http_service',
      entityId: row.id,
      workflowId: row.workflowId,
      summary: `HTTP service "${row.name}" updated`,
      data: { name: row.name, changedFields }
    });
    return row;
  });
}

/** Soft-delete: operations are archived and their derived tool rows disabled. */
export async function archiveHttpService(
  db: Executor,
  actor: ActorContext,
  serviceId: string
): Promise<HttpService> {
  assertPermission(actor, Permissions.httpWrite, 'Not permitted to archive HTTP services');
  const current = findServiceRow(db, actor.workspaceId, serviceId);
  if (!current) throw errors.notFound('HTTP service', serviceId);
  if (current.archivedAt !== null) return current;

  const now = Date.now();
  return withTransaction(db, (tx) => {
    for (const operation of listOperationRows(tx, actor.workspaceId, {
      serviceId,
      includeArchived: true
    })) {
      if (operation.archivedAt !== null) continue;
      const archived = updateOperationRow(tx, actor.workspaceId, operation.id, {
        archivedAt: now,
        updatedAt: now
      });
      if (archived) syncToolForOperation(tx, archived, current);
    }
    const row = updateServiceRow(tx, actor.workspaceId, serviceId, {
      archivedAt: now,
      updatedAt: now
    });
    if (!row) throw errors.notFound('HTTP service', serviceId);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.serviceUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'http_service',
      entityId: row.id,
      workflowId: row.workflowId,
      summary: `HTTP service "${row.name}" archived`,
      data: { name: row.name, archived: true }
    });
    return row;
  });
}

export function getHttpService(db: Executor, actor: ActorContext, serviceId: string): HttpService {
  assertPermission(actor, Permissions.httpRead, 'Not permitted to read HTTP services');
  const row = findServiceRow(db, actor.workspaceId, serviceId);
  if (!row) throw errors.notFound('HTTP service', serviceId);
  return row;
}

export function listHttpServices(
  db: Executor,
  actor: ActorContext,
  options: ListServiceOptions = {}
): HttpService[] {
  assertPermission(actor, Permissions.httpRead, 'Not permitted to read HTTP services');
  return listServiceRows(db, actor.workspaceId, options);
}

export interface CreateHttpOperationInput {
  serviceId: string;
  key: string;
  name?: string;
  description?: string;
  method?: HttpMethod;
  path: string;
  parameters?: HttpParameterMapping[] | null;
  headers?: Record<string, string> | null;
  body?: HttpBodyMapping | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
  successRules?: HttpSuccessRules | null;
  responseMapping?: HttpResponseMapping | null;
  timeoutMs?: number | null;
  retryPolicy?: RetryPolicy | null;
  cachePolicy?: CachePolicy | null;
  approvalPolicy?: ApprovalPolicy | null;
  rateLimitOverride?: RateLimitConfig | null;
  exposeAsTool?: boolean;
  enabled?: boolean;
  position?: number;
}

export type UpdateHttpOperationInput = Partial<Omit<CreateHttpOperationInput, 'serviceId'>>;

export async function createHttpOperation(
  db: Executor,
  actor: ActorContext,
  input: CreateHttpOperationInput
): Promise<HttpOperation> {
  assertPermission(actor, Permissions.httpWrite, 'Not permitted to create HTTP operations');
  const service = findServiceRow(db, actor.workspaceId, input.serviceId);
  if (!service) throw errors.notFound('HTTP service', input.serviceId);
  if (service.archivedAt !== null) throw errors.precondition('HTTP service is archived');

  const key = normalizeOperationKey(input.key);
  const path = input.path?.trim();
  if (!path) throw errors.validation('HTTP operation path is required');
  const parameters = input.parameters ?? null;
  assertUniqueParameterNames(parameters);

  const duplicate = findOperationRowByKey(db, actor.workspaceId, key);
  if (duplicate) {
    throw errors.conflict(`An HTTP operation with key "${key}" already exists`, { key });
  }

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const row = insertOperationRow(tx, {
      id: uuidv7(),
      workspaceId: actor.workspaceId,
      serviceId: service.id,
      key,
      name: input.name?.trim() || key,
      description: input.description ?? '',
      method: input.method ?? 'GET',
      path,
      parameters,
      headers: input.headers ?? null,
      body: input.body ?? null,
      inputSchema: input.inputSchema ?? null,
      outputSchema: input.outputSchema ?? null,
      successRules: input.successRules ?? null,
      responseMapping: input.responseMapping ?? null,
      timeoutMs: input.timeoutMs ?? null,
      retryPolicy: input.retryPolicy ?? null,
      cachePolicy: input.cachePolicy ?? null,
      approvalPolicy: input.approvalPolicy ?? null,
      rateLimitOverride: input.rateLimitOverride ?? null,
      exposeAsTool: input.exposeAsTool ?? true,
      enabled: input.enabled ?? true,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now
    });
    const synced = syncToolForOperation(tx, row, service);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.operationCreated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'http_operation',
      entityId: synced.id,
      workflowId: service.workflowId,
      summary: `HTTP operation "${synced.key}" created`,
      data: { key: synced.key, method: synced.method, path: synced.path, serviceId: service.id }
    });
    return synced;
  });
}

export async function updateHttpOperation(
  db: Executor,
  actor: ActorContext,
  operationId: string,
  patch: UpdateHttpOperationInput
): Promise<HttpOperation> {
  assertPermission(actor, Permissions.httpWrite, 'Not permitted to update HTTP operations');
  const current = findOperationRow(db, actor.workspaceId, operationId);
  if (!current) throw errors.notFound('HTTP operation', operationId);
  const service = findServiceRow(db, actor.workspaceId, current.serviceId);
  if (!service) throw errors.notFound('HTTP service', current.serviceId);

  const updates: Partial<CreateHttpOperationInput> = {};
  if (patch.key !== undefined) {
    const key = normalizeOperationKey(patch.key);
    if (key !== current.key) {
      const duplicate = findOperationRowByKey(db, actor.workspaceId, key);
      if (duplicate && duplicate.id !== current.id) {
        throw errors.conflict(`An HTTP operation with key "${key}" already exists`, { key });
      }
    }
    updates.key = key;
  }
  if (patch.name !== undefined) updates.name = patch.name.trim() || current.key;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.method !== undefined) updates.method = patch.method;
  if (patch.path !== undefined) {
    const path = patch.path.trim();
    if (!path) throw errors.validation('HTTP operation path is required');
    updates.path = path;
  }
  if (patch.parameters !== undefined) {
    assertUniqueParameterNames(patch.parameters ?? null);
    updates.parameters = patch.parameters;
  }
  if (patch.headers !== undefined) updates.headers = patch.headers;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.inputSchema !== undefined) updates.inputSchema = patch.inputSchema;
  if (patch.outputSchema !== undefined) updates.outputSchema = patch.outputSchema;
  if (patch.successRules !== undefined) updates.successRules = patch.successRules;
  if (patch.responseMapping !== undefined) updates.responseMapping = patch.responseMapping;
  if (patch.timeoutMs !== undefined) updates.timeoutMs = patch.timeoutMs;
  if (patch.retryPolicy !== undefined) updates.retryPolicy = patch.retryPolicy;
  if (patch.cachePolicy !== undefined) updates.cachePolicy = patch.cachePolicy;
  if (patch.approvalPolicy !== undefined) updates.approvalPolicy = patch.approvalPolicy;
  if (patch.rateLimitOverride !== undefined) updates.rateLimitOverride = patch.rateLimitOverride;
  if (patch.exposeAsTool !== undefined) updates.exposeAsTool = patch.exposeAsTool;
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  if (patch.position !== undefined) updates.position = patch.position;

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const row = updateOperationRow(tx, actor.workspaceId, operationId, {
      ...updates,
      updatedAt: now
    });
    if (!row) throw errors.notFound('HTTP operation', operationId);
    const synced = syncToolForOperation(tx, row, service);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.operationUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'http_operation',
      entityId: synced.id,
      workflowId: service.workflowId,
      summary: `HTTP operation "${synced.key}" updated`,
      data: {
        key: synced.key,
        changedFields: Object.keys(updates),
        exposeAsTool: synced.exposeAsTool
      }
    });
    return synced;
  });
}

export async function archiveHttpOperation(
  db: Executor,
  actor: ActorContext,
  operationId: string
): Promise<HttpOperation> {
  assertPermission(actor, Permissions.httpWrite, 'Not permitted to archive HTTP operations');
  const current = findOperationRow(db, actor.workspaceId, operationId);
  if (!current) throw errors.notFound('HTTP operation', operationId);
  const service = findServiceRow(db, actor.workspaceId, current.serviceId);
  if (!service) throw errors.notFound('HTTP service', current.serviceId);
  if (current.archivedAt !== null) return current;

  const now = Date.now();
  return withTransaction(db, (tx) => {
    const row = updateOperationRow(tx, actor.workspaceId, operationId, {
      archivedAt: now,
      updatedAt: now
    });
    if (!row) throw errors.notFound('HTTP operation', operationId);
    const synced = syncToolForOperation(tx, row, service);
    writeAudit(tx, {
      workspaceId: actor.workspaceId,
      action: AuditActions.operationUpdated,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      entityType: 'http_operation',
      entityId: synced.id,
      workflowId: service.workflowId,
      summary: `HTTP operation "${synced.key}" archived`,
      data: { key: synced.key, archived: true }
    });
    return synced;
  });
}

export function getHttpOperation(
  db: Executor,
  actor: ActorContext,
  operationId: string
): HttpOperation {
  assertPermission(actor, Permissions.httpRead, 'Not permitted to read HTTP operations');
  const row = findOperationRow(db, actor.workspaceId, operationId);
  if (!row) throw errors.notFound('HTTP operation', operationId);
  return row;
}

export function getHttpOperationByKey(
  db: Executor,
  actor: ActorContext,
  key: string
): HttpOperation {
  assertPermission(actor, Permissions.httpRead, 'Not permitted to read HTTP operations');
  const row = findOperationRowByKey(db, actor.workspaceId, normalizeOperationKey(key));
  if (!row) throw errors.notFound('HTTP operation', key);
  return row;
}

export function listHttpOperations(
  db: Executor,
  actor: ActorContext,
  options: ListOperationOptions = {}
): HttpOperation[] {
  assertPermission(actor, Permissions.httpRead, 'Not permitted to read HTTP operations');
  return listOperationRows(db, actor.workspaceId, options);
}

/**
 * Create/update/disable the `tools` row derived from an operation.
 *
 * Called inside the caller's transaction so the operation row, the tool row and the
 * audit row commit together. Returns the operation with a current `toolId`.
 */
export function syncToolForOperation(
  executor: Executor,
  operation: HttpOperation,
  service: HttpService
): HttpOperation {
  const now = Date.now();
  const active =
    operation.exposeAsTool &&
    operation.enabled &&
    operation.archivedAt === null &&
    service.archivedAt === null;

  if (!active) {
    if (operation.toolId) {
      executor
        .update(tools)
        .set({ enabled: false, updatedAt: now })
        .where(and(eq(tools.id, operation.toolId), eq(tools.workspaceId, operation.workspaceId)))
        .run();
    }
    return operation;
  }

  const inputSchema =
    operation.inputSchema ?? inferInputSchema(operation.parameters, operation.body);
  const implementation: ToolImplementation = {
    kind: 'http',
    operationId: operation.id,
    serviceId: service.id
  };
  const values = {
    key: operation.key,
    name: operation.name,
    description: operation.description,
    kind: 'http' as const,
    implementation,
    inputSchema,
    outputSchema: operation.outputSchema ?? null,
    permissions: [Permissions.httpInvoke],
    timeoutSeconds: Math.max(
      1,
      Math.round((operation.timeoutMs ?? service.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)
    ),
    retryPolicy: operation.retryPolicy ?? service.retryPolicy ?? null,
    approvalPolicy: operation.approvalPolicy ?? service.defaultApprovalPolicy ?? null,
    cachePolicy: operation.cachePolicy ?? service.cachePolicy ?? null,
    enabled: true,
    updatedAt: now,
    archivedAt: null
  };

  let toolId = operation.toolId;
  let existing = toolId ? findToolRow(executor, operation.workspaceId, toolId) : null;
  if (!existing) {
    const byKey = findToolRowByKey(executor, operation.workspaceId, operation.key);
    if (byKey) {
      if (byKey.kind !== 'http') {
        throw errors.conflict(
          `A ${byKey.kind} tool with key "${operation.key}" already exists; choose another operation key`
        );
      }
      const bound = byKey.implementation;
      if (bound.kind === 'http' && bound.operationId !== operation.id) {
        throw errors.conflict(`Tool key "${operation.key}" is already bound to another operation`);
      }
      existing = byKey;
      toolId = byKey.id;
    }
  }

  if (existing) {
    executor
      .update(tools)
      .set({ ...values, version: existing.version + 1 })
      .where(and(eq(tools.id, existing.id), eq(tools.workspaceId, operation.workspaceId)))
      .run();
  } else {
    const inserted = executor
      .insert(tools)
      .values({
        id: uuidv7(),
        workspaceId: operation.workspaceId,
        version: 1,
        createdAt: now,
        ...values
      })
      .returning({ id: tools.id })
      .all()[0];
    if (!inserted) throw errors.internal('Failed to create HTTP tool row');
    toolId = inserted.id;
  }

  if (toolId && toolId !== operation.toolId) {
    return (
      updateOperationRow(executor, operation.workspaceId, operation.id, {
        toolId,
        updatedAt: now
      }) ?? operation
    );
  }
  return operation;
}

/** The schema a model sees: authored when present, otherwise inferred from the wire contract. */
export function inferOperationInputSchema(
  operation: Pick<HttpOperation, 'parameters' | 'body' | 'inputSchema'>
): JsonSchema {
  if (operation.inputSchema && typeof operation.inputSchema === 'object') {
    return operation.inputSchema as JsonSchema;
  }
  return inferInputSchema(operation.parameters, operation.body);
}

/**
 * Best-effort JSON Schema from a sample response, used by the editor's "infer schema"
 * action. Arrays are typed from their first element; an empty array stays untyped
 * rather than guessing.
 */
export function inferOutputSchemaFromSample(sample: unknown): JsonSchema {
  if (sample === null) return { type: ['null'] };
  if (Array.isArray(sample)) {
    return sample.length > 0
      ? { type: 'array', items: inferOutputSchemaFromSample(sample[0]) }
      : { type: 'array' };
  }
  switch (typeof sample) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(sample) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
        properties[key] = inferOutputSchemaFromSample(value);
        required.push(key);
      }
      return { type: 'object', properties, required };
    }
    default:
      return {};
  }
}

function assertHttpBaseUrl(raw: string): string {
  const value = raw?.trim();
  if (!value) throw errors.validation('HTTP service base URL is required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw errors.validation(`HTTP service base URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw errors.validation('HTTP service base URL must use http or https');
  }
  return value;
}

function normalizeOperationKey(raw: string): string {
  const key = raw?.trim().toLowerCase();
  if (!key || !OPERATION_KEY_RE.test(key)) {
    throw errors.validation(
      'HTTP operation key must be lowercase letters, digits, dots, dashes or underscores',
      { key: raw }
    );
  }
  return key;
}

function assertUniqueParameterNames(parameters: readonly HttpParameterMapping[] | null): void {
  if (!parameters) return;
  const seen = new Set<string>();
  for (const parameter of parameters) {
    if (!parameter.name) throw errors.validation('HTTP parameter requires a name');
    if (seen.has(parameter.name)) {
      throw errors.validation(`Duplicate HTTP parameter "${parameter.name}"`, {
        parameter: parameter.name
      });
    }
    seen.add(parameter.name);
  }
}

function assertWorkflow(db: Executor, workspaceId: string, workflowId: string): void {
  const row = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId)))
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Workflow', workflowId);
}

/**
 * Validate the shape of an auth configuration and confirm referenced secrets exist in
 * this workspace. Values are never read here — only references are checked.
 */
function validateAuthConfig(
  db: Executor,
  workspaceId: string,
  authType: HttpAuthType,
  authConfig: HttpAuthConfig | null
): void {
  const config = authConfig ?? {};
  switch (authType) {
    case 'none':
      return;
    case 'bearer':
    case 'api_key_header':
    case 'api_key_query':
    case 'custom_header':
      assertSecretReference(db, workspaceId, config.secretId, authType);
      if (
        authType === 'custom_header' &&
        config.template &&
        !config.template.includes(SECRET_PLACEHOLDER)
      ) {
        throw errors.validation(`custom_header template must contain ${SECRET_PLACEHOLDER}`);
      }
      return;
    case 'basic':
      if (!config.username) throw errors.validation('Basic auth requires a username');
      assertSecretReference(db, workspaceId, config.passwordSecretId, 'basic');
      return;
    default: {
      const exhaustive: never = authType;
      throw errors.unsupported(`Unsupported auth type: ${String(exhaustive)}`);
    }
  }
}

function assertSecretReference(
  db: Executor,
  workspaceId: string,
  secretId: string | undefined,
  authType: HttpAuthType
): void {
  if (!secretId) throw errors.validation(`Auth type "${authType}" requires a secret reference`);
  const row = db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(eq(secrets.id, secretId), eq(secrets.workspaceId, workspaceId), isNull(secrets.deletedAt))
    )
    .limit(1)
    .all()[0];
  if (!row) throw errors.notFound('Secret', secretId);
}

function isSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
