/**
 * Test-facing re-export of the in-process provider mock server.
 *
 * The implementation lives under `src` so the execution workstream can reuse it;
 * this shim keeps the import path stable for test files.
 */
export * from '../../src/lib/server/providers/testing/mock-ollama';
