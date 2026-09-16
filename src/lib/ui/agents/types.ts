/**
 * Agent, skill, tool, provider and model types.
 *
 * These mirror the `/api` contract so the configuration pages are typed against the
 * same vocabulary the services use. The important shape decision is that
 * {@link AgentView} is a *view*: it adds the resolved current version, the skills it
 * references and its run statistics, none of which are stored on the agent row
 * (ADR-0008 keeps the run's pinned version separate from the editable head).
 */

import type { ApprovalPolicy, CachePolicy, HttpService, RetryPolicy } from '../http/types';

export interface ModelCapabilities {
  streaming?: boolean;
  toolCalling?: boolean;
  jsonMode?: boolean;
  vision?: boolean;
  embeddings?: boolean;
  reasoning?: boolean;
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
  continueOnToolError?: boolean;
  retryOnProviderError?: boolean;
  requireApprovalForMutations?: boolean;
}

export interface AgentPermissions {
  /** Native capability keys, e.g. `ticket.fields.set` or `mentat.data.get`. */
  native?: string[];
  /** HTTP operation ids the agent may invoke. */
  httpOperationIds?: string[];
  canTransferTickets?: boolean;
  canCreateTickets?: boolean;
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
  key: string;
  name: string;
  description: string;
  kind: 'native';
  inputSchema: unknown;
  permission: string | null;
  enabled: boolean;
}

export interface ToolImplementation {
  kind: 'native' | 'http';
  key?: string;
  operationId?: string;
  serviceId?: string;
}

export interface Tool {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string;
  kind: 'native' | 'http';
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

export interface RunSummary {
  id: string;
  status: string;
  agentId: string | null;
  agent_name?: string | null;
  ticket_key?: string | null;
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

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  fake: 'Fake (tests)'
};

/** The namespaces the native permission checklist groups by. */
export const NATIVE_PERMISSION_NAMESPACES = ['ticket', 'state', 'data', 'cache', 'files'] as const;

/** A workflow as the scope pickers need it. */
export interface WorkflowOption {
  id: string;
  name: string;
  key: string;
}

export type { ApprovalPolicy, CachePolicy, HttpService, RetryPolicy };
