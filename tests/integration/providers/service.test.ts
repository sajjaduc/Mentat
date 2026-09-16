/**
 * Provider and model service contracts.
 *
 * These tests exercise the trust boundaries — permissions, workspace scoping,
 * audit records — and the persistence side effects of health checks and model
 * discovery, all against the mock provider server.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { AuditActions, queryAudit } from '../../../src/lib/server/audit/ledger';
import { isAppError } from '../../../src/lib/server/core/errors';
import {
  agentRuns,
  models,
  providerHealthChecks,
  providers
} from '../../../src/lib/server/db/schema';
import {
  deleteModel,
  listModels,
  registerModel,
  setEnabled,
  setFavorite,
  updateModel,
  updateModelDefaults
} from '../../../src/lib/server/providers/models';
import {
  checkHealth,
  deleteProvider,
  getProvider,
  listProviders,
  refreshModels,
  registerProvider,
  updateProvider
} from '../../../src/lib/server/providers/service';
import { ProviderUnavailableError } from '../../../src/lib/server/providers/types';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, memberActor, ownerActor } from '../../helpers/factories';
import { jsonReply, type MockOllamaServer, startMockOllama } from '../../helpers/mock-ollama';

const OLLAMA_URL = 'http://127.0.0.1:1';

let handle: TestDatabase;
let server: MockOllamaServer | null = null;

function tag(name: string, family: string, quantization: string) {
  return {
    name,
    model: name,
    modified_at: new Date(0).toISOString(),
    size: 1_000,
    digest: 'a'.repeat(64),
    details: {
      parent_model: '',
      format: 'gguf',
      family,
      families: [family],
      parameter_size: '8.0B',
      quantization_level: quantization
    }
  };
}

beforeEach(() => {
  handle = createTestDatabase();
});

afterEach(() => {
  server?.stop();
  server = null;
  handle.cleanup();
});

async function tenants() {
  const a = await createWorkspace(handle.db, 'Workspace A');
  const b = await createWorkspace(handle.db, 'Workspace B');
  const userA = await createUser(handle.db);
  const userB = await createUser(handle.db);
  return {
    a,
    b,
    ownerA: ownerActor(a.id, userA.id),
    ownerB: ownerActor(b.id, userB.id),
    memberA: memberActor(a.id, userA.id)
  };
}

describe('provider service', () => {
  test('registers, lists and updates a provider with audit rows', async () => {
    const { a, ownerA } = await tenants();
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: OLLAMA_URL
    });
    expect(provider.workspaceId).toBe(a.id);
    expect(provider.type).toBe('ollama');
    expect(provider.enabled).toBe(true);

    expect(await listProviders(handle.db, ownerA)).toHaveLength(1);
    expect((await getProvider(handle.db, ownerA, provider.id)).name).toBe('Local Ollama');

    const updated = await updateProvider(handle.db, ownerA, provider.id, {
      name: 'Renamed Ollama',
      baseUrl: 'http://127.0.0.1:2'
    });
    expect(updated.name).toBe('Renamed Ollama');
    expect(updated.baseUrl).toBe('http://127.0.0.1:2');

    const created = await queryAudit(handle.db, {
      workspaceId: a.id,
      actions: [AuditActions.providerCreated]
    });
    const changed = await queryAudit(handle.db, {
      workspaceId: a.id,
      actions: [AuditActions.providerUpdated]
    });
    expect(created).toHaveLength(1);
    expect(changed).toHaveLength(1);
    expect(created[0]?.entityId).toBe(provider.id);
  });

  test('rejects writes without provider:write but allows reads with provider:read', async () => {
    const { ownerA, memberA } = await tenants();
    await registerProvider(handle.db, ownerA, { name: 'P', type: 'ollama', baseUrl: OLLAMA_URL });
    await expect(
      registerProvider(handle.db, memberA, { name: 'Nope', type: 'ollama', baseUrl: OLLAMA_URL })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await listProviders(handle.db, memberA)).toHaveLength(1);
  });

  test('never exposes another workspace provider', async () => {
    const { ownerA, ownerB } = await tenants();
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'A only',
      type: 'ollama',
      baseUrl: OLLAMA_URL
    });
    let thrown: unknown;
    try {
      getProvider(handle.db, ownerB, provider.id);
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) expect(thrown.code).toBe('not_found');
    expect(await listProviders(handle.db, ownerB)).toHaveLength(0);
    await expect(
      updateProvider(handle.db, ownerB, provider.id, { name: 'hijack' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('deleteProvider removes the row and cascades models', async () => {
    const { ownerA } = await tenants();
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'temp',
      type: 'ollama',
      baseUrl: OLLAMA_URL
    });
    await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'm1',
      displayName: 'M1',
      capabilities: { toolCalling: true }
    });
    await deleteProvider(handle.db, ownerA, provider.id);
    expect(await listProviders(handle.db, ownerA)).toHaveLength(0);
    expect(handle.sqlite.query('SELECT count(*) AS n FROM models').get()).toEqual({ n: 0 });
  });
});

describe('checkHealth', () => {
  test('persists a health check row and updates the provider columns', async () => {
    const { a, ownerA } = await tenants();
    server = startMockOllama({ models: ['llama3.1:8b'] });
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Health',
      type: 'ollama',
      baseUrl: server.url
    });

    const result = await checkHealth(handle.db, ownerA, provider.id);
    expect(result.health.status).toBe('healthy');

    const checks = await handle.db
      .select()
      .from(providerHealthChecks)
      .where(eq(providerHealthChecks.providerId, provider.id))
      .all();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('healthy');
    expect(checks[0]?.workspaceId).toBe(a.id);

    const rows = await handle.db
      .select()
      .from(providers)
      .where(eq(providers.id, provider.id))
      .all();
    expect(rows[0]?.healthStatus).toBe('healthy');
    expect(rows[0]?.healthCheckedAt).toBeGreaterThan(0);
    expect(rows[0]?.healthMessage).toContain('1');

    const audit = await queryAudit(handle.db, {
      workspaceId: a.id,
      actions: [AuditActions.providerHealthChecked]
    });
    expect(audit).toHaveLength(1);
  });

  test('records unreachable without throwing when the server is down', async () => {
    const { ownerA } = await tenants();
    server = startMockOllama();
    const url = server.url;
    server.stop();
    server = null;
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Down',
      type: 'ollama',
      baseUrl: url
    });
    const result = await checkHealth(handle.db, ownerA, provider.id);
    expect(result.health.status).toBe('unreachable');
    const rows = await handle.db
      .select()
      .from(providers)
      .where(eq(providers.id, provider.id))
      .all();
    expect(rows[0]?.healthStatus).toBe('unreachable');
  });
});

describe('refreshModels', () => {
  test('upserts, updates, disables disappeared models and is idempotent', async () => {
    const { a, ownerA } = await tenants();
    let tagModels = [
      tag('llama3.1:8b', 'llama', 'Q4_K_M'),
      tag('qwen2.5:7b', 'qwen2', 'Q4_K_M'),
      tag('llava:13b', 'llama', 'Q4_0')
    ];
    server = startMockOllama({
      routes: { '/api/tags': () => jsonReply({ models: tagModels }) }
    });
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Discovery',
      type: 'ollama',
      baseUrl: server.url
    });

    const first = await refreshModels(handle.db, ownerA, provider.id);
    expect(first.added).toBe(3);
    expect(first.updated).toBe(0);
    expect(first.removed).toBe(0);
    expect(first.models).toHaveLength(3);
    expect(first.models.every((model) => model.discovered)).toBe(true);
    expect(first.models[0]?.capabilities?.toolCalling).toBe(true);
    expect(first.models.find((model) => model.modelKey === 'llava:13b')?.capabilities?.vision).toBe(
      true
    );

    const second = await refreshModels(handle.db, ownerA, provider.id);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.removed).toBe(0);
    const count = handle.sqlite.query('SELECT count(*) AS n FROM models').get() as { n: number };
    expect(count.n).toBe(3);

    // One model changes family, one disappears, one is new.
    tagModels = [
      tag('llama3.1:8b', 'llama', 'Q4_K_M'),
      tag('qwen2.5:7b', 'qwen3', 'Q5_K_M'),
      tag('gemma2:9b', 'gemma2', 'Q4_0')
    ];
    const third = await refreshModels(handle.db, ownerA, provider.id);
    expect(third.added).toBe(1);
    expect(third.updated).toBe(1);
    expect(third.removed).toBe(1);

    const all = await handle.db
      .select()
      .from(models)
      .where(eq(models.providerId, provider.id))
      .all();
    const llava = all.find((model) => model.modelKey === 'llava:13b');
    expect(llava).toBeDefined();
    expect(llava?.enabled).toBe(false);
    expect(all.find((model) => model.modelKey === 'gemma2:9b')?.enabled).toBe(true);

    const audit = await queryAudit(handle.db, {
      workspaceId: a.id,
      actions: [AuditActions.modelsDiscovered]
    });
    expect(audit).toHaveLength(3);
  });

  test('surfaces a ProviderUnavailableError and writes nothing when discovery fails', async () => {
    const { ownerA } = await tenants();
    server = startMockOllama({ failWith: { '/api/tags': { status: 500, body: 'boom' } } });
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Broken discovery',
      type: 'ollama',
      baseUrl: server.url
    });
    await expect(refreshModels(handle.db, ownerA, provider.id)).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    expect(handle.sqlite.query('SELECT count(*) AS n FROM models').get()).toEqual({ n: 0 });
  });

  test('never overwrites capabilities of a hand-registered model', async () => {
    const { ownerA } = await tenants();
    let tagModels = [tag('llama3.1:8b', 'llama', 'Q4_K_M')];
    server = startMockOllama({
      routes: { '/api/tags': () => jsonReply({ models: tagModels }) }
    });
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Curated',
      type: 'ollama',
      baseUrl: server.url
    });
    await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'llama3.1:8b',
      displayName: 'Curated Llama',
      capabilities: { toolCalling: false, jsonMode: false },
      inferenceDefaults: { temperature: 0.05 }
    });

    const first = await refreshModels(handle.db, ownerA, provider.id);
    expect(first.added).toBe(0);
    expect(first.updated).toBe(0);
    const curated = first.models.find((model) => model.modelKey === 'llama3.1:8b');
    expect(curated?.discovered).toBe(false);
    expect(curated?.displayName).toBe('Curated Llama');
    expect(curated?.capabilities).toEqual({ toolCalling: false, jsonMode: false });
    expect(curated?.inferenceDefaults).toEqual({ temperature: 0.05 });
    expect(curated?.lastSeenAt).not.toBeNull();

    // It disappearing from the provider must not disable a curated model.
    tagModels = [tag('qwen2.5:7b', 'qwen2', 'Q4_K_M')];
    const second = await refreshModels(handle.db, ownerA, provider.id);
    expect(second.removed).toBe(0);
    const stillThere = second.models.find((model) => model.modelKey === 'llama3.1:8b');
    expect(stillThere?.enabled).toBe(true);
  });

  test('cannot refresh another workspace provider', async () => {
    const { ownerA, ownerB } = await tenants();
    server = startMockOllama();
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Scoped',
      type: 'ollama',
      baseUrl: server.url
    });
    await expect(refreshModels(handle.db, ownerB, provider.id)).rejects.toMatchObject({
      code: 'not_found'
    });
  });
});

describe('model service', () => {
  async function seedProvider() {
    const { a, ownerA, ownerB } = await tenants();
    const provider = await registerProvider(handle.db, ownerA, {
      name: 'Models',
      type: 'ollama',
      baseUrl: OLLAMA_URL
    });
    return { a, ownerA, ownerB, provider };
  }

  test('registers a model with explicit capabilities and rejects duplicates', async () => {
    const { ownerA, provider } = await seedProvider();
    const model = await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'custom:latest',
      displayName: 'Custom',
      capabilities: { toolCalling: true, jsonMode: false },
      inferenceDefaults: { temperature: 0.4, numCtx: 8192 },
      contextWindow: 32768,
      maxOutputTokens: 1024
    });
    expect(model.discovered).toBe(false);
    expect(model.capabilities).toEqual({ toolCalling: true, jsonMode: false });
    expect(model.inferenceDefaults).toEqual({ temperature: 0.4, numCtx: 8192 });

    await expect(
      registerModel(handle.db, ownerA, {
        providerId: provider.id,
        modelKey: 'custom:latest',
        displayName: 'Dup',
        capabilities: {}
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('lists, favorites, updates defaults and toggles enablement', async () => {
    const { ownerA, provider } = await seedProvider();
    const model = await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'm1',
      displayName: 'M1',
      capabilities: { toolCalling: true }
    });
    expect(await listModels(handle.db, ownerA)).toHaveLength(1);

    expect((await setFavorite(handle.db, ownerA, model.id, true)).isFavorite).toBe(true);
    const tuned = await updateModelDefaults(handle.db, ownerA, model.id, {
      temperature: 0.2,
      topP: 0.9,
      stop: ['X']
    });
    expect(tuned.inferenceDefaults).toEqual({ temperature: 0.2, topP: 0.9, stop: ['X'] });
    expect((await setEnabled(handle.db, ownerA, model.id, false)).enabled).toBe(false);

    expect(await listModels(handle.db, ownerA, { includeDisabled: false })).toHaveLength(0);
    expect(await listModels(handle.db, ownerA, { includeDisabled: true })).toHaveLength(1);
  });

  test('updateModel persists capabilities and reasoning defaults together', async () => {
    const { ownerA, provider } = await seedProvider();
    const model = await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'thinker',
      displayName: 'Thinker'
    });

    const updated = await updateModel(handle.db, ownerA, model.id, {
      displayName: 'Thinker v2',
      capabilities: { reasoning: true, reasoningEfforts: ['off', 'low', 'high'] },
      inferenceDefaults: {
        reasoningEffort: 'medium',
        reasoningOptions: { budget_tokens: 4000 }
      }
    });
    expect(updated.displayName).toBe('Thinker v2');
    expect(updated.capabilities).toEqual({
      reasoning: true,
      reasoningEfforts: ['off', 'low', 'high']
    });
    expect(updated.inferenceDefaults).toEqual({
      reasoningEffort: 'medium',
      reasoningOptions: { budget_tokens: 4000 }
    });
  });

  test('updateModel rejects an unknown reasoning level', async () => {
    const { ownerA, provider } = await seedProvider();
    const model = await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'strict',
      displayName: 'Strict'
    });
    let thrown: unknown;
    try {
      await updateModel(handle.db, ownerA, model.id, {
        inferenceDefaults: { reasoningEffort: 'turbo' as never }
      });
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) expect(thrown.code).toBe('validation_failed');
  });

  test('deleteModel refuses when an agent run references the model', async () => {
    const { a, ownerA, provider } = await seedProvider();
    const model = await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'busy',
      displayName: 'Busy',
      capabilities: {}
    });
    await handle.db
      .insert(agentRuns)
      .values({
        id: 'run-1',
        workspaceId: a.id,
        workflowId: 'wf-1',
        stateId: 'st-1',
        agentId: 'agent-1',
        agentVersionId: 'av-1',
        modelId: model.id,
        modelKey: model.modelKey
      })
      .run();

    let thrown: unknown;
    try {
      await deleteModel(handle.db, ownerA, model.id);
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) {
      expect(thrown.code).toBe('conflict');
      expect(thrown.message).toContain('agent run');
    }
    expect(await listModels(handle.db, ownerA, { includeDisabled: true })).toHaveLength(1);
  });

  test('deleteModel removes an unreferenced model', async () => {
    const { ownerA, provider } = await seedProvider();
    const model = await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'free',
      displayName: 'Free',
      capabilities: {}
    });
    await deleteModel(handle.db, ownerA, model.id);
    expect(
      await handle.db
        .select()
        .from(models)
        .where(and(eq(models.id, model.id)))
        .all()
    ).toHaveLength(0);
  });

  test('models are tenant-scoped', async () => {
    const { ownerA, ownerB, provider } = await seedProvider();
    await registerModel(handle.db, ownerA, {
      providerId: provider.id,
      modelKey: 'm1',
      displayName: 'M1',
      capabilities: {}
    });
    expect(await listModels(handle.db, ownerB)).toHaveLength(0);
  });
});
