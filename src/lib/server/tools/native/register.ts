/**
 * Native tool registration.
 *
 * Bootstrap calls this exactly once. Keeping registration in one explicit function
 * (rather than scanning the filesystem) means the complete set of capabilities an
 * agent can reach is reviewable in a single place, and a missing registration fails
 * at startup rather than at 3am inside a run.
 *
 * Work-item and file tools are owned here; state/data/cache tools are contributed by
 * the native-data module. Both entry points are composed below so the composition
 * itself is explicit.
 */
import type { ToolRegistry } from '../types';
import { fileTools } from './files';
import { recordTools } from './records';
import { workflowItemTools } from './workflow-items';

export interface NativeToolRegistration {
  /** Registering twice is a programming error, not a runtime condition. */
  register(registry: ToolRegistry): void;
}

/** Tools that are always present. */
export function registerCoreNativeTools(registry: ToolRegistry): void {
  for (const tool of [...workflowItemTools, ...recordTools, ...fileTools]) {
    registry.register(tool);
  }
}

/**
 * Compose additional registration functions (for example the state/data/cache
 * tools) with the core set. Each contributor registers only its own keys.
 */
export function registerNativeTools(
  registry: ToolRegistry,
  contributors: Array<(registry: ToolRegistry) => void> = []
): ToolRegistry {
  registerCoreNativeTools(registry);
  for (const contribute of contributors) contribute(registry);
  return registry;
}

export const nativeToolOwnership = {
  workflowItem: workflowItemTools.map((tool) => tool.key),
  record: recordTools.map((tool) => tool.key),
  file: fileTools.map((tool) => tool.key)
};
