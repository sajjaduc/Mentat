/**
 * FileService locator seam.
 *
 * The frozen contract installs one FileService for the process so triggers, agent
 * tools and HTTP connectors can ingest without knowing how blobs or dedupe work.
 * This pins the install/read/reset behaviour the bootstrap relies on.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { fileService, hasFileService } from '../../../src/lib/server/files/contracts';
import {
  createFileService,
  installFileService,
  resetFileService
} from '../../../src/lib/server/files/service';
import { configureLocalStorage } from '../../helpers/blobs';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;

beforeEach(() => {
  resetFileService();
  handle = createTestDatabase();
});

describe('FileService locator', () => {
  test('throws before installation and resolves afterwards', async () => {
    expect(hasFileService()).toBe(false);
    expect(() => fileService()).toThrow();

    const workspace = await createWorkspace(handle.db, 'Locator Workspace');
    await configureLocalStorage(handle.db, workspace.id, handle.tempDir);
    const user = await createUser(handle.db);
    const actor = ownerActor(workspace.id, user.id);
    const service = installFileService({ db: handle.db, blobStore: undefined });

    expect(hasFileService()).toBe(true);
    expect(fileService()).toBe(service);
    // The installed service is usable end to end.
    const result = await fileService().ingest(actor, {
      filename: 'locator.txt',
      bytes: new TextEncoder().encode('installed'),
      source: { type: 'system' },
      process: false
    });
    expect(result.fileId).toBeTruthy();

    resetFileService();
    expect(hasFileService()).toBe(false);
  });

  test('createFileService does not install itself', async () => {
    const service = createFileService({ db: handle.db });
    expect(service).toBeTruthy();
    expect(hasFileService()).toBe(false);
  });
});
