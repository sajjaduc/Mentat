/**
 * Provider lookup seam.
 *
 * The execution engine must not import a concrete provider module: it needs
 * "given a workspace and a model id, give me a provider and a model descriptor".
 * That is exactly the `getProviderForModel` contract from the providers
 * workstream. Installing it through a locator keeps the dependency explicit and
 * one-directional, and lets tests drive the whole engine with the deterministic
 * fake provider.
 */

import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import type { Model } from '../db/schema';
import type { ModelProvider } from '../providers/types';

export interface ResolvedModel {
  provider: ModelProvider;
  model: Model;
}

export type ProviderLookup = (
  db: Executor,
  options: { workspaceId: string; modelId: string }
) => Promise<ResolvedModel>;

let lookup: ProviderLookup | null = null;

export function setProviderLookup(fn: ProviderLookup | null): void {
  lookup = fn;
}

export function hasProviderLookup(): boolean {
  return lookup !== null;
}

export async function resolveProviderForModel(
  db: Executor,
  options: { workspaceId: string; modelId: string }
): Promise<ResolvedModel> {
  if (!lookup) {
    throw errors.internal(
      'Provider lookup is not installed. Call setProviderLookup(getProviderForModel) during bootstrap.'
    );
  }
  return lookup(db, options);
}
