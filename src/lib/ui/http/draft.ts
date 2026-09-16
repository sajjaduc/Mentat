/**
 * Editor drafts and their translation to API payloads.
 *
 * The editor keeps a *draft* rather than the API row because the two differ in ways
 * that matter: policies are `null` when they inherit the service default, JSON schemas
 * are edited as text so a half-typed document is not lost, and a raw body is a
 * template string rather than the mapped result.
 *
 * `inferredInputSchema` and `sampleInput` deliberately mirror the server's
 * `inferInputSchema`/`applyBodyMapping` rules so the "schema the model sees" preview
 * and the Test Request prefill match what execution will actually do.
 */

import { formatJson, type JsonSchema, parseJson } from './json';
import { templateParams } from './template';
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
  RetryPolicy
} from './types';

export interface OperationDraft {
  serviceId: string;
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  parameters: HttpParameterMapping[];
  headers: Record<string, string>;
  body: HttpBodyMapping;
  inputSchemaText: string;
  outputSchemaText: string;
  successRules: HttpSuccessRules;
  responseMapping: HttpResponseMapping;
  timeoutMs: number | null;
  retryPolicy: RetryPolicy | null;
  cachePolicy: CachePolicy | null;
  approvalPolicy: ApprovalPolicy | null;
  rateLimitOverride: RateLimitConfig | null;
  exposeAsTool: boolean;
  enabled: boolean;
  position: number;
}

export interface ServiceDraft {
  name: string;
  description: string;
  baseUrl: string;
  allowedHosts: string[];
  timeoutMs: number;
  rateLimit: RateLimitConfig | null;
  retryPolicy: RetryPolicy | null;
  cachePolicy: CachePolicy | null;
  defaultApprovalPolicy: ApprovalPolicy | null;
  authType: HttpAuthType;
  authConfig: HttpAuthConfig;
  defaultHeaders: Record<string, string>;
}

export function emptyOperation(serviceId: string): OperationDraft {
  return {
    serviceId,
    key: '',
    name: '',
    description: '',
    method: 'GET',
    path: '/',
    parameters: [],
    headers: {},
    body: { mode: 'none' },
    inputSchemaText: '',
    outputSchemaText: '',
    successRules: {},
    responseMapping: {},
    timeoutMs: null,
    retryPolicy: null,
    cachePolicy: null,
    approvalPolicy: null,
    rateLimitOverride: null,
    exposeAsTool: true,
    enabled: true,
    position: 0
  };
}

export function draftFromOperation(operation: HttpOperation): OperationDraft {
  return {
    serviceId: operation.serviceId,
    key: operation.key,
    name: operation.name,
    description: operation.description,
    method: operation.method,
    path: operation.path,
    parameters: operation.parameters ? [...operation.parameters] : [],
    headers: operation.headers ? { ...operation.headers } : {},
    body: operation.body ? { ...operation.body } : { mode: 'none' },
    inputSchemaText: operation.inputSchema ? formatJson(operation.inputSchema) : '',
    outputSchemaText: operation.outputSchema ? formatJson(operation.outputSchema) : '',
    successRules: operation.successRules ? { ...operation.successRules } : {},
    responseMapping: operation.responseMapping ? { ...operation.responseMapping } : {},
    timeoutMs: operation.timeoutMs,
    retryPolicy: operation.retryPolicy ? { ...operation.retryPolicy } : null,
    cachePolicy: operation.cachePolicy ? { ...operation.cachePolicy } : null,
    approvalPolicy: operation.approvalPolicy ? { ...operation.approvalPolicy } : null,
    rateLimitOverride: operation.rateLimitOverride ? { ...operation.rateLimitOverride } : null,
    exposeAsTool: operation.exposeAsTool,
    enabled: operation.enabled,
    position: operation.position
  };
}

export function serviceDraftFromService(service: HttpService): ServiceDraft {
  return {
    name: service.name,
    description: service.description ?? '',
    baseUrl: service.baseUrl,
    allowedHosts: service.allowedHosts ? [...service.allowedHosts] : [],
    timeoutMs: service.timeoutMs,
    rateLimit: service.rateLimit ? { ...service.rateLimit } : null,
    retryPolicy: service.retryPolicy ? { ...service.retryPolicy } : null,
    cachePolicy: service.cachePolicy ? { ...service.cachePolicy } : null,
    defaultApprovalPolicy: service.defaultApprovalPolicy
      ? { ...service.defaultApprovalPolicy }
      : null,
    authType: service.authType,
    authConfig: service.authConfig ? { ...service.authConfig } : {},
    defaultHeaders: service.defaultHeaders ? { ...service.defaultHeaders } : {}
  };
}

/** Problems a save would otherwise surface as a server 400. */
export function validateOperationDraft(draft: OperationDraft): string[] {
  const problems: string[] = [];
  if (draft.key.trim().length === 0) problems.push('Tool key is required.');
  if (draft.name.trim().length === 0) problems.push('Name is required.');
  if (draft.path.trim().length === 0) problems.push('Path is required.');
  if (draft.inputSchemaText.trim().length > 0 && !parseJson(draft.inputSchemaText).ok) {
    problems.push('Input schema is not valid JSON.');
  }
  if (draft.outputSchemaText.trim().length > 0 && !parseJson(draft.outputSchemaText).ok) {
    problems.push('Output schema is not valid JSON.');
  }
  const missing = missingPathParameters(draft);
  if (missing.length > 0) {
    problems.push(`Path parameter(s) not declared: ${missing.join(', ')}.`);
  }
  return problems;
}

export function validateServiceDraft(draft: ServiceDraft): string[] {
  const problems: string[] = [];
  if (draft.name.trim().length === 0) problems.push('Service name is required.');
  if (draft.baseUrl.trim().length === 0) problems.push('Base URL is required.');
  if (draft.timeoutMs < 100 || draft.timeoutMs > 120_000) {
    problems.push('Timeout must be between 100 and 120000 ms.');
  }
  for (const type of ['bearer', 'api_key_header', 'api_key_query', 'custom_header'] as const) {
    if (draft.authType === type && !draft.authConfig.secretId) {
      problems.push('This authentication type requires a secret.');
    }
  }
  if (draft.authType === 'basic') {
    if (!draft.authConfig.username) problems.push('Basic auth requires a username.');
    if (!draft.authConfig.passwordSecretId) problems.push('Basic auth requires a password secret.');
  }
  if (
    draft.authType === 'custom_header' &&
    !(draft.authConfig.template ?? '').includes('{{secret}}')
  ) {
    problems.push('The custom header template must contain {{secret}}.');
  }
  return problems;
}

export function operationPayload(draft: OperationDraft): Record<string, unknown> {
  const inputSchema = parseJson(draft.inputSchemaText);
  const outputSchema = parseJson(draft.outputSchemaText);
  return {
    serviceId: draft.serviceId,
    key: draft.key.trim().toLowerCase(),
    name: draft.name.trim(),
    description: draft.description,
    method: draft.method,
    path: draft.path,
    parameters: draft.parameters,
    headers: Object.keys(draft.headers).length > 0 ? draft.headers : null,
    body: draft.body,
    inputSchema: inputSchema.ok ? inputSchema.value : null,
    outputSchema: outputSchema.ok ? outputSchema.value : null,
    successRules: draft.successRules,
    responseMapping: draft.responseMapping,
    timeoutMs: draft.timeoutMs,
    retryPolicy: draft.retryPolicy,
    cachePolicy: draft.cachePolicy,
    approvalPolicy: draft.approvalPolicy,
    rateLimitOverride: draft.rateLimitOverride,
    exposeAsTool: draft.exposeAsTool,
    enabled: draft.enabled,
    position: draft.position
  };
}

export function servicePayload(draft: ServiceDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim().length > 0 ? draft.description : null,
    baseUrl: draft.baseUrl.trim(),
    allowedHosts: draft.allowedHosts.length > 0 ? draft.allowedHosts : null,
    timeoutMs: draft.timeoutMs,
    rateLimit: draft.rateLimit,
    retryPolicy: draft.retryPolicy,
    cachePolicy: draft.cachePolicy,
    defaultApprovalPolicy: draft.defaultApprovalPolicy,
    authType: draft.authType,
    authConfig: draft.authType === 'none' ? {} : draft.authConfig,
    defaultHeaders: Object.keys(draft.defaultHeaders).length > 0 ? draft.defaultHeaders : null
  };
}

/** Path template placeholders with no matching `location: 'path'` declaration. */
export function missingPathParameters(draft: {
  path: string;
  parameters: HttpParameterMapping[];
}): string[] {
  const declared = new Set(
    draft.parameters.filter((entry) => entry.location === 'path').map((entry) => entry.name)
  );
  return templateParams(draft.path).filter((name) => !declared.has(name));
}

export type JsonSchemaObject = JsonSchema;

/**
 * The JSON Schema a model sees when `inputSchema` is not authored. Mirrors the
 * server's `inferInputSchema`, including the closed `additionalProperties: false`.
 */
export function inferredInputSchema(
  parameters: readonly HttpParameterMapping[] | null | undefined,
  body: HttpBodyMapping | null | undefined
): JsonSchema {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  const add = (mapping: HttpParameterMapping) => {
    properties[mapping.name] = mapping.description
      ? { type: mapping.type ?? 'string', description: mapping.description }
      : { type: mapping.type ?? 'string' };
    if (mapping.required ?? mapping.location === 'path') required.push(mapping.name);
  };

  for (const parameter of parameters ?? []) {
    if (body?.mode === 'raw' && parameter.location === 'body') continue;
    add(parameter);
  }
  if (body?.mode === 'raw') {
    for (const name of templateParams(body.template ?? '')) {
      if (!properties[name]) {
        properties[name] = { type: 'string' };
        required.push(name);
      }
    }
  } else if (body?.passthrough) {
    properties.body = { type: 'object' };
    required.push('body');
  } else {
    for (const field of body?.fields ?? []) add(field);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function sampleForType(type: HttpParameterMapping['type']): unknown {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'object':
      return {};
    case 'array':
      return [];
    default:
      return '';
  }
}

/** Prefill for the Test Request input editor; declared defaults and constants win. */
export function sampleInput(draft: OperationDraft): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const mode = draft.body.mode;

  for (const parameter of draft.parameters) {
    if (mode === 'raw' && parameter.location === 'body') continue;
    if (parameter.constant !== undefined) {
      input[parameter.name] = parameter.constant;
      continue;
    }
    if (parameter.default !== undefined) {
      input[parameter.name] = parameter.default;
      continue;
    }
    if (parameter.location === 'body' && mode !== 'raw') continue;
    input[parameter.name] = sampleForType(parameter.type);
  }

  if (mode !== 'none') {
    if (draft.body.passthrough) {
      input.body = {};
    } else {
      for (const field of draft.body.fields ?? []) {
        if (field.constant !== undefined) input[field.name] = field.constant;
        else if (field.default !== undefined) input[field.name] = field.default;
        else input[field.name] = sampleForType(field.type);
      }
    }
  }
  return input;
}

/** Convenience used by the parameters table's "add missing" action. */
export function pathParameterMappings(names: string[]): HttpParameterMapping[] {
  return names.map((name) => ({
    name,
    location: 'path' as const,
    required: true,
    type: 'string' as const
  }));
}
