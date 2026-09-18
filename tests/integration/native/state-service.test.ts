import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { agentActor, createActorContext, Permissions } from '../../../src/lib/server/core/context';
import { AppError } from '../../../src/lib/server/core/errors';
import { agentState } from '../../../src/lib/server/db/schema';
import {
  deleteStateValue,
  getStateValue,
  listState,
  MAX_STATE_VALUE_BYTES,
  setStateValue
} from '../../../src/lib/server/state/service';
import { createTestDatabase, type TestDatabase } from '../../helpers/db';
import { createWorkspace, memberActor, ownerActor } from '../../helpers/factories';

let handle: TestDatabase;
let workspaceA: string;
let workspaceB: string;

beforeEach(async () => {
  handle = createTestDatabase();
  workspaceA = (await createWorkspace(handle.db, 'A')).id;
  workspaceB = (await createWorkspace(handle.db, 'B')).id;
});

function owner(workspaceId: string) {
  return ownerActor(workspaceId, 'user-1');
}

describe('scoped state service', () => {
  test('round-trips values in all five scopes', () => {
    const actor = owner(workspaceA);
    const cases = [
      { scope: 'workspace' as const, owners: {} },
      { scope: 'workflow' as const, owners: { workflowId: 'wf-1' } },
      { scope: 'workflowItem' as const, owners: { workflowItemId: 'wi-1' } },
      { scope: 'agent' as const, owners: { agentId: 'ag-1' } },
      { scope: 'run' as const, owners: { runId: 'run-1' } }
    ];
    for (const entry of cases) {
      const written = setStateValue(handle.db, actor, {
        scope: entry.scope,
        key: 'cursor',
        value: { step: entry.scope },
        ...entry.owners
      });
      expect(written.scope).toBe(entry.scope);
      const read = getStateValue(handle.db, actor, {
        scope: entry.scope,
        key: 'cursor',
        ...entry.owners
      });
      expect(read?.value).toEqual({ step: entry.scope });
    }
    expect(handle.db.select().from(agentState).all()).toHaveLength(5);
  });

  test('requires the owner id for each scoped address', () => {
    const actor = owner(workspaceA);
    expect(() =>
      setStateValue(handle.db, actor, { scope: 'workflow', key: 'k', value: 1 })
    ).toThrow();
    expect(() =>
      setStateValue(handle.db, actor, { scope: 'workflowItem', key: 'k', value: 1 })
    ).toThrow();
    expect(() => setStateValue(handle.db, actor, { scope: 'agent', key: 'k', value: 1 })).toThrow();
    expect(() => setStateValue(handle.db, actor, { scope: 'run', key: 'k', value: 1 })).toThrow();
    expect(() =>
      setStateValue(handle.db, actor, { scope: 'workspace', key: 'k', value: 1 })
    ).not.toThrow();
  });

  test('a second set upserts and bumps the version', () => {
    const actor = owner(workspaceA);
    const first = setStateValue(handle.db, actor, { scope: 'workspace', key: 'k', value: 1 });
    const second = setStateValue(handle.db, actor, { scope: 'workspace', key: 'k', value: 2 });
    expect(second.id).toBe(first.id);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(handle.db.select().from(agentState).all()).toHaveLength(1);
    expect(getStateValue(handle.db, actor, { scope: 'workspace', key: 'k' })?.value).toBe(2);
  });

  test('expires values and deletes them lazily', () => {
    const actor = owner(workspaceA);
    const now = Date.now();
    setStateValue(handle.db, actor, {
      scope: 'workflowItem',
      workflowItemId: 'tk-1',
      key: 'temp',
      value: 'x',
      ttlSeconds: 60,
      now
    });
    expect(
      getStateValue(handle.db, actor, {
        scope: 'workflowItem',
        workflowItemId: 'tk-1',
        key: 'temp',
        now
      })?.value
    ).toBe('x');
    expect(
      getStateValue(handle.db, actor, {
        scope: 'workflowItem',
        workflowItemId: 'tk-1',
        key: 'temp',
        now: now + 61_000
      })
    ).toBeNull();
    expect(handle.db.select().from(agentState).all()).toHaveLength(0);
  });

  test('lists newest-first, filtered by namespace and prefix', () => {
    const actor = owner(workspaceA);
    const base = Date.now();
    setStateValue(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      key: 'alpha',
      value: 1,
      now: base
    });
    setStateValue(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      key: 'alphabet',
      value: 2,
      now: base + 10
    });
    setStateValue(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      key: 'beta',
      value: 3,
      now: base + 20
    });
    setStateValue(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      key: 'alpha',
      value: 4,
      namespace: 'other',
      now: base + 30
    });

    const all = listState(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      now: base + 40
    });
    expect(all.map((entry) => entry.key)).toEqual(['beta', 'alphabet', 'alpha']);

    const prefixed = listState(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      prefix: 'alph',
      now: base + 40
    });
    expect(prefixed.map((entry) => entry.key).sort()).toEqual(['alpha', 'alphabet']);

    const scopedNamespace = listState(handle.db, actor, {
      scope: 'workflow',
      workflowId: 'wf-1',
      namespace: 'other',
      now: base + 40
    });
    expect(scopedNamespace).toHaveLength(1);
    expect(scopedNamespace[0]?.namespace).toBe('other');
  });

  test('honours limit and never returns another workspace value', () => {
    const actorA = owner(workspaceA);
    const actorB = owner(workspaceB);
    for (let index = 0; index < 5; index++) {
      setStateValue(handle.db, actorA, { scope: 'workspace', key: `k${index}`, value: index });
    }
    setStateValue(handle.db, actorB, { scope: 'workspace', key: 'b-only', value: 'b' });

    const limited = listState(handle.db, actorA, { scope: 'workspace', limit: 2 });
    expect(limited).toHaveLength(2);
    expect(listState(handle.db, actorB, { scope: 'workspace' }).map((e) => e.key)).toEqual([
      'b-only'
    ]);
    expect(getStateValue(handle.db, actorB, { scope: 'workspace', key: 'k0' })).toBeNull();
  });

  test('refuses reads without data:read and writes without data:write', () => {
    const silent = createActorContext({
      workspaceId: workspaceA,
      actorType: 'agent',
      actorId: 'agent-1',
      role: 'agent',
      permissions: []
    });
    expect(() => getStateValue(handle.db, silent, { scope: 'workspace', key: 'k' })).toThrow();
    expect(() =>
      setStateValue(handle.db, silent, { scope: 'workspace', key: 'k', value: 1 })
    ).toThrow();
  });

  test('workspace-scope writes require the explicit grant', () => {
    const writerOnly = agentActor(workspaceA, 'agent-1', 'Agent', [Permissions.dataWrite]);
    expect(() =>
      setStateValue(handle.db, writerOnly, { scope: 'workspace', key: 'k', value: 1 })
    ).toThrow();

    const granted = agentActor(workspaceA, 'agent-2', 'Agent', [
      Permissions.dataWrite,
      Permissions.configWrite
    ]);
    expect(() =>
      setStateValue(handle.db, granted, { scope: 'workspace', key: 'k', value: 1 })
    ).not.toThrow();

    // A human member has data:write but not config:write, so workspace state is
    // still opt-in for them.
    const member = memberActor(workspaceA, 'user-2');
    expect(() =>
      setStateValue(handle.db, member, { scope: 'workspace', key: 'm', value: 1 })
    ).toThrow();
    expect(member.permissions.has('config:write')).toBe(false);
  });

  test('workflow-item-scope writes do not need the workspace grant', () => {
    const agent = agentActor(workspaceA, 'agent-1', 'Agent', [Permissions.dataWrite]);
    expect(() =>
      setStateValue(handle.db, agent, {
        scope: 'workflowItem',
        workflowItemId: 'tk-1',
        key: 'k',
        value: 1
      })
    ).not.toThrow();
  });

  test('delete is idempotent and requires the workspace grant in workspace scope', () => {
    const actor = owner(workspaceA);
    setStateValue(handle.db, actor, { scope: 'workspace', key: 'k', value: 1 });
    expect(deleteStateValue(handle.db, actor, { scope: 'workspace', key: 'k' })).toBe(true);
    expect(deleteStateValue(handle.db, actor, { scope: 'workspace', key: 'k' })).toBe(false);

    const ungranted = agentActor(workspaceA, 'agent-1', 'Agent', [Permissions.dataWrite]);
    setStateValue(handle.db, actor, { scope: 'workspace', key: 'k2', value: 2 });
    expect(() =>
      deleteStateValue(handle.db, ungranted, { scope: 'workspace', key: 'k2' })
    ).toThrow();
  });

  test('rejects an oversized serialized value with validation_failed', () => {
    const actor = owner(workspaceA);
    const huge = 'x'.repeat(MAX_STATE_VALUE_BYTES + 1);
    try {
      setStateValue(handle.db, actor, { scope: 'workspace', key: 'huge', value: huge });
      throw new Error('expected setStateValue to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('validation_failed');
    }
    expect(handle.db.select().from(agentState).all()).toHaveLength(0);
  });

  test('state writes are not audited at the service level by design', async () => {
    const actor = owner(workspaceA);
    setStateValue(handle.db, actor, { scope: 'workspace', key: 'k', value: 1 });
    setStateValue(handle.db, actor, {
      scope: 'workflowItem',
      workflowItemId: 'tk-1',
      key: 'k',
      value: 1
    });
    const { queryAudit } = await import('../../../src/lib/server/audit/ledger');
    const rows = await queryAudit(handle.db, { workspaceId: workspaceA });
    expect(rows).toHaveLength(0);
  });
});

describe('state value round trips across owners', () => {
  test('the same key in different owner slots is a different entry', () => {
    const actor = owner(workspaceA);
    setStateValue(handle.db, actor, {
      scope: 'workflowItem',
      workflowItemId: 'tk-1',
      key: 'k',
      value: 'one'
    });
    setStateValue(handle.db, actor, {
      scope: 'workflowItem',
      workflowItemId: 'tk-2',
      key: 'k',
      value: 'two'
    });
    expect(
      getStateValue(handle.db, actor, { scope: 'workflowItem', workflowItemId: 'tk-1', key: 'k' })
        ?.value
    ).toBe('one');
    expect(
      getStateValue(handle.db, actor, { scope: 'workflowItem', workflowItemId: 'tk-2', key: 'k' })
        ?.value
    ).toBe('two');
    const rows = handle.db.select().from(agentState).where(eq(agentState.key, 'k')).all();
    expect(rows).toHaveLength(2);
  });
});
