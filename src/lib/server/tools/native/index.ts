/**
 * The native Mentat tool surface owned by this workstream: state, structured data
 * and cache.
 *
 * Ticket, file and HTTP tools are owned by other workstreams and register on the
 * *same* registry instance through their own `register*Tools` functions. This module
 * therefore registers only its own handlers and relies on `ToolRegistry.register`
 * throwing on duplicate keys so a collision (two workstreams claiming one key, or
 * bootstrap running twice) fails loudly instead of silently shadowing a tool.
 */
import type { NativeToolHandler, ToolRegistry } from '../types';
import { cacheTools } from './cache';
import { dataTools } from './data';
import { stateTools } from './state';

/** Every handler this workstream contributes, in registration order. */
export const nativeTools: NativeToolHandler[] = [...stateTools, ...dataTools, ...cacheTools];

/**
 * Register this workstream's native tools on a shared registry.
 *
 * Bootstrap calls `registerNativeTools(getDefaultToolRegistry())` exactly once and
 * other workstreams register their handlers on the same instance.
 */
export function registerNativeTools(registry: ToolRegistry): ToolRegistry {
  registry.registerAll(nativeTools);
  return registry;
}

/** Sorted keys of the tools this workstream registers; used by docs and tests. */
export function nativeToolKeys(): string[] {
  return nativeTools.map((tool) => tool.key).sort();
}
