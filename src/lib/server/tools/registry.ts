/**
 * Default tool registry.
 *
 * The registry holds *in-process* native handlers. HTTP tools are not registered
 * here — they live in the database as `http_operations` and are dispatched through
 * the HTTP runtime — so this module stays a small, honest map with one instance
 * per process.
 *
 * Native tool implementations are contributed by their owning modules
 * (`tools/native/**`) at bootstrap, which keeps the set of things an agent can do
 * auditable in one place.
 */
import { ToolRegistry } from './types';

let instance: ToolRegistry | null = null;

export function getDefaultToolRegistry(): ToolRegistry {
  if (!instance) instance = new ToolRegistry();
  return instance;
}

/** Convenience alias so callers do not repeat `getDefaultToolRegistry()`. */
export function toolRegistry(): ToolRegistry {
  return getDefaultToolRegistry();
}

/** Test/bootstrap helper: install native tools exactly once. */
export function installNativeTools(
  register: (registry: ToolRegistry) => void,
  registry: ToolRegistry = getDefaultToolRegistry()
): ToolRegistry {
  register(registry);
  return registry;
}

export function resetToolRegistry(): void {
  instance = null;
}

export { ToolRegistry };
