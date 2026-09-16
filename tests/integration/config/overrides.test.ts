/**
 * Override lifecycle and provenance.
 *
 * Set → effective configuration shows the override; remove → inheritance
 * resumes. Fork and use-as-is are distinguished because they mean different
 * things to a user deciding "is my workflow using the shared resource?".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { queryAudit } from '../../../src/lib/server/audit/ledger';
import {
  listEffectiveConfiguration,
  listOverrides,
  removeOverride,
  resolveBinding,
  setOverride
} from '../../../src/lib/server/config/overrides';
import type { ActorContext } from '../../../src/lib/server/core/context';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createUser, createWorkspace, memberActor, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceId: string;
let actor: ActorContext;
const workflowId = 'workflow-a';

beforeEach(async () => {
  handle = createTestDatabase();
  const workspace = await createWorkspace(handle.db, 'Overrides integration');
  workspaceId = workspace.id;
  actor = ownerActor(workspaceId, (await createUser(handle.db)).id);
});

afterEach(() => {
  handle.cleanup();
});

describe('config/overrides integration', () => {
  test('set records an override that effective configuration reports', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'wf-agent',
      sourceResourceId: 'ws-agent',
      mode: 'override',
      overriddenFields: ['prompt']
    });

    const effective = listEffectiveConfiguration(handle.db, actor, workflowId);
    const group = effective.groups.find((entry) => entry.resourceType === 'agent');
    expect(group?.counts).toEqual({ inherited: 0, overridden: 1, local: 0, forked: 0 });
    expect(group?.bindings[0]).toMatchObject({
      resourceId: 'wf-agent',
      sourceResourceId: 'ws-agent',
      mode: 'override',
      overriddenFields: ['prompt'],
      exists: true
    });
  });

  test('remove resumes inheritance', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'tool',
      resourceId: 'wf-tool',
      sourceResourceId: 'ws-tool',
      mode: 'override',
      overriddenFields: ['timeoutSeconds']
    });
    await removeOverride(handle.db, actor, {
      workflowId,
      resourceType: 'tool',
      resourceId: 'wf-tool'
    });

    const resolution = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'tool',
      resourceId: 'wf-tool'
    });
    expect(resolution.exists).toBe(false);
    expect(resolution.mode).toBe('use_asis');
    expect(resolution.inherited).toBe(true);
    expect(listOverrides(handle.db, actor, { workflowId })).toHaveLength(0);
  });

  test('use-as-is shares the source; fork is an independent local copy', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'provider',
      resourceId: 'ws-provider',
      sourceResourceId: 'ws-provider',
      mode: 'use_asis'
    });
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'provider',
      resourceId: 'local-provider',
      mode: 'fork'
    });

    const shared = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'provider',
      resourceId: 'ws-provider'
    });
    const forked = resolveBinding(handle.db, actor, {
      workflowId,
      resourceType: 'provider',
      resourceId: 'local-provider'
    });
    expect(shared).toMatchObject({ mode: 'use_asis', inherited: true, forked: false });
    expect(forked).toMatchObject({ mode: 'fork', local: true, forked: true, inherited: false });
  });

  test('lists bindings per resource type', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'a1',
      sourceResourceId: 'ws-a',
      mode: 'override',
      overriddenFields: ['systemPrompt']
    });
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'skill',
      resourceId: 's1',
      sourceResourceId: 'ws-s',
      mode: 'use_asis'
    });

    const effective = listEffectiveConfiguration(handle.db, actor, workflowId);
    expect(effective.groups.map((group) => group.resourceType)).toEqual(['agent', 'skill']);
    expect(effective.totals).toEqual({ inherited: 1, overridden: 1, local: 0, forked: 0 });
  });

  test('is tenant isolated', async () => {
    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'a1',
      sourceResourceId: 'ws-a',
      mode: 'override',
      overriddenFields: ['systemPrompt']
    });

    const otherWorkspace = await createWorkspace(handle.db, 'Other overrides');
    const otherActor = ownerActor(otherWorkspace.id, (await createUser(handle.db)).id);
    expect(listOverrides(handle.db, otherActor, { workflowId })).toHaveLength(0);
    expect(listEffectiveConfiguration(handle.db, otherActor, workflowId).groups).toHaveLength(0);
    // Same workflow id, different tenant: resolveBinding must not leak the row.
    const resolution = resolveBinding(handle.db, otherActor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'a1'
    });
    expect(resolution.exists).toBe(false);
  });

  test('enforces permissions and audits both mutations', async () => {
    const member = memberActor(workspaceId, (await createUser(handle.db)).id);
    expect(listEffectiveConfiguration(handle.db, member, workflowId).groups).toHaveLength(0);
    await expect(
      setOverride(handle.db, member, {
        workflowId,
        resourceType: 'agent',
        resourceId: 'a1',
        mode: 'fork'
      })
    ).rejects.toMatchObject({ code: 'forbidden' });

    await setOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'a1',
      mode: 'fork'
    });
    await removeOverride(handle.db, actor, {
      workflowId,
      resourceType: 'agent',
      resourceId: 'a1'
    });

    expect(await queryAudit(handle.db, { workspaceId, actions: ['override.set'] })).toHaveLength(1);
    expect(
      await queryAudit(handle.db, { workspaceId, actions: ['override.removed'] })
    ).toHaveLength(1);
  });
});
