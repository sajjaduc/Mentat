/**
 * Override mode resolution.
 *
 * Use as-is, Override and Fork are provenance states, so these tests pin the
 * effective mode, the inherited source and the changed field names rather than
 * just the stored row.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BINDABLE_RESOURCE_TYPES,
  listEffectiveConfiguration,
  removeOverride,
  resolveBinding,
  setOverride
} from '../../../src/lib/server/config/overrides';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { isAppError } from '../../../src/lib/server/core/errors';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let actor: ActorContext;
let workspaceId: string;
const workflowId = 'wf-1';

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Overrides');
  workspaceId = workspace.id;
  const user = await createUser(handle.db);
  actor = ownerActor(workspaceId, user.id);
});

afterEach(() => {
  handle.cleanup();
});

describe('config/overrides validation', () => {
  test('rejects an override binding without a source', async () => {
    await expect(
      setOverride(handle.db, actor, {
        workflowId,
        resourceType: 'agent',
        resourceId: 'wf-agent',
        mode: 'override'
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('rejects unknown resource types and modes', async () => {
    await expect(
      setOverride(handle.db, actor, {
        workflowId,
        resourceType: 'not_a_resource' as never,
        resourceId: 'x',
        mode: 'override',
        sourceResourceId: 'y'
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      setOverride(handle.db, actor, {
        workflowId,
        resourceType: 'agent',
        resourceId: 'x',
        mode: 'copy' as never,
        sourceResourceId: 'y'
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  test('rejects field changes on a use-as-is binding', async () => {
    await expect(
      setOverride(handle.db, actor, {
        workflowId,
        resourceType: 'agent',
        resourceId: 'wf-agent',
        sourceResourceId: 'ws-agent',
        mode: 'use_asis',
        overriddenFields: ['prompt']
      })
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('config/overrides resolution', () => {
  test('no binding row means inherited use-as-is', () => {
    const resolution = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'ws-agent'
    });
    expect(resolution).toMatchObject({
      mode: 'use_asis',
      sourceResourceId: 'ws-agent',
      overriddenFields: [],
      inherited: true,
      exists: false
    });
  });

  test('set → override, remove → inheritance resumes', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'wf-agent',
      sourceResourceId: 'ws-agent',
      mode: 'override',
      overriddenFields: ['prompt', 'temperature']
    });

    const bound = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'wf-agent'
    });
    expect(bound.mode).toBe('override');
    expect(bound.sourceResourceId).toBe('ws-agent');
    expect(bound.overriddenFields).toEqual(['prompt', 'temperature']);
    expect(bound.exists).toBe(true);
    expect(bound.inherited).toBe(false);

    await removeOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'wf-agent'
    });

    const after = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'wf-agent'
    });
    expect(after.exists).toBe(false);
    expect(after.mode).toBe('use_asis');
    expect(after.inherited).toBe(true);
  });

  test('fork without a source is a local resource', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'collection',
      resourceId: 'local-collection',
      mode: 'fork'
    });
    const resolution = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'collection',
      resourceId: 'local-collection'
    });
    expect(resolution.mode).toBe('fork');
    expect(resolution.sourceResourceId).toBeNull();
    expect(resolution.local).toBe(true);
    expect(resolution.forked).toBe(true);
  });

  test('groups bindings per resource type with UI counts', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'wf-agent',
      sourceResourceId: 'ws-agent',
      mode: 'use_asis'
    });
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'tool',
      resourceId: 'wf-tool',
      sourceResourceId: 'ws-tool',
      mode: 'override',
      overriddenFields: ['timeout']
    });
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'tool',
      resourceId: 'local-tool',
      mode: 'fork'
    });

    const effective = listEffectiveConfiguration(handle.db, actor, workflowId);
    const agentGroup = effective.groups.find((group) => group.resourceType === 'agent');
    const toolGroup = effective.groups.find((group) => group.resourceType === 'tool');
    expect(agentGroup?.counts).toEqual({ inherited: 1, overridden: 0, local: 0, forked: 0 });
    expect(toolGroup?.counts).toEqual({ inherited: 0, overridden: 1, local: 1, forked: 0 });
    expect(effective.totals).toEqual({ inherited: 1, overridden: 1, local: 1, forked: 0 });
    expect(effective.groups.map((group) => group.resourceType)).toEqual(['agent', 'tool']);
  });

  test('exposes every bindable resource type in the vocabulary', () => {
    expect(BINDABLE_RESOURCE_TYPES).toContain('secret');
    expect(BINDABLE_RESOURCE_TYPES).toContain('environment_variable');
    expect(BINDABLE_RESOURCE_TYPES.length).toBeGreaterThan(8);
  });

  test('removing an unknown override is a not-found error', async () => {
    try {
      await removeOverride(handle.db, actor, {
        workflowId,
        resourceType: 'agent',
        resourceId: 'never-bound'
      });
      throw new Error('expected removeOverride to throw');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('not_found');
    }
  });
});
