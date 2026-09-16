/**
 * The registry is the only place that maps a provider row's `type` to a concrete
 * `ModelProvider`. Unknown types must fail loudly with `unsupported`, and the
 * instance cache must key on `updatedAt` so a config edit is picked up.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { isAppError } from '../../../src/lib/server/core/errors';
import { type ProviderType, providers } from '../../../src/lib/server/db/schema';
import { FakeProvider } from '../../../src/lib/server/providers/fake';
import {
  clearProviderOverrides,
  createProvider,
  getProviderForModel,
  resetProviderCache,
  setProviderOverride
} from '../../../src/lib/server/providers/registry';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createModelRow, createProviderRow, createWorkspace } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;

beforeEach(async () => {
  handle = createTestDatabase();
  resetProviderCache();
  clearProviderOverrides();
  workspaceId = (await createWorkspace(handle.db, 'Registry')).id;
});

afterEach(() => {
  resetProviderCache();
  clearProviderOverrides();
  handle.cleanup();
});

describe('createProvider', () => {
  test('maps each provider type to its implementation', async () => {
    const cases: Array<[ProviderType, string]> = [
      ['ollama', 'ollama'],
      ['openai', 'openai'],
      ['openai_compatible', 'openai_compatible'],
      ['anthropic', 'anthropic'],
      ['fake', 'fake']
    ];
    for (const [type, expected] of cases) {
      const row = await createProviderRow(handle.db, {
        workspaceId,
        type,
        baseUrl: type === 'ollama' ? 'http://127.0.0.1:1' : 'http://127.0.0.1:1'
      });
      const provider = createProvider(handle.db, row);
      expect(provider.type).toBe(expected);
    }
  });

  test('rejects an unknown provider type with errors.unsupported', async () => {
    const row = await createProviderRow(handle.db, {
      workspaceId,
      type: 'mystery' as ProviderType
    });
    let thrown: unknown;
    try {
      createProvider(handle.db, row);
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) expect(thrown.code).toBe('unsupported');
  });

  test('caches per provider id and updatedAt, and resetProviderCache clears it', async () => {
    const row = await createProviderRow(handle.db, { workspaceId, type: 'ollama' });
    const first = createProvider(handle.db, row);
    const second = createProvider(handle.db, row);
    expect(second).toBe(first);

    handle.sqlite
      .query('UPDATE providers SET updated_at = updated_at + 1 WHERE id = ?')
      .run(row.id);
    const refreshed = (
      await handle.db.select().from(providers).where(eq(providers.id, row.id)).all()
    )[0]!;
    expect(createProvider(handle.db, refreshed)).not.toBe(first);

    resetProviderCache();
    const afterReset = createProvider(handle.db, refreshed);
    resetProviderCache();
    expect(createProvider(handle.db, refreshed)).not.toBe(afterReset);
  });

  test('an injected override wins over construction', async () => {
    const row = await createProviderRow(handle.db, { workspaceId, type: 'ollama' });
    const fake = new FakeProvider({ generate: { content: 'injected' } });
    setProviderOverride(row.id, fake);
    expect(createProvider(handle.db, row)).toBe(fake);
  });
});

describe('getProviderForModel', () => {
  test('returns the provider and model for a workspace-scoped model id', async () => {
    const providerRow = await createProviderRow(handle.db, {
      workspaceId,
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:1'
    });
    const model = await createModelRow(handle.db, {
      workspaceId,
      providerId: providerRow.id,
      modelKey: 'llama3.1:8b'
    });
    const resolved = getProviderForModel(handle.db, { workspaceId, modelId: model.id });
    expect(resolved.model.id).toBe(model.id);
    expect(resolved.provider.type).toBe('ollama');
  });

  test('a model in another workspace is not visible, and probing cannot confirm it', async () => {
    const other = await createWorkspace(handle.db, 'Other');
    const providerRow = await createProviderRow(handle.db, {
      workspaceId: other.id,
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:1'
    });
    const model = await createModelRow(handle.db, {
      workspaceId: other.id,
      providerId: providerRow.id,
      modelKey: 'private:latest'
    });

    let thrown: unknown;
    try {
      getProviderForModel(handle.db, { workspaceId, modelId: model.id });
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) expect(thrown.code).toBe('not_found');
  });

  test('a missing model id is not_found', () => {
    let thrown: unknown;
    try {
      getProviderForModel(handle.db, { workspaceId, modelId: 'does-not-exist' });
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) expect(thrown.code).toBe('not_found');
  });
});
