/**
 * Native cache tools (`mentat.cache.*`).
 *
 * The cache key is always scoped to the actor's workspace; `authScope` separates
 * values produced under different credentials so one agent can never read another
 * identity's cached response. `mentat.cache.getOrCompute` is the model-facing
 * read-through: it returns the cached value when present, otherwise stores the value
 * the model supplies and returns it, which makes a repeated call with the same
 * arguments idempotent. The service-level `cacheGetOrCompute` remains the stampede
 * protected path for real async producers inside Mentat.
 */
import { z } from 'zod';
import { cacheDelete, cacheGet, cacheGetOrCompute, cacheSet } from '../../cache/service';
import { assertPermission, Permissions } from '../../core/context';
import { defineNativeTool, toolSuccess } from '../types';
import { inputJsonSchema, outputJsonSchema, parseToolInput } from './schema';

const keyFields = {
  key: z.string().min(1),
  namespace: z.string().min(1).optional(),
  authScope: z.string().optional()
};

const getInput = z.object({ ...keyFields });
const getOutput = z.object({
  value: z.unknown(),
  hit: z.boolean(),
  ageMs: z.number().int().nullable(),
  expiresAt: z.number().int().nullable(),
  storedAt: z.number().int().nullable()
});

const setInput = z.object({
  ...keyFields,
  value: z.unknown(),
  ttlSeconds: z.number().positive().optional(),
  tags: z.array(z.string().min(1)).max(20).optional()
});
const setOutput = z.object({
  sizeBytes: z.number().int(),
  storedAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  tags: z.array(z.string())
});

const deleteInput = z.object({ ...keyFields });
const deleteOutput = z.object({
  deleted: z.boolean(),
  key: z.string(),
  namespace: z.string()
});

const getOrComputeInput = z.object({
  ...keyFields,
  value: z.unknown(),
  ttlSeconds: z.number().positive().optional(),
  tags: z.array(z.string().min(1)).max(20).optional()
});
const getOrComputeOutput = z.object({
  value: z.unknown(),
  hit: z.boolean(),
  computed: z.boolean(),
  cacheStatus: z.enum(['hit', 'stored'])
});

export const cacheGetTool = defineNativeTool({
  key: 'mentat.cache.get',
  name: 'Get cached value',
  description:
    'Read a cached value by key. Namespace and authScope are part of the identity, so a value ' +
    'cached by another workspace or credential is never returned. An expired entry is treated ' +
    'as a miss. Idempotent.',
  inputSchema: inputJsonSchema(getInput),
  outputSchema: outputJsonSchema(getOutput),
  permission: Permissions.cacheRead,
  async execute(input, context) {
    const parsed = parseToolInput(getInput, input);
    assertPermission(context.actor, Permissions.cacheRead, 'Not permitted to read the cache');
    const result = cacheGet(context.db, {
      workspaceId: context.actor.workspaceId,
      key: parsed.key,
      namespace: parsed.namespace,
      authScope: parsed.authScope
    });
    return toolSuccess(result);
  }
});

export const cacheSetTool = defineNativeTool({
  key: 'mentat.cache.set',
  name: 'Set cached value',
  description:
    'Store a value under a key with an optional TTL in seconds. Repeated calls with the same ' +
    'key overwrite rather than duplicate. The workspace and authScope are recorded as part of ' +
    'the identity.',
  inputSchema: inputJsonSchema(setInput),
  outputSchema: outputJsonSchema(setOutput),
  permission: Permissions.cacheWrite,
  async execute(input, context) {
    const parsed = parseToolInput(setInput, input);
    assertPermission(context.actor, Permissions.cacheWrite, 'Not permitted to write the cache');
    const result = cacheSet(context.db, {
      workspaceId: context.actor.workspaceId,
      key: parsed.key,
      namespace: parsed.namespace,
      authScope: parsed.authScope,
      value: parsed.value,
      ttlSeconds: parsed.ttlSeconds,
      tags: parsed.tags
    });
    return toolSuccess(result);
  }
});

export const cacheDeleteTool = defineNativeTool({
  key: 'mentat.cache.delete',
  name: 'Delete cached value',
  description:
    'Delete one cached entry. Idempotent: deleting a missing key returns deleted=false. The ' +
    'call is destructive, so it declares a conditional approval policy the runner evaluates.',
  inputSchema: inputJsonSchema(deleteInput),
  outputSchema: outputJsonSchema(deleteOutput),
  permission: Permissions.cacheWrite,
  approvalPolicy: {
    mode: 'conditional',
    condition: 'destructive',
    reason: 'Deleting a cache entry is destructive and may require approval'
  },
  async execute(input, context) {
    const parsed = parseToolInput(deleteInput, input);
    assertPermission(
      context.actor,
      Permissions.cacheWrite,
      'Not permitted to delete cache entries'
    );
    const deleted = cacheDelete(context.db, {
      workspaceId: context.actor.workspaceId,
      key: parsed.key,
      namespace: parsed.namespace,
      authScope: parsed.authScope
    });
    return toolSuccess({
      deleted,
      key: parsed.key,
      namespace: parsed.namespace ?? 'default'
    });
  }
});

export const cacheGetOrComputeTool = defineNativeTool({
  key: 'mentat.cache.getOrCompute',
  name: 'Get or compute cached value',
  description:
    'Read-through cache: return the cached value when present, otherwise store the supplied ' +
    'value and return it. Use it once with a freshly computed value so later calls hit the ' +
    'cache. Idempotent for a fixed key and value.',
  inputSchema: inputJsonSchema(getOrComputeInput),
  outputSchema: outputJsonSchema(getOrComputeOutput),
  permission: Permissions.cacheWrite,
  async execute(input, context) {
    const parsed = parseToolInput(getOrComputeInput, input);
    assertPermission(context.actor, Permissions.cacheWrite, 'Not permitted to write the cache');
    const result = await cacheGetOrCompute(context.db, {
      workspaceId: context.actor.workspaceId,
      key: parsed.key,
      namespace: parsed.namespace,
      authScope: parsed.authScope,
      ttlSeconds: parsed.ttlSeconds,
      tags: parsed.tags,
      compute: () => parsed.value
    });
    return toolSuccess({
      value: result.value,
      hit: result.hit,
      computed: result.computed,
      cacheStatus: result.cacheStatus
    });
  }
});

export const cacheTools = [cacheGetTool, cacheSetTool, cacheDeleteTool, cacheGetOrComputeTool];

/** Guard used by the index test to keep the documented surface honest. */
export function cacheToolKeys(): string[] {
  return cacheTools.map((tool) => tool.key).sort();
}
