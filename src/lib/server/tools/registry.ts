/**
 * Module-level default native tool registry.
 *
 * Bootstrap needs one shared registry that every workstream adds to, rather than
 * each module keeping a private map. `getDefaultToolRegistry()` returns that
 * instance; tests use `resetDefaultToolRegistry()` to get a clean one because
 * duplicate registration is intentionally fatal (see `ToolRegistry.register`).
 *
 * Usage from bootstrap:
 *
 * ```ts
 * import { getDefaultToolRegistry } from '$server/tools/registry';
 * import { registerNativeTools } from '$server/tools/native';
 * registerNativeTools(getDefaultToolRegistry());
 * // ticket/files/http workstreams register their own handlers on the same instance
 * ```
 */
import { ToolRegistry } from './types';

let defaultRegistry = new ToolRegistry();

/** The process-wide registry every native tool module registers into. */
export function getDefaultToolRegistry(): ToolRegistry {
  return defaultRegistry;
}

/**
 * Replace the default registry with a fresh, empty one. Intended for test isolation;
 * production bootstrap registers exactly once per process.
 */
export function resetDefaultToolRegistry(): ToolRegistry {
  defaultRegistry = new ToolRegistry();
  return defaultRegistry;
}

export { nativeToolKeys, nativeTools, registerNativeTools } from './native';
