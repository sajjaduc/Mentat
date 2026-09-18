/**
 * Module-level default native tool registry.
 *
 * Bootstrap needs one shared registry that every workstream adds to, rather than
 * each module keeping a private map. `getDefaultToolRegistry()` returns that
 * instance; tests use `resetToolRegistry()` to get a clean one because duplicate
 * registration is intentionally fatal (see `ToolRegistry.register`).
 *
 * Usage from bootstrap:
 *
 * ```ts
 * import { getDefaultToolRegistry } from '$server/tools/registry';
 * import { registerNativeTools } from '$server/tools/native';
 * import { registerCoreNativeTools } from '$server/tools/native/register';
 * const registry = getDefaultToolRegistry();
 * registerNativeTools(registry);        // state / data / cache tools
 * registerCoreNativeTools(registry);    // work-item / record / file tools
 * ```
 *
 * Tool keys are namespaced per owning module, so the two entry points never
 * collide; a genuine duplicate still throws loudly at startup rather than at 3am
 * inside a run.
 */
import { ToolRegistry } from './types';

let defaultRegistry = new ToolRegistry();

/** The process-wide registry every native tool module registers into. */
export function getDefaultToolRegistry(): ToolRegistry {
  return defaultRegistry;
}

/** Convenience alias so callers do not repeat `getDefaultToolRegistry()`. */
export function toolRegistry(): ToolRegistry {
  return defaultRegistry;
}

/**
 * Replace the default registry with a fresh, empty one. Intended for test
 * isolation; production bootstrap registers exactly once per process.
 */
export function resetToolRegistry(): ToolRegistry {
  defaultRegistry = new ToolRegistry();
  return defaultRegistry;
}

/** Alias kept for the native-data module's original naming. */
export const resetDefaultToolRegistry = resetToolRegistry;

/** Install a contributor function against a registry (bootstrap/test helper). */
export function installNativeTools(
  register: (registry: ToolRegistry) => void,
  registry: ToolRegistry = getDefaultToolRegistry()
): ToolRegistry {
  register(registry);
  return registry;
}

export { nativeToolKeys, nativeTools, registerNativeTools } from './native';
export { ToolRegistry };
