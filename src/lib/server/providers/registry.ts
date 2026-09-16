/**
 * Provider registry.
 *
 * `getProviderForModel` is the single entry point the execution engine and the
 * file-extraction pipeline use to turn a `(workspaceId, modelId)` pair into a
 * live `ModelProvider`. Everything provider-specific stays below this line, which
 * is what lets a fake provider drive the whole execution suite (ADR-0015).
 *
 * Instances are cached by `(providerId, updatedAt)`, so editing a provider's
 * configuration produces a new instance on the next call while steady-state
 * generation avoids re-decrypting the API key on every request. Secret
 * resolution still goes exclusively through `resolveSecretValue`.
 */
import { and, eq } from 'drizzle-orm';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import { type Model, models, type Provider, providers } from '../db/schema';
import { resolveSecretValue } from '../secrets/service';
import { AnthropicProvider } from './anthropic';
import { FakeProvider } from './fake';
import { OllamaProvider } from './ollama';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { ModelProvider } from './types';

const instanceCache = new Map<string, ModelProvider>();
const overrides = new Map<string, ModelProvider>();

export interface CreateProviderOptions {
  /** Inject a provider instance for this row (tests, local development). */
  override?: ModelProvider;
  /** Convenience shorthand for a scripted fake provider. */
  fakeProvider?: FakeProvider;
}

function resolveApiKey(db: Executor, providerRow: Provider): string | null {
  if (!providerRow.apiKeySecretId) return null;
  return resolveSecretValue(db, {
    workspaceId: providerRow.workspaceId,
    secretId: providerRow.apiKeySecretId,
    purpose: `provider:${providerRow.type}`
  });
}

function constructProvider(db: Executor, providerRow: Provider): ModelProvider {
  const config = providerRow.config ?? {};
  const baseUrl = providerRow.baseUrl ?? undefined;
  const apiKey = resolveApiKey(db, providerRow);

  switch (providerRow.type) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: baseUrl ?? 'http://localhost:11434',
        apiKey,
        timeoutMs: config.timeoutMs,
        keepAlive: config.keepAlive,
        headers: config.headers,
        queryParams: config.queryParams
      });
    case 'openai':
      return new OpenAiCompatibleProvider({
        type: 'openai',
        baseUrl: baseUrl ?? 'https://api.openai.com',
        apiKey,
        timeoutMs: config.timeoutMs,
        organization: config.organization,
        headers: config.headers,
        queryParams: config.queryParams
      });
    case 'openai_compatible':
      return new OpenAiCompatibleProvider({
        type: 'openai_compatible',
        baseUrl: baseUrl ?? 'http://localhost:8000',
        apiKey,
        timeoutMs: config.timeoutMs,
        organization: config.organization,
        headers: config.headers,
        queryParams: config.queryParams
      });
    case 'anthropic':
      return new AnthropicProvider({
        baseUrl: baseUrl ?? 'https://api.anthropic.com',
        apiKey,
        timeoutMs: config.timeoutMs,
        headers: config.headers
      });
    case 'fake':
      return new FakeProvider();
    default:
      throw errors.unsupported(`Unsupported provider type "${String(providerRow.type)}"`, {
        type: providerRow.type
      });
  }
}

/**
 * Build (or reuse) the provider for a row.
 *
 * Test seams `options.override` and `setProviderOverride` are checked first so a
 * workstream can script the fake provider without touching the database.
 */
export function createProvider(
  db: Executor,
  providerRow: Provider,
  options: CreateProviderOptions = {}
): ModelProvider {
  const injected = options.override ?? options.fakeProvider ?? overrides.get(providerRow.id);
  if (injected) return injected;

  const cacheKey = `${providerRow.id}:${providerRow.updatedAt}`;
  const cached = instanceCache.get(cacheKey);
  if (cached) return cached;

  const provider = constructProvider(db, providerRow);
  instanceCache.set(cacheKey, provider);
  return provider;
}

export interface ProviderForModelInput {
  workspaceId: string;
  modelId: string;
}

/**
 * Resolve the provider and model row for a workspace-scoped model id.
 *
 * Cross-workspace access returns `notFound`, never `forbidden`, so a probe
 * cannot confirm that another tenant's model exists.
 */
export function getProviderForModel(
  db: Executor,
  input: ProviderForModelInput
): { provider: ModelProvider; model: Model } {
  const modelRows = db
    .select()
    .from(models)
    .where(and(eq(models.id, input.modelId), eq(models.workspaceId, input.workspaceId)))
    .limit(1)
    .all();
  const model = modelRows[0];
  if (!model) throw errors.notFound('Model', input.modelId);

  const providerRows = db
    .select()
    .from(providers)
    .where(and(eq(providers.id, model.providerId), eq(providers.workspaceId, input.workspaceId)))
    .limit(1)
    .all();
  const providerRow = providerRows[0];
  if (!providerRow) throw errors.notFound('Provider', model.providerId);

  return { provider: createProvider(db, providerRow), model };
}

/** Test helper: drop cached instances so a config edit is observable immediately. */
export function resetProviderCache(): void {
  instanceCache.clear();
}

/** Test helper: force a specific instance for a provider id. */
export function setProviderOverride(providerId: string, provider: ModelProvider): void {
  overrides.set(providerId, provider);
}

/** Test helper: remove all injected overrides. */
export function clearProviderOverrides(): void {
  overrides.clear();
}
