/**
 * API-key handling for Ollama-compatible hosts and proxies.
 *
 * The only way a provider obtains a key is `resolveSecretValue`; the key must
 * reach the wire as a bearer token and must never appear in persisted rows.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProvider } from '../../../src/lib/server/providers/registry';
import { ProviderUnavailableError } from '../../../src/lib/server/providers/types';
import { createSecret } from '../../../src/lib/server/secrets/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import {
  createProviderRow,
  createUser,
  createWorkspace,
  ownerActor
} from '../../helpers/factories';
import { type MockOllamaServer, startMockOllama } from '../../helpers/mock-ollama';

const SECRET_VALUE = 'ollama-secret-key-abcdef-1234567890';

let handle: TestDatabase;
let server: MockOllamaServer | null = null;

beforeEach(() => {
  handle = createTestDatabase();
});

afterEach(() => {
  server?.stop();
  server = null;
  handle.cleanup();
});

/** Dump every application table so a leak anywhere is caught. */
function rawSqliteDump(database: TestDatabase): string {
  const tables = database.sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const parts: string[] = [];
  for (const table of tables) {
    if (table.name.startsWith('sqlite_')) continue;
    const rows = database.sqlite.query(`SELECT * FROM "${table.name}"`).all();
    parts.push(`${table.name}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

describe('provider API keys', () => {
  test('sends Authorization: Bearer <key> and never persists the value', async () => {
    const workspace = await createWorkspace(handle.db, 'Auth Workspace');
    const user = await createUser(handle.db);
    const actor = ownerActor(workspace.id, user.id);
    const secret = createSecret(handle.db, actor, {
      key: 'OLLAMA_API_KEY',
      value: SECRET_VALUE
    });

    server = startMockOllama({ chatHandler: () => undefined });
    const row = await createProviderRow(handle.db, {
      workspaceId: workspace.id,
      type: 'ollama',
      baseUrl: server.url,
      apiKeySecretId: secret.id
    });

    const provider = createProvider(handle.db, row);
    const result = await provider.generate({
      model: 'llama3.1:8b',
      messages: [{ role: 'user', content: 'hi' }]
    });
    expect(result.content).toBe('Hello');

    const chat = server.requestsFor('/api/chat')[0]!;
    expect(chat.headers.authorization).toBe(`Bearer ${SECRET_VALUE}`);

    const dump = rawSqliteDump(handle);
    expect(dump).not.toContain(SECRET_VALUE);
    // The secret row itself stores only the ciphertext columns.
    expect(dump).toContain('OLLAMA_API_KEY');
  });

  test('redacts a credential echoed back by the server in an error message', async () => {
    const workspace = await createWorkspace(handle.db, 'Auth Workspace 2');
    const user = await createUser(handle.db);
    const actor = ownerActor(workspace.id, user.id);
    const secret = createSecret(handle.db, actor, { key: 'PROXY_TOKEN', value: SECRET_VALUE });

    server = startMockOllama({
      failWith: { '/api/chat': { status: 500, body: `upstream rejected Bearer ${SECRET_VALUE}` } }
    });
    const row = await createProviderRow(handle.db, {
      workspaceId: workspace.id,
      type: 'ollama',
      baseUrl: server.url,
      apiKeySecretId: secret.id
    });

    const provider = createProvider(handle.db, row);
    let thrown: unknown;
    try {
      await provider.generate({
        model: 'llama3.1:8b',
        messages: [{ role: 'user', content: 'hi' }]
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderUnavailableError);
    expect((thrown as Error).message).not.toContain(SECRET_VALUE);
  });

  test('a missing secret id fails as not_found rather than sending an unauthenticated call', async () => {
    const workspace = await createWorkspace(handle.db, 'Auth Workspace 3');
    const row = await createProviderRow(handle.db, {
      workspaceId: workspace.id,
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      apiKeySecretId: 'does-not-exist'
    });
    expect(() => createProvider(handle.db, row)).toThrow();
  });
});
