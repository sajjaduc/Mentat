/**
 * Providers (connections) and Models (selectable inference targets).
 *
 * Provider and Model are separate on purpose: one Ollama server can host many
 * models, and the same model key can be served by different providers with
 * different defaults. The runner depends only on the `ModelProvider` interface,
 * never on Ollama directly (ADR-0015).
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ReasoningEffort } from '../../../shared/reasoning';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';
import { users, workspaces } from './tenancy';

export type ProviderType = 'ollama' | 'openai' | 'openai_compatible' | 'anthropic' | 'fake';

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

export interface ProviderConfig {
  /** Ollama: keep-alive window; OpenAI-compatible: organization/project ids. */
  keepAlive?: string;
  organization?: string;
  headers?: Record<string, string>;
  /** Request timeout for provider calls. */
  timeoutMs?: number;
  /** Extra query parameters appended to generation requests. */
  queryParams?: Record<string, string>;
}

export const providers = sqliteTable(
  'providers',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<ProviderType>().notNull(),
    baseUrl: text('base_url'),
    /** Secret reference for the API key / bearer token. */
    apiKeySecretId: text('api_key_secret_id'),
    config: json<ProviderConfig>('config'),
    enabled: bool('enabled', true),
    isDefault: bool('is_default'),
    healthStatus: text('health_status')
      .$type<'unknown' | 'healthy' | 'degraded' | 'unreachable'>()
      .notNull()
      .default('unknown'),
    healthMessage: text('health_message'),
    healthCheckedAt: epochMs('health_checked_at'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('providers_name_unique').on(table.workspaceId, table.name),
    index('providers_workspace_idx').on(table.workspaceId, table.enabled)
  ]
);

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

export const models = sqliteTable(
  'models',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    /** Provider-native model identifier, e.g. `llama3.1:8b`. */
    modelKey: text('model_key').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    family: text('family'),
    parameterSize: text('parameter_size'),
    quantization: text('quantization'),
    capabilities: json<ModelCapabilities>('capabilities'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    inferenceDefaults: json<ModelInferenceDefaults>('inference_defaults'),
    /** Pricing metadata in cents per 1M tokens, when known. */
    inputCostPerMTokCents: real('input_cost_per_mtokens_cents'),
    outputCostPerMTokCents: real('output_cost_per_mtokens_cents'),
    enabled: bool('enabled', true),
    isFavorite: bool('is_favorite'),
    /** True when discovered from the provider rather than registered by hand. */
    discovered: bool('discovered'),
    discoveredAt: epochMs('discovered_at'),
    lastSeenAt: epochMs('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('models_provider_key_unique').on(table.providerId, table.modelKey),
    index('models_workspace_idx').on(table.workspaceId, table.enabled)
  ]
);

export const providerHealthChecks = sqliteTable(
  'provider_health_checks',
  {
    id: primaryId(),
    workspaceId: text('workspace_id').notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    status: text('status').$type<'healthy' | 'degraded' | 'unreachable'>().notNull(),
    latencyMs: integer('latency_ms'),
    message: text('message'),
    modelCount: integer('model_count'),
    checkedAt: integer('checked_at').notNull()
  },
  (table) => [index('provider_health_checks_idx').on(table.providerId, table.checkedAt)]
);

export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
export type ProviderHealthCheck = typeof providerHealthChecks.$inferSelect;
