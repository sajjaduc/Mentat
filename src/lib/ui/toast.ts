/**
 * Toast state.
 *
 * Deliberately a plain `svelte/store` rather than a rune-backed module: `$state` at
 * module scope only works in `.svelte.ts` files, and this module must stay
 * importable from ordinary TypeScript (the API client, event handlers, server-side
 * code paths). A store gives components `$toasts` reactivity without that
 * constraint.
 *
 * Toasts report something that already happened, so they are never blocking. An
 * error that needs a decision is rendered inline instead (see `ErrorState`).
 */
import { get, type Readable, writable } from 'svelte/store';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Milliseconds; 0 keeps it until dismissed. */
  timeoutMs: number;
}

let nextId = 1;
const store = writable<Toast[]>([]);

/**
 * The toast list.
 *
 * Reactive in components (`$toasts`); `.current` is a non-reactive snapshot for
 * imperative callers that only need to read or clear the list.
 */
export const toasts: Readable<Toast[]> & { readonly current: Toast[] } = {
  subscribe: store.subscribe,
  get current() {
    return get(store);
  }
};

export function pushToast(input: Omit<Toast, 'id' | 'timeoutMs'> & { timeoutMs?: number }): number {
  const id = nextId++;
  const toast: Toast = {
    id,
    tone: input.tone,
    title: input.title,
    description: input.description,
    timeoutMs: input.timeoutMs ?? (input.tone === 'error' ? 8000 : 3500)
  };
  store.update((items) => [...items, toast]);
  if (toast.timeoutMs > 0) {
    setTimeout(() => dismissToast(id), toast.timeoutMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  store.update((items) => items.filter((toast) => toast.id !== id));
}

export function clearToasts(): void {
  store.set([]);
}
