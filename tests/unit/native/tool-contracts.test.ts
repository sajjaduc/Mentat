import { describe, expect, test } from 'bun:test';
import { errors } from '../../../src/lib/server/core/errors';
import { nativeToolKeys, nativeTools } from '../../../src/lib/server/tools/native';
import {
  defineNativeTool,
  type NativeToolHandler,
  type ToolInvocationContext,
  toolSuccess
} from '../../../src/lib/server/tools/types';

const EXPECTED_KEYS = [
  'mentat.cache.delete',
  'mentat.cache.get',
  'mentat.cache.getOrCompute',
  'mentat.cache.set',
  'mentat.data.delete',
  'mentat.data.find',
  'mentat.data.get',
  'mentat.data.insert',
  'mentat.data.update',
  'mentat.state.delete',
  'mentat.state.get',
  'mentat.state.list',
  'mentat.state.set'
];

const noopContext = {
  actor: {
    workspaceId: 'ws',
    actorType: 'system',
    actorId: null,
    actorLabel: null,
    role: 'service',
    permissions: new Set<string>()
  },
  db: {}
} as unknown as ToolInvocationContext;

describe('native tool contracts', () => {
  test('exposes exactly the documented keys', () => {
    expect(nativeToolKeys()).toEqual(EXPECTED_KEYS);
    expect(new Set(nativeToolKeys()).size).toBe(nativeTools.length);
  });

  test('every tool declares a real, non-empty JSON Schema for input and output', () => {
    for (const tool of nativeTools) {
      expect(typeof tool.key).toBe('string');
      expect(tool.key.startsWith('mentat.')).toBe(true);
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(20);

      expect(tool.inputSchema.type).toBe('object');
      const inputProperties = tool.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(inputProperties).length).toBeGreaterThan(0);
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);

      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe('object');
      const outputProperties = tool.outputSchema?.properties as Record<string, unknown>;
      expect(Object.keys(outputProperties).length).toBeGreaterThan(0);
    }
  });

  test('every tool declares a permission the runner can enforce', () => {
    for (const tool of nativeTools) {
      expect(tool.permission).toBeDefined();
      expect((tool.permission as string).length).toBeGreaterThan(0);
    }
  });

  test('destructive deletes declare a conditional approval policy', () => {
    for (const key of ['mentat.data.delete', 'mentat.cache.delete']) {
      const tool = nativeTools.find((candidate) => candidate.key === key);
      expect(tool?.approvalPolicy?.mode).toBe('conditional');
      expect(tool?.approvalPolicy?.condition).toBe('destructive');
    }
  });
});

describe('defineNativeTool', () => {
  test('converts a thrown AppError into a structured tool failure with timing', async () => {
    const tool = defineNativeTool({
      key: 'test.app_error',
      name: 'Test',
      description: 'A test handler',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      async execute() {
        throw errors.validation('bad input', { field: 'a' });
      }
    });

    const result = await tool.execute({}, noopContext);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('validation_failed');
    expect(result.error?.message).toBe('bad input');
    expect(result.error?.details).toEqual({ field: 'a' });
    expect(typeof result.durationMs).toBe('number');
  });

  test('converts an unknown throw into a generic tool error', async () => {
    const tool = defineNativeTool({
      key: 'test.unknown',
      name: 'Test',
      description: 'A test handler',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      async execute() {
        throw new Error('boom');
      }
    });

    const result = await tool.execute({}, noopContext);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('tool_error');
    expect(result.error?.message).toBe('boom');
  });

  test('preserves a successful tool result and adds its duration', async () => {
    const tool: NativeToolHandler<{ a: string }, { echoed: string }> = defineNativeTool({
      key: 'test.success',
      name: 'Test',
      description: 'A test handler',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
      async execute(input) {
        return toolSuccess({ echoed: input.a });
      }
    });

    const result = await tool.execute({ a: 'hi' }, noopContext);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ echoed: 'hi' });
    expect(typeof result.durationMs).toBe('number');
  });
});
