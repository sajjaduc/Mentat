import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getDefaultToolRegistry,
  nativeToolKeys,
  nativeTools,
  registerNativeTools,
  resetDefaultToolRegistry
} from '../../../src/lib/server/tools/registry';
import { type NativeToolHandler, ToolRegistry } from '../../../src/lib/server/tools/types';

function foreignTool(key: string): NativeToolHandler {
  return {
    key,
    name: 'Foreign tool',
    description: 'A tool owned by another workstream',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    async execute() {
      return { ok: true, output: { ok: true } };
    }
  };
}

let registry: ToolRegistry;

beforeEach(() => {
  registry = new ToolRegistry();
});

describe('registerNativeTools', () => {
  test('registers exactly this workstream’s tools', () => {
    registerNativeTools(registry);
    expect(registry.list().map((tool) => tool.key)).toEqual(nativeToolKeys());
    expect(registry.list()).toHaveLength(nativeTools.length);
  });

  test('throws when the same registry is registered twice', () => {
    registerNativeTools(registry);
    expect(() => registerNativeTools(registry)).toThrow(/Duplicate native tool registration/);
  });

  test('is composable with tools registered by other workstreams', () => {
    registry.register(foreignTool('ticket.fields.set'));
    registry.register(foreignTool('files.upload'));
    registerNativeTools(registry);
    const keys = registry.list().map((tool) => tool.key);
    expect(keys).toContain('ticket.fields.set');
    expect(keys).toContain('files.upload');
    for (const key of nativeToolKeys()) expect(keys).toContain(key);
    expect(registry.has('mentat.state.get')).toBe(true);
  });

  test('a foreign tool reusing a native key fails loudly at registration', () => {
    registerNativeTools(registry);
    expect(() => registry.register(foreignTool('mentat.cache.set'))).toThrow(
      /Duplicate native tool registration/
    );
  });

  test('exposes model-facing definitions for the registered tools', () => {
    registerNativeTools(registry);
    const definitions = registry.modelDefinitions(['mentat.state.get', 'mentat.data.find']);
    expect(definitions.map((definition) => definition.name).sort()).toEqual([
      'mentat.data.find',
      'mentat.state.get'
    ]);
    for (const definition of definitions) {
      expect(Object.keys(definition.parameters).length).toBeGreaterThan(0);
    }
  });
});

describe('default registry', () => {
  test('getDefaultToolRegistry returns one shared instance until reset', () => {
    const first = getDefaultToolRegistry();
    expect(getDefaultToolRegistry()).toBe(first);
    registerNativeTools(first);
    expect(first.has('mentat.state.set')).toBe(true);

    const second = resetDefaultToolRegistry();
    expect(second).not.toBe(first);
    expect(second.list()).toHaveLength(0);
    // Restore for any later test reading the default registry.
    registerNativeTools(getDefaultToolRegistry());
  });
});
