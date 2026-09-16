/**
 * First-class HTTP platform: public API.
 *
 * Layers, from the outside in:
 *
 *  - `service.ts` / `repository.ts` — configuration CRUD with permissions, audit and
 *    automatic tool exposure;
 *  - `runtime.ts` — the execution lifecycle (authorize → validate → approve → cache →
 *    rate limit → resolve secrets → fetch → map → log);
 *  - `testing.ts` — the editor's Test Request path;
 *  - `url.ts` / `auth.ts` / `mapping.ts` / `retry.ts` / `rate-limit.ts` / `cache.ts` —
 *    small, independently testable pieces the runtime composes.
 *
 * Everything an importing module needs is exported here so no caller reaches into an
 * internal file by path.
 */
export * from './auth';
export * from './cache';
export * from './mapping';
export * from './rate-limit';
export * from './repository';
export * from './retry';
export * from './runtime';
export * from './service';
export * from './testing';
export * from './url';
