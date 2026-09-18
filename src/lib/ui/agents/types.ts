/**
 * Agent, skill, tool, provider and model types.
 *
 * These mirror the `/api` contract so the configuration pages are typed against the
 * same vocabulary the services use. The important shape decision is that
 * {@link AgentView} is a *view*: it adds the resolved current version, the skills it
 * references and its run statistics, none of which are stored on the agent row
 * (ADR-0008 keeps the run's pinned version separate from the editable head).
 */

import {
  isReasoningEffort,
  normalizeReasoningEfforts,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_OPTIONS,
  REASONING_EFFORTS,
  type ReasoningEffort
} from '$shared/reasoning';
import type { ApprovalPolicy, CachePolicy, HttpService, RetryPolicy } from '../http/types';

export interface ModelCapabilities {
  streaming?: boolean;
  toolCalling?: boolean;
  jsonMode?: boolean;
  vision?: boolean;
  embeddings?: boolean;
  /** Supports controllable reasoning/thinking. */
  reasoning?: boolean;
  /** Portable levels the model accepts; absent means "derive from the provider". */
  reasoningEfforts?: ReasoningEffort[];
}

export interface ModelInferenceDefaults {
  temperature?: number;
  topP?: number;
  topK?: number;
  numCtx?: number;
  numPredict?: number;
  stop?: string[];
  seed?: number;
  repeatPenalty?: number;
  /** Default reasoning level for this model; an agent can override it. */
  reasoningEffort?: ReasoningEffort;
  /** Provider-native reasoning keys applied after the level is mapped. */
  reasoningOptions?: Record<string, unknown>;
}

export type ProviderType = 'ollama' | 'openai' | 'openai_compatible' | 'anthropic' | 'fake';

export interface Provider {
  id: string;
  workspaceId: string;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  /** Secret reference only; the key itself is never returned. */
  apiKeySecretId: string | null;
  config: {
    keepAlive?: string;
    organization?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    queryParams?: Record<string, string>;
  } | null;
  enabled: boolean;
  isDefault: boolean;
  healthStatus: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  healthMessage: string | null;
  healthCheckedAt: number | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unreachable';
  latencyMs?: number;
  message?: string;
  modelCount?: number;
}

export interface CheckHealthResult {
  provider: Provider;
  health: ProviderHealth;
}

export interface RefreshModelsResult {
  added: number;
  updated: number;
  removed: number;
  models: Model[];
}

export interface Model {
  id: string;
  workspaceId: string;
  providerId: string;
  modelKey: string;
  displayName: string;
  description: string | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  capabilities: ModelCapabilities | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inferenceDefaults: ModelInferenceDefaults | null;
  inputCostPerMTokCents: number | null;
  outputCostPerMTokCents: number | null;
  enabled: boolean;
  isFavorite: boolean;
  /** True when discovered from the provider rather than registered by hand. */
  discovered: boolean;
  discoveredAt: number | null;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentExecutionConfig {
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutSeconds?: number;
  /** Reasoning level for thinking models; unsupported levels are dropped at run time. */
  reasoningEffort?: ReasoningEffort;
  /** Provider-native reasoning keys that win over the portable level. */
  reasoningOptions?: Record<string, unknown>;
  continueOnToolError?: boolean;
  retryOnProviderError?: boolean;
  requireApprovalForMutations?: boolean;
}

export interface AgentPermissions {
  /** Native capability keys, e.g. `work item.fields.set` or `mentat.data.get`. */
  native?: string[];
  /** HTTP operation ids the agent may invoke. */
  httpOperationIds?: string[];
  canTransferWork?: boolean;
  canCreateWork?: boolean;
  canWriteWorkspaceState?: boolean;
  canUploadFiles?: boolean;
  /** Field keys the agent may write; empty means none, `*` means all. */
  writableFieldKeys?: string[];
}

export interface Agent {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  sourceAgentId: string | null;
  bindingMode: 'use_asis' | 'override' | 'fork';
  name: string;
  description: string | null;
  instructions: string;
  providerId: string | null;
  modelId: string | null;
  skillIds: string[] | null;
  toolIds: string[] | null;
  outputSchema: unknown;
  executionConfig: AgentExecutionConfig | null;
  permissions: AgentPermissions | null;
  currentVersionId: string | null;
  version: number;
  isFavorite: boolean;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface AgentStats {
  runs: number;
  failures: number;
  lastRunAt: number | null;
}

export interface AgentView extends Agent {
  currentVersion: number;
  skills: Array<{ id: string; name: string; version: number; description: string | null }>;
  toolKeys: string[];
  /** Present on list responses only. */
  stats?: AgentStats;
}

export interface AgentVersion {
  id: string;
  version: number;
  changeNote: string | null;
  createdAt: number;
}

export interface SkillExample {
  title: string;
  input?: string;
  output?: string;
  notes?: string;
}

export interface SkillReference {
  title: string;
  url?: string;
  content?: string;
}

export interface Skill {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  sourceSkillId: string | null;
  bindingMode: 'use_asis' | 'override' | 'fork';
  name: string;
  description: string | null;
  category: string | null;
  currentVersionId: string | null;
  version: number;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface SkillView extends Skill {
  instructions: string;
  examples: SkillExample[];
  references: SkillReference[];
  recommendedToolKeys: string[];
}

export interface NativeToolDescriptor {
  id: null;
  /** The materialised `tools` row, when the native handler has one. */
  rowId: string | null;
  key: string;
  name: string;
  description: string;
  kind: 'native';
  inputSchema: unknown;
  permission: string | null;
  enabled: boolean;
}

export interface ToolImplementation {
  kind: 'native' | 'http' | 'mcp';
  key?: string;
  operationId?: string;
  serviceId?: string;
  serverId?: string;
  toolName?: string;
}

export interface Tool {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string;
  kind: 'native' | 'http' | 'mcp';
  implementation: ToolImplementation;
  inputSchema: unknown;
  outputSchema: unknown;
  permissions: string[] | null;
  timeoutSeconds: number;
  retryPolicy: RetryPolicy | null;
  approvalPolicy: ApprovalPolicy | null;
  cachePolicy: CachePolicy | null;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type McpAuthType = 'none' | 'bearer' | 'custom_header';

export interface McpAuthConfig {
  /** Secret reference only; the value is never returned. */
  secretId?: string;
  headerName?: string;
  template?: string;
}

export interface McpServer {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  url: string;
  transport: 'http' | 'sse';
  authType: McpAuthType;
  authConfig: McpAuthConfig | null;
  defaultHeaders: Record<string, string> | null;
  timeoutMs: number;
  enabled: boolean;
  lastDiscoveredAt: number | null;
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** One operation an OpenAPI import would create. */
export interface OpenApiOperationDraft {
  key: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    location: 'path' | 'query' | 'header' | 'body';
    required?: boolean;
    description?: string;
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  }>;
  body: unknown;
  outputSchema: unknown;
}

export interface OpenApiPreview {
  title: string;
  version: string | null;
  baseUrl: string | null;
  namespace: string;
  operations: OpenApiOperationDraft[];
}

export interface RunSummary {
  id: string;
  status: string;
  agentId: string | null;
  agent_name?: string | null;
  record_key?: string | null;
  createdAt: number;
  [key: string]: unknown;
}

export const CAPABILITY_KEYS: ReadonlyArray<{
  key: keyof ModelCapabilities;
  label: string;
  hint: string;
}> = [
  { key: 'streaming', label: 'Streaming', hint: 'Emits tokens incrementally' },
  { key: 'toolCalling', label: 'Tool calling', hint: 'Can request a Mentat tool' },
  { key: 'jsonMode', label: 'JSON mode', hint: 'Can be constrained to JSON output' },
  { key: 'vision', label: 'Vision', hint: 'Accepts image input' },
  { key: 'reasoning', label: 'Reasoning', hint: 'Exposes a thinking channel' },
  { key: 'embeddings', label: 'Embeddings', hint: 'Produces vectors, not chat' }
];

export {
  isReasoningEffort,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_OPTIONS,
  REASONING_EFFORTS,
  type ReasoningEffort
};

/**
 * Levels a model declares it accepts, from the client's point of view.
 *
 * The provider type is not known here, so a model that declares reasoning without
 * an explicit effort set is offered every level and the runner drops anything the
 * model turns out not to accept.
 */
export function supportedReasoningEffortsFor(
  capabilities: ModelCapabilities | null | undefined
): ReasoningEffort[] {
  if (capabilities?.reasoning !== true) return [];
  const declared = normalizeReasoningEfforts(capabilities.reasoningEfforts);
  return declared ?? [...REASONING_EFFORTS];
}

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  fake: 'Fake (tests)'
};

/** The namespaces the native permission checklist groups by. */
export const NATIVE_PERMISSION_NAMESPACES = [
  'workflowItems',
  'state',
  'data',
  'cache',
  'files'
] as const;

/** A workflow as the scope pickers need it. */
export interface WorkflowOption {
  id: string;
  name: string;
  key: string;
}

export type { ApprovalPolicy, CachePolicy, HttpService, RetryPolicy };
