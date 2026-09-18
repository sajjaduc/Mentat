/**
 * Turning an agent's declared permissions into an actor permission set.
 *
 * Two layers, deliberately:
 *
 *  - **Coarse service permissions** (`workflow_item:write`, `file:read`, …) gate the
 *    service methods the runner and tools call.
 *  - **Native capability keys** (`workflowItems.setFields`, `files.read`, …) are
 *    placed in the same set verbatim, so the tool registry can assert the exact
 *    capability an agent was granted instead of inferring it from a coarse scope.
 *
 * The result is that an agent gets nothing implicitly: an empty permission
 * declaration yields an agent that can read the work it is working on and
 * nothing else.
 */
import { Permissions } from '../core/context';
import type { AgentPermissions } from '../db/schema';

const READ_ONLY_BASELINE = [
  Permissions.workflowRead,
  Permissions.runRead,
  Permissions.agentRead,
  Permissions.fileRead,
  Permissions.dataRead,
  Permissions.cacheRead,
  Permissions.configRead,
  Permissions.objectTypeRead,
  Permissions.recordRead,
  Permissions.workflowItemRead
];

/**
 * Capability keys are namespaced, optionally with the `mentat.` product prefix
 * (`mentat.workflowItems.setFields`) which is the form used by the native tool registry.
 * Comparison always happens on the un-prefixed form so a grant works whichever
 * spelling the caller used.
 */
export function normalizeCapabilityKey(key: string): string {
  if (key === '*') return '*';
  return key.startsWith('mentat.') ? key.slice('mentat.'.length) : key;
}

export function agentPermissionsToSet(
  permissions: AgentPermissions | null | undefined
): Set<string> {
  const set = new Set<string>(READ_ONLY_BASELINE);
  if (!permissions) return set;

  for (const rawKey of permissions.native ?? []) {
    if (rawKey === '*') {
      // Wildcard native access still does not grant workspace-level administration.
      set.add('*');
      continue;
    }
    set.add(rawKey);
    // Also store the un-prefixed form so either spelling resolves.
    set.add(normalizeCapabilityKey(rawKey));
  }

  if (permissions.httpOperationIds && permissions.httpOperationIds.length > 0) {
    set.add(Permissions.httpInvoke);
  }
  if (permissions.canCreateWork) {
    set.add(Permissions.workflowItemCreate);
    set.add(Permissions.workflowItemWrite);
  }
  if (permissions.canTransferWork) set.add(Permissions.workflowItemTransfer);
  if (permissions.canUploadFiles) {
    set.add(Permissions.fileWrite);
    set.add(Permissions.fileDelete);
  }
  if (permissions.canWriteWorkspaceState) {
    // Workspace-scoped agent state is the only place this grant is consulted.
    set.add(Permissions.configWrite);
  }

  // Mutating native capabilities imply the matching coarse service permission,
  // because the services they call assert at their own boundary.
  for (const rawKey of permissions.native ?? []) {
    const key = normalizeCapabilityKey(rawKey);
    // Universal-model capabilities (ADR-0021): Records and WorkflowItems.
    if (key === 'records.create') {
      set.add(Permissions.recordCreate);
      set.add(Permissions.recordWrite);
    } else if (key.startsWith('records.')) {
      set.add(Permissions.recordWrite);
    }
    if (key === 'workflowItems.create') {
      set.add(Permissions.workflowItemCreate);
      set.add(Permissions.workflowItemWrite);
    } else if (key.startsWith('workflowItems.')) {
      set.add(Permissions.workflowItemWrite);
    }
    if (key === 'workflowItems.transfer') set.add(Permissions.workflowItemTransfer);
    if (key.startsWith('data.')) set.add(Permissions.dataWrite);
    if (key.startsWith('cache.')) set.add(Permissions.cacheWrite);
    if (key.startsWith('files.setFields') || key.startsWith('files.linkToWorkItem')) {
      set.add(Permissions.fileWrite);
    }
    if (key.startsWith('http.')) set.add(Permissions.httpInvoke);
    if (key.startsWith('mcp.')) set.add(Permissions.mcpInvoke);
  }

  return set;
}

/** True when the actor may use a specific native capability key. */
export function hasNativeCapability(permissions: Set<string>, key: string): boolean {
  if (permissions.has('*')) return true;
  return (
    permissions.has(key) ||
    permissions.has(normalizeCapabilityKey(key)) ||
    permissions.has(`mentat.${normalizeCapabilityKey(key)}`)
  );
}

/**
 * A native tool may be reachable through several capability keys; the agent needs
 * at least one. Throws a policy error so the runner records a structured failure
 * instead of silently skipping the call.
 */
export function assertNativeCapability(
  permissions: Set<string>,
  keys: string[],
  label: string
): void {
  if (keys.length === 0) return;
  if (keys.some((key) => hasNativeCapability(permissions, key))) return;
  const error = new Error(`This agent is not permitted to ${label}`) as Error & {
    code: string;
    details: Record<string, unknown>;
  };
  error.code = 'policy_denied';
  error.details = { requiredCapabilities: keys };
  throw error;
}
